import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { buildAcpDatabaseSessionKey } from "../acp/runtime/session-meta-keys.js";
import {
  prepareAcpSessionMutation,
  commitAcpSessionMutation,
} from "../acp/runtime/session-meta-worker-mutation.js";
import { withIncognitoSessionActor } from "../config/sessions/session-incognito-binding.js";
import type { IncognitoSessionAuthority } from "../config/sessions/session-incognito-contract.js";
import type {
  IncognitoHistoryOperations,
  IncognitoHistoryTarget,
} from "../config/sessions/session-incognito-history-contract.js";
import type { IncognitoLifecycleEntry } from "../config/sessions/session-incognito-lifecycle-contract.js";
import { readProcessHeldCliHistory } from "../gateway/cli-session-history.process-held.js";
import { readChatHistoryDelta } from "../gateway/server-methods/chat-history-delta.js";
import { readChatHistoryPage } from "../gateway/server-methods/chat-history-pages.js";
import { createIncognitoSessionHistoryReader } from "../gateway/session-history-snapshot.js";
import {
  readSessionHistorySnapshotAsync,
  SessionHistorySseState,
} from "../gateway/session-history-state.js";
import {
  captureIncognitoSessionHistoryReader,
  readSessionConversationBindingAsync,
} from "../gateway/session-transcript-readers.js";
import { buildConversationRef } from "../routing/conversation-ref.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { IncognitoAgentDatabaseExecution } from "./openclaw-agent-execution-incognito.js";
import { runOpenClawAgentWorkerWrite } from "./openclaw-agent-write-admission.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";

export type HistoryWiringFixture = {
  readonly actor: IncognitoAgentDatabaseExecution;
  readonly siblingActor: IncognitoAgentDatabaseExecution;
  readonly env: NodeJS.ProcessEnv;
  authority: IncognitoSessionAuthority;
  create(this: void, name: string): Promise<IncognitoLifecycleEntry>;
  append(this: void, target: IncognitoLifecycleEntry, content: string): Promise<unknown>;
  targetInput(this: void, target: IncognitoLifecycleEntry): IncognitoHistoryTarget;
};

