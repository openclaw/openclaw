import fs from "node:fs/promises";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { closeGatewayTestWebSocket } from "../../test/helpers/gateway-websocket.js";
import type { QueuedCompactionHostOptions } from "../agents/embedded-agent-runner/compact.types.js";
import { acceptCompactionSuccessor } from "../agents/embedded-agent-runner/compaction-successor.js";
import { resolveEmbeddedSessionLane } from "../agents/embedded-agent-runner/lanes.js";
import { withSessionCompactionPersistenceAsync } from "../agents/sessions/session-compaction-persistence.js";
import { enqueueFollowupRun, type FollowupRun } from "../auto-reply/reply/queue.js";
import { clearFollowupQueue, getExistingFollowupQueue } from "../auto-reply/reply/queue/state.js";
import { SESSION_TOTAL_TOKENS_VERSION } from "../config/sessions.js";
import { contextBudgetStatusFixture } from "../config/sessions/context-budget.test-support.js";
import {
  appendTranscriptMessage,
  loadSessionEntry as loadAccessorSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import * as transcriptTargets from "../config/sessions/session-accessor.transcript-target.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { clearAgentRunContext, registerAgentRunContext } from "../infra/agent-run-registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import {
  enqueueCommandInLane,
  getCommandLaneSnapshot,
  setCommandLaneConcurrency,
} from "../process/command-queue.js";
import {
  beginSessionWorkAdmission,
  isSessionWorkAdmissionActive,
} from "../sessions/session-lifecycle-admission.js";
import {
  getSessionStateVersion,
  listSessionStateEventsSince,
} from "../sessions/session-state-events.js";
import { embeddedRunMock, onceMessage, agentDiscoveryMock, rpcReq } from "./test-helpers.js";
import { getTestPluginRegistry } from "./test-helpers.plugin-registry.js";
import { testConfigRoot } from "./test-helpers.runtime-state.js";
import { holdCompaction } from "./test/server-sessions-compaction.test-helpers.js";
import {
  setupGatewaySessionsTestHarness,
  sessionStoreEntry,
  directSessionReq,
  expectNoSessionQueueCleanup,
  seedSessionTranscript,
} from "./test/server-sessions.test-helpers.js";
import { loseSessionSignalAcknowledgement } from "./test/session-signal-failure.test-support.js";
import { registerWorkerInferenceSessionControl } from "./worker-environments/inference-control-internal.js";
// Load after the fixture mocks, during collection rather than the first RPC deadline.
import "./server-methods/sessions-compact.js";

const { createSessionStoreDir, openClient } = setupGatewaySessionsTestHarness();

async function requestCompact(params: Record<string, unknown> = { key: "main" }) {
  const { ws } = await openClient();
  try {
    return await rpcReq(ws, "sessions.compact", params);
  } finally {
    await closeGatewayTestWebSocket(ws);
  }
}

function expectRejectedCompaction(
  response: { ok: boolean; error?: { code?: string; message?: string } },
  message: unknown,
) {
  expect(response).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST", message } });
  expect(embeddedRunMock.compactEmbeddedAgentSession).not.toHaveBeenCalled();
  expectNoSessionQueueCleanup();
}

const cliSessions = {
  cliSessionIds: { "claude-cli": "claude-session", "codex-cli": "codex-session" },
  cliSessionBindings: {
    "claude-cli": { sessionId: "claude-session" },
    "codex-cli": { sessionId: "codex-session" },
  },
  claudeCliSessionId: "claude-session",
};
const discardedUsage = {
  inputTokens: 60,
  outputTokens: 10,
  cacheRead: 40,
  cacheWrite: 10,
  estimatedCostUsd: 0.02,
  contextBudgetStatus: contextBudgetStatusFixture(),
};
const summary = {
  summary: "summary",
  firstKeptEntryId: "entry-1",
  tokensBefore: 120,
  tokensAfter: 80,
};

function isCompactOperationEvent(message: unknown, phase: "start" | "end") {
  const candidate = message as {
    event?: unknown;
    payload?: { operation?: unknown; phase?: unknown };
    type?: unknown;
  };
  return (
    candidate.type === "event" &&
    candidate.event === "session.operation" &&
    candidate.payload?.operation === "compact" &&
    candidate.payload?.phase === phase
  );
}

function expectOperation(
  payload: unknown,
  phase: "start" | "end",
  fields: Record<string, unknown>,
) {
  expect(payload).toMatchObject({
    operation: "compact",
    phase,
    sessionKey: "agent:main:main",
    ...fields,
  });
}

function expectMainCompactionResult(
  compacted: { ok?: boolean; payload?: { compacted?: boolean; key?: string } | null },
  expectedCompacted: boolean,
) {
  expect(compacted.ok, JSON.stringify(compacted)).toBe(true);
  expect(compacted.payload?.key).toBe("agent:main:main");
  expect(compacted.payload?.compacted, JSON.stringify(compacted)).toBe(expectedCompacted);
}

function loadSessionEntry(scope: Parameters<typeof loadAccessorSessionEntry>[0]) {
  return loadAccessorSessionEntry({ ...scope, readConsistency: "latest" });
}

function expectCleared<K extends keyof InternalSessionEntry>(
  entry: InternalSessionEntry | undefined,
  fields: Pick<InternalSessionEntry, K>,
) {
  for (const field in fields) {
    expect(entry?.[field], field).toBeUndefined();
  }
}

async function createCompactionSession(
  sessionId = "sess-main",
  {
    totalLines = 3,
    entry = {},
    sessionKey = "agent:main:main",
  }: { totalLines?: number; entry?: Partial<InternalSessionEntry>; sessionKey?: string } = {},
) {
  const { dir, storePath } = await createSessionStoreDir();
  const scope = {
    agentId: "main",
    sessionId,
    sessionKey,
    storePath,
  };
  await upsertSessionEntryCore(scope, sessionStoreEntry(sessionId, entry));
  if (totalLines > 0) {
    await seedSessionTranscript({
      ...scope,
      messages: Array.from({ length: totalLines - 1 }, (_, index) => ({
        role: "user",
        content: `line-${index}`,
        timestamp: index,
      })),
    });
  }
  return { ...scope, dir };
}

test("sessions.compact without maxLines runs embedded manual compaction without checkpoint metadata", async () => {
  const sessionScope = await createCompactionSession("sess-main", {
    totalLines: 1,
    entry: {
      spawnedCwd: "/tmp/task-repo",
      thinkingLevel: "medium",
      reasoningLevel: "stream",
      ...cliSessions,
      ...discardedUsage,
    },
  });
  const seedMessage = await appendTranscriptMessage(sessionScope, {
    message: { role: "user", content: "hello", timestamp: 1 },
    now: Date.parse("2026-06-19T12:00:01.000Z"),
  });
  await appendTranscriptMessage(sessionScope, {
    message: { role: "user", content: "follow-up", timestamp: 2 },
    now: Date.parse("2026-06-19T12:00:02.000Z"),
  });
  embeddedRunMock.compactEmbeddedAgentSession.mockImplementationOnce(async (_params, hostInput) => {
    const host = hostInput as QueuedCompactionHostOptions;
    const manager = host.preparedSession?.sessionManager;
    if (!manager || !host.withCompactionPersistenceAsync) {
      throw new Error("expected prepared Gateway compaction persistence");
    }
    expect(manager.getEntries()).toHaveLength(2);
    await withSessionCompactionPersistenceAsync(manager, host.withCompactionPersistenceAsync, () =>
      manager.appendCompactionAsync(
        "summary",
        seedMessage.messageId,
        120,
        undefined,
        undefined,
        undefined,
        80,
      ),
    );
    expect(loadSessionEntry(sessionScope)).toMatchObject({ compactionCount: 1, totalTokens: 80 });
    return {
      ok: true,
      compacted: true,
      compactionKind: "context-engine",
      result: summary,
    };
  });

  const { ws } = await openClient();
  await rpcReq(ws, "sessions.subscribe", {});
  const signalVersion = await getSessionStateVersion(sessionScope.sessionKey, "main");
  const signal = loseSessionSignalAcknowledgement();
  using resolveTarget = vi.spyOn(transcriptTargets, "resolveSessionTranscriptRuntimeTarget");
  const [startEvent, endEvent, compacted] = await Promise.all([
    onceMessage(ws, (message) => isCompactOperationEvent(message, "start")),
    onceMessage(ws, (message) => isCompactOperationEvent(message, "end")),
    rpcReq(ws, "sessions.compact", { key: "main" }),
  ]).finally(signal.restore);

  expectMainCompactionResult(compacted, true);
  expect(resolveTarget).not.toHaveBeenCalled();
  expect(signal.attempts()).toBe(1);
  expect(
    (await listSessionStateEventsSince(sessionScope.sessionKey, "main", signalVersion)).events,
  ).toMatchObject([{ kind: "compacted", sessionId: sessionScope.sessionId }]);
  const startPayload = startEvent.payload as { operationId?: string };
  expectOperation(startPayload, "start", {
    operationId: expect.any(String),
    ts: expect.any(Number),
  });
  expectOperation(endEvent.payload, "end", {
    completed: true,
    operationId: startPayload.operationId,
    ts: expect.any(Number),
  });
  expect(startPayload.operationId).toBeTruthy();
  expect(embeddedRunMock.compactEmbeddedAgentSession).toHaveBeenCalledTimes(1);
  expect(embeddedRunMock.compactEmbeddedAgentSession.mock.calls[0]?.[0]).toMatchObject({
    sessionId: "sess-main",
    runId: startPayload.operationId,
    sessionKey: "agent:main:main",
    sessionFile: "agent:main:main",
    sessionTarget: {
      agentId: "main",
      sessionId: "sess-main",
      sessionKey: "agent:main:main",
      storePath: sessionScope.storePath,
    },
    workspaceDir: "/tmp/task-repo",
    cwd: "/tmp/task-repo",
    config: {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-6" },
          workspace: path.join(testConfigRoot.value, "workspace"),
        },
      },
    },
    provider: "anthropic",
    model: "claude-opus-4-6",
    allowGatewaySubagentBinding: true,
    agentHarnessId: undefined,
    thinkLevel: "medium",
    reasoningLevel: "stream",
    bashElevated: { enabled: false, allowed: false, defaultLevel: "off" },
    trigger: "manual",
  });

  const sqliteRows = await loadTranscriptEvents(sessionScope);
  expect(sqliteRows).toHaveLength(4);
  expect(sqliteRows.at(-1)).toMatchObject({
    type: "compaction",
    summary: "summary",
  });
  await expect(fs.readdir(sessionScope.dir)).resolves.not.toContain("sess-main.jsonl");
  const storedEntry = loadAccessorSessionEntry(sessionScope);
  expect(storedEntry).toMatchObject({
    compactionCount: 1,
    totalTokens: 80,
    totalTokensFresh: true,
  });
  expect(storedEntry).not.toHaveProperty("compactionCheckpoints");
  expectCleared(storedEntry, { ...cliSessions, ...discardedUsage });

  ws.close();
});

