import assert from "node:assert/strict";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { listSessionBranches } from "../config/sessions/session-accessor.sqlite-branch-list.js";
import { withIncognitoSessionActor } from "../config/sessions/session-incognito-binding.js";
import type { IncognitoSessionAuthority } from "../config/sessions/session-incognito-contract.js";
import type { IncognitoHistoryTarget } from "../config/sessions/session-incognito-history-contract.js";
import type { IncognitoLifecycleEntry } from "../config/sessions/session-incognito-lifecycle-contract.js";
import { readSessionPendingInputReceiptsInWorker } from "../config/sessions/session-pending-input-receipts.js";
import { readSessionTranscriptModelContextAsync } from "../config/sessions/session-transcript-context-read.js";
import { loadTranscriptEvents } from "../config/sessions/session-transcript-events.js";
import { findTranscriptEvent } from "../config/sessions/session-transcript-match.js";
import { hasSessionTranscriptMessage } from "../config/sessions/session-transcript-message-presence.js";
import { SessionTranscriptReadFenceError } from "../config/sessions/session-transcript-read-fence.js";
import { waitForSessionTranscriptIndexReconcile } from "../config/sessions/session-transcript-reconcile.js";
import { searchSessionTranscripts } from "../config/sessions/session-transcript-search.js";
import { readSessionTranscriptWatermarkAsync } from "../config/sessions/session-transcript-watermark.js";
import { readChatHistoryDelta } from "../gateway/server-methods/chat-history-delta.js";
import {
  readChatHistoryPage,
  readChatHistoryMessageById,
} from "../gateway/server-methods/chat-history-pages.js";
import { createIncognitoSessionHistoryReader } from "../gateway/session-history-snapshot.js";
import {
  readSessionHistorySnapshotAsync,
  SessionHistorySseState,
} from "../gateway/session-history-state.js";
import { readSessionPreviewItemsFromTranscriptAsync } from "../gateway/session-transcript-preview.js";
import {
  readSessionMessagesAsync,
  readSessionMessageCountAsync,
  readSessionTranscriptSummaryAsync,
  readSessionArtifacts,
} from "../gateway/session-transcript-readers.js";
import { readSessionTitleFieldsFromTranscriptAsync } from "../gateway/session-transcript-title-reader.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { IncognitoAgentDatabaseExecution } from "./openclaw-agent-execution-incognito.js";
import { captureOpenClawAgentDatabaseExecution } from "./openclaw-agent-execution.js";

type HistoryWiringFixture = {
  readonly actor: IncognitoAgentDatabaseExecution;
  readonly env: NodeJS.ProcessEnv;
  authority: IncognitoSessionAuthority;
  create(this: void, name: string): Promise<IncognitoLifecycleEntry>;
  append(this: void, target: IncognitoLifecycleEntry, content: string): Promise<unknown>;
  targetInput(this: void, target: IncognitoLifecycleEntry): IncognitoHistoryTarget;
};

