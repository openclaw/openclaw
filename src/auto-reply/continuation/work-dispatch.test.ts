import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const turnGrants: unknown[] = [];
const systemEvents: unknown[] = [];
const activeSessions = new Set<string>();
let mainQueueSize = 0;
let gatewayDraining = false;
let replyError: Error | undefined;
let drainAfterReply = false;
let replyPayloadOverride: unknown;
const mockSessionStore: Record<string, unknown> = {};

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: () => ({ session: { store: "test-store" } }),
}));

vi.mock("../../config/sessions/paths.js", () => ({
  resolveStorePath: () => "test-store",
}));

vi.mock("../../config/sessions/store-load.js", () => ({
  loadSessionStore: () => mockSessionStore,
}));

vi.mock("../../config/sessions/store-entry.js", () => ({
  resolveSessionStoreEntry: ({
    store,
    sessionKey,
  }: {
    store: Record<string, unknown>;
    sessionKey: string;
  }) => {
    const normalizedKey = sessionKey.trim();
    return {
      normalizedKey,
      existing: store[normalizedKey] ?? store[sessionKey],
      legacyKeys: normalizedKey === sessionKey ? [] : [sessionKey],
    };
  },
}));

vi.mock("../../sessions/session-key-utils.js", () => ({
  parseAgentSessionKey: (sessionKey: string) => {
    const match = /^agent:([^:]+)/.exec(sessionKey);
    return match ? { agentId: match[1] } : undefined;
  },
}));

vi.mock("../reply/reply-run-registry.js", () => ({
  replyRunRegistry: {
    isActive: (sessionKey: string) => activeSessions.has(sessionKey),
  },
}));

vi.mock("../../process/command-queue.js", () => ({
  getQueueSize: () => mainQueueSize,
  isGatewayDraining: () => gatewayDraining,
}));

vi.mock("../reply/get-reply.js", () => ({
  getReplyFromConfig: vi.fn(async (context: unknown, options: unknown, cfg: unknown) => {
    if (replyError) {
      throw replyError;
    }
    if (replyPayloadOverride !== undefined) {
      if (drainAfterReply) {
        gatewayDraining = true;
      }
      return replyPayloadOverride;
    }
    turnGrants.push({ context, options, cfg });
    if (drainAfterReply) {
      gatewayDraining = true;
    }
    return [{ text: "ok" }];
  }),
}));

vi.mock("../../infra/heartbeat-runner.js", () => {
  throw new Error("continuation_work dispatch must not use the heartbeat runner");
});

vi.mock("../../infra/heartbeat-wake.js", () => ({
  isRetryableHeartbeatBusySkipReason: (reason: string) => reason === "requests-in-flight",
}));

vi.mock("../../infra/system-events.js", () => ({
  enqueueSystemEvent: (text: string, options: unknown) => {
    systemEvents.push({ text, options });
  },
}));

vi.mock("../../infra/continuation-tracer.js", () => ({
  emitContinuationWorkFireSpan: vi.fn(),
  emitContinuationWorkSpan: vi.fn(),
}));

vi.mock("./config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./config.js")>();
  return {
    ...actual,
    resolveContinuationRuntimeConfig: () => ({
      enabled: true,
      maxChainLength: 8,
      maxDelegatesPerTurn: 4,
      defaultDelayMs: 1_000,
      minDelayMs: 1_000,
      maxDelayMs: 60_000,
      costCapTokens: 0,
      crossSessionTargeting: "enabled",
    }),
  };
});

vi.mock("../../logging/subsystem.js", () => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  };
  return { createSubsystemLogger: () => logger };
});

type MockFlow = {
  flowId: string;
  syncMode: "managed";
  ownerKey: string;
  controllerId: string;
  status: "queued" | "running" | "succeeded" | "failed";
  notifyPolicy: "silent";
  goal: string;
  currentStep?: string;
  stateJson?: unknown;
  revision: number;
  createdAt: number;
  updatedAt: number;
  endedAt?: number;
};

const mockFlows = new Map<string, MockFlow>();
let flowCounter = 0;

function cloneFlow(flow: MockFlow): MockFlow {
  return { ...flow };
}

