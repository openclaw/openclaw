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
      maxPendingWork: 32,
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
  cancelRequestedAt?: number;
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
  computeBusySkipBackoffMs,
  partitionSupersededWork,
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
  maxPendingWork: 32,
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

    const deliveredReasons = turnGrants.map(
      (grant) => (grant as { context: { Body: string } }).context.Body,
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

  it("never supersedes a recovered running wake folded against a newer queued election (#988-P2-1)", async () => {
    // End-to-end proof that the PRE-claim status is carried through
    // consumePendingWork into partitionSupersededWork: a stale, recovered
    // `running` wake co-drained with a newer `queued` election must DRIVE, not
    // be finished-as-superseded. Without the carry-status guard the running
    // wake (stale, not newest) would be folded and only the queued one would run.
    const sessionKey = "agent:main:recovered-running-fold";
    mockSessionStore[sessionKey] = { sessionKey };
    const now = Date.now();

    enqueuePendingWork({
      sessionKey,
      hop: 1,
      delayMs: 1_000,
      electedAt: now - 500_000,
      dueAt: now - 500_000, // matured and stale (overdue >> 120s grace)
      maxChainLength: 8,
      reason: "recovered running",
    });
    const runningFlow = [...mockFlows.values()][0];
    if (!runningFlow) {
      throw new Error("expected running mock flow");
    }
    runningFlow.status = "running";
    runningFlow.updatedAt = now - 200_000; // older than the 60s recovery staleness window

    enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 1_000,
      electedAt: now - 1_000, // newest election
      dueAt: now - 1_000, // matured
      maxChainLength: 8,
      reason: "newest queued",
    });

    const result = await dispatchPendingContinuationWork({
      sessionKey,
      recoverRunning: true,
      includeRunningUpdatedAtOrBefore: now - 60_000,
    });

    expect(result).toEqual({ dispatched: 2, failed: 0 });
    const bodies = turnGrants.map((grant) => (grant as { context: { Body: string } }).context.Body);
    expect(bodies.some((body) => body.includes("recovered running"))).toBe(true);
    expect(bodies.some((body) => body.includes("newest queued"))).toBe(true);
    expect(systemEvents.some((event) => (event as { text: string }).text.includes("folded"))).toBe(
      false,
    );
  });

  it("backs off exponentially on consecutive busy-skip re-arms instead of a flat 1s (#990 Pillar-0)", async () => {
    // RED against the old flat BUSY_RETRY_MS: step 1 would re-arm at 1s again (and
    // carry no busySkipCount) instead of doubling. The storm was exactly this flat
    // ~1Hz re-arm on a chronically-busy seat.
    const sessionKey = "agent:main:busy-backoff";
    mockSessionStore[sessionKey] = { sessionKey };
    activeSessions.add(sessionKey); // chronically busy: every drive busy-skips
    enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "storm",
    });

    // 2^0..2^6 * 1s, capped at maxDelayMs (60s in test config), then flat at cap.
    const expectedDelays = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000];
    for (let i = 0; i < expectedDelays.length; i++) {
      await dispatchPendingContinuationWork({ sessionKey });
      // Drop the just-armed hedge so we drive each re-consume deterministically.
      resetContinuationWorkDispatchForTests();
      const flow = [...mockFlows.values()][0];
      expect(flow?.status).toBe("queued");
      const state = flow?.stateJson as {
        dueAt: number;
        busySkipCount?: number;
        retryCount?: number;
      };
      expect(state.dueAt - Date.now()).toBe(expectedDelays[i]);
      expect(state.busySkipCount).toBe(i + 1);
      expect(state.retryCount).toBeUndefined(); // busy-skip never penalizes
      // Mature the flow for the next consume (no hedge armed; clock-only advance).
      await vi.advanceTimersByTimeAsync(expectedDelays[i]);
    }

    expect(turnGrants).toHaveLength(0); // never driven while busy, never dropped
    expect(systemEvents).toEqual([]); // never failed
  });

  it("never increments retryCount or drops the flow across many busy-skips (rate-cap-forever, #952 never-penalize)", async () => {
    const sessionKey = "agent:main:busy-forever";
    mockSessionStore[sessionKey] = { sessionKey };
    activeSessions.add(sessionKey);
    enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "forever busy",
    });

    // Far more skips than MAX_TRANSIENT_ERROR_RETRY_COUNT (8): a busy-defer must
    // never approach the fail-bound, never fail, never drop.
    for (let i = 0; i < 20; i++) {
      await dispatchPendingContinuationWork({ sessionKey });
      resetContinuationWorkDispatchForTests();
      await vi.advanceTimersByTimeAsync(60_000); // mature past the ceiling each loop
    }

    const flow = [...mockFlows.values()][0];
    expect(flow?.status).toBe("queued"); // never failed/dropped — still deliverable
    const state = flow?.stateJson as { busySkipCount?: number; retryCount?: number };
    expect(state.busySkipCount).toBe(20);
    expect(state.retryCount).toBeUndefined();
    expect(turnGrants).toHaveLength(0);
    expect(systemEvents).toEqual([]); // no failure warning ever enqueued
  });

  it("resets busySkipCount to 0 and delivers once a busy-deferred flow finally drives (#990 Pillar-0 + #952-preserve)", async () => {
    const sessionKey = "agent:main:busy-then-drive";
    mockSessionStore[sessionKey] = { sessionKey };
    activeSessions.add(sessionKey);
    enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "deferred then drives",
    });

    for (let i = 0; i < 3; i++) {
      await dispatchPendingContinuationWork({ sessionKey });
      resetContinuationWorkDispatchForTests();
      await vi.advanceTimersByTimeAsync(60_000);
    }
    const deferredState = [...mockFlows.values()][0]?.stateJson as { busySkipCount?: number };
    expect(deferredState.busySkipCount).toBe(3);

    // Seat quiets: the legit-deferred flow delivers (never dropped, #952), and the
    // granted record clears the backoff counter (rate-cap, never permanent).
    activeSessions.clear();
    const result = await dispatchPendingContinuationWork({ sessionKey });

    expect(result).toEqual({ dispatched: 1, failed: 0 });
    const flow = [...mockFlows.values()][0];
    expect(flow?.status).toBe("succeeded");
    const state = flow?.stateJson as { busySkipCount?: number; turnGrantedAt?: number };
    expect(state.busySkipCount).toBe(0);
    expect(state.turnGrantedAt).toBeGreaterThan(0);
    expect(turnGrants).toEqual([
      expect.objectContaining({
        context: expect.objectContaining({ Body: expect.stringContaining("deferred then drives") }),
      }),
    ]);
  });

  it("does not re-consume a cancel-requested continuation work flow (:259 dedup harden, #990 Pillar-0)", async () => {
    const sessionKey = "agent:main:cancel-requested";
    mockSessionStore[sessionKey] = { sessionKey };
    enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "cancel requested",
    });
    const flow = [...mockFlows.values()][0];
    if (!flow) {
      throw new Error("expected mock flow");
    }
    // User requested cancel; the maintenance reaper has not yet finalized it.
    flow.cancelRequestedAt = Date.now();

    const result = await dispatchPendingContinuationWork({
      sessionKey,
      recoverRunning: true,
      includeRunningUpdatedAtOrBefore: Date.now(),
    });

    expect(result).toEqual({ dispatched: 0, failed: 0 });
    expect(turnGrants).toHaveLength(0);
    // Left untouched (still queued) for the reaper to finalize — not driven.
    expect([...mockFlows.values()][0]?.status).toBe("queued");
  });

  it("does not re-consume a terminal (succeeded) continuation work flow (:259 structural dedup)", async () => {
    const sessionKey = "agent:main:already-succeeded";
    mockSessionStore[sessionKey] = { sessionKey };
    enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "already succeeded",
    });
    const flow = [...mockFlows.values()][0];
    if (!flow) {
      throw new Error("expected mock flow");
    }
    flow.status = "succeeded";

    const result = await dispatchPendingContinuationWork({
      sessionKey,
      recoverRunning: true,
      includeRunningUpdatedAtOrBefore: Date.now(),
    });

    expect(result).toEqual({ dispatched: 0, failed: 0 });
    expect(turnGrants).toHaveLength(0);
  });
});