test("sessions.compact accounts against the host-accepted successor before returning", async () => {
  const { sessionId, sessionKey, storePath } = await createCompactionSession(
    "gateway-compaction-predecessor",
    { entry: { lifecycleRevision: "lifecycle" } },
  );
  embeddedRunMock.compactEmbeddedAgentSession.mockImplementationOnce(async (_input, hostInput) => {
    const entry = loadSessionEntry({ sessionKey, storePath });
    if (!entry) {
      throw new Error("expected gateway predecessor");
    }
    const host = hostInput as QueuedCompactionHostOptions;
    await acceptCompactionSuccessor({
      currentTarget: { agentId: "main", sessionId, sessionKey, storePath },
      expectedEntry: {
        sessionId,
        lifecycleRevision: entry.lifecycleRevision,
        activeWriterRunId: entry.activeWriterRunId,
      },
      assertActive: () => {},
      result: {
        ok: true,
        compacted: true,
        result: { sessionId: "gateway-compaction-successor", tokensBefore: 120 },
      },
      onCommitted: host.onCommitted,
    });
    return {
      ok: true,
      compacted: true,
      compactionKind: "context-engine",
      result: { sessionId: "gateway-compaction-successor", tokensAfter: 42 },
    };
  });

  const response = await requestCompact();

  expectMainCompactionResult(response, true);
  expect(response.payload).toMatchObject({ ok: true });
  expect(embeddedRunMock.compactEmbeddedAgentSession).toHaveBeenCalledTimes(1);
  expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
    sessionId: "gateway-compaction-successor",
    lifecycleRevision: "lifecycle",
    compactionCount: 1,
    totalTokens: 42,
  });
});