vi.mock("../../tasks/task-flow-registry.js", () => ({
  createManagedTaskFlow: vi.fn((params: Partial<MockFlow> & { ownerKey: string }) => {
    const now = Date.now();
    const flow: MockFlow = {
      flowId: `flow-${++flowCounter}`,
      syncMode: "managed",
      ownerKey: params.ownerKey,
      controllerId: params.controllerId ?? "tests/controller",
      status: params.status ?? "queued",
      notifyPolicy: "silent",
      goal: params.goal ?? "goal",
      currentStep: params.currentStep,
      stateJson: params.stateJson,
      revision: 0,
      createdAt: params.createdAt ?? now,
      updatedAt: params.updatedAt ?? params.createdAt ?? now,
    };
    mockFlows.set(flow.flowId, flow);
    return cloneFlow(flow);
  }),
  listTaskFlowsForOwnerKey: vi.fn((ownerKey: string) =>
    Array.from(
      [...mockFlows.values()].filter((flow) => flow.ownerKey === ownerKey),
      cloneFlow,
    ),
  ),
  listTaskFlowRecords: vi.fn(() => Array.from(mockFlows.values(), cloneFlow)),
  getTaskFlowById: vi.fn((flowId: string) => {
    const flow = mockFlows.get(flowId);
    return flow ? cloneFlow(flow) : undefined;
  }),
  updateFlowRecordByIdExpectedRevision: vi.fn(
    (params: { flowId: string; expectedRevision: number; patch: Partial<MockFlow> }) => {
      const flow = mockFlows.get(params.flowId);
      if (!flow || flow.revision !== params.expectedRevision) {
        return { applied: false, reason: flow ? "revision_conflict" : "not_found" };
      }
      Object.assign(flow, params.patch, { revision: flow.revision + 1 });
      return { applied: true, flow: cloneFlow(flow) };
    },
  ),
  finishFlow: vi.fn(
    (params: {
      flowId: string;
      expectedRevision: number;
      currentStep?: string;
      stateJson?: unknown;
      updatedAt?: number;
      endedAt?: number;
    }) => {
      const flow = mockFlows.get(params.flowId);
      if (!flow || flow.revision !== params.expectedRevision) {
        return { applied: false, reason: flow ? "revision_conflict" : "not_found" };
      }
      const endedAt = params.endedAt ?? params.updatedAt ?? Date.now();
      flow.status = "succeeded";
      flow.currentStep = params.currentStep;
      flow.stateJson = params.stateJson ?? flow.stateJson;
      flow.updatedAt = params.updatedAt ?? endedAt;
      flow.endedAt = endedAt;
      flow.revision += 1;
      return { applied: true, flow: cloneFlow(flow) };
    },
  ),
  failFlow: vi.fn((params: { flowId: string }) => {
    const flow = mockFlows.get(params.flowId);
    if (flow) {
      flow.status = "failed";
      flow.revision += 1;
    }
    return { applied: Boolean(flow) };
  }),
  deleteTaskFlowRecordById: vi.fn((flowId: string) => {
    mockFlows.delete(flowId);
  }),
}));

import {
  deleteSubagentSessionForCleanup,
  resetSubagentSessionCleanupForTests,
} from "../../agents/subagent-session-cleanup.js";
import type { ContinuationRuntimeConfig } from "./types.js";
import {
  dispatchPendingContinuationWork,
  recoverPendingContinuationWork,
  resetContinuationWorkDispatchForTests,
  scheduleContinuationWork,
  scheduleContinuationWorkBatch,
} from "./work-dispatch.js";
import { enqueuePendingWork, hasLiveOrRecentlyDispatchedContinuationWork } from "./work-store.js";

const config = {
  enabled: true,
  maxChainLength: 8,
  maxDelegatesPerTurn: 4,
  defaultDelayMs: 1_000,
  minDelayMs: 1_000,
  maxDelayMs: 60_000,
  costCapTokens: 0,
  crossSessionTargeting: "enabled",
} satisfies ContinuationRuntimeConfig;

async function flushTimers(): Promise<void> {
  await vi.runOnlyPendingTimersAsync();
  await Promise.resolve();
}