describe("#990 Pillar-0 computeBusySkipBackoffMs (exp-backoff)", () => {
  it("doubles BUSY_RETRY_MS per consecutive busy-skip and caps at the ceiling", () => {
    const ceiling = 60_000;
    expect(computeBusySkipBackoffMs(0, ceiling)).toBe(1_000);
    expect(computeBusySkipBackoffMs(1, ceiling)).toBe(2_000);
    expect(computeBusySkipBackoffMs(2, ceiling)).toBe(4_000);
    expect(computeBusySkipBackoffMs(3, ceiling)).toBe(8_000);
    expect(computeBusySkipBackoffMs(4, ceiling)).toBe(16_000);
    expect(computeBusySkipBackoffMs(5, ceiling)).toBe(32_000);
    expect(computeBusySkipBackoffMs(6, ceiling)).toBe(60_000); // 64s clamped to 60s
    expect(computeBusySkipBackoffMs(7, ceiling)).toBe(60_000);
  });

  it("clamps to the ceiling without overflow for very large counts", () => {
    expect(computeBusySkipBackoffMs(1_000, 60_000)).toBe(60_000); // 2**1000 -> Infinity, clamped
    expect(computeBusySkipBackoffMs(-5, 60_000)).toBe(1_000); // negative guarded to 2^0
  });
});

