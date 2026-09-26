/**
 * Gateway session compaction RPC tests.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { closeGatewayTestWebSocket } from "../../test/helpers/gateway-websocket.js";
import { createDeferred } from "../../test/helpers/promise.js";
import type { QueuedCompactionHostOptions } from "../agents/embedded-agent-runner/compact.queued-execution.js";
import { acceptCompactionSuccessor } from "../agents/embedded-agent-runner/compaction-successor.js";
import { resolveEmbeddedSessionLane } from "../agents/embedded-agent-runner/lanes.js";
import { resolveSessionModelRef } from "../agents/session-model-ref.js";
import { resolveManualCompactionCliTarget } from "../agents/session-runtime-compat.js";
import { enqueueFollowupRun, type FollowupRun } from "../auto-reply/reply/queue.js";
import {
  clearFollowupQueue,
  getExistingFollowupQueue,
  getFollowupQueue,
} from "../auto-reply/reply/queue/state.js";
import { SESSION_TOTAL_TOKENS_VERSION } from "../config/sessions.js";
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
import { withTestDir } from "../test-helpers/temp-dir.js";
import { embeddedRunMock, onceMessage, agentDiscoveryMock, rpcReq } from "./test-helpers.js";
import { getTestPluginRegistry } from "./test-helpers.plugin-registry.js";
import { testConfigRoot } from "./test-helpers.runtime-state.js";
import {
  holdCompaction,
  seedTranscriptRows,
  loadTranscriptRows,
} from "./test/server-sessions-compaction.test-helpers.js";
import {
  setupGatewaySessionsTestHarness,
  getGatewayConfigModule,
  sessionStoreEntry,
  directSessionReq,
  expectNoSessionQueueCleanup,
} from "./test/server-sessions.test-helpers.js";

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

async function seedSessionEntry(params: {
  agentId?: string;
  entry: ReturnType<typeof sessionStoreEntry>;
  sessionKey: string;
  storePath: string;
}): Promise<void> {
  await upsertSessionEntryCore(
    {
      ...(params.agentId ? { agentId: params.agentId } : {}),
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    },
    params.entry,
  );
}

function loadSessionEntry(params: {
  agentId?: string;
  sessionKey: string;
  storePath: string;
}): ReturnType<typeof loadAccessorSessionEntry> {
  return loadAccessorSessionEntry({
    ...(params.agentId ? { agentId: params.agentId } : {}),
    readConsistency: "latest",
    sessionKey: params.sessionKey,
    storePath: params.storePath,
  });
}

test("sessions.compact without maxLines runs embedded manual compaction without checkpoint metadata", async () => {
  const { dir, storePath } = await createSessionStoreDir();
  const sessionScope = {
    agentId: "main",
    sessionId: "sess-main",
    sessionKey: "agent:main:main",
    storePath,
  };
  await upsertSessionEntryCore(sessionScope, {
    ...sessionStoreEntry("sess-main", {
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
      contextBudgetStatus: {
        schemaVersion: 1,
        source: "pre-prompt-estimate",
        updatedAt: Date.now() - 5_000,
        provider: "anthropic",
        model: "claude-opus-4-6",
        route: "fits",
        shouldCompact: false,
        estimatedPromptTokens: 120,
        contextTokenBudget: 200,
        promptBudgetBeforeReserve: 180,
        reserveTokens: 20,
        effectiveReserveTokens: 20,
        remainingPromptBudgetTokens: 60,
        overflowTokens: 0,
        toolResultReducibleChars: 0,
        messageCount: 2,
        unwindowedMessageCount: 2,
      },
    }),
  });
  await appendTranscriptEvent(sessionScope, {
    type: "session",
    version: 3,
    id: "sess-main",
    timestamp: "2026-06-19T12:00:00.000Z",
    cwd: "/tmp",
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
    const call = params as {
      sessionTarget?: {
        agentId?: string;
        sessionId?: string;
        sessionKey?: string;
        storePath?: string;
      };
    };
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
  const [startEvent, endEvent, compacted] = await Promise.all([
    onceMessage(ws, (message) => isCompactOperationEvent(message, "start")),
    onceMessage(ws, (message) => isCompactOperationEvent(message, "end")),
    rpcReq(ws, "sessions.compact", { key: "main" }),
  ]);

  expectMainCompactionResult(compacted, true);
  const startPayload = startEvent.payload as {
    operationId?: string;
    sessionKey?: string;
    ts?: number;
  };
  const endPayload = endEvent.payload as {
    operationId?: string;
    sessionKey?: string;
    completed?: boolean;
    ts?: number;
  };
  expect(startPayload).toMatchObject({
    operation: "compact",
    phase: "start",
    sessionKey: "agent:main:main",
  });
  expect(endPayload).toMatchObject({
    operation: "compact",
    phase: "end",
    sessionKey: "agent:main:main",
    completed: true,
  });
  expect(startPayload.operationId).toBeTruthy();
  expect(endPayload.operationId).toBe(startPayload.operationId);
  expect(typeof startPayload.ts).toBe("number");
  expect(typeof endPayload.ts).toBe("number");
  expect(embeddedRunMock.compactEmbeddedAgentSession).toHaveBeenCalledTimes(1);
  const compactionCall = embeddedRunMock.compactEmbeddedAgentSession.mock.calls.at(0)?.[0] as
    | {
        agentHarnessId?: string;
        allowGatewaySubagentBinding?: boolean;
        bashElevated?: unknown;
        config?: unknown;
        model?: string;
        provider?: string;
        reasoningLevel?: string;
        runId?: string;
        sessionFile?: string;
        sessionId?: string;
        sessionKey?: string;
        sessionTarget?: {
          agentId?: string;
          sessionId?: string;
          sessionKey?: string;
          storePath?: string;
        };
        thinkLevel?: string;
        trigger?: string;
        workspaceDir?: string;
        cwd?: string;
      }
    | undefined;
  if (!compactionCall) {
    throw new Error("expected embedded compaction call");
  }
  const callConfig = compactionCall.config as {
    agents?: { defaults?: { model?: { primary?: unknown }; workspace?: unknown } };
  };
  expect(compactionCall.sessionId).toBe("sess-main");
  expect(compactionCall.runId).toBe(startPayload.operationId);
  expect(compactionCall.sessionKey).toBe("agent:main:main");
  if (!compactionCall.sessionFile) {
    throw new Error("expected embedded compaction session file");
  }
  expect(compactionCall.sessionFile).toBe("agent:main:main");
  expect(compactionCall.sessionTarget).toEqual({
    agentId: "main",
    sessionId: "sess-main",
    sessionKey: "agent:main:main",
    storePath,
  });
  expect(compactionCall.workspaceDir).toBe("/tmp/task-repo");
  expect(compactionCall.cwd).toBe("/tmp/task-repo");
  expect(callConfig.agents?.defaults?.model?.primary).toBe("anthropic/claude-opus-4-6");
  expect(callConfig.agents?.defaults?.workspace).toBe(path.join(testConfigRoot.value, "workspace"));
  expect(compactionCall.provider).toBe("anthropic");
  expect(compactionCall.model).toBe("claude-opus-4-6");
  expect(compactionCall.allowGatewaySubagentBinding).toBe(true);
  expect(compactionCall.agentHarnessId).toBeUndefined();
  expect(compactionCall.thinkLevel).toBe("medium");
  expect(compactionCall.reasoningLevel).toBe("stream");
  expect(compactionCall.bashElevated).toEqual({
    enabled: false,
    allowed: false,
    defaultLevel: "off",
  });
  expect(compactionCall.trigger).toBe("manual");

  const sqliteRows = await loadTranscriptEvents(sessionScope);
  expect(sqliteRows).toHaveLength(4);
  expect(sqliteRows.at(-1)).toMatchObject({
    type: "compaction",
    summary: "summary",
  });
  await expect(fs.readdir(dir)).resolves.not.toContain("sess-main.jsonl");
  const storedEntry = loadAccessorSessionEntry(sessionScope) as
    | {
        compactionCount?: number;
        cliSessionBindings?: unknown;
        cliSessionIds?: unknown;
        claudeCliSessionId?: string;
        inputTokens?: number;
        outputTokens?: number;
        cacheRead?: number;
        cacheWrite?: number;
        estimatedCostUsd?: number;
        contextBudgetStatus?: unknown;
        totalTokens?: number;
        totalTokensFresh?: boolean;
      }
    | undefined;
  expect(storedEntry?.compactionCount).toBe(1);
  expect(storedEntry).not.toHaveProperty("compactionCheckpoints");
  expect(storedEntry?.cliSessionBindings).toBeUndefined();
  expect(storedEntry?.cliSessionIds).toBeUndefined();
  expect(storedEntry?.claudeCliSessionId).toBeUndefined();
  expect(storedEntry?.inputTokens).toBeUndefined();
  expect(storedEntry?.outputTokens).toBeUndefined();
  expect(storedEntry?.cacheRead).toBeUndefined();
  expect(storedEntry?.cacheWrite).toBeUndefined();
  expect(storedEntry?.estimatedCostUsd).toBeUndefined();
  expect(storedEntry?.contextBudgetStatus).toBeUndefined();
  expect(storedEntry?.totalTokens).toBe(80);
  expect(storedEntry?.totalTokensFresh).toBe(true);

  ws.close();
});

test("sessions.compact accounts against the host-accepted successor before returning", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:main";
  const sessionId = "gateway-compaction-predecessor";
  await seedSessionEntry({
    entry: sessionStoreEntry(sessionId, { lifecycleRevision: "lifecycle" }),
    sessionKey,
    storePath,
  });
  await seedTranscriptRows({ sessionId, sessionKey, storePath, totalLines: 3 });
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

    expect(response.ok, JSON.stringify(response)).toBe(true);
    expect(response.payload, JSON.stringify(response)).toMatchObject({
      ok: true,
      key: sessionKey,
      compacted: true,
    });
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
  const { storePath } = await createSessionStoreDir();
  const sessionId = "sess-invalid-compaction-usage";
  const sessionKey = "agent:main:main";
  await seedSessionEntry({
    entry: sessionStoreEntry(sessionId, {
      compactionCount: 2,
      totalTokens: 54_321,
      totalTokensFresh: true,
      totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
    }),
    sessionKey,
    storePath,
  });
  await seedTranscriptRows({ sessionId, sessionKey, storePath, totalLines: 3 });
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
    const entry = loadSessionEntry({ sessionKey, storePath });
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
  const { storePath } = await createSessionStoreDir();
  await seedSessionEntry({
    entry: sessionStoreEntry("sess-claude", {
      providerOverride: "anthropic",
      modelOverride: "claude-opus-4-6",
      cliSessionBindings: {
        "claude-cli": { sessionId: "native-claude-session" },
      },
    }),
    sessionKey: "agent:main:main",
    storePath,
  });
  await seedTranscriptRows({
    sessionId: "sess-claude",
    sessionKey: "agent:main:main",
    storePath,
    totalLines: 2,
  });
  embeddedRunMock.compactEmbeddedAgentSession.mockResolvedValueOnce({
    ok: true,
    compacted: true,
  });
  const storedEntry = loadAccessorSessionEntry({
    sessionKey: "agent:main:main",
    storePath,
  });
  const cfg = (await getGatewayConfigModule()).loadConfig();
  const selectedModel = resolveSessionModelRef(cfg, storedEntry, "main");
  expect(selectedModel.provider).toBe("anthropic");
  expect(storedEntry).toMatchObject({
    cliSessionBindings: {
      "claude-cli": { sessionId: "native-claude-session" },
    },
  });
  expect(
    resolveManualCompactionCliTarget({ provider: selectedModel.provider, entry: storedEntry, cfg }),
  ).toMatchObject({
    agentHarnessId: "claude-cli",
    cliSessionBinding: { sessionId: "native-claude-session" },
    cliSessionId: "native-claude-session",
  });

  const { ws } = await openClient();
  try {
    await rpcReq(ws, "sessions.subscribe", {});
    const compacted = await rpcReq<{ ok: true; key: string; compacted: boolean }>(
      ws,
      "sessions.compact",
      { key: "main" },
    );

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
  const { storePath } = await createSessionStoreDir();
  const sessionId = "sess-compact-write-failure";
  await seedSessionEntry({
    entry: sessionStoreEntry(sessionId),
    sessionKey: "agent:main:main",
    storePath,
  });
  await seedTranscriptRows({
    sessionId,
    sessionKey: "agent:main:main",
    storePath,
    totalLines: 3,
  });
  const compaction = createDeferred<{
    ok: true;
    compacted: true;
    result: {
      summary: string;
      firstKeptEntryId: string;
      tokensBefore: number;
      tokensAfter: number;
    };
  }>();
  embeddedRunMock.compactEmbeddedAgentSession.mockReturnValueOnce(compaction.promise);

  const { ws } = await openClient();
  await rpcReq(ws, "sessions.subscribe", {});
  const startEventPromise = onceMessage(ws, (message) => isCompactOperationEvent(message, "start"));
  const endEventPromise = onceMessage(ws, (message) => isCompactOperationEvent(message, "end"));
  const compactResult = rpcReq(ws, "sessions.compact", { key: "main" });
  await startEventPromise;
  const terminalResult = {
    ok: true as const,
    compacted: true as const,
    result: {
      summary: "summary",
      firstKeptEntryId: "entry-1",
      tokensBefore: 120,
      tokensAfter: 80,
    },
  };
  Object.defineProperty(terminalResult.result, "tokensAfter", {
    get: () => {
      throw new Error("forced persistence projection failure");
    },
  });
  compaction.resolve(terminalResult);

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
  const { storePath } = await createSessionStoreDir();
  await seedSessionEntry({
    entry: sessionStoreEntry("sess-compact-old"),
    sessionKey: "agent:main:main",
    storePath,
  });
  await seedTranscriptRows({
    sessionId: "sess-compact-old",
    sessionKey: "agent:main:main",
    storePath,
    totalLines: 3,
  });
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
    await seedSessionEntry({
      entry: sessionStoreEntry("sess-replacement"),
      sessionKey: "agent:main:main",
      storePath,
    });
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
  const { storePath } = await createSessionStoreDir();
  await seedSessionEntry({
    entry: sessionStoreEntry("sess-compact-reset"),
    sessionKey: "agent:main:main",
    storePath,
  });
  await seedTranscriptRows({
    sessionId: "sess-compact-reset",
    sessionKey: "agent:main:main",
    storePath,
    totalLines: 3,
  });
  const compaction = holdCompaction({
    ok: true,
    compacted: true,
    result: {
      summary: "summary",
      firstKeptEntryId: "entry-1",
      tokensBefore: 120,
      tokensAfter: 80,
    },
  });

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
  const { storePath } = await createSessionStoreDir();
  const sessionId = "sess-compact-admission";
  await seedSessionEntry({
    entry: sessionStoreEntry(sessionId),
    sessionKey: "agent:main:main",
    storePath,
  });
  await seedTranscriptRows({
    sessionId,
    sessionKey: "agent:main:main",
    storePath,
    totalLines: 3,
  });
  const compaction = holdCompaction({
    ok: true,
    compacted: true,
    result: {
      summary: "summary",
      firstKeptEntryId: "entry-1",
      tokensBefore: 120,
      tokensAfter: 80,
    },
  });

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
  const { storePath } = await createSessionStoreDir();
  const sessionId = "sess-compact-noop-active";
  await seedSessionEntry({
    entry: sessionStoreEntry(sessionId),
    sessionKey: "agent:main:main",
    storePath,
  });
  await seedTranscriptRows({
    sessionId,
    sessionKey: "agent:main:main",
    storePath,
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
  const { storePath } = await createSessionStoreDir();
  const sessionId = "sess-compact-queued-work";
  await seedSessionEntry({
    entry: sessionStoreEntry(sessionId),
    sessionKey: "agent:main:main",
    storePath,
  });
  await seedTranscriptRows({
    sessionId,
    sessionKey: "agent:main:main",
    storePath,
    totalLines: 3,
  });
  embeddedRunMock.compactEmbeddedAgentSession.mockResolvedValueOnce({
    ok: true,
    compacted: true,
    result: {
      summary: "summary",
      firstKeptEntryId: "entry-1",
      tokensBefore: 120,
      tokensAfter: 80,
    },
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
  const { storePath } = await createSessionStoreDir();
  const sessionId = "sess-compact-followup-queue";
  const sessionKey = "agent:main:main";
  await seedSessionEntry({
    entry: sessionStoreEntry(sessionId),
    sessionKey,
    storePath,
  });
  await seedTranscriptRows({
    sessionId,
    sessionKey,
    storePath,
    totalLines: 3,
  });
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

test.each([
  { name: "follow-up-backed", withFollowup: true },
  { name: "lane-only", withFollowup: false },
])("sessions.compact preserves accepted $name command-lane work", async ({ withFollowup }) => {
  const { storePath } = await createSessionStoreDir();
  const sessionId = "sess-compact-command-queue";
  const sessionKey = "agent:main:main";
  await seedSessionEntry({
    entry: sessionStoreEntry(sessionId),
    sessionKey,
    storePath,
  });
  await seedTranscriptRows({
    sessionId,
    sessionKey,
    storePath,
    totalLines: 3,
  });
  const lane = resolveEmbeddedSessionLane(sessionKey);
  const queuedRun = {
    prompt: "please also update the changelog",
    enqueuedAt: Date.now(),
    run: {},
  } as unknown as FollowupRun;
  if (withFollowup) {
    getFollowupQueue(sessionKey, { mode: "collect" }).inFlight.add(queuedRun);
  }
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
    expect(Boolean(getExistingFollowupQueue(sessionKey)?.inFlight.has(queuedRun))).toBe(
      withFollowup,
    );
    expect(getCommandLaneSnapshot(lane).queuedCount).toBe(1);
    expect(commandRan).toBe(false);
    expect(embeddedRunMock.compactEmbeddedAgentSession).not.toHaveBeenCalled();
    expectNoSessionQueueCleanup();
  } finally {
    clearFollowupQueue(sessionKey);
    setCommandLaneConcurrency(lane, 1);
    await queuedCommand;
    ws.close();
  }
  expect(commandRan).toBe(true);
});

test("sessions.compact preserves summary-elided queued follow-up work", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionId = "sess-compact-elided-followup-queue";
  const sessionKey = "agent:main:main";
  await seedSessionEntry({
    entry: sessionStoreEntry(sessionId),
    sessionKey,
    storePath,
  });
  await seedTranscriptRows({
    sessionId,
    sessionKey,
    storePath,
    totalLines: 3,
  });
  const queue = getFollowupQueue(sessionKey, { mode: "followup" });
  const elidedRun = {
    prompt: "please also update the changelog",
    enqueuedAt: Date.now(),
    run: {},
  } as unknown as FollowupRun;
  queue.droppedCount = 1;
  queue.summaryElisions.push({
    contextKey: "test",
    count: 1,
    sources: [elidedRun],
    summaryLines: ["elided summary"],
    sourceRefs: new WeakMap(),
  });

  const { ws } = await openClient();
  try {
    const compacted = await rpcReq(ws, "sessions.compact", { key: "main" });

    expect(compacted.ok).toBe(false);
    expect(compacted.error).toMatchObject({
      code: "INVALID_REQUEST",
      message: "Session main has queued work; retry after it finishes.",
    });
    expect(getExistingFollowupQueue(sessionKey)?.summaryElisions).toHaveLength(1);
    expect(embeddedRunMock.compactEmbeddedAgentSession).not.toHaveBeenCalled();
    expectNoSessionQueueCleanup();
  } finally {
    clearFollowupQueue(sessionKey);
    ws.close();
  }
});

test("sessions.compact refuses real compaction while a worker inference owns the session", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionId = "sess-compact-worker-inference";
  await seedSessionEntry({
    entry: sessionStoreEntry(sessionId),
    sessionKey: "agent:main:main",
    storePath,
  });
  await seedTranscriptRows({
    sessionId,
    sessionKey: "agent:main:main",
    storePath,
    totalLines: 3,
  });
  const hasInferenceForSession = vi.fn(
    (candidateSessionId: string) => candidateSessionId === sessionId,
  );
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
        workerEnvironmentService: { hasInferenceForSession },
      },
    },
  );

  expect(compacted.ok, JSON.stringify(compacted)).toBe(false);
  expect(compacted.error).toMatchObject({
    code: "INVALID_REQUEST",
    message: expect.stringContaining("has an active run"),
  });
  expect(hasInferenceForSession).toHaveBeenCalledWith(sessionId);
  expect(embeddedRunMock.compactEmbeddedAgentSession).not.toHaveBeenCalled();
  expectNoSessionQueueCleanup();
});

test("sessions.patch waits for terminal compaction before archiving the session", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:dashboard:compact-race";
  await seedSessionEntry({
    entry: sessionStoreEntry("sess-compact-archive"),
    sessionKey,
    storePath,
  });
  await seedTranscriptRows({
    sessionId: "sess-compact-archive",
    sessionKey,
    storePath,
    totalLines: 3,
  });
  const compaction = holdCompaction({
    ok: true,
    compacted: true,
    result: {
      summary: "summary",
      firstKeptEntryId: "entry-1",
      tokensBefore: 120,
      tokensAfter: 80,
    },
  });

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
  const { dir, storePath } = await createSessionStoreDir();
  await seedSessionEntry({
    entry: sessionStoreEntry("sess-main", {
      cliSessionIds: { "claude-cli": "claude-session", "codex-cli": "codex-session" },
      cliSessionBindings: {
        "claude-cli": { sessionId: "claude-session" },
        "codex-cli": { sessionId: "codex-session" },
      },
      claudeCliSessionId: "claude-session",
    }),
    sessionKey: "agent:main:main",
    storePath,
  });
  await seedTranscriptRows({
    sessionId: "sess-main",
    sessionKey: "agent:main:main",
    storePath,
    totalLines: 500,
  });
  const { ws } = await openClient();
  const compacted = await rpcReq<{
    ok: true;
    key: string;
    compacted: boolean;
    kept?: number;
  }>(ws, "sessions.compact", { key: "main", maxLines: 50 });

  expect(compacted.ok).toBe(true);
  expect(compacted.payload?.compacted).toBe(true);
  expect(compacted.payload?.kept).toBe(50);

  const retained = await loadTranscriptRows({
    sessionId: "sess-main",
    sessionKey: "agent:main:main",
    storePath,
  });
  expect(retained).toHaveLength(50);
  expect(retained[0]).toMatchObject({ type: "session", id: "sess-main" });
  expect(retained[1]).toMatchObject({
    parentId: null,
    message: { content: "line-450" },
  });
  expect(retained.at(-1)).toMatchObject({
    message: { content: "line-498" },
  });
  expect(compacted.payload).not.toHaveProperty("archived");
  expect((await fs.readdir(dir)).some((name) => name.includes(".jsonl.bak."))).toBe(false);
  await expect(fs.readdir(dir)).resolves.not.toContain("sess-main.jsonl");
  const trimmedEntry = loadSessionEntry({ sessionKey: "agent:main:main", storePath });
  expect(trimmedEntry?.cliSessionIds).toBeUndefined();
  expect(trimmedEntry?.cliSessionBindings).toBeUndefined();
  expect(trimmedEntry?.claudeCliSessionId).toBeUndefined();

  // No active run present, so the interrupt guard short-circuits without aborting.
  expect(embeddedRunMock.abortCalls).toEqual([]);
  expect(embeddedRunMock.waitCalls).toEqual([]);

  ws.close();
});

test("sessions.compact maxLines refuses an active run without trimming rows", async () => {
  const { dir, storePath } = await createSessionStoreDir();
  await seedSessionEntry({
    entry: sessionStoreEntry("sess-main"),
    sessionKey: "agent:main:main",
    storePath,
  });
  await seedTranscriptRows({
    sessionId: "sess-main",
    sessionKey: "agent:main:main",
    storePath,
    totalLines: 500,
  });

  const { ws } = await openClient();
  const runId = "manual-trim-active-run";
  registerAgentRunContext(runId, {
    agentId: "main",
    sessionId: "sess-main",
    sessionKey: "agent:main:main",
    projectSessionActive: true,
  });
  try {
    const compacted = await rpcReq(ws, "sessions.compact", { key: "main", maxLines: 50 });

    expect(compacted.ok).toBe(false);
    expect(compacted.error?.message).toContain("has an active run");
    expect(embeddedRunMock.abortCalls).toEqual([]);
    expect(embeddedRunMock.waitCalls).toEqual([]);
    await expect(
      loadTranscriptRows({
        sessionId: "sess-main",
        sessionKey: "agent:main:main",
        storePath,
      }),
    ).resolves.toHaveLength(500);
    expect((await fs.readdir(dir)).some((name) => name.includes(".bak"))).toBe(false);
  } finally {
    clearAgentRunContext(runId);
    ws.close();
  }
});

test("sessions.compact maxLines does not interrupt an active run when row trimming is a no-op", async () => {
  const { storePath } = await createSessionStoreDir();
  await seedSessionEntry({
    entry: sessionStoreEntry("sess-main"),
    sessionKey: "agent:main:main",
    storePath,
  });
  await seedTranscriptRows({
    sessionId: "sess-main",
    sessionKey: "agent:main:main",
    storePath,
    totalLines: 10,
  });

  const { ws } = await openClient();
  embeddedRunMock.activeIds.add("sess-main");
  embeddedRunMock.waitResults.set("sess-main", true);

  const compacted = await rpcReq<{
    ok: true;
    compacted: boolean;
    kept?: number;
  }>(ws, "sessions.compact", { key: "main", maxLines: 50 });

  expect(compacted.ok).toBe(true);
  expect(compacted.payload?.compacted).toBe(false);
  expect(compacted.payload?.kept).toBe(10);
  expect(embeddedRunMock.abortCalls).toEqual([]);
  expect(embeddedRunMock.waitCalls).toEqual([]);

  ws.close();
});

test("sessions.compact maxLines does not interrupt an active run when no transcript exists", async () => {
  const { storePath } = await createSessionStoreDir();
  await seedSessionEntry({
    entry: sessionStoreEntry("sess-main"),
    sessionKey: "agent:main:main",
    storePath,
  });

  const { ws } = await openClient();
  embeddedRunMock.activeIds.add("sess-main");
  embeddedRunMock.waitResults.set("sess-main", true);

  const compacted = await rpcReq<{
    ok: true;
    compacted: boolean;
    reason?: string;
  }>(ws, "sessions.compact", { key: "main", maxLines: 50 });

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
    await seedSessionEntry({
      entry: sessionStoreEntry("sess-main"),
      sessionKey: "agent:main:main",
      storePath,
    });

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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