export function registerIncognitoHistoryWiringTests(fixture: HistoryWiringFixture) {
  const { authority, create, append, targetInput } = fixture;

  it("keeps a multi-page history read current across an unrelated session write", async () => {
    const { actor } = fixture;
    const selected = await create("stable-paged-history");
    const sibling = await create("active-history-sibling");
    await append(selected, "first page");
    await append(selected, "second page");
    const scope = { ...targetInput(selected), agentId: actor.agentId, storePath: actor.path };
    const history = createIncognitoSessionHistoryReader({
      actor,
      authority,
      target: scope,
      subagentCoordination: { isSubagentSession: () => false, isSubagentRunMessage: () => false },
      resolveCurrentUserProfileDisplay: () => ({ kind: "unresolved" as const }),
    });
    const messages = await history.consume(scope, async (readers) => {
      const recent = await readers.readSessionMessagesPageWithStatsAsync(scope, {
        offset: 0,
        maxMessages: 1,
      });
      await append(sibling, "unrelated activity");
      const older = await readers.readSessionMessagesPageWithStatsAsync(scope, {
        offset: 1,
        maxMessages: 1,
      });
      return [...older.messages, ...recent.messages];
    });
    expect(messages).toMatchObject([
      { content: [{ text: "first page" }] },
      { content: [{ text: "second page" }] },
    ]);
  });

  it("schedules actor search indexing for a dirty sibling through the store owner", async () => {
    const { actor, env } = fixture;
    const selected = await create("search-selected");
    const sibling = await create("search-dirty-sibling");
    await append(selected, "selected result");
    await append(sibling, "retired sibling branch");
    const rewritten = await actor.sessions.transcript(authority, {
      type: "session.message.append",
      input: {
        ...targetInput(sibling),
        fence: { expectedLifecycleRevision: sibling.entry.lifecycleRevision },
        parentId: null,
        message: { role: "assistant", content: "replacement sibling branch", timestamp: 10_001 },
      },
    });
    assert(rewritten.ok);
    expect(rewritten.value.projectionNeedsReconcile).toBe(true);
    const query = (session: IncognitoLifecycleEntry) =>
      searchSessionTranscripts(
        {
          ...targetInput(session),
          agentId: actor.agentId,
          storePath: actor.path,
          env,
          query: session === selected ? "selected" : "replacement",
        },
        undefined,
        { actor, authority, target: targetInput(session) },
      );
    expect(await query(selected)).toMatchObject({
      indexing: true,
      hits: [{ sessionId: selected.entry.sessionId }],
    });
    await waitForSessionTranscriptIndexReconcile(
      { agentId: actor.agentId, path: actor.path, env },
      { actor, authority },
    );
    expect(await query(sibling)).toMatchObject({
      indexing: false,
      hits: [{ sessionId: sibling.entry.sessionId }],
    });
  });
  it("routes production history facades through one explicitly supplied actor", async () => {
    const { actor, env } = fixture;
    const session = await create("wired-history");
    await append(session, "wired history proof");
    const binding = { actor, authority, target: targetInput(session) };
    const scope = {
      ...binding.target,
      agentId: actor.agentId,
      storePath: actor.path,
      sessionEntry: session.entry,
      env,
    };
    const history = createIncognitoSessionHistoryReader({
      ...binding,
      target: scope,
      subagentCoordination: { isSubagentSession: () => false, isSubagentRunMessage: () => false },
      resolveCurrentUserProfileDisplay: () => ({ kind: "unresolved" as const }),
    });
    const events = await loadTranscriptEvents(scope, binding);
    expect(await hasSessionTranscriptMessage(scope, binding)).toBe(true);
    const message = events.find((event) => isRecord(event) && event.type === "message");
    assert(isRecord(message) && typeof message.id === "string");
    expect(await findTranscriptEvent(scope, { kind: "latest" }, binding)).toMatchObject({
      event: { id: message.id },
    });
    expect(await readSessionTranscriptWatermarkAsync(scope, binding)).toMatchObject({
      maxSeq: expect.any(Number),
    });
    expect(
      await readSessionTranscriptModelContextAsync(
        scope,
        (context) => context.events.some((event) => isRecord(event) && event.id === message.id),
        undefined,
        undefined,
        undefined,
        undefined,
        binding,
      ),
    ).toBe(true);
    expect(
      await readSessionTitleFieldsFromTranscriptAsync(scope, undefined, binding),
    ).toMatchObject({
      lastMessagePreview: "wired history proof",
    });
    for (const view of ["display", "model-context"] as const) {
      expect(
        await readSessionPreviewItemsFromTranscriptAsync(scope, 10, 100, view, binding),
      ).toContainEqual({ role: "assistant", text: "wired history proof" });
    }
    await expect(
      readSessionPreviewItemsFromTranscriptAsync(scope, 10, 100, "model-context", {
        ...binding,
        authority: {
          assertCurrent() {},
          authorize(stage) {
            if (stage === "transaction") {
              throw new Error("preview grant refused");
            }
          },
        },
      }),
    ).rejects.toThrow("preview grant refused");
    expect(await listSessionBranches(scope, binding)).toMatchObject({
      status: "ok",
      branches: [{ leafEntryId: message.id }],
    });
    expect(
      await searchSessionTranscripts({ ...scope, query: "wired" }, undefined, binding),
    ).toMatchObject({ hits: [{ messageId: message.id }] });
    expect(
      await readSessionPendingInputReceiptsInWorker(scope, { runIds: ["no-receipt"] }, binding),
    ).toEqual([]);
    expect(await readSessionMessageCountAsync(scope, history)).toBe(1);
    expect(
      await readSessionMessagesAsync(
        scope,
        { mode: "full", reason: "history wiring proof" },
        history,
      ),
    ).toMatchObject([{ content: [{ text: "wired history proof" }] }]);
    expect(
      await readSessionTranscriptSummaryAsync(scope, { kind: "usage" }, history),
    ).toMatchObject({
      kind: "usage",
    });
    expect(
      await readSessionArtifacts(scope, { kind: "list", sessionKey: scope.sessionKey }, history),
    ).toMatchObject({ kind: "list", artifacts: [] });
    const request = {
      entry: session.entry,
      provider: undefined,
      sessionId: scope.sessionId,
      storePath: scope.storePath,
      sessionAgentId: scope.agentId,
      canonicalKey: scope.sessionKey,
      max: 10,
      maxHistoryBytes: 4096,
      effectiveMaxChars: 1000,
      offset: undefined,
      messageId: undefined,
    };
    const page = await readChatHistoryPage(request, undefined, history);
    expect(page).toMatchObject({
      messages: [{ content: [{ text: "wired history proof" }] }],
    });
    assert(page.deltaCursor);
    for (const kind of ["rpc", "delta"] as const) {
      const controller = new AbortController();
      const pending =
        kind === "rpc"
          ? readChatHistoryPage(request, controller.signal, history)
          : readChatHistoryDelta(
              {
                agentId: scope.agentId,
                cursor: page.deltaCursor,
                scope,
                sessionKey: scope.sessionKey,
                sessionSnapshot: {},
              },
              controller.signal,
              history,
            );
      controller.abort(new Error("history request cancelled"));
      await expect(pending).rejects.toThrow("history request cancelled");
    }
    expect(
      await readChatHistoryMessageById({ ...request, messageId: message.id }, history),
    ).toMatchObject({ found: true });
    const snapshot = await readSessionHistorySnapshotAsync({ target: scope, limit: 10 }, history);
    const sse = SessionHistorySseState.fromSnapshot({
      target: scope,
      limit: 10,
      snapshot,
      incognito: history,
    });
    await append(session, "second wired answer");
    expect(await sse.refreshAsync()).toMatchObject({
      messages: [
        { content: [{ text: "wired history proof" }] },
        { content: [{ text: "second wired answer" }] },
      ],
    });
    await expect(
      history.consume(scope, async (readers) => {
        const selected = await readers.readSessionMessageCountAsync(scope);
        await append(session, "intervening rewrite witness");
        return selected;
      }),
    ).rejects.toThrow("snapshot changed");
    await expect(
      readSessionMessagesAsync(
        { ...scope, sessionId: "foreign" },
        { mode: "full", reason: "foreign binding" },
        history,
      ),
    ).rejects.toThrow("another session or store");
    let revoked = false;
    const guarded = createIncognitoSessionHistoryReader({
      ...binding,
      target: scope,
      authority: {
        assertCurrent() {},
        authorize() {
          if (revoked) {
            throw new Error("visitor grant revoked");
          }
        },
      },
      subagentCoordination: { isSubagentSession: () => false, isSubagentRunMessage: () => false },
      resolveCurrentUserProfileDisplay: () => ({ kind: "unresolved" as const }),
    });
    let disclosed = 0;
    await expect(
      guarded.visitSessionMessagesAsync(scope, () => {
        disclosed++;
        revoked = true;
      }),
    ).rejects.toThrow("visitor grant revoked");
    expect(disclosed).toBe(1);
    expect(() => guarded.assertCurrent()).toThrow("visitor grant revoked");
  });

  it("preserves raw visitor message ordinals across reset and visible control markers", async () => {
    const { actor, env } = fixture;
    const session = await create("raw-visitor");
    const target = { ...targetInput(session), agentId: actor.agentId, storePath: actor.path, env };
    await withIncognitoSessionActor(actor, async () => {
      const manager = await SessionManager.openAsync(target);
      await manager.appendMessageAsync({ role: "user", content: "before reset", timestamp: 1 });
      await manager.appendResetBoundaryAsync("reset");
      await manager.appendCustomMessageEntryAsync("notice", "visible control", true);
      await manager.appendMessageAsync({ role: "user", content: "after marker", timestamp: 2 });
    });
    const history = createIncognitoSessionHistoryReader({
      actor,
      authority,
      target,
      subagentCoordination: { isSubagentSession: () => false, isSubagentRunMessage: () => false },
      resolveCurrentUserProfileDisplay: () => ({ kind: "unresolved" as const }),
    });
    const visited: Array<{ message: unknown; seq: number }> = [];
    await history.visitSessionMessagesAsync(target, (message, seq) =>
      visited.push({ message, seq }),
    );
    expect(visited).toEqual([
      { message: { role: "user", content: "after marker", timestamp: 2 }, seq: 2 },
    ]);
  });

  it("rejects async preview transaction grants while commit grants remain synchronous", async () => {
    const { actor, env } = fixture;
    const session = await create("async-preview-grant");
    await append(session, "preview content");
    const target = { ...targetInput(session), agentId: actor.agentId, storePath: actor.path, env };
    const grant: IncognitoSessionAuthority = { assertCurrent() {} };
    // Inject an invalid runtime hook to exercise the synchronous-grant boundary.
    Object.defineProperty(grant, "authorize", {
      value(stage: "transaction" | "commit") {
        if (stage === "transaction") {
          return Promise.reject(new Error("asynchronous grant denied"));
        }
        return undefined;
      },
    });
    await expect(
      readSessionPreviewItemsFromTranscriptAsync(target, 10, 100, "model-context", {
        actor,
        target,
        authority: grant,
      }),
    ).rejects.toThrow("Incognito session grants must remain synchronous");
  });

  it.each(["unchanged", "revoke", "write", "release"] as const)(
    "revalidates async model context consumers after %s and joins their lifetime",
    async (mode) => {
      const { actor, env } = fixture;
      const session = await create(`async-model-context-${mode}`);
      await append(session, "private context before consumer");
      let revoked = false;
      const grant: IncognitoSessionAuthority = {
        assertCurrent() {},
        authorize() {
          if (revoked) {
            throw new Error("context grant revoked");
          }
        },
      };
      const borrowed = await captureOpenClawAgentDatabaseExecution({
        kind: "ephemeral",
        agentId: actor.agentId,
        env,
        authority: grant,
        existingOnly: true,
      });
      assert(borrowed);
      const target = targetInput(session);
      const scope = { ...target, agentId: borrowed.agentId, storePath: borrowed.path, env };
      const entered = createDeferredCore();
      const resume = createDeferredCore();
      let calls = 0;
      const work = readSessionTranscriptModelContextAsync(
        scope,
        async (context) => {
          calls++;
          entered.resolve();
          await resume.promise;
          return context.events;
        },
        undefined,
        undefined,
        undefined,
        undefined,
        { actor: borrowed, authority: grant, target },
      );
      const settled =
        mode === "unchanged"
          ? expect(work).resolves.toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  message: expect.objectContaining({
                    content: [{ type: "text", text: "private context before consumer" }],
                  }),
                }),
              ]),
            )
          : mode === "write"
            ? expect(work).rejects.toBeInstanceOf(SessionTranscriptReadFenceError)
            : expect(work).rejects.toThrow(
                mode === "release" ? "reference is released" : "context grant revoked",
              );
      let releasing: Promise<void> | undefined;
      let released = false;
      try {
        await awaitGateBeforeSettlement(
          entered.promise,
          work,
          "Context read settled before its consumer",
        );
        if (mode === "revoke") {
          revoked = true;
        } else if (mode === "write") {
          await append(session, "context changed while consumer awaited");
        } else if (mode === "release") {
          releasing = borrowed.release().then(() => {
            released = true;
          });
          await actor.run(authority, async () => undefined);
          expect(released).toBe(false);
        }
        resume.resolve();
        await Promise.all([settled, releasing]);
        expect(calls).toBe(1);
      } finally {
        resume.resolve();
        await Promise.allSettled([work, settled, borrowed.release()]);
      }
    },
  );
}