test.each([false, true])(
  "sessions.compact accounts for terminal results (native: %s)",
  async (native) => {
    const sessionId = native ? "sess-codex" : "sess-latch";
    const latch = { activeBytes: 60_000, sessionId, maxBytes: 50_000 };
    const nativeBindings = {
      cliSessionIds: { "codex-cli": "thread-1" },
      cliSessionBindings: { "codex-cli": { sessionId: "thread-1" } },
    };
    const scope = await createCompactionSession(sessionId, {
      totalLines: native ? 2 : 3,
      entry: {
        transcriptByteCompactionLatch: latch,
        ...(native
          ? {
              agentHarnessId: "codex",
              modelSelectionLocked: true,
              compactionCount: 2,
              totalTokens: 54_321,
              totalTokensFresh: true,
              totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
              ...nativeBindings,
            }
          : {}),
      },
    });
    const details = {
      backend: "codex-app-server",
      threadId: "thread-1",
      signal: "thread/compact/start",
      pending: false,
      completed: true,
    };
    embeddedRunMock.compactEmbeddedAgentSession.mockResolvedValueOnce({
      ok: true,
      compacted: true,
      compactionKind: native ? "native-harness" : "context-engine",
      result: native
        ? { summary: "", firstKeptEntryId: "", tokensBefore: 54_321, tokensAfter: -1, details }
        : { ...summary, sessionId },
    });
    const { ws } = await openClient();
    try {
      if (native) {
        await rpcReq(ws, "sessions.subscribe", {});
      }
      const end = native
        ? onceMessage(ws, (message) => isCompactOperationEvent(message, "end"))
        : undefined;
      const compacted = await rpcReq(ws, "sessions.compact", { key: "main" });
      expectMainCompactionResult(compacted, true);
      const stored = loadSessionEntry(scope);
      expect(stored).toMatchObject({
        compactionCount: native ? 3 : 1,
        totalTokens: native ? 54_321 : 80,
      });
      if (native) {
        expect(compacted.payload).toMatchObject({ result: { details } });
        expectOperation((await end)?.payload, "end", { completed: true });
        expect(stored).toMatchObject({ ...nativeBindings, totalTokensFresh: false });
        expect(stored?.totalTokensVersion).toBeUndefined();
        expect(stored?.transcriptByteCompactionLatch).toEqual(latch);
      } else {
        expect(stored?.transcriptByteCompactionLatch).toBeUndefined();
      }
    } finally {
      ws.close();
    }
  },
);

