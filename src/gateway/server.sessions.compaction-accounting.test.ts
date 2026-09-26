import { expect, test, vi } from "vitest";
import type { QueuedCompactionHostOptions } from "../agents/embedded-agent-runner/compact.queued-execution.js";
import { SESSION_TOTAL_TOKENS_VERSION } from "../config/sessions.js";
import {
  loadSessionEntry,
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { embeddedRunMock } from "./test-helpers.runtime-state.js";
import { seedTranscriptRows } from "./test/server-sessions-compaction.test-helpers.js";
import {
  directSessionReq,
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

test.each([
  { hostCommitted: false, nativeOk: true, replaced: false },
  { hostCommitted: true, nativeOk: true, replaced: false },
  { hostCommitted: true, nativeOk: false, replaced: false },
  { hostCommitted: false, nativeOk: false, replaced: false },
  { hostCommitted: true, nativeOk: false, replaced: true },
])(
  "sessions.compact accounts and publishes with hostCommitted=$hostCommitted nativeOk=$nativeOk replaced=$replaced",
  async ({ hostCommitted, nativeOk, replaced }) => {
    const { storePath } = await createSessionStoreDir();
    const target = { agentId: "main", sessionKey: "agent:main:main", storePath };
    const byteLatch = { sessionId: "sess-codex", activeBytes: 200, maxBytes: 100 };
    await upsertSessionEntryCore(
      target,
      sessionStoreEntry("sess-codex", {
        agentHarnessId: "codex",
        modelSelectionLocked: true,
        compactionCount: 2,
        transcriptByteCompactionLatch: byteLatch,
        totalTokens: 54_321,
        totalTokensFresh: true,
        totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
        cliSessionIds: { "codex-cli": "thread-1" },
        cliSessionBindings: { "codex-cli": { sessionId: "thread-1" } },
      }),
    );
    await seedTranscriptRows({ ...target, sessionId: "sess-codex", totalLines: 2 });
    const nativeReason = nativeOk ? undefined : "native compaction failed";
    embeddedRunMock.compactEmbeddedAgentSession.mockImplementationOnce(
      async (_input, hostInput) => {
        if (hostCommitted) {
          const entry = await patchSessionEntryCore(target, () => ({ compactionCount: 3 }));
          if (!entry) {
            throw new Error("expected committed compaction entry");
          }
          await (hostInput as QueuedCompactionHostOptions).onHostCompactionCommitted?.({
            entry,
            compactionKind: "context-engine",
            accountingCommitted: true,
          });
        }
        if (replaced) {
          await upsertSessionEntryCore(
            target,
            sessionStoreEntry("sess-replacement", { compactionCount: 7 }),
          );
        }
        return {
          ok: nativeOk,
          compacted: hostCommitted || nativeOk,
          compactionKind: hostCommitted ? "context-engine" : "native-harness",
          reason: nativeReason,
          result: {
            summary: "",
            firstKeptEntryId: "",
            tokensBefore: 54_321,
            details: {
              backend: "codex-app-server",
              threadId: "thread-1",
              signal: "thread/compact/start",
              pending: false,
              completed: nativeOk,
            },
          },
        };
      },
    );
    const broadcastToConnIds = vi.fn();
    const runtimeConfig = {
      agents: { list: [{ id: "main", default: true }] },
      session: { store: storePath },
    };
    const response = await directSessionReq(
      "sessions.compact",
      { key: "main" },
      {
        context: {
          broadcastToConnIds,
          getRuntimeConfig: () => runtimeConfig,
          getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
        },
      },
    );
    const changes = broadcastToConnIds.mock.calls.filter(([event]) => event === "sessions.changed");
    const entry = loadSessionEntry({ ...target, readConsistency: "latest" });

    if (replaced) {
      expect(response).toMatchObject({
        ok: false,
        error: { details: { reason: "session-changed" } },
      });
      expect(entry?.sessionId).toBe("sess-replacement");
      expect(entry?.compactionCount).toBe(7);
      expect(changes).toHaveLength(0);
      return;
    }

    expect(response).toMatchObject({
      ok: true,
      payload: {
        ok: nativeOk,
        key: target.sessionKey,
        compacted: hostCommitted || nativeOk,
        reason: nativeReason,
        result: { details: { completed: nativeOk, pending: false } },
      },
    });
    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "session.operation",
      expect.objectContaining({ phase: "end", completed: nativeOk, reason: nativeReason }),
      expect.any(Set),
      expect.any(Object),
    );
    expect(entry).toMatchObject({
      compactionCount: hostCommitted || nativeOk ? 3 : 2,
      transcriptByteCompactionLatch: byteLatch,
      cliSessionIds: { "codex-cli": "thread-1" },
      cliSessionBindings: { "codex-cli": { sessionId: "thread-1" } },
      totalTokens: 54_321,
      totalTokensFresh: hostCommitted || !nativeOk,
    });
    expect(entry?.totalTokensVersion).toBe(
      hostCommitted || !nativeOk ? SESSION_TOTAL_TOKENS_VERSION : undefined,
    );
    expect(changes).toHaveLength(hostCommitted || nativeOk ? 1 : 0);
    if (hostCommitted || nativeOk) {
      expect(changes[0]?.[1]).toMatchObject({
        sessionKey: target.sessionKey,
        sessionId: "sess-codex",
        compacted: true,
        reason: "compact",
        session: { sessionId: "sess-codex" },
      });
    }
  },
);
