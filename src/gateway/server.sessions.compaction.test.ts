import fs from "node:fs/promises";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { closeGatewayTestWebSocket } from "../../test/helpers/gateway-websocket.js";
import type {
  CompactEmbeddedAgentSessionParams,
  QueuedCompactionHostOptions,
} from "../agents/embedded-agent-runner/compact.types.js";
import { acceptCompactionSuccessor } from "../agents/embedded-agent-runner/compaction-successor.js";
import { withSessionCompactionPersistenceAsync } from "../agents/sessions/session-compaction-persistence.js";
import { enqueueFollowupRun } from "../auto-reply/reply/queue.js";
import { createQueueTestRun } from "../auto-reply/reply/queue.test-helpers.js";
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
import { getGatewayContextResolver } from "../plugins/runtime/gateway-context-binding.js";
import {
  beginSessionEffect,
  isSessionControllerWorkActive,
} from "../sessions/session-controller.lifecycle.js";
import {
  getSessionStateVersion,
  listSessionStateEventsSince,
} from "../sessions/session-state-events.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { getGatewayRecoveryRuntime } from "./server-recovery-runtime-context.js";
import {
  isCompactOperationEvent,
  loadSessionEntry,
  seedTranscriptRows,
} from "./server.sessions.compaction-fixtures.test-support.js";
import { embeddedRunMock, onceMessage, agentDiscoveryMock, rpcReq } from "./test-helpers.js";
import { getTestPluginRegistry } from "./test-helpers.plugin-registry.js";
import { claimRpcSourceForTest, createRpcSourceForTest } from "./test-helpers.rpc-source.js";
import { testConfigRoot } from "./test-helpers.runtime-state.js";
import { holdCompaction } from "./test/server-sessions-compaction.test-helpers.js";
import {
  setupGatewaySessionsTestHarness,
  sessionStoreEntry,
  directSessionReq,
  expectNoSessionQueueCleanup,
} from "./test/server-sessions.test-helpers.js";
import { loseSessionSignalAcknowledgement } from "./test/session-signal-failure.test-support.js";
import { registerWorkerInferenceSessionControl } from "./worker-environments/inference-control-internal.js";
// Load after the fixture mocks, during collection rather than the first RPC deadline.
import "./server-methods/sessions-compact.js";

const { createSessionStoreDir, openClient } = setupGatewaySessionsTestHarness();

function expectMainCompactionResult(
  compacted: { ok?: boolean; payload?: { compacted?: boolean; key?: string } | null },
  expectedCompacted: boolean,
) {
  expect(compacted.ok, JSON.stringify(compacted)).toBe(true);
  expect(compacted.payload?.key).toBe("agent:main:main");
  expect(compacted.payload?.compacted, JSON.stringify(compacted)).toBe(expectedCompacted);
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
  await seedTranscriptRows({ ...scope, totalLines });
  return { ...scope, dir };
}

function getSuiteGatewayContextResolver() {
  const runtime = getGatewayRecoveryRuntime();
  const resolveGatewayContext = runtime && getGatewayContextResolver(runtime);
  if (!resolveGatewayContext) {
    throw new Error("Suite Gateway runtime is unavailable");
  }
  return resolveGatewayContext;
}