test("sessions.compact targets the persisted native CLI session", async () => {
  const pluginRegistry = getTestPluginRegistry();
  pluginRegistry.cliBackends.push({
    pluginId: "anthropic",
    source: "test",
    backend: {
      id: "claude-cli",
      modelProvider: "anthropic",
      config: { command: "claude" },
      bundleMcp: false,
    },
  });
  setActivePluginRegistry(pluginRegistry);
  await createCompactionSession("sess-claude", {
    totalLines: 2,
    entry: {
      providerOverride: "anthropic",
      modelOverride: "claude-opus-4-6",
      cliSessionBindings: {
        "claude-cli": { sessionId: "native-claude-session" },
      },
    },
  });
  embeddedRunMock.compactEmbeddedAgentSession.mockResolvedValueOnce({
    ok: true,
    compacted: true,
  });
  const compacted = await requestCompact();
  expectMainCompactionResult(compacted, true);
  expect(embeddedRunMock.compactEmbeddedAgentSession).toHaveBeenCalledWith(
    expect.objectContaining({
      agentHarnessId: "claude-cli",
      cliSessionBinding: expect.objectContaining({ sessionId: "native-claude-session" }),
      cliSessionId: "native-claude-session",
      trigger: "manual",
    }),
    expect.objectContaining({ onCommitted: expect.any(Function) }),
  );
});

test("sessions.compact emits a terminal operation event when persistence fails", async () => {
  await createCompactionSession("sess-compact-write-failure");
  const compaction = holdCompaction({
    ok: true,
    compacted: true,
    result: {
      summary: "summary",
      firstKeptEntryId: "entry-1",
      tokensBefore: 120,
      get tokensAfter(): number {
        throw new Error("forced persistence projection failure");
      },
    },
  });
  const { ws } = await openClient();
  await rpcReq(ws, "sessions.subscribe", {});
  const endEventPromise = onceMessage(ws, (message) => isCompactOperationEvent(message, "end"));
  const compactResult = rpcReq(ws, "sessions.compact", { key: "main" });
  await compaction.waitForEntry(compactResult);
  compaction.release();

  const response = await compactResult;
  expect(response).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
  expectOperation((await endEventPromise).payload, "end", { completed: false });
  ws.close();
});

