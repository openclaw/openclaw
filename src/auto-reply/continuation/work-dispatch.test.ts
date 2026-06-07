import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const turnGrants: unknown[] = [];
const systemEvents: unknown[] = [];
const activeSessions = new Set<string>();
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

vi.mock("../reply/get-reply.js", () => ({
  getReplyFromConfig: vi.fn(async (context: unknown, options: unknown, cfg: unknown) => {
    turnGrants.push({ context, options, cfg });
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

import { deleteSubagentSessionForCleanup } from "../../agents/subagent-session-cleanup.js";
import type { ContinuationRuntimeConfig } from "./types.js";
import {
  dispatchPendingContinuationWork,
  recoverPendingContinuationWork,
  resetContinuationWorkDispatchForTests,
  scheduleContinuationWork,
} from "./work-dispatch.js";
import { enqueuePendingWork } from "./work-store.js";

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
    for (const key of Object.keys(mockSessionStore)) {
      delete mockSessionStore[key];
    }
    mockFlows.clear();
    flowCounter = 0;
    resetContinuationWorkDispatchForTests();
  });

  afterEach(() => {
    resetContinuationWorkDispatchForTests();
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

    const callGateway = vi.fn();
    await deleteSubagentSessionForCleanup({
      callGateway: callGateway as never,
      childSessionKey,
      spawnMode: "run",
    });
    expect(callGateway).not.toHaveBeenCalled();

    await dispatchPendingContinuationWork({ sessionKey: childSessionKey });
    await vi.advanceTimersByTimeAsync(1_000);
    await flushTimers();

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
        context: expect.objectContaining({ SessionKey: sessionKey }),
        options: expect.objectContaining({
          continuationTrigger: "work-wake",
          parentRunId: "run-1",
        }),
      }),
    ]);
    expect(systemEvents).toEqual([
      expect.objectContaining({ text: expect.stringContaining("restart proof") }),
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
    expect(systemEvents).toEqual([
      expect.objectContaining({ text: expect.stringContaining("busy proof") }),
      expect.objectContaining({ text: expect.stringContaining("was not granted") }),
    ]);
  });
});