function work(
  partial: Partial<{
    hop: number;
    electedAt: number;
    dueAt: number;
    status: "queued" | "running";
  }> = {},
): Parameters<typeof partitionSupersededWork>[0][number] {
  return {
    sessionKey: "agent:main:s",
    hop: partial.hop ?? 1,
    delayMs: 1_000,
    electedAt: partial.electedAt ?? 1_000,
    dueAt: partial.dueAt ?? 2_000,
    maxChainLength: 8,
    status: partial.status ?? "queued",
    flowId: `f-${partial.hop ?? 1}`,
    expectedRevision: 0,
  };
}

describe("#986 partitionSupersededWork (drain-superseded)", () => {
  const GRACE = 120_000;
  const NOW = 1_000_000;

  it("passes a single matured work through untouched", () => {
    const works = [work({ hop: 1, electedAt: 1, dueAt: 1 })];
    const { drive, superseded } = partitionSupersededWork(works, GRACE, NOW);
    expect(drive).toHaveLength(1);
    expect(superseded).toHaveLength(0);
  });

  it("never collapses when grace is non-positive (guard disabled)", () => {
    const works = [
      work({ hop: 1, electedAt: 1, dueAt: 1 }),
      work({ hop: 2, electedAt: 2, dueAt: 2 }),
      work({ hop: 3, electedAt: 3, dueAt: 3 }),
    ];
    const { drive, superseded } = partitionSupersededWork(works, 0, NOW);
    expect(drive).toHaveLength(3);
    expect(superseded).toHaveLength(0);
  });

  it("folds stale older siblings into the newest-elected member (backlog)", () => {
    // All three matured long ago (overdue >> grace): a genuine stale pile.
    const works = [
      work({ hop: 1, electedAt: 100, dueAt: NOW - 500_000 }),
      work({ hop: 2, electedAt: 200, dueAt: NOW - 400_000 }),
      work({ hop: 3, electedAt: 300, dueAt: NOW - 300_000 }),
    ];
    const { drive, superseded } = partitionSupersededWork(works, GRACE, NOW);
    expect(drive.map((w) => w.hop)).toEqual([3]); // newest-elected drives
    expect(superseded.map((w) => w.hop).toSorted((a, b) => a - b)).toEqual([1, 2]);
  });

  it("preserves a close burst that is not yet stale (within grace)", () => {
    // Three matured just now, none overdue past grace: distinct close burst.
    const works = [
      work({ hop: 1, electedAt: 100, dueAt: NOW - 10 }),
      work({ hop: 2, electedAt: 200, dueAt: NOW - 5 }),
      work({ hop: 3, electedAt: 300, dueAt: NOW }),
    ];
    const { drive, superseded } = partitionSupersededWork(works, GRACE, NOW);
    expect(drive).toHaveLength(3);
    expect(superseded).toHaveLength(0);
  });

  it("keeps the newest even if it is itself overdue, folds only stale older", () => {
    const works = [
      work({ hop: 1, electedAt: 100, dueAt: NOW - 500_000 }), // stale older
      work({ hop: 2, electedAt: 200, dueAt: NOW - 1_000 }), // recent, not stale
      work({ hop: 3, electedAt: 300, dueAt: NOW - 300_000 }), // newest, stale-but-newest
    ];
    const { drive, superseded } = partitionSupersededWork(works, GRACE, NOW);
    // newest (hop 3) always drives; hop 2 within grace drives; hop 1 stale folds.
    expect(drive.map((w) => w.hop).toSorted((a, b) => a - b)).toEqual([2, 3]);
    expect(superseded.map((w) => w.hop)).toEqual([1]);
  });

  it("tie-breaks same-millisecond electedAt by hop — keeps the highest-hop newest intent (#988 :252)", () => {
    // Synchronous batch enqueue can stamp identical electedAt; the newest intent
    // is the highest hop, NOT the first array-order row. consumePendingWork
    // sorts createdAt asc, so the stale older sibling appears first.
    const works = [
      work({ hop: 1, electedAt: 5_000, dueAt: NOW - 500_000 }), // same ms, oldest hop, stale
      work({ hop: 2, electedAt: 5_000, dueAt: NOW - 400_000 }), // same ms, middle hop, stale
      work({ hop: 3, electedAt: 5_000, dueAt: NOW - 300_000 }), // same ms, NEWEST hop
    ];
    const { drive, superseded } = partitionSupersededWork(works, GRACE, NOW);
    // The highest-hop (3) is the kept newest — NOT the first array row (hop 1).
    expect(drive.map((w) => w.hop)).toEqual([3]);
    expect(superseded.map((w) => w.hop).toSorted((a, b) => a - b)).toEqual([1, 2]);
  });

  it("never supersedes a recovered running member even when stale and not newest (#988-P2-1)", () => {
    // A recovered `running` turn is actively executing (it may be observing
    // requests-in-flight). It must drive, never fold, even though it is overdue
    // past grace and a newer queued election exists. RED before the write-guard:
    // the stale, non-newest running member was classified `superseded`.
    const works = [
      work({ hop: 1, electedAt: 100, dueAt: NOW - 500_000, status: "running" }), // stale running, oldest
      work({ hop: 2, electedAt: 300, dueAt: NOW - 300_000, status: "queued" }), // newest queued election
    ];
    const { drive, superseded } = partitionSupersededWork(works, GRACE, NOW);
    expect(drive.map((w) => w.hop).toSorted((a, b) => a - b)).toEqual([1, 2]);
    expect(superseded).toHaveLength(0);
  });

  it("still folds a stale queued member into a newer election (#986 Guard 2 intact)", () => {
    // The only supersede-eligible member is `queued`; the #986 behavior is
    // unchanged for genuine queued backlog.
    const works = [
      work({ hop: 1, electedAt: 100, dueAt: NOW - 500_000, status: "queued" }), // stale queued backlog
      work({ hop: 2, electedAt: 300, dueAt: NOW - 300_000, status: "queued" }), // newest queued election
    ];
    const { drive, superseded } = partitionSupersededWork(works, GRACE, NOW);
    expect(drive.map((w) => w.hop)).toEqual([2]);
    expect(superseded.map((w) => w.hop)).toEqual([1]);
  });

  it("mixed batch: stale running drives, stale queued folds, newest queued drives (#988-P2-1)", () => {
    const works = [
      work({ hop: 1, electedAt: 100, dueAt: NOW - 500_000, status: "running" }), // stale running → drives
      work({ hop: 2, electedAt: 200, dueAt: NOW - 400_000, status: "queued" }), // stale queued → folds
      work({ hop: 3, electedAt: 300, dueAt: NOW - 300_000, status: "queued" }), // newest queued → drives
    ];
    const { drive, superseded } = partitionSupersededWork(works, GRACE, NOW);
    expect(drive.map((w) => w.hop).toSorted((a, b) => a - b)).toEqual([1, 3]);
    expect(superseded.map((w) => w.hop)).toEqual([2]);
  });
});