test.each(["replacement", "metadata"] as const)(
  "sessions.compact respects concurrent %s changes at terminal persistence",
  async (change) => {
    const scope = await createCompactionSession("sess-compact-old");
    const replaced = change === "replacement";
    const compaction = holdCompaction(
      replaced
        ? {
            ok: true,
            compacted: true,
            result: { ...summary, sessionId: "sess-compacted-successor" },
          }
        : undefined,
    );
    const { ws } = await openClient();
    const compactResult = rpcReq(ws, "sessions.compact", { key: "main" });
    try {
      await compaction.waitForEntry(compactResult);
      await upsertSessionEntryCore(
        scope,
        replaced
          ? sessionStoreEntry("sess-replacement")
          : {
              ...loadSessionEntry(scope),
              sessionId: scope.sessionId,
              compactionCount: 3,
              label: "changed during compaction",
            },
      );
      compaction.release();
      const response = await compactResult;
      const entry = loadSessionEntry(scope);
      if (replaced) {
        expect(response).toMatchObject({
          ok: false,
          error: { details: { reason: "session-changed" } },
        });
        expect(entry?.sessionId).toBe("sess-replacement");
        expect(entry?.compactionCount).toBeUndefined();
      } else {
        expectMainCompactionResult(response, true);
        expect(entry).toMatchObject({ label: "changed during compaction", compactionCount: 4 });
      }
    } finally {
      compaction.release();
      await Promise.allSettled([compactResult]);
      await closeGatewayTestWebSocket(ws);
    }
  },
);

test.each(["reset", "archive"] as const)(
  "sessions.%s waits for terminal compaction",
  async (operation) => {
    const resetting = operation === "reset";
    const scope = await createCompactionSession("sess-compact-race", {
      sessionKey: resetting ? "agent:main:main" : "agent:main:dashboard:compact-race",
    });
    const compaction = holdCompaction();
    const { ws } = await openClient();
    const compactResult = rpcReq(ws, "sessions.compact", {
      key: resetting ? "main" : scope.sessionKey,
    });
    let mutation: ReturnType<typeof rpcReq<{ entry: { sessionId: string } }>> | undefined;
    try {
      await compaction.waitForEntry(compactResult);
      let settled = false;
      mutation = rpcReq<{ entry: { sessionId: string } }>(
        ws,
        resetting ? "sessions.reset" : "sessions.patch",
        {
          key: resetting ? "main" : scope.sessionKey,
          ...(!resetting ? { archived: true, expectedSessionId: scope.sessionId } : {}),
        },
      ).finally(() => {
        settled = true;
      });
      await (resetting
        ? new Promise<void>((resolve) => {
            setImmediate(resolve);
          })
        : Promise.resolve());
      expect(settled).toBe(false);
      compaction.release();
      expect((await compactResult).ok).toBe(true);
      const result = await mutation;
      expect(result.ok).toBe(true);
      if (resetting) {
        expect(result.payload?.entry.sessionId).toBe(scope.sessionId);
        expect(loadSessionEntry(scope)?.sessionId).toBe(result.payload?.entry.sessionId);
      }
    } finally {
      compaction.release();
      await Promise.allSettled([compactResult, mutation]);
      await closeGatewayTestWebSocket(ws);
    }
  },
);