test("sessions.compact without maxLines runs embedded manual compaction without checkpoint metadata", async () => {
  const sessionScope = await createCompactionSession("sess-main", {
    totalLines: 1,
    entry: {
      spawnedCwd: "/tmp/task-repo",
      thinkingLevel: "medium",
      reasoningLevel: "stream",
      cliSessionIds: { "claude-cli": "claude-session", "codex-cli": "codex-session" },
      cliSessionBindings: {
        "claude-cli": { sessionId: "claude-session" },
        "codex-cli": { sessionId: "codex-session" },
      },
      claudeCliSessionId: "claude-session",
      inputTokens: 60,
      outputTokens: 10,
      cacheRead: 40,
      cacheWrite: 10,
      estimatedCostUsd: 0.02,
      contextBudgetStatus: contextBudgetStatusFixture(),
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
  embeddedRunMock.compactEmbeddedAgentSession.mockImplementationOnce(async (params, hostInput) => {
    const call = params as CompactEmbeddedAgentSessionParams;
    if (
      !call.sessionTarget?.agentId ||
      !call.sessionTarget.sessionId ||
      !call.sessionTarget.sessionKey ||
      !call.sessionTarget.storePath
    ) {
      throw new Error("expected SQLite session target");
    }
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
      result: {
        summary: "summary",
        firstKeptEntryId: "entry-1",
        tokensBefore: 120,
        tokensAfter: 80,
      },
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
  const endPayload = endEvent.payload as { operationId?: string };
  expect(startPayload).toMatchObject({
    operation: "compact",
    phase: "start",
    sessionKey: "agent:main:main",
    operationId: expect.any(String),
    ts: expect.any(Number),
  });
  expect(endPayload).toMatchObject({
    operation: "compact",
    phase: "end",
    sessionKey: "agent:main:main",
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
  for (const field of [
    "cliSessionBindings",
    "cliSessionIds",
    "claudeCliSessionId",
    "inputTokens",
    "outputTokens",
    "cacheRead",
    "cacheWrite",
    "estimatedCostUsd",
    "contextBudgetStatus",
  ] as const) {
    expect(storedEntry?.[field], field).toBeUndefined();
  }

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

  const { ws } = await openClient();
  try {
    const response = await rpcReq(ws, "sessions.compact", { key: "main" });

    expectMainCompactionResult(response, true);
    expect(response.payload).toMatchObject({ ok: true });
    expect(embeddedRunMock.compactEmbeddedAgentSession).toHaveBeenCalledTimes(1);
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
      sessionId: "gateway-compaction-successor",
      lifecycleRevision: "lifecycle",
      compactionCount: 1,
      totalTokens: 42,
    });
  } finally {
    ws.close();
  }
});

test("sessions.compact accounting clears the transcript-byte latch after a manual host rewrite", async () => {
  const sessionScope = await createCompactionSession("sess-latch", {
    totalLines: 3,
    entry: {
      transcriptByteCompactionLatch: {
        activeBytes: 60_000,
        sessionId: "sess-latch",
        maxBytes: 50_000,
      },
    },
  });
  embeddedRunMock.compactEmbeddedAgentSession.mockResolvedValueOnce({
    ok: true,
    compacted: true,
    compactionKind: "context-engine",
    result: {
      summary: "summary",
      firstKeptEntryId: "entry-1",
      sessionId: "sess-latch",
      tokensBefore: 120,
      tokensAfter: 80,
    },
  });

  const { ws } = await openClient();
  try {
    const response = await rpcReq(ws, "sessions.compact", { key: "main" });

    expectMainCompactionResult(response, true);
    const storedEntry = loadSessionEntry(sessionScope);
    expect(storedEntry).toMatchObject({ compactionCount: 1, totalTokens: 80 });
    expect(storedEntry?.transcriptByteCompactionLatch).toBeUndefined();
  } finally {
    ws.close();
  }
});

test("sessions.compact records terminal Codex native compaction with a stale negative estimate", async () => {
  const latch = { activeBytes: 60_000, sessionId: "sess-codex", maxBytes: 50_000 };
  const scope = await createCompactionSession("sess-codex", {
    totalLines: 2,
    entry: {
      agentHarnessId: "codex",
      modelSelectionLocked: true,
      compactionCount: 2,
      transcriptByteCompactionLatch: latch,
      totalTokens: 54_321,
      totalTokensFresh: true,
      totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
      cliSessionIds: { "codex-cli": "thread-1" },
      cliSessionBindings: { "codex-cli": { sessionId: "thread-1" } },
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
    compactionKind: "native-harness",
    result: {
      summary: "",
      firstKeptEntryId: "",
      tokensBefore: 54_321,
      tokensAfter: -1,
      details,
    },
  });

  const { ws } = await openClient();
  await rpcReq(ws, "sessions.subscribe", {});
  const endEventPromise = onceMessage(ws, (message) => isCompactOperationEvent(message, "end"));

  const compacted = await rpcReq(ws, "sessions.compact", { key: "main" });
  expectMainCompactionResult(compacted, true);
  expect(compacted.payload).toMatchObject({ result: { details } });
  const endEvent = await endEventPromise;
  expect(endEvent.payload).toMatchObject({
    operation: "compact",
    phase: "end",
    sessionKey: "agent:main:main",
    completed: true,
  });

  const codexEntry = loadSessionEntry(scope);
  expect(codexEntry).toMatchObject({
    compactionCount: 3,
    cliSessionIds: { "codex-cli": "thread-1" },
    cliSessionBindings: { "codex-cli": { sessionId: "thread-1" } },
    totalTokens: 54_321,
    totalTokensFresh: false,
  });
  expect(codexEntry?.totalTokensVersion).toBeUndefined();
  expect(codexEntry?.transcriptByteCompactionLatch).toEqual(latch);

  ws.close();
});

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
  const { ws } = await openClient();
  try {
    const compacted = await rpcReq(ws, "sessions.compact", { key: "main" });
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
  } finally {
    ws.close();
  }
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
  expect(response.ok).toBe(false);
  expect(response.error?.code).toBe("UNAVAILABLE");
  expect((await endEventPromise).payload).toMatchObject({
    operation: "compact",
    phase: "end",
    sessionKey: "agent:main:main",
    completed: false,
  });
  ws.close();
});

test("sessions.compact rejects stale terminal persistence after the session changes", async () => {
  const { storePath } = await createCompactionSession("sess-compact-old");
  const compaction = holdCompaction({
    ok: true,
    compacted: true,
    result: {
      summary: "summary",
      firstKeptEntryId: "entry-1",
      tokensBefore: 120,
      tokensAfter: 80,
      sessionId: "sess-compacted-successor",
    },
  });

  const { ws } = await openClient();
  const compactResult = rpcReq(ws, "sessions.compact", { key: "main" });
  try {
    await compaction.waitForEntry(compactResult);
    await upsertSessionEntryCore(
      { sessionKey: "agent:main:main", storePath },
      sessionStoreEntry("sess-replacement"),
    );
    compaction.release();

    const response = await compactResult;
    expect(response.ok).toBe(false);
    expect(response.error).toMatchObject({
      details: { reason: "session-changed" },
    });
    const replacedEntry = loadSessionEntry({ sessionKey: "agent:main:main", storePath });
    expect(replacedEntry?.sessionId).toBe("sess-replacement");
    expect(replacedEntry?.compactionCount).toBeUndefined();
  } finally {
    compaction.release();
    await Promise.allSettled([compactResult]);
    await closeGatewayTestWebSocket(ws);
  }
});

test("sessions.compact accounts from the latest entry without overwriting concurrent metadata", async () => {
  const scope = await createCompactionSession("sess-compact-metadata");
  const compaction = holdCompaction();
  const { ws } = await openClient();
  const compactResult = rpcReq(ws, "sessions.compact", { key: "main" });
  try {
    await compaction.waitForEntry(compactResult);
    await upsertSessionEntryCore(scope, {
      ...loadSessionEntry(scope),
      sessionId: scope.sessionId,
      compactionCount: 3,
      label: "changed during compaction",
    });
    compaction.release();
    expectMainCompactionResult(await compactResult, true);
    const entry = loadSessionEntry(scope);
    expect(entry?.label).toBe("changed during compaction");
    expect(entry?.compactionCount).toBe(4);
  } finally {
    compaction.release();
    await Promise.allSettled([compactResult]);
    await closeGatewayTestWebSocket(ws);
  }
});

test("sessions.reset waits for terminal compaction before replacing the session", async () => {
  const { storePath } = await createCompactionSession("sess-compact-reset");
  const compaction = holdCompaction();

  const { ws } = await openClient();
  const compactResult = rpcReq(ws, "sessions.compact", { key: "main" });
  let resetResult: ReturnType<typeof rpcReq<{ entry: { sessionId: string } }>> | undefined;
  try {
    await compaction.waitForEntry(compactResult);
    let resetSettled = false;
    resetResult = rpcReq<{ entry: { sessionId: string } }>(ws, "sessions.reset", {
      key: "main",
    }).finally(() => {
      resetSettled = true;
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(resetSettled).toBe(false);

    compaction.release();
    expect((await compactResult).ok).toBe(true);
    const reset = await resetResult;
    expect(reset.ok).toBe(true);
    const resetSessionId = reset.payload?.entry.sessionId;
    expect(resetSessionId).toBe("sess-compact-reset");
    const resetEntry = loadSessionEntry({ sessionKey: "agent:main:main", storePath });
    expect(resetEntry?.sessionId).toBe(resetSessionId);
  } finally {
    compaction.release();
    await Promise.allSettled([compactResult, resetResult]);
    await closeGatewayTestWebSocket(ws);
  }
});

test("sessions.compact blocks new work admission through terminal persistence", async () => {
  const { storePath, sessionId } = await createCompactionSession("sess-compact-admission");
  const compaction = holdCompaction();

  const { ws } = await openClient();
  const compactResult = rpcReq(ws, "sessions.compact", { key: "main" });
  let pendingAdmission: ReturnType<typeof beginSessionEffect> | undefined;
  try {
    await compaction.waitForEntry(compactResult);

    let admitted = false;
    pendingAdmission = beginSessionEffect({
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

test("sessions.compact returns a no-op without interrupting an active admission", async () => {
  const { storePath, sessionId } = await createCompactionSession("sess-compact-noop-active", {
    totalLines: 2,
  });

  let interrupted = false;
  const admission = await beginSessionEffect({
    scope: storePath,
    identities: ["main", "agent:main:main", sessionId],
    resolveGatewayContext: getSuiteGatewayContextResolver(),
    assertAllowed: () => {},
    onInterrupt: () => {
      interrupted = true;
    },
  });

  const { ws } = await openClient();
  try {
    const compacted = await rpcReq<{
      ok: boolean;
      compacted: boolean;
      reason?: string;
    }>(ws, "sessions.compact", { key: "main" });

    expect(compacted.ok).toBe(true);
    expect(compacted.payload).toMatchObject({
      ok: false,
      compacted: false,
      reason: "Nothing to compact (session too small)",
    });
    expect(interrupted).toBe(false);
    expect(isSessionControllerWorkActive(storePath, [sessionId])).toBe(true);
    expect(embeddedRunMock.compactEmbeddedAgentSession).not.toHaveBeenCalled();
    expectNoSessionQueueCleanup();
  } finally {
    admission.release();
    ws.close();
  }
});

test("sessions.compact refuses real compaction without interrupting an active admission", async () => {
  const { storePath, sessionId } = await createCompactionSession("sess-compact-queued-work");

  let interrupted = false;
  const admission = await beginSessionEffect({
    scope: storePath,
    identities: ["main", "agent:main:main", sessionId],
    resolveGatewayContext: getSuiteGatewayContextResolver(),
    assertAllowed: () => {},
    onInterrupt: () => {
      interrupted = true;
    },
  });

  const { ws } = await openClient();
  try {
    const compacted = await rpcReq(ws, "sessions.compact", { key: "main" });

    expect(compacted.ok).toBe(false);
    expect(compacted.error).toMatchObject({
      code: "INVALID_REQUEST",
      message: expect.stringContaining("has an active run"),
    });
    expect(interrupted).toBe(false);
    expect(isSessionControllerWorkActive(storePath, [sessionId])).toBe(true);
    expect(embeddedRunMock.compactEmbeddedAgentSession).not.toHaveBeenCalled();
    expectNoSessionQueueCleanup();
  } finally {
    admission.release();
    ws.close();
  }
});

test("sessions.compact preserves accepted queued follow-up work", async () => {
  const { sessionKey, sessionId, storePath } = await createCompactionSession(
    "sess-compact-followup-queue",
  );
  const queuedRun = createQueueTestRun({ prompt: "please also update the changelog" });
  queuedRun.run = {
    ...queuedRun.run,
    sessionKey,
    sessionId,
    agentId: "main",
    config: { session: { store: storePath } },
  };
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

  const { ws } = await openClient();
  try {
    const compacted = await rpcReq(ws, "sessions.compact", { key: "main" });

    expect(compacted.ok).toBe(true);
    expect(getExistingFollowupQueue(sessionKey)?.items).toHaveLength(1);
    expect(embeddedRunMock.compactEmbeddedAgentSession).toHaveBeenCalledOnce();
    expectNoSessionQueueCleanup();
  } finally {
    clearFollowupQueue(sessionKey);
    ws.close();
  }
});

test("sessions.compact preserves summary-elided queued follow-up work", async () => {
  const { sessionKey, sessionId, storePath } = await createCompactionSession(
    "sess-compact-elided-followup-queue",
  );
  for (const prompt of ["first queued task", "second queued task", "latest queued task"]) {
    const run = createQueueTestRun({ prompt });
    run.run = {
      ...run.run,
      sessionKey,
      sessionId,
      agentId: "main",
      config: { session: { store: storePath } },
    };
    expect(
      enqueueFollowupRun(
        sessionKey,
        run,
        { mode: "followup", cap: 1, dropPolicy: "summarize" },
        "none",
        undefined,
        false,
      ),
    ).toBe(true);
  }
  const queue = getExistingFollowupQueue(sessionKey)!;
  expect(queue.summaryElisions).toHaveLength(1);
  const elidedSource = queue.summaryElisions[0]!.sources[0]!;
  expect(elidedSource.controllerInput).toBeDefined();

  const { ws } = await openClient();
  try {
    const compacted = await rpcReq(ws, "sessions.compact", { key: "main" });

    expect(compacted.ok).toBe(true);
    expect(getExistingFollowupQueue(sessionKey)?.summaryElisions[0]?.sources).toContain(
      elidedSource,
    );
    expect(elidedSource.controllerInput?.retirementRequested).not.toBe(true);
    expect(embeddedRunMock.compactEmbeddedAgentSession).toHaveBeenCalledOnce();
    expectNoSessionQueueCleanup();
  } finally {
    clearFollowupQueue(sessionKey);
    ws.close();
  }
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

  expect(compacted.ok, JSON.stringify(compacted)).toBe(false);
  expect(compacted.error).toMatchObject({
    code: "INVALID_REQUEST",
    message: expect.stringContaining("has an active run"),
  });
  expect(hasSession).toHaveBeenCalledWith(sessionId);
  expect(embeddedRunMock.compactEmbeddedAgentSession).not.toHaveBeenCalled();
  expectNoSessionQueueCleanup();
});

test("sessions.patch waits for terminal compaction before archiving the session", async () => {
  const { sessionKey } = await createCompactionSession("sess-compact-archive", {
    sessionKey: "agent:main:dashboard:compact-race",
  });
  const compaction = holdCompaction();

  const { ws } = await openClient();
  const compactResult = rpcReq(ws, "sessions.compact", { key: sessionKey });
  let archiveResult: ReturnType<typeof rpcReq> | undefined;
  try {
    await compaction.waitForEntry(compactResult);
    let archiveSettled = false;
    archiveResult = rpcReq(ws, "sessions.patch", {
      key: sessionKey,
      archived: true,
      expectedSessionId: "sess-compact-archive",
    }).then((result) => {
      archiveSettled = true;
      return result;
    });
    await Promise.resolve();
    expect(archiveSettled).toBe(false);

    compaction.release();
    expect((await compactResult).ok).toBe(true);
    expect((await archiveResult).ok).toBe(true);
  } finally {
    compaction.release();
    await Promise.allSettled([compactResult, archiveResult]);
    await closeGatewayTestWebSocket(ws);
  }
});

test("sessions.compact maxLines trims SQLite transcript rows without creating a transcript archive", async () => {
  const scope = await createCompactionSession("sess-main", {
    totalLines: 5,
    entry: {
      cliSessionIds: { "claude-cli": "claude-session", "codex-cli": "codex-session" },
      cliSessionBindings: {
        "claude-cli": { sessionId: "claude-session" },
        "codex-cli": { sessionId: "codex-session" },
      },
      claudeCliSessionId: "claude-session",
    },
  });
  const { ws } = await openClient();
  const signalVersion = await getSessionStateVersion(scope.sessionKey, "main");
  const signal = loseSessionSignalAcknowledgement();
  const compacted = await rpcReq(ws, "sessions.compact", { key: "main", maxLines: 3 }).finally(
    signal.restore,
  );
  expectMainCompactionResult(compacted, true);
  expect(signal.attempts()).toBe(1);
  expect(compacted.payload?.kept).toBe(3);

  const retained = await loadTranscriptEvents(scope);
  expect(retained).toHaveLength(3);
  expect(retained[0]).toMatchObject({ type: "session", id: "sess-main" });
  expect(retained[1]).toMatchObject({
    parentId: null,
    message: { content: "line-2" },
  });
  expect(retained.at(-1)).toMatchObject({
    message: { content: "line-3" },
  });
  expect(compacted.payload).not.toHaveProperty("archived");
  const files = await fs.readdir(scope.dir);
  expect(files.some((name) => name.includes(".jsonl.bak."))).toBe(false);
  expect(files).not.toContain("sess-main.jsonl");
  const trimmedEntry = loadSessionEntry(scope);
  expect(trimmedEntry?.cliSessionIds).toBeUndefined();
  expect(trimmedEntry?.cliSessionBindings).toBeUndefined();
  expect(trimmedEntry?.claudeCliSessionId).toBeUndefined();

  expect(embeddedRunMock.abortCalls).toEqual([]);
  expect(embeddedRunMock.waitCalls).toEqual([]);

  expect(
    (await listSessionStateEventsSince(scope.sessionKey, "main", signalVersion)).events,
  ).toMatchObject([{ kind: "compacted", sessionId: scope.sessionId }]);

  ws.close();
});

test("sessions.compact maxLines refuses an active run without trimming rows", async () => {
  const scope = await createCompactionSession("sess-main", { totalLines: 5 });

  const { ws } = await openClient();
  const runId = "manual-trim-active-run";
  registerAgentRunContext(runId, {
    agentId: "main",
    sessionId: "sess-main",
    sessionKey: "agent:main:main",
    projectSessionActive: true,
  });
  try {
    const compacted = await rpcReq(ws, "sessions.compact", { key: "main", maxLines: 3 });

    expect(compacted.ok).toBe(false);
    expect(compacted.error?.message).toContain("has an active run");
    expect(embeddedRunMock.abortCalls).toEqual([]);
    expect(embeddedRunMock.waitCalls).toEqual([]);
    await expect(loadTranscriptEvents(scope)).resolves.toHaveLength(5);
    expect((await fs.readdir(scope.dir)).some((name) => name.includes(".bak"))).toBe(false);
  } finally {
    clearAgentRunContext(runId);
    ws.close();
  }
});

test("sessions.compact maxLines does not interrupt an active run when row trimming is a no-op", async () => {
  const scope = await createCompactionSession("sess-main", { totalLines: 2 });
  const source = createRpcSourceForTest({}, { ...scope, storeScope: scope.storePath });
  const release = await claimRpcSourceForTest(source);
  const operation = source.input.claim!.operation!;
  const { ws } = await openClient();
  try {
    const compacted = await rpcReq(ws, "sessions.compact", { key: "main", maxLines: 3 });

    expect(compacted.ok).toBe(true);
    expect(compacted.payload?.compacted).toBe(false);
    expect(compacted.payload?.kept).toBe(2);
    expect(operation.abortSignal.aborted).toBe(false);
    expect(isSessionControllerWorkActive(scope.storePath, [scope.sessionId])).toBe(true);
    expect(embeddedRunMock.abortCalls).toEqual([]);
    expect(embeddedRunMock.waitCalls).toEqual([]);
  } finally {
    release();
    ws.close();
  }
});

test("sessions.compact maxLines does not interrupt an active run when no transcript exists", async () => {
  const scope = await createCompactionSession("sess-main", { totalLines: 0 });
  const source = createRpcSourceForTest({}, { ...scope, storeScope: scope.storePath });
  const release = await claimRpcSourceForTest(source);
  const operation = source.input.claim!.operation!;
  const { ws } = await openClient();
  try {
    const compacted = await rpcReq(ws, "sessions.compact", { key: "main", maxLines: 3 });

    expect(compacted.ok).toBe(true);
    expect(compacted.payload?.compacted).toBe(false);
    expect(compacted.payload?.reason).toBe("no transcript");
    expect(operation.abortSignal.aborted).toBe(false);
    expect(isSessionControllerWorkActive(scope.storePath, [scope.sessionId])).toBe(true);
    expect(embeddedRunMock.abortCalls).toEqual([]);
    expect(embeddedRunMock.waitCalls).toEqual([]);
  } finally {
    release();
    ws.close();
  }
});

test("sessions.patch preserves nested model ids under provider overrides", async () => {
  await withTestDir({ prefix: "openclaw-gw-sessions-nested-" }, async (dir) => {
    const storePath = path.join(dir, "sessions.json");
    const runtimeConfig = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-test-a" },
        },
        entries: { main: { workspace: dir } },
      },
      session: { mainKey: "main", store: storePath },
    };
    await upsertSessionEntryCore(
      { sessionKey: "agent:main:main", storePath },
      sessionStoreEntry("sess-main"),
    );

    agentDiscoveryMock.enabled = true;
    agentDiscoveryMock.models = [
      { id: "moonshotai/kimi-k2.6", name: "Kimi K2.6 (NVIDIA)", provider: "nvidia" },
    ];

    const context = { getRuntimeConfig: () => runtimeConfig };
    const patched = await directSessionReq<{
      entry: {
        modelOverride?: string;
        providerOverride?: string;
        model?: string;
        modelProvider?: string;
      };
      resolved?: { model?: string; modelProvider?: string };
    }>(
      "sessions.patch",
      {
        key: "agent:main:main",
        model: "nvidia/moonshotai/kimi-k2.6",
      },
      { context },
    );
    expect(patched.ok).toBe(true);
    expect(patched.payload?.entry.modelOverride).toBe("moonshotai/kimi-k2.6");
    expect(patched.payload?.entry.providerOverride).toBe("nvidia");
    expect(patched.payload?.entry.model).toBeUndefined();
    expect(patched.payload?.entry.modelProvider).toBeUndefined();
    expect(patched.payload?.resolved?.modelProvider).toBe("nvidia");
    expect(patched.payload?.resolved?.model).toBe("moonshotai/kimi-k2.6");

    const listed = await directSessionReq<{
      sessions: Array<{ key: string; modelProvider?: string; model?: string }>;
    }>("sessions.list", {}, { context });
    expect(listed.ok).toBe(true);
    const mainSession = listed.payload?.sessions.find(
      (session) => session.key === "agent:main:main",
    );
    expect(mainSession?.modelProvider).toBe("nvidia");
    expect(mainSession?.model).toBe("moonshotai/kimi-k2.6");
  });
});