describe("#986 maxPendingWork cap (Guard 1)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_000_000 });
    mockFlows.clear();
    flowCounter = 0;
    resetContinuationWorkDispatchForTests();
  });
  afterEach(() => {
    resetContinuationWorkDispatchForTests();
    vi.useRealTimers();
  });

  const sessionKey = "agent:main:flood";
  const baseChain = { currentChainCount: 0, chainStartedAt: 1_000_000, accumulatedChainTokens: 0 };

  it("rejects a new election once pendingWorkCount is at maxPendingWork", async () => {
    const capped = {
      ...config,
      maxPendingWork: 2,
      maxChainLength: 100,
    } satisfies ContinuationRuntimeConfig;
    // Pre-fill the store to the cap (2 queued flows).
    enqueuePendingWork({
      sessionKey,
      hop: 1,
      delayMs: 1_000,
      electedAt: 1_000_000,
      dueAt: 1_001_000,
      maxChainLength: 100,
    });
    enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 1_000,
      electedAt: 1_000_000,
      dueAt: 1_001_000,
      maxChainLength: 100,
    });

    const result = await scheduleContinuationWork({
      sessionKey,
      chainState: baseChain,
      request: { delaySeconds: 1, reason: "over the pending cap" },
      config: capped,
    });

    expect(result.scheduled).toBe(false);
    expect(result.capped).toBe(true);
  });

  it("batch ends early on pending-cap but preserves earlier scheduled elections (#982 partial-success)", async () => {
    const capped = {
      ...config,
      maxPendingWork: 3,
      maxChainLength: 100,
    } satisfies ContinuationRuntimeConfig;
    // Start empty; a 5-election batch should schedule 3, then hit the cap.
    const result = await scheduleContinuationWorkBatch({
      sessionKey,
      chainState: baseChain,
      requests: [
        { delaySeconds: 1, reason: "a" },
        { delaySeconds: 1, reason: "b" },
        { delaySeconds: 1, reason: "c" },
        { delaySeconds: 1, reason: "d" },
        { delaySeconds: 1, reason: "e" },
      ],
      config: capped,
    });

    expect(result.scheduledCount).toBe(3);
    expect(result.cappedCount).toBe(2);
    expect(result.capped).toBe(true);
    // The 3 earlier elections stayed durably enqueued (not silently dropped).
    const queued = [...mockFlows.values()].filter((f) => f.ownerKey === sessionKey);
    expect(queued).toHaveLength(3);
  });

  it("does NOT count the active driving (running) wake against the cap — serial maxPendingWork:1 still schedules its successor (#988 :403)", async () => {
    const capOne = {
      ...config,
      maxPendingWork: 1,
      maxChainLength: 100,
    } satisfies ContinuationRuntimeConfig;
    // Simulate the in-flight driver: one continuation-work flow currently
    // `running` (its turn is being driven; markPendingWorkTurnGranted hasn't run
    // yet). A serial chain at maxPendingWork:1 must still schedule the successor
    // — the running driver is NOT a pending future wake.
    enqueuePendingWork({
      sessionKey,
      hop: 1,
      delayMs: 1_000,
      electedAt: 1_000_000,
      dueAt: 1_001_000,
      maxChainLength: 100,
    });
    const driver = [...mockFlows.values()].find((f) => f.ownerKey === sessionKey);
    if (driver) {
      driver.status = "running";
    }

    const result = await scheduleContinuationWork({
      sessionKey,
      chainState: { currentChainCount: 1, chainStartedAt: 1_000_000, accumulatedChainTokens: 0 },
      request: { delaySeconds: 1, reason: "serial successor under cap 1" },
      config: capOne,
    });

    // Pre-fix this rejected (running driver counted → pending 1 >= cap 1).
    // Post-fix the running driver is excluded, so the successor schedules.
    expect(result.scheduled).toBe(true);
    expect(result.capped).toBe(false);
  });
});
