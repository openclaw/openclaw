import assert from "node:assert/strict";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { listSessionBranches } from "../config/sessions/session-accessor.sqlite-branch-list.js";
import { withIncognitoSessionActor } from "../config/sessions/session-incognito-binding.js";
import type { IncognitoSessionAuthority } from "../config/sessions/session-incognito-contract.js";
import type { IncognitoLifecycleEntry } from "../config/sessions/session-incognito-lifecycle-contract.js";
import { readSessionPendingInputReceiptsInWorker } from "../config/sessions/session-pending-input-receipts.js";
import { readSessionTranscriptModelContextAsync } from "../config/sessions/session-transcript-context-read.js";
import { loadTranscriptEvents } from "../config/sessions/session-transcript-events.js";
import { prepareSessionTranscriptHydration } from "../config/sessions/session-transcript-hydration.js";
import { findTranscriptEvent } from "../config/sessions/session-transcript-match.js";
import { hasSessionTranscriptMessage } from "../config/sessions/session-transcript-message-presence.js";
import {
  reconcileSessionTranscriptIndexes,
  waitForSessionTranscriptIndexReconcile,
} from "../config/sessions/session-transcript-reconcile.js";
import { searchSessionTranscripts } from "../config/sessions/session-transcript-search.js";
import { readTranscriptStatsAsync } from "../config/sessions/session-transcript-stats.js";
import { readSessionTranscriptWatermarkAsync } from "../config/sessions/session-transcript-watermark.js";
import { readRecentUserAssistantTextForSession } from "../config/sessions/transcript.js";
import * as cronJobNames from "../cron/store/job-name.js";
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
import {
  registerIncognitoHistoryVisibilityTests,
  type HistoryWiringFixture,
} from "./openclaw-agent-execution-incognito.history-visibility.test-support.js";
import { registerIncognitoSdkHistoryTests } from "./openclaw-agent-execution-incognito.sdk-history.test-support.js";
import type { IncognitoActorProbe } from "./openclaw-agent-execution-incognito.test-support.js";
import { captureOpenClawAgentDatabaseExecution } from "./openclaw-agent-execution.js";

