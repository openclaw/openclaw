import fs from "node:fs/promises";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { closeGatewayTestWebSocket } from "../../test/helpers/gateway-websocket.js";
import type { QueuedCompactionHostOptions } from "../agents/embedded-agent-runner/compact.queued-execution.js";
import type { CompactEmbeddedAgentSessionParams } from "../agents/embedded-agent-runner/compact.types.js";
import { acceptCompactionSuccessor } from "../agents/embedded-agent-runner/compaction-successor.js";
import { resolveEmbeddedSessionLane } from "../agents/embedded-agent-runner/lanes.js";
import { enqueueFollowupRun, type FollowupRun } from "../auto-reply/reply/queue.js";
import { clearFollowupQueue, getExistingFollowupQueue } from "../auto-reply/reply/queue/state.js";
import { SESSION_TOTAL_TOKENS_VERSION, type SessionEntry } from "../config/sessions.js";
import { contextBudgetStatusFixture } from "../config/sessions/context-budget.test-support.js";
import {
  appendTranscriptMessage,
  appendTranscriptEvent,
  loadSessionEntry as loadAccessorSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
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
import { withTestDir } from "../test-helpers/temp-dir.js";
import { embeddedRunMock, onceMessage, agentDiscoveryMock, rpcReq } from "./test-helpers.js";
import { getTestPluginRegistry } from "./test-helpers.plugin-registry.js";
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

const { createSessionStoreDir, openClient } = setupGatewaySessionsTestHarness();

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

async function createCompactionSession(
  sessionId = "sess-main",
  {
    totalLines = 3,
    entry = {},
    sessionKey = "agent:main:main",
  }: { totalLines?: number; entry?: Partial<SessionEntry>; sessionKey?: string } = {},
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
    await appendTranscriptEvent(scope, {
      type: "session",
      version: 3,
      id: sessionId,
      timestamp: "2026-06-19T12:00:00.000Z",
      cwd: "/tmp",
    });
  }
  for (let index = 0; index < totalLines - 1; index += 1) {
    await appendTranscriptMessage(scope, {
      cwd: "/tmp",
      message: { role: "user", content: `line-${index}`, timestamp: index },
      now: Date.parse(`2026-06-19T12:00:${String(index % 60).padStart(2, "0")}.000Z`),
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
  embeddedRunMock.compactEmbeddedAgentSession.mockImplementationOnce(async (params) => {
    const call = params as CompactEmbeddedAgentSessionParams;
    if (
      !call.sessionTarget?.agentId ||
      !call.sessionTarget.sessionId ||
      !call.sessionTarget.sessionKey ||
      !call.sessionTarget.storePath
    ) {
      throw new Error("expected SQLite session target");
    }
    const targetScope = {
      agentId: call.sessionTarget.agentId,
      sessionId: call.sessionTarget.sessionId,
      sessionKey: call.sessionTarget.sessionKey,
      storePath: call.sessionTarget.storePath,
    };
    const rows = await loadTranscriptEvents(targetScope);
    expect(rows).toHaveLength(3);
    await appendTranscriptEvent(targetScope, {
      type: "compaction",
      id: "compact-1",
      parentId: seedMessage.messageId,
      timestamp: "2026-06-19T12:00:02.000Z",
      summary: "summary",
      firstKeptEntryId: seedMessage.messageId,
      tokensBefore: 120,
      tokensAfter: 80,
    });
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
  // Prepare the lazy handler before arming the RPC and event observers.
  await import("./server-methods/sessions-compact.js");
  await rpcReq(ws, "sessions.subscribe", {});
  const signalVersion = await getSessionStateVersion(sessionScope.sessionKey, "main");
  const signal = loseSessionSignalAcknowledgement();
  const [startEvent, endEvent, compacted] = await Promise.all([
    onceMessage(ws, (message) => isCompactOperationEvent(message, "start")),
    onceMessage(ws, (message) => isCompactOperationEvent(message, "end")),
    rpcReq(ws, "sessions.compact", { key: "main" }),
  ]).finally(signal.restore);

  expectMainCompactionResult(compacted, true);
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

test("sessions.compact keeps prior usage stale when the compactor returns a negative estimate", async () => {
  const scope = await createCompactionSession("sess-invalid-compaction-usage", {
    entry: {
      compactionCount: 2,
      totalTokens: 54_321,
      totalTokensFresh: true,
      totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
    },
  });
  embeddedRunMock.compactEmbeddedAgentSession.mockResolvedValueOnce({
    ok: true,
    compacted: true,
    compactionKind: "context-engine",
    result: { summary: "summary", firstKeptEntryId: "entry-1", tokensAfter: -1 },
  });

  const { ws } = await openClient();
  try {
    const compacted = await rpcReq(ws, "sessions.compact", { key: "main" });

    expectMainCompactionResult(compacted, true);
    const entry = loadSessionEntry(scope);
    expect(entry).toMatchObject({
      compactionCount: 3,
      totalTokens: 54_321,
      totalTokensFresh: false,
    });
    expect(entry?.totalTokensVersion).toBeUndefined();
  } finally {
    ws.close();
  }
});

test("sessions.compact records terminal Codex native compaction", async () => {
  const scope = await createCompactionSession("sess-codex", {
    totalLines: 2,
    entry: {
      agentHarnessId: "codex",
      modelSelectionLocked: true,
      compactionCount: 2,
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

test("sessions.compact returns a no-op without interrupting an active admission", async () => {
  const { storePath, sessionId } = await createCompactionSession("sess-compact-noop-active", {
    totalLines: 2,
  });

  let interrupted = false;
  const admission = await beginSessionWorkAdmission({
    scope: storePath,
    identities: ["main", "agent:main:main", sessionId],
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
    expect(isSessionWorkAdmissionActive(storePath, [sessionId])).toBe(true);
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
  const admission = await beginSessionWorkAdmission({
    scope: storePath,
    identities: ["main", "agent:main:main", sessionId],
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
    expect(isSessionWorkAdmissionActive(storePath, [sessionId])).toBe(true);
    expect(embeddedRunMock.compactEmbeddedAgentSession).not.toHaveBeenCalled();
    expectNoSessionQueueCleanup();
  } finally {
    admission.release();
    ws.close();
  }
});

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

  const { ws } = await openClient();
  try {
    const compacted = await rpcReq(ws, "sessions.compact", { key: "main" });

    expect(compacted.ok).toBe(false);
    expect(compacted.error).toMatchObject({
      code: "INVALID_REQUEST",
      message: "Session main has queued work; retry after it finishes.",
    });
    expect(getExistingFollowupQueue(sessionKey)?.items).toHaveLength(1);
    expect(embeddedRunMock.compactEmbeddedAgentSession).not.toHaveBeenCalled();
    expectNoSessionQueueCleanup();
  } finally {
    clearFollowupQueue(sessionKey);
    ws.close();
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

  const { ws } = await openClient();
  try {
    expect(getCommandLaneSnapshot(lane)).toMatchObject({
      activeCount: 0,
      queuedCount: 1,
    });

    const compacted = await rpcReq(ws, "sessions.compact", { key: "main" });

    expect(compacted.ok).toBe(false);
    expect(compacted.error).toMatchObject({
      code: "INVALID_REQUEST",
      message: "Session main has queued work; retry after it finishes.",
    });
    expect(getCommandLaneSnapshot(lane).queuedCount).toBe(1);
    expect(commandRan).toBe(false);
    expect(embeddedRunMock.compactEmbeddedAgentSession).not.toHaveBeenCalled();
    expectNoSessionQueueCleanup();
  } finally {
    setCommandLaneConcurrency(lane, 1);
    await queuedCommand;
    ws.close();
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
    agents: { list: [{ id: "main", default: true }] },
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
  await createCompactionSession("sess-main", { totalLines: 2 });

  const { ws } = await openClient();
  embeddedRunMock.activeIds.add("sess-main");
  embeddedRunMock.waitResults.set("sess-main", true);

  const compacted = await rpcReq(ws, "sessions.compact", { key: "main", maxLines: 3 });

  expect(compacted.ok).toBe(true);
  expect(compacted.payload?.compacted).toBe(false);
  expect(compacted.payload?.kept).toBe(2);
  expect(embeddedRunMock.abortCalls).toEqual([]);
  expect(embeddedRunMock.waitCalls).toEqual([]);

  ws.close();
});

test("sessions.compact maxLines does not interrupt an active run when no transcript exists", async () => {
  await createCompactionSession("sess-main", { totalLines: 0 });

  const { ws } = await openClient();
  embeddedRunMock.activeIds.add("sess-main");
  embeddedRunMock.waitResults.set("sess-main", true);

  const compacted = await rpcReq(ws, "sessions.compact", { key: "main", maxLines: 3 });

  expect(compacted.ok).toBe(true);
  expect(compacted.payload?.compacted).toBe(false);
  expect(compacted.payload?.reason).toBe("no transcript");
  expect(embeddedRunMock.abortCalls).toEqual([]);
  expect(embeddedRunMock.waitCalls).toEqual([]);

  ws.close();
});

test("sessions.patch preserves nested model ids under provider overrides", async () => {
  await withTestDir({ prefix: "openclaw-gw-sessions-nested-" }, async (dir) => {
    const storePath = path.join(dir, "sessions.json");
    const runtimeConfig = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-test-a" },
        },
        list: [{ id: "main", default: true, workspace: dir }],
      },
      session: { mainKey: "main", store: storePath },
    };
    await upsertSessionEntryCore(
      { sessionKey: "agent:main:main", storePath },
      sessionStoreEntry("sess-main"),
    );

    agentDiscoveryMock.enabled = true;
    agentDiscoveryMock.models = [
      { id: "moonshotai/kimi-k2.5", name: "Kimi K2.5 (NVIDIA)", provider: "nvidia" },
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
        model: "nvidia/moonshotai/kimi-k2.5",
      },
      { context },
    );
    expect(patched.ok).toBe(true);
    expect(patched.payload?.entry.modelOverride).toBe("moonshotai/kimi-k2.5");
    expect(patched.payload?.entry.providerOverride).toBe("nvidia");
    expect(patched.payload?.entry.model).toBeUndefined();
    expect(patched.payload?.entry.modelProvider).toBeUndefined();
    expect(patched.payload?.resolved?.modelProvider).toBe("nvidia");
    expect(patched.payload?.resolved?.model).toBe("moonshotai/kimi-k2.5");

    const listed = await directSessionReq<{
      sessions: Array<{ key: string; modelProvider?: string; model?: string }>;
    }>("sessions.list", {}, { context });
    expect(listed.ok).toBe(true);
    const mainSession = listed.payload?.sessions.find(
      (session) => session.key === "agent:main:main",
    );
    expect(mainSession?.modelProvider).toBe("nvidia");
    expect(mainSession?.model).toBe("moonshotai/kimi-k2.5");
  });
});