describe("durable continuation_work dispatch", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_000_000 });
    turnGrants.length = 0;
    systemEvents.length = 0;
    activeSessions.clear();
    mainQueueSize = 0;
    gatewayDraining = false;
    replyError = undefined;
    drainAfterReply = false;
    replyPayloadOverride = undefined;
    for (const key of Object.keys(mockSessionStore)) {
      delete mockSessionStore[key];
    }
    mockFlows.clear();
    flowCounter = 0;
    resetContinuationWorkDispatchForTests();
    resetSubagentSessionCleanupForTests();
  });

  afterEach(() => {
    resetContinuationWorkDispatchForTests();
    resetSubagentSessionCleanupForTests();
    vi.useRealTimers();
  });

  it("retains a continue_delegate child session while its continue_work wake is pending", async () => {
    const childSessionKey = "agent:main:continuation-child";
    mockSessionStore[childSessionKey] = { sessionKey: childSessionKey };
    enqueuePendingWork({
      sessionKey: childSessionKey,
      hop: 2,
      delayMs: 1_000,
      electedAt: Date.now(),
      dueAt: Date.now() + 1_000,
      maxChainLength: 8,
      reason: "nested hop",
    });

    expect(hasLiveOrRecentlyDispatchedContinuationWork(childSessionKey)).toBe(true);

    const callGateway = vi.fn();
    await deleteSubagentSessionForCleanup({
      callGateway: callGateway as never,
      childSessionKey,
      spawnMode: "run",
    });
    expect(callGateway).not.toHaveBeenCalled();

    await dispatchPendingContinuationWork({ sessionKey: childSessionKey });
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.resolve();

    expect(turnGrants).toEqual([
      expect.objectContaining({
        context: expect.objectContaining({
          SessionKey: childSessionKey,
          Provider: "system",
          Body: expect.stringContaining("nested hop"),
        }),
        options: expect.objectContaining({ continuationTrigger: "work-wake" }),
      }),
    ]);

    expect(hasLiveOrRecentlyDispatchedContinuationWork(childSessionKey)).toBe(false);

    await vi.advanceTimersByTimeAsync(4_000);
    await Promise.resolve();

    expect(callGateway).toHaveBeenCalledWith({
      method: "sessions.delete",
      params: {
        key: childSessionKey,
        deleteTranscript: true,
        emitLifecycleHooks: false,
      },
      timeoutMs: 10_000,
    });
  });

  it("re-arms a delayed continue_work election after simulated gateway restart", async () => {
    const sessionKey = "agent:main:main";
    mockSessionStore[sessionKey] = { sessionKey };
    await scheduleContinuationWork({
      sessionKey,
      chainState: {
        currentChainCount: 0,
        chainStartedAt: Date.now(),
        accumulatedChainTokens: 12,
        chainId: "chain-1",
      },
      request: { delaySeconds: 1, reason: "restart proof" },
      config,
      parentRunId: "run-1",
    });
    expect(turnGrants).toHaveLength(0);

    resetContinuationWorkDispatchForTests();
    await recoverPendingContinuationWork();
    await vi.advanceTimersByTimeAsync(999);
    expect(turnGrants).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await flushTimers();

    expect(turnGrants).toEqual([
      expect.objectContaining({
        context: expect.objectContaining({
          SessionKey: sessionKey,
          Body: expect.stringContaining("restart proof"),
        }),
        options: expect.objectContaining({
          continuationTrigger: "work-wake",
          parentRunId: "run-1",
        }),
      }),
    ]);
    expect(systemEvents).toEqual([]);
  });

  it("resolves normalized session-store aliases before treating work as missing-session", async () => {
    const normalizedSessionKey = "agent:main:alias";
    const queuedSessionKey = `${normalizedSessionKey} `;
    mockSessionStore[normalizedSessionKey] = { sessionKey: normalizedSessionKey };
    enqueuePendingWork({
      sessionKey: queuedSessionKey,
      hop: 2,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "alias proof",
    });

    const result = await dispatchPendingContinuationWork({ sessionKey: queuedSessionKey });

    expect(result).toEqual({ dispatched: 1, failed: 0 });
    expect(turnGrants).toEqual([
      expect.objectContaining({
        context: expect.objectContaining({
          SessionKey: queuedSessionKey,
          Body: expect.stringContaining("alias proof"),
        }),
      }),
    ]);
  });

  it("requeues instead of losing a claimed continuation when the session is busy", async () => {
    const sessionKey = "agent:main:busy";
    mockSessionStore[sessionKey] = { sessionKey };
    activeSessions.add(sessionKey);
    enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "busy proof",
    });

    const result = await dispatchPendingContinuationWork({ sessionKey });

    expect(result).toEqual({ dispatched: 0, failed: 0 });
    const flow = [...mockFlows.values()][0];
    expect(flow).toMatchObject({ status: "queued" });
    expect(flow?.currentStep).toBe("Requeued same-session continuation wake");
    expect(systemEvents).toEqual([]);

    activeSessions.clear();
    mainQueueSize = 0;
    gatewayDraining = false;
    replyError = undefined;
    drainAfterReply = false;
    replyPayloadOverride = undefined;
    await vi.advanceTimersByTimeAsync(1_000);
    await flushTimers();

    expect(turnGrants).toEqual([
      expect.objectContaining({
        context: expect.objectContaining({
          SessionKey: sessionKey,
          Body: expect.stringContaining("busy proof"),
        }),
        options: expect.objectContaining({ continuationTrigger: "work-wake" }),
      }),
    ]);
  });

  it("arms zero-delay work for the next tick so callers can persist chain state first", async () => {
    const sessionKey = "agent:main:immediate";
    mockSessionStore[sessionKey] = { sessionKey };
    const immediateConfig = {
      ...config,
      defaultDelayMs: 0,
      minDelayMs: 0,
    } satisfies ContinuationRuntimeConfig;

    await scheduleContinuationWork({
      sessionKey,
      chainState: {
        currentChainCount: 0,
        chainStartedAt: Date.now(),
        accumulatedChainTokens: 3,
      },
      request: { delaySeconds: 0, reason: "persist first" },
      config: immediateConfig,
    });

    expect(turnGrants).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(0);
    await flushTimers();

    expect(turnGrants).toEqual([
      expect.objectContaining({
        context: expect.objectContaining({
          SessionKey: sessionKey,
          Body: expect.stringContaining("persist first"),
        }),
      }),
    ]);
  });

  it("requeues instead of bypassing already queued main-lane work", async () => {
    const sessionKey = "agent:main:queued-user-turn";
    mockSessionStore[sessionKey] = { sessionKey };
    mainQueueSize = 1;
    enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "queued user turn",
    });

    const result = await dispatchPendingContinuationWork({ sessionKey });

    expect(result).toEqual({ dispatched: 0, failed: 0 });
    expect(turnGrants).toHaveLength(0);
    expect([...mockFlows.values()][0]).toMatchObject({
      status: "queued",
      currentStep: "Requeued same-session continuation wake",
    });

    mainQueueSize = 0;
    gatewayDraining = false;
    replyError = undefined;
    drainAfterReply = false;
    replyPayloadOverride = undefined;
    await vi.advanceTimersByTimeAsync(1_000);
    await flushTimers();

    expect(turnGrants).toEqual([
      expect.objectContaining({
        context: expect.objectContaining({
          SessionKey: sessionKey,
          Body: expect.stringContaining("queued user turn"),
        }),
      }),
    ]);
  });

  it("recovers only stale running continuation work", async () => {
    const sessionKey = "agent:main:running-recovery";
    mockSessionStore[sessionKey] = { sessionKey };
    enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "running recovery",
    });
    const flow = [...mockFlows.values()][0];
    if (!flow) {
      throw new Error("expected mock flow");
    }
    flow.status = "running";
    flow.updatedAt = Date.now();

    await recoverPendingContinuationWork();

    expect(turnGrants).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(60_000);
    await flushTimers();

    expect(turnGrants).toEqual([
      expect.objectContaining({
        context: expect.objectContaining({
          SessionKey: sessionKey,
          Body: expect.stringContaining("running recovery"),
        }),
      }),
    ]);
  });

  it("finalizes a completed turn when the gateway starts draining after the grant", async () => {
    const sessionKey = "agent:main:draining-after-grant";
    mockSessionStore[sessionKey] = { sessionKey };
    drainAfterReply = true;
    enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "drain after grant",
    });

    const result = await dispatchPendingContinuationWork({ sessionKey });

    expect(result).toEqual({ dispatched: 1, failed: 0 });
    expect([...mockFlows.values()][0]).toMatchObject({ status: "succeeded" });
    expect(systemEvents).toEqual([]);

    drainAfterReply = false;
    gatewayDraining = false;
    await vi.advanceTimersByTimeAsync(1_000);
    await flushTimers();

    expect(turnGrants).toEqual([
      expect.objectContaining({
        context: expect.objectContaining({ Body: expect.stringContaining("drain after grant") }),
      }),
    ]);
  });

  it("requeues when gateway drain prevents the turn grant", async () => {
    const sessionKey = "agent:main:draining-before-grant";
    mockSessionStore[sessionKey] = { sessionKey };
    gatewayDraining = true;
    enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "drain before grant",
    });

    const result = await dispatchPendingContinuationWork({ sessionKey });

    expect(result).toEqual({ dispatched: 0, failed: 0 });
    expect(turnGrants).toEqual([]);
    expect(systemEvents).toEqual([]);
    expect([...mockFlows.values()][0]).toMatchObject({
      status: "queued",
      currentStep: "Requeued same-session continuation wake",
    });

    gatewayDraining = false;
    await vi.advanceTimersByTimeAsync(1_000);
    await flushTimers();

    expect(turnGrants).toEqual([
      expect.objectContaining({
        context: expect.objectContaining({ Body: expect.stringContaining("drain before grant") }),
      }),
    ]);
  });

  it("requeues when getReply returns only the gateway-draining notice", async () => {
    const sessionKey = "agent:main:drain-payload";
    mockSessionStore[sessionKey] = { sessionKey };
    drainAfterReply = true;
    replyPayloadOverride = {
      text: "⚠️ Gateway is restarting. Please wait a few seconds and try again.",
    };
    enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "drain payload",
    });

    const result = await dispatchPendingContinuationWork({ sessionKey });

    expect(result).toEqual({ dispatched: 0, failed: 0 });
    expect(turnGrants).toEqual([]);
    expect(systemEvents).toEqual([]);
    expect([...mockFlows.values()][0]).toMatchObject({
      status: "queued",
      currentStep: "Requeued same-session continuation wake",
    });
  });

  it("requeues transient turn-grant errors instead of failing the durable work", async () => {
    const sessionKey = "agent:main:transient-error";
    mockSessionStore[sessionKey] = { sessionKey };
    replyError = new Error("provider unavailable");
    enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "transient proof",
    });

    const result = await dispatchPendingContinuationWork({ sessionKey });

    expect(result).toEqual({ dispatched: 0, failed: 0 });
    const flow = [...mockFlows.values()][0];
    expect(flow).toMatchObject({
      status: "queued",
      currentStep: "Requeued same-session continuation wake",
    });
    expect(flow?.stateJson).toMatchObject({ retryCount: 1 });

    replyError = undefined;
    await vi.advanceTimersByTimeAsync(5_000);
    await flushTimers();

    expect(turnGrants).toEqual([
      expect.objectContaining({
        context: expect.objectContaining({ Body: expect.stringContaining("transient proof") }),
      }),
    ]);
  });

  it("enqueues warning events only for non-retryable skips", async () => {
    const sessionKey = "agent:main:missing";
    enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "missing session",
    });

    const result = await dispatchPendingContinuationWork({ sessionKey });

    expect(result).toEqual({ dispatched: 0, failed: 1 });
    expect(systemEvents).toEqual([
      expect.objectContaining({ text: expect.stringContaining("was not granted") }),
    ]);
  });

  it("delivers a distinct wake for every continue_work election scheduled in one turn (#982)", async () => {
    // Regression for #982: N continue_work() calls in one model turn must each
    // deliver their own wake at their own offset. The single-variable capture
    // dropped all but the last; the batch helper fans out all N, and the
    // wake-timer re-arms for the soonest pending after each fire.
    const sessionKey = "agent:main:multi-fanout";
    mockSessionStore[sessionKey] = { sessionKey };

    const batch = await scheduleContinuationWorkBatch({
      sessionKey,
      chainState: {
        currentChainCount: 0,
        chainStartedAt: Date.now(),
        accumulatedChainTokens: 0,
        chainId: "chain-multi",
      },
      requests: [
        { reason: "work-A", delaySeconds: 1 },
        { reason: "work-B", delaySeconds: 2 },
        { reason: "work-C", delaySeconds: 3 },
      ],
      config,
      parentRunId: "run-multi",
    });

    expect(batch).toMatchObject({ scheduledCount: 3, cappedCount: 0, capped: false });
    expect(turnGrants).toHaveLength(0);

    // Advance one offset at a time. Each fire delivers exactly one wake and
    // re-arms for the next pending dueAt — proving distinct delivery, not the
    // single collapsed wake of the regression. `advanceTimersByTimeAsync` only
    // runs timers due within the window (unlike `flushTimers`, which drains the
    // re-armed future timers too).
    await vi.advanceTimersByTimeAsync(1_000);
    expect(turnGrants).toHaveLength(1);
    expect(turnGrants[0]).toMatchObject({
      context: expect.objectContaining({ Body: expect.stringContaining("work-A") }),
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(turnGrants).toHaveLength(2);
    expect(turnGrants[1]).toMatchObject({
      context: expect.objectContaining({ Body: expect.stringContaining("work-B") }),
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(turnGrants).toHaveLength(3);
    expect(turnGrants[2]).toMatchObject({
      context: expect.objectContaining({ Body: expect.stringContaining("work-C") }),
    });
  });

  it("schedules the valid elections and caps the overflow without dropping the earlier ones", async () => {
    // Partial-success is load-bearing: when the cumulative chain cap rejects a
    // later election, the earlier valid ones must still schedule and deliver.
    const sessionKey = "agent:main:partial-cap";
    mockSessionStore[sessionKey] = { sessionKey };
    const cappedConfig = { ...config, maxChainLength: 2 } satisfies ContinuationRuntimeConfig;

    const batch = await scheduleContinuationWorkBatch({
      sessionKey,
      chainState: {
        currentChainCount: 0,
        chainStartedAt: Date.now(),
        accumulatedChainTokens: 0,
        chainId: "chain-partial",
      },
      requests: [
        { reason: "fit-1", delaySeconds: 1 },
        { reason: "fit-2", delaySeconds: 1 },
        { reason: "over-cap", delaySeconds: 1 },
      ],
      config: cappedConfig,
      parentRunId: "run-partial",
    });

    expect(batch).toMatchObject({ scheduledCount: 2, cappedCount: 1, capped: true });
    expect(batch.chainState.currentChainCount).toBe(2);

    await vi.advanceTimersByTimeAsync(1_000);
    await flushTimers();

    const deliveredReasons = turnGrants.map((grant) =>
      String((grant as { context: { Body: string } }).context.Body),
    );
    expect(deliveredReasons).toHaveLength(2);
    expect(deliveredReasons.some((body) => body.includes("fit-1"))).toBe(true);
    expect(deliveredReasons.some((body) => body.includes("fit-2"))).toBe(true);
    expect(deliveredReasons.some((body) => body.includes("over-cap"))).toBe(false);
  });

  it("does not let a hedge reclaim freshly running continuation work", async () => {
    const sessionKey = "agent:main:fresh-running";
    mockSessionStore[sessionKey] = { sessionKey };
    enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "fresh running",
    });
    const runningFlow = [...mockFlows.values()][0];
    if (!runningFlow) {
      throw new Error("expected mock flow");
    }
    runningFlow.status = "running";
    runningFlow.updatedAt = Date.now();

    await scheduleContinuationWork({
      sessionKey,
      chainState: {
        currentChainCount: 0,
        chainStartedAt: Date.now(),
        accumulatedChainTokens: 1,
      },
      request: { delaySeconds: 0, reason: "new queued" },
      config: { ...config, defaultDelayMs: 0, minDelayMs: 0 },
    });

    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();

    expect(runningFlow.status).toBe("running");
    expect(turnGrants).toEqual([
      expect.objectContaining({
        context: expect.objectContaining({ Body: expect.stringContaining("new queued") }),
      }),
    ]);
  });
});