export function registerIncognitoHistoryWiringTests(
  fixture: HistoryWiringFixture,
  probe: IncognitoActorProbe,
) {
  const { authority, create, append, targetInput } = fixture;
  registerIncognitoSdkHistoryTests(fixture);

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
  it("preserves shared search filters, retained windows, and per-key grants", async () => {
    const { actor, env } = fixture;
    const previous = await create("search-scope-previous");
    const sibling = await create("search-scope-sibling");
    await append(previous, "capturedsearchproof previous");
    await append(sibling, "capturedsearchproof sibling");
    const current = {
      ...previous,
      entry: { ...previous.entry, sessionId: "search-scope-current" },
    };
    const branched = await actor.sessions.transcript(authority, {
      type: "session.manager.transcript.branch",
      input: {
        sessionKey: previous.sessionKey,
        command: {
          type: "session.transcript.branch",
          input: {
            scope: { ...targetInput(previous), agentId: actor.agentId, storePath: actor.path },
            branch: { sessionId: current.entry.sessionId, events: [] },
            expectedLifecycleRevision: previous.entry.lifecycleRevision,
          },
        },
      },
    });
    assert(branched.ok);
    await append(current, "capturedsearchproof current");
    const params = {
      agentId: actor.agentId,
      storePath: actor.path,
      env,
      query: "capturedsearchproof",
    };
    await withIncognitoSessionActor(actor, async () => {
      await reconcileSessionTranscriptIndexes({ agentId: actor.agentId, path: actor.path, env });
      const all = [
        previous.entry.sessionId,
        current.entry.sessionId,
        sibling.entry.sessionId,
      ].toSorted();
      for (const [selection, expected] of [
        [{}, all],
        [{ sessionKeys: [] }, all],
        [{ sessionKey: previous.sessionKey }, all],
        [{ sessionKeys: [previous.sessionKey, sibling.sessionKey] }, all],
        [
          { sessionKeys: [previous.sessionKey] },
          [previous.entry.sessionId, current.entry.sessionId].toSorted(),
        ],
        [{ sessionId: previous.entry.sessionId }, [previous.entry.sessionId]],
        [{ sessionKeys: [previous.sessionKey], sessionId: sibling.entry.sessionId }, []],
        [{ sessionKeys: ["agent:main:dashboard:incognito-search-missing"] }, []],
      ] as const) {
        const result = await searchSessionTranscripts({
          ...params,
          ...selection,
          sessionKeys: "sessionKeys" in selection ? [...selection.sessionKeys] : undefined,
        });
        expect(result.hits.map((hit) => hit.sessionId).toSorted()).toEqual(expected);
      }
      expect(
        (
          await searchSessionTranscripts(params, undefined, {
            actor,
            authority,
            target: targetInput(current),
          })
        ).hits.map((hit) => hit.sessionId),
      ).toEqual([current.entry.sessionId]);
    });
    await expect(
      actor.sessions.history(
        {
          assertCurrent() {},
          authorize(_stage, facts) {
            if (facts.sessionKey === sibling.sessionKey) {
              throw new Error("Sibling search grant refused");
            }
          },
        },
        {
          type: "session.history.search",
          input: { sessions: [targetInput(current), targetInput(sibling)], query: params.query },
        },
      ),
    ).rejects.toThrow("Sibling search grant refused");
  });

  it("rejects an empty search selection changed by an earlier queued creation", async () => {
    const { actor, env } = fixture;
    const entered = createDeferredCore();
    const resume = createDeferredCore();
    const captured = createDeferredCore();
    const held = probe.read(actor, authority, async () => {
      entered.resolve();
      await resume.promise;
    });
    await entered.promise;
    const creating = create("search-empty-before-create");
    const reading = withIncognitoSessionActor(actor, () => {
      const pending = searchSessionTranscripts({
        agentId: actor.agentId,
        storePath: actor.path,
        env,
        query: "absent",
        sessionKeys: ["agent:main:dashboard:incognito-search-empty-before-create"],
      });
      captured.resolve();
      return pending;
    });
    const rejected = expect(reading).rejects.toThrow("search selection changed");
    try {
      await awaitGateBeforeSettlement(
        captured.promise,
        reading,
        "Search settled before capturing its source",
      );
      resume.resolve();
      await Promise.all([held, creating, rejected]);
    } finally {
      resume.resolve();
      await Promise.allSettled([held, creating, reading, rejected]);
    }
  });

  it("routes production history facades through their shared captured actor", async () => {
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
    await withIncognitoSessionActor(actor, async () => {
      const events = await loadTranscriptEvents(scope);
      expect(await loadTranscriptEvents({ ...scope, sessionKey: undefined })).toEqual(events);
      expect(await loadTranscriptEvents({ ...scope, env: undefined })).toEqual(events);
      await expect(
        loadTranscriptEvents(
          {
            ...scope,
            env: { ...env, OPENCLAW_STATE_DIR: `${env.OPENCLAW_STATE_DIR}/another-root` },
          },
          binding,
        ),
      ).rejects.toThrow("another session or store");
      await expect(
        loadTranscriptEvents({
          ...scope,
          env: undefined,
          sessionKey: "agent:foreign:dashboard:incognito-wired-history",
        }),
      ).rejects.toThrow(
        "Explicit incognito database target does not match its agent and state root",
      );
      expect(
        await loadTranscriptEvents({
          ...scope,
          storePath: `${env.OPENCLAW_STATE_DIR}/sessions.json`,
        }),
      ).toEqual(events);
      expect((await prepareSessionTranscriptHydration(scope).read()).kind).toBe("full");
      expect(await readTranscriptStatsAsync(scope)).toMatchObject({ eventCount: events.length });
      expect(await hasSessionTranscriptMessage(scope)).toBe(true);
      const message = events.find((event) => isRecord(event) && event.type === "message");
      assert(isRecord(message) && typeof message.id === "string");
      expect(
        await readRecentUserAssistantTextForSession({ ...scope, role: "assistant", limit: 2 }),
      ).toMatchObject([{ id: message.id, role: "assistant", text: "wired history proof" }]);
      expect(await findTranscriptEvent(scope, { kind: "latest" })).toMatchObject({
        event: { id: message.id },
      });
      expect(await readSessionTranscriptWatermarkAsync(scope)).toMatchObject({
        maxSeq: expect.any(Number),
      });
      expect(
        await readSessionTranscriptModelContextAsync(scope, (context) =>
          context.events.some((event) => isRecord(event) && event.id === message.id),
        ),
      ).toBe(true);
      expect(await readSessionTitleFieldsFromTranscriptAsync(scope)).toMatchObject({
        lastMessagePreview: "wired history proof",
      });
      for (const view of ["display", "model-context"] as const) {
        expect(
          await readSessionPreviewItemsFromTranscriptAsync(scope, 10, 100, view),
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
      expect(await listSessionBranches(scope)).toMatchObject({
        status: "ok",
        branches: [{ leafEntryId: message.id }],
      });
      expect(await searchSessionTranscripts({ ...scope, query: "wired" })).toMatchObject({
        hits: [{ messageId: message.id }],
      });
      expect(
        await readSessionPendingInputReceiptsInWorker(scope, { runIds: ["no-receipt"] }, binding),
      ).toEqual([]);
      expect(await readSessionMessageCountAsync(scope)).toBe(1);
      expect(
        await readSessionMessagesAsync(scope, { mode: "full", reason: "history wiring proof" }),
      ).toMatchObject([{ content: [{ text: "wired history proof" }] }]);
      expect(await readSessionTranscriptSummaryAsync(scope, { kind: "usage" })).toMatchObject({
        kind: "usage",
      });
      expect(
        await readSessionArtifacts(scope, { kind: "list", sessionKey: scope.sessionKey }),
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
      const page = await readChatHistoryPage(request);
      expect(page).toMatchObject({
        messages: [{ content: [{ text: "wired history proof" }] }],
      });
      for (const missingIdentity of [{ sessionId: undefined }, { storePath: undefined }]) {
        expect(await readChatHistoryPage({ ...request, ...missingIdentity })).toMatchObject({
          messages: [],
          pagination: { offset: 0, totalMessages: 0, rawPageMessages: 0 },
        });
      }
      assert(page.deltaCursor);
      for (const kind of ["rpc", "delta"] as const) {
        const controller = new AbortController();
        const pending =
          kind === "rpc"
            ? readChatHistoryPage(request, controller.signal)
            : readChatHistoryDelta(
                {
                  agentId: scope.agentId,
                  cursor: page.deltaCursor,
                  scope,
                  sessionKey: scope.sessionKey,
                  sessionSnapshot: {},
                },
                controller.signal,
              );
        controller.abort(new Error("history request cancelled"));
        await expect(pending).rejects.toThrow("history request cancelled");
      }
      expect(await readChatHistoryMessageById({ ...request, messageId: message.id })).toMatchObject(
        { found: true },
      );
      const snapshot = await readSessionHistorySnapshotAsync({ target: scope, limit: 10 });
      const sse = SessionHistorySseState.fromSnapshot({
        target: scope,
        limit: 10,
        snapshot,
      });
      await append(session, "second wired answer");
      const deltaRequest = {
        agentId: scope.agentId,
        cursor: page.deltaCursor,
        scope,
        sessionKey: scope.sessionKey,
        sessionSnapshot: {},
      };
      expect(await readChatHistoryDelta(deltaRequest, undefined, history)).toMatchObject({
        kind: "delta",
        messages: [{ message: { content: [{ text: "second wired answer" }] } }],
      });
      expect(await readChatHistoryDelta(deltaRequest)).toMatchObject({
        kind: "delta",
        messages: [{ message: { content: [{ text: "second wired answer" }] } }],
      });
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
  });

  registerIncognitoHistoryVisibilityTests(fixture);

  it("projects named cron labels before encoding actor-backed history", async () => {
    const { actor } = fixture;
    const session = await create("encoded-cron-history");
    const appended = await actor.sessions.transcript(authority, {
      type: "session.message.append",
      input: {
        ...targetInput(session),
        fence: { expectedLifecycleRevision: session.entry.lifecycleRevision },
        message: {
          role: "user",
          content: "Scheduled report",
          timestamp: 10_001,
          provenance: {
            kind: "inter_session",
            sourceTool: "sessions_send",
            sourceSessionKey: "agent:main:cron:daily-report:run:completed",
          },
        },
      },
    });
    assert(appended.ok);
    const names = vi
      .spyOn(cronJobNames, "prepareCronJobNameResolver")
      .mockResolvedValue((jobId) => (jobId === "daily-report" ? "Daily report" : undefined));
    try {
      const page = await withIncognitoSessionActor(actor, () =>
        readChatHistoryPage({
          entry: session.entry,
          provider: undefined,
          sessionId: session.entry.sessionId,
          storePath: actor.path,
          sessionAgentId: actor.agentId,
          canonicalKey: session.sessionKey,
          max: 10,
          maxHistoryBytes: 4096,
          effectiveMaxChars: 1000,
          offset: undefined,
          messageId: undefined,
          encodeResponse: true,
        }),
      );
      assert(page.encodedResponse);
      const encoded = new TextDecoder().decode(page.encodedResponse.messages);
      expect(JSON.parse(encoded)).toMatchObject([
        {
          content: "Scheduled report",
          senderLabel: "Forwarded from Daily report",
          senderSession: { label: "Daily report" },
        },
      ]);
      expect(page.encodedResponse.messagesBytes).toBe(Buffer.byteLength(encoded));
    } finally {
      names.mockRestore();
    }
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
    expect(
      await withIncognitoSessionActor(actor, () =>
        readRecentUserAssistantTextForSession({ ...target, role: "user", limit: 2 }),
      ),
    ).toMatchObject([{ role: "user", text: "after marker", timestamp: 2 }]);
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

  it.each(["unchanged", "revoke", "abort", "append", "release"] as const)(
    "settles async model context consumers after %s and joins their lifetime",
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
      const admission = new AbortController();
      let calls = 0;
      const work = withIncognitoSessionActor(
        borrowed,
        () =>
          readSessionTranscriptModelContextAsync(
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
            mode === "revoke" ? { actor: borrowed, authority: grant, target } : undefined,
          ),
        admission.signal,
      );
      const settled =
        mode === "unchanged" || mode === "append"
          ? expect(work).resolves.toMatchObject([
              { type: "session" },
              {
                message: {
                  content: [{ type: "text", text: "private context before consumer" }],
                },
              },
            ])
          : expect(work).rejects.toThrow(
              mode === "release"
                ? "reference is released"
                : mode === "abort"
                  ? "context admission revoked"
                  : "context grant revoked",
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
        } else if (mode === "abort") {
          admission.abort(new Error("context admission revoked"));
        } else if (mode === "append") {
          await append(session, "context changed while consumer awaited");
        } else if (mode === "release") {
          releasing = borrowed.release().then(() => {
            released = true;
          });
          await probe.read(actor, authority);
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