test("sessions.compact blocks new work admission through terminal persistence", async () => {
  const { storePath, sessionId } = await createCompactionSession("sess-compact-admission");
  const compaction = holdCompaction();

  const { ws } = await openClient();
  const compactResult = rpcReq(ws, "sessions.compact", { key: "main" });
  let pendingAdmission: ReturnType<typeof beginSessionWorkAdmission> | undefined;
  try {
    await compaction.waitForEntry(compactResult);

    let admitted = false;
    pendingAdmission = beginSessionWorkAdmission({
      scope: storePath,
      identities: ["agent:main:main", sessionId],
      assertAllowed: () => {},
    }).then((lease) => {
      admitted = true;
      return lease;
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(admitted).toBe(false);

    compaction.release();
    expect((await compactResult).ok).toBe(true);
    await pendingAdmission;
    expect(admitted).toBe(true);
  } finally {
    compaction.release();
    await Promise.allSettled([
      compactResult,
      pendingAdmission?.then((admission) => admission.release()),
    ]);
    await closeGatewayTestWebSocket(ws);
  }
});

test.each([2, 3])(
  "sessions.compact preserves an active admission with %i transcript rows",
  async (totalLines) => {
    const scope = await createCompactionSession("sess-compact-admission", { totalLines });
    let interrupted = false;
    const admission = await beginSessionWorkAdmission({
      scope: scope.storePath,
      identities: ["main", scope.sessionKey, scope.sessionId],
      assertAllowed: () => {},
      onInterrupt: () => {
        interrupted = true;
      },
    });
    try {
      const compacted = await requestCompact();
      if (totalLines === 2) {
        expect(compacted).toMatchObject({
          ok: true,
          payload: {
            ok: false,
            compacted: false,
            reason: "Nothing to compact (session too small)",
          },
        });
        expect(embeddedRunMock.compactEmbeddedAgentSession).not.toHaveBeenCalled();
        expectNoSessionQueueCleanup();
      } else {
        expectRejectedCompaction(compacted, expect.stringContaining("has an active run"));
      }
      expect(interrupted).toBe(false);
      expect(isSessionWorkAdmissionActive(scope.storePath, [scope.sessionId])).toBe(true);
    } finally {
      admission.release();
    }
  },
);

test("sessions.compact preserves accepted queued follow-up work", async () => {
  const { sessionKey } = await createCompactionSession("sess-compact-followup-queue");
  const queuedRun = {
    prompt: "please also update the changelog",
    enqueuedAt: Date.now(),
    run: {},
  } as unknown as FollowupRun;
  expect(
    enqueueFollowupRun(
      sessionKey,
      queuedRun,
      { mode: "followup", debounceMs: 60_000 },
      "none",
      undefined,
      false,
    ),
  ).toBe(true);

  try {
    const compacted = await requestCompact();

    expectRejectedCompaction(compacted, "Session main has queued work; retry after it finishes.");
    expect(getExistingFollowupQueue(sessionKey)?.items).toHaveLength(1);
  } finally {
    clearFollowupQueue(sessionKey);
  }
});

test("sessions.compact preserves accepted command-lane work", async () => {
  const { sessionKey } = await createCompactionSession("sess-compact-command-queue");
  const lane = resolveEmbeddedSessionLane(sessionKey);
  setCommandLaneConcurrency(lane, 0);
  let commandRan = false;
  const queuedCommand = enqueueCommandInLane(lane, async () => {
    commandRan = true;
  });

  try {
    expect(getCommandLaneSnapshot(lane)).toMatchObject({
      activeCount: 0,
      queuedCount: 1,
    });

    const compacted = await requestCompact();

    expectRejectedCompaction(compacted, "Session main has queued work; retry after it finishes.");
    expect(getCommandLaneSnapshot(lane).queuedCount).toBe(1);
    expect(commandRan).toBe(false);
  } finally {
    setCommandLaneConcurrency(lane, 1);
    await queuedCommand;
  }
  expect(commandRan).toBe(true);
});

test("sessions.compact refuses real compaction while a worker inference owns the session", async () => {
  const { storePath, sessionId } = await createCompactionSession("sess-compact-worker-inference");
  const hasSession = vi.fn((candidateSessionId: string) => candidateSessionId === sessionId);
  const workerEnvironmentService = {};
  registerWorkerInferenceSessionControl(workerEnvironmentService, {
    hasSession,
    reserveSessionDrain: () => {
      throw new Error("Compaction must reject active inference before draining");
    },
    captureSessionCancellation: () => ({ runIds: [], cancel: async () => [] }),
    resolveSessionTargetForRunId: () => undefined,
  });
  const runtimeConfig = {
    agents: { entries: { main: {} } },
    session: { store: storePath },
  };

  const compacted = await directSessionReq(
    "sessions.compact",
    { key: "main" },
    {
      context: {
        getRuntimeConfig: () => runtimeConfig,
        workerEnvironmentService,
      },
    },
  );

  expectRejectedCompaction(compacted, expect.stringContaining("has an active run"));
  expect(hasSession).toHaveBeenCalledWith(sessionId);
});

test("sessions.compact maxLines trims SQLite transcript rows without creating a transcript archive", async () => {
  const scope = await createCompactionSession("sess-main", {
    totalLines: 5,
    entry: cliSessions,
  });
  const signalVersion = await getSessionStateVersion(scope.sessionKey, "main");
  const signal = loseSessionSignalAcknowledgement();
  const compacted = await requestCompact({ key: "main", maxLines: 3 }).finally(signal.restore);
  expectMainCompactionResult(compacted, true);
  expect(signal.attempts()).toBe(1);
  expect(compacted.payload?.kept).toBe(3);

  const retained = await loadTranscriptEvents(scope);
  expect(retained).toMatchObject([
    { type: "session", id: "sess-main" },
    { parentId: null, message: { content: "line-2" } },
    { message: { content: "line-3" } },
  ]);
  expect(compacted.payload).not.toHaveProperty("archived");
  const files = await fs.readdir(scope.dir);
  expect(files.some((name) => name.includes(".jsonl.bak."))).toBe(false);
  expect(files).not.toContain("sess-main.jsonl");
  const trimmedEntry = loadSessionEntry(scope);
  expectCleared(trimmedEntry, cliSessions);

  expect(embeddedRunMock.abortCalls).toEqual([]);
  expect(embeddedRunMock.waitCalls).toEqual([]);

  expect(
    (await listSessionStateEventsSince(scope.sessionKey, "main", signalVersion)).events,
  ).toMatchObject([{ kind: "compacted", sessionId: scope.sessionId }]);
});

test("sessions.compact maxLines refuses an active run without trimming rows", async () => {
  const scope = await createCompactionSession("sess-main", { totalLines: 5 });

  const runId = "manual-trim-active-run";
  registerAgentRunContext(runId, {
    agentId: "main",
    sessionId: "sess-main",
    sessionKey: "agent:main:main",
    projectSessionActive: true,
  });
  try {
    const compacted = await requestCompact({ key: "main", maxLines: 3 });

    expect(compacted.ok).toBe(false);
    expect(compacted.error?.message).toContain("has an active run");
    expect(embeddedRunMock.abortCalls).toEqual([]);
    expect(embeddedRunMock.waitCalls).toEqual([]);
    await expect(loadTranscriptEvents(scope)).resolves.toHaveLength(5);
    expect((await fs.readdir(scope.dir)).some((name) => name.includes(".bak"))).toBe(false);
  } finally {
    clearAgentRunContext(runId);
  }
});

test.each([0, 2])(
  "sessions.compact maxLines preserves active runs with %i transcript rows",
  async (totalLines) => {
    await createCompactionSession("sess-main", { totalLines });
    embeddedRunMock.activeIds.add("sess-main");
    embeddedRunMock.waitResults.set("sess-main", true);
    const compacted = await requestCompact({ key: "main", maxLines: 3 });
    expect(compacted).toMatchObject({
      ok: true,
      payload: {
        compacted: false,
        ...(totalLines ? { kept: 2 } : { reason: "no transcript" }),
      },
    });
    expect(embeddedRunMock.abortCalls).toEqual([]);
    expect(embeddedRunMock.waitCalls).toEqual([]);
  },
);

test("sessions.patch preserves nested model ids under provider overrides", async () => {
  const { dir, storePath } = await createCompactionSession("sess-main", { totalLines: 0 });
  const context = {
    getRuntimeConfig: () => ({
      agents: {
        defaults: { model: { primary: "openai/gpt-test-a" } },
        entries: { main: { workspace: dir } },
      },
      session: { mainKey: "main", store: storePath },
    }),
  };
  const selection = { modelProvider: "nvidia", model: "moonshotai/kimi-k2.6" };
  agentDiscoveryMock.enabled = true;
  agentDiscoveryMock.models = [
    { id: selection.model, name: "Kimi K2.6 (NVIDIA)", provider: "nvidia" },
  ];
  const patched = await directSessionReq<{
    entry: InternalSessionEntry;
    resolved: typeof selection;
  }>(
    "sessions.patch",
    { key: "agent:main:main", model: "nvidia/moonshotai/kimi-k2.6" },
    { context },
  );
  expect(patched).toMatchObject({
    ok: true,
    payload: {
      entry: { modelOverride: selection.model, providerOverride: "nvidia" },
      resolved: selection,
    },
  });
  expect(patched.payload?.entry.model).toBeUndefined();
  expect(patched.payload?.entry.modelProvider).toBeUndefined();
  const listed = await directSessionReq<{ sessions: Array<typeof selection & { key: string }> }>(
    "sessions.list",
    {},
    { context },
  );
  expect(listed.ok).toBe(true);
  expect(
    listed.payload?.sessions.find((session) => session.key === "agent:main:main"),
  ).toMatchObject(selection);
});