export function registerIncognitoHistoryVisibilityTests(fixture: HistoryWiringFixture) {
  const { authority, create, append, targetInput } = fixture;

  it("cancels a worker host history read before the held actor FIFO resumes", async ({
    signal,
  }) => {
    const { actor } = fixture;
    const selected = await create("cancelled-host-history");
    const scope = { ...targetInput(selected), agentId: actor.agentId, storePath: actor.path };
    const history = createIncognitoSessionHistoryReader({
      actor,
      authority,
      target: scope,
      subagentCoordination: { isSubagentSession: () => false, isSubagentRunMessage: () => false },
      resolveCurrentUserProfileDisplay: () => ({ kind: "unresolved" as const }),
    });
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const held = runOpenClawAgentWorkerWrite(
      { target: actor.identity, assertCurrent: () => actor.assertReadable() },
      async () => {
        entered.resolve();
        await release.promise;
      },
    );
    await entered.promise;
    const requested = createDeferredCore();
    const hostRead = createDeferredCore<unknown>();
    const execute = actor.sessions.history;
    const observed = vi
      .spyOn(actor.sessions, "history")
      .mockImplementation(
        <Key extends keyof IncognitoHistoryOperations>(
          grant: IncognitoSessionAuthority,
          command: { type: Key; input: IncognitoHistoryOperations[Key]["input"] },
          requestSignal?: AbortSignal,
          onRead?: (value: IncognitoHistoryOperations[Key]["output"]) => void,
        ) => {
          const pending = execute(grant, command, requestSignal, onRead);
          hostRead.resolve(pending);
          requested.resolve();
          return pending;
        },
      );
    const controller = new AbortController();
    const reading = history.consume(scope, () =>
      readProcessHeldCliHistory(
        {
          entry: selected.entry,
          provider: undefined,
          sessionId: scope.sessionId,
          storePath: scope.storePath,
          sessionAgentId: scope.agentId,
          canonicalKey: scope.sessionKey,
          max: 1,
          maxHistoryBytes: 4096,
          effectiveMaxChars: 1000,
          offset: undefined,
          messageId: undefined,
        },
        controller.signal,
        history,
      ),
    );
    void reading.catch(hostRead.reject);
    const reason = new Error("Worker callback deadline expired");
    const rejected = expect(reading).rejects.toThrow(reason.message);
    const hostRejected = expect(hostRead.promise).rejects.toThrow(reason.message);
    try {
      await awaitGateBeforeSettlement(requested.promise, reading, "History skipped its host read");
      controller.abort(reason);
      await withinTest(hostRejected, signal);
      await rejected;
    } finally {
      release.resolve();
      await Promise.allSettled([held, reading, rejected, hostRead.promise, hostRejected]);
      observed.mockRestore();
    }
    await expect(history.readers.readSessionMessageCountAsync(scope)).resolves.toBe(0);
  });

  it.each(["native", "acp"] as const)(
    "captures %s child visibility for pages, worker callbacks, deltas and SSE without an injected resolver",
    async (kind) => {
      const { actor, env } = fixture;
      const selected = await create(`visibility-${kind}`);
      const childActor = kind === "acp" ? fixture.siblingActor : actor;
      const childKey = `agent:${childActor.agentId}:dashboard:incognito-visibility-child-${kind}`;
      await childActor.sessions.create(authority, {
        sessionKey: childKey,
        entry: {
          ...selected.entry,
          sessionId: `visibility-child-${kind}`,
          ...(kind === "native"
            ? { spawnedBy: selected.sessionKey, spawnDepth: 1 }
            : { parentSessionKey: selected.sessionKey }),
        },
      });
      if (kind === "acp") {
        await childActor.acp.upsertMeta({
          authority,
          env,
          cfg: {},
          sessionKey: childKey,
          mutate: () => ({
            backend: "fixture",
            agent: "fixture",
            runtimeSessionName: "visibility",
            mode: "persistent",
            state: "idle",
            lastActivityAt: 10_000,
          }),
        });
      }
      const seed = await actor.sessions.transcript(authority, {
        type: "session.message.append",
        input: {
          ...targetInput(selected),
          fence: { expectedLifecycleRevision: selected.entry.lifecycleRevision },
          message: {
            role: "assistant",
            content: [{ type: "text", text: "visible seed" }],
            timestamp: 10_000,
            __openclaw: { runId: `visibility-visible-${kind}` },
          },
        },
      });
      assert(seed.ok);
      const runId = `visibility-run-${kind}`;
      const scope = {
        ...targetInput(selected),
        agentId: actor.agentId,
        storePath: actor.path,
        sessionEntry: selected.entry,
        env,
      };
      await withIncognitoSessionActor(actor, async () => {
        const history = captureIncognitoSessionHistoryReader(scope);
        assert(history);
        const request = {
          entry: selected.entry,
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
        const processHeld = await history.consume(scope, () =>
          readProcessHeldCliHistory(request, undefined, history),
        );
        expect(processHeld.messages).toMatchObject([{ content: [{ text: "visible seed" }] }]);
        expect(processHeld.messages).toHaveLength(1);
        const hiddenInput = await actor.sessions.transcript(authority, {
          type: "session.message.append",
          input: {
            ...targetInput(selected),
            fence: { expectedLifecycleRevision: selected.entry.lifecycleRevision },
            message: {
              role: "user",
              content: "private coordination",
              timestamp: 10_001,
              idempotencyKey: `${runId}:user`,
              provenance: {
                kind: "inter_session",
                sourceTool: "sessions_send",
                sourceSessionKey: childKey,
              },
            },
          },
        });
        assert(hiddenInput.ok);
        const page = await readChatHistoryPage(request);
        expect(page.messages).toMatchObject([{ content: [{ text: "visible seed" }] }]);
        expect(page.messages).toHaveLength(1);
        assert(page.deltaCursor);
        const snapshot = await readSessionHistorySnapshotAsync({ target: scope });
        const sse = SessionHistorySseState.fromSnapshot({ target: scope, snapshot });
        const hiddenReply = {
          role: "assistant",
          content: "private child reply",
          timestamp: 10_002,
          __openclaw: { runId },
        };
        const appended = await actor.sessions.transcript(authority, {
          type: "session.message.append",
          input: {
            ...targetInput(selected),
            fence: { expectedLifecycleRevision: selected.entry.lifecycleRevision },
            message: hiddenReply,
          },
        });
        assert(appended.ok);
        await append(selected, "visible answer");
        const delta = await readChatHistoryDelta({
          agentId: actor.agentId,
          scope,
          sessionKey: selected.sessionKey,
          sessionSnapshot: {},
          cursor: page.deltaCursor,
        });
        expect(delta).toMatchObject({
          kind: "delta",
          messages: [{ message: { content: [{ text: "visible answer" }] } }],
        });
        assert(delta.kind === "delta");
        expect(delta.messages).toHaveLength(1);
        expect((await sse.prepareInlineMessage({ message: hiddenReply, messageSeq: 3 }))()).toEqual(
          { shouldRefresh: true },
        );
        expect((await sse.refreshAsync()).messages).toMatchObject([
          { content: [{ text: "visible seed" }] },
          { content: [{ text: "visible answer" }] },
        ]);
        await append(selected, "ordinary inline answer");
        expect(
          (
            await sse.prepareInlineMessage({
              message: {
                role: "assistant",
                content: [{ type: "text", text: "ordinary inline answer" }],
              },
              messageSeq: 5,
            })
          )(),
        ).toMatchObject({ message: { content: [{ text: "ordinary inline answer" }] } });
        if (kind === "acp") {
          await expect(
            history.consume(scope, async () => {
              const preparedPage = await history.http({ target: scope });
              const source = await childActor.sessions.acpSource(authority, childKey);
              const before = childActor.sessions.readSharing(childKey);
              const context = captureOpenClawStateWorkerContext({ env });
              const selectedSource = {
                kind: "ephemeral" as const,
                agentId: childActor.agentId,
                path: childActor.path,
                identity: childActor.identity,
                snapshot: source.snapshot,
              };
              const current = childActor.sessions.captureSnapshot(childKey);
              const { preparation, decision } = await prepareAcpSessionMutation(
                context,
                {
                  read: {
                    keys: [buildAcpDatabaseSessionKey(childKey, childActor.agentId)],
                    entry: source.snapshot.entry,
                  },
                  entry: source.snapshot.entry,
                  updatedAt: 10_003,
                  source: selectedSource,
                  sessionKey: childKey,
                  agentId: childActor.agentId,
                },
                () => null,
                current.assertCurrent,
              );
              assert(decision.kind !== "keep");
              await commitAcpSessionMutation(
                context,
                {
                  agentId: childActor.agentId,
                  storageSessionKey: childKey,
                  sessionKey: childKey,
                  entry: source.snapshot.entry,
                  currentRowKey: preparation.currentRowKey,
                  currentRowSessionId: preparation.currentRowSessionId,
                  updatedAt: 10_003,
                  decision,
                  source: selectedSource,
                },
                current.assertCurrent,
              );
              expect(childActor.sessions.readSharing(childKey)).toEqual(before);
              return preparedPage;
            }),
          ).rejects.toThrow("Prepared ACP session changed");
        }
      });
    },
  );

  it("reads captured actor conversation bindings for reaction delivery", async () => {
    const { actor, env } = fixture;
    const sessionKey = "agent:main:dashboard:incognito-reaction-source";
    const created = await actor.sessions.create(authority, {
      sessionKey,
      entry: {
        sessionId: "reaction-source",
        lifecycleRevision: "initial",
        createdAt: 10_000,
        updatedAt: 10_000,
        incognito: true,
        chatType: "direct",
        delivery: {
          kind: "external",
          route: {
            channel: "discord",
            accountId: "default",
            target: { to: "user:123456", chatType: "direct" },
          },
          context: { channel: "discord", accountId: "default", to: "user:123456" },
          origin: { provider: "discord", accountId: "default", chatType: "direct" },
        },
      },
    });
    assert(created.entry);
    const scope = {
      sessionKey,
      sessionId: created.entry.sessionId,
      agentId: actor.agentId,
      storePath: actor.path,
      env,
    };
    const ref = buildConversationRef({
      channel: "discord",
      accountId: "default",
      kind: "direct",
      peerId: "123456",
    });
    await withIncognitoSessionActor(actor, async () => {
      expect(await readSessionConversationBindingAsync(scope, ref)).toEqual({
        channel: "discord",
        accountId: "default",
        target: "user:123456",
        threadId: undefined,
        nativeChannelId: undefined,
      });
      expect(
        await readSessionConversationBindingAsync(scope, "conv_00000000000000000000000000000000"),
      ).toBeNull();
      await expect(
        readSessionConversationBindingAsync(
          { ...scope, sessionId: "retired-reaction-source" },
          ref,
        ),
      ).rejects.toThrow("current captured session");
    });
  });
}
