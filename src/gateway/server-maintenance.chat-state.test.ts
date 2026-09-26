import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../agents/embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../agents/embedded-agent-runner/runs.test-support.js";
import { claimAgentRunContext, releaseAgentRunContext } from "../infra/agent-run-registry.js";
import { completeQueuedChatTurn, registerQueuedChatTurn } from "./chat-queued-turns.js";
import { createChatAbortMarker } from "./server-chat-state.js";
import { createGatewayMaintenanceStateForTest } from "./test-helpers.maintenance-state.js";

vi.mock("../infra/device-bootstrap.js", () => ({
  pruneExpiredDevicePairSetupCompletions: vi.fn(async () => 0),
}));

const ABORTED_RUN_TTL_MS = 60 * 60_000;

function createMaintenanceTimerDeps() {
  return {
    ...createGatewayMaintenanceStateForTest(),
    runWorktreeGc: async () => undefined,
    runManagedOutgoingMediaGc: async () => undefined,
  };
}

type MaintenanceTimerDeps = ReturnType<typeof createMaintenanceTimerDeps>;

async function createTimedMaintenanceScenario() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-22T00:00:00Z"));
  const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
  return { startGatewayMaintenanceTimers, deps: createMaintenanceTimerDeps(), now: Date.now() };
}

async function stopMaintenanceTimers(
  timers: ReturnType<typeof import("./server-maintenance.js").startGatewayMaintenanceTimers>,
) {
  await timers.stopPeriodicTasks();
  await timers.skillUsageCleanup();
}

function staleRunTimestamp(): number {
  return Date.now() - ABORTED_RUN_TTL_MS - 1;
}

function seedStaleRunBuffers(deps: MaintenanceTimerDeps, runId: string): void {
  const now = Date.now();
  vi.setSystemTime(staleRunTimestamp());
  Object.assign(deps.chatRunState.getOrCreate(runId), {
    buffer: "buffer",
    rawBuffer: "raw buffer",
    deltaSentAt: Date.now(),
    assistantScope: { itemId: "assistant-1", prefix: "", boundaryNewlines: 0, separatorLength: 0 },
    deltaLastBroadcastText: "buffer",
  });
  vi.setSystemTime(now);
}

function expectStaleRunBuffersPresent(deps: MaintenanceTimerDeps, runId: string): void {
  expect(deps.chatRunState.runs.get(runId)).toMatchObject({
    buffer: "buffer",
    rawBuffer: "raw buffer",
    deltaSentAt: expect.any(Number),
    assistantScope: { itemId: "assistant-1", prefix: "", boundaryNewlines: 0, separatorLength: 0 },
    deltaLastBroadcastText: "buffer",
  });
}

function expectStaleRunBuffersSwept(deps: MaintenanceTimerDeps, runId: string): void {
  const run = deps.chatRunState.runs.get(runId);
  expect(run?.buffer).toBeUndefined();
  expect(run?.rawBuffer).toBeUndefined();
  expect(run?.deltaSentAt).toBeUndefined();
  expect(run?.assistantScope).toBeUndefined();
  expect(run?.deltaLastBroadcastText).toBeUndefined();
}

function seedBufferedAgentEvent(deps: MaintenanceTimerDeps, runId: string): void {
  deps.chatRunState.getOrCreate(runId).agentText = {
    assistant: {
      bufferedEvent: {
        payload: {
          runId,
          seq: 1,
          stream: "assistant",
          ts: Date.now(),
          data: { text: "buffer", delta: "buffer" },
        },
      },
    },
  };
}

describe("gateway chat-state maintenance", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps stale buffers for active runs that still have abort controllers", async () => {
    const { startGatewayMaintenanceTimers, deps } = await createTimedMaintenanceScenario();
    const runId = "run-active";
    deps.chatAbortControllers.set(runId, {
      controller: new AbortController(),
      sessionId: "maintenance-session",
      sessionKey: "main",
      startedAtMs: Date.now(),
      expiresAtMs: Date.now() + ABORTED_RUN_TTL_MS,
    });
    seedStaleRunBuffers(deps, runId);

    const timers = startGatewayMaintenanceTimers(deps);

    await vi.advanceTimersByTimeAsync(60_000);

    expectStaleRunBuffersPresent(deps, runId);

    await stopMaintenanceTimers(timers);
  });

  it("sweeps orphaned stale buffers once the abort controller is gone", async () => {
    const { startGatewayMaintenanceTimers, deps } = await createTimedMaintenanceScenario();
    const runId = "run-orphaned";
    seedStaleRunBuffers(deps, runId);

    const timers = startGatewayMaintenanceTimers(deps);

    await vi.advanceTimersByTimeAsync(60_000);

    expectStaleRunBuffersSwept(deps, runId);

    await stopMaintenanceTimers(timers);
  });

  it.each(["progress", "status", "plan", "canvas"] as const)(
    "sweeps abandoned %s-only records without requiring assistant text",
    async (kind) => {
      const { startGatewayMaintenanceTimers, deps, now } = await createTimedMaintenanceScenario();
      vi.setSystemTime(staleRunTimestamp());
      const runId = `orphan-${kind}`;
      if (kind === "progress" || kind === "status") {
        deps.chatRunState.recordProgressEvent(runId, {
          runId,
          seq: 1,
          ts: Date.now(),
          stream: kind === "progress" ? "tool" : "run_status",
          data:
            kind === "progress"
              ? { phase: "start", toolCallId: "read-1", name: "read" }
              : { phase: "starting_model" },
        });
      } else if (kind === "plan") {
        deps.chatRunState.getOrCreate(runId).planSnapshot = {
          steps: [{ step: "Inspect", status: "in_progress" }],
        };
      } else {
        deps.chatRunState.getOrCreate(runId).canvasBlocks = [
          {
            type: "canvas",
            rawText: null,
            preview: {
              kind: "canvas",
              surface: "assistant_message",
              render: "url",
              title: "Orphaned widget",
              url: "/__openclaw__/canvas/documents/orphan/index.html",
              viewId: "orphan",
              sandbox: "scripts",
            },
          },
        ];
      }
      vi.setSystemTime(now);
      const timers = startGatewayMaintenanceTimers(deps);
      try {
        expect(deps.chatRunState.runs.has(runId)).toBe(true);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(deps.chatRunState.runs.has(runId)).toBe(false);
      } finally {
        await stopMaintenanceTimers(timers);
      }
    },
  );

  it("keeps recently updated records despite an old thinking timestamp", async () => {
    const { startGatewayMaintenanceTimers, deps, now } = await createTimedMaintenanceScenario();
    vi.setSystemTime(staleRunTimestamp());
    deps.chatRunState.getOrCreate("recent").agentText = {
      thinking: { lastSentAt: Date.now() },
    };
    vi.setSystemTime(now);
    deps.chatRunState.getOrCreate("recent").rawBuffer = "Fresh output";
    const timers = startGatewayMaintenanceTimers(deps);
    try {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(deps.chatRunState.resolveBuffer("recent").text).toBe("Fresh output");
    } finally {
      await stopMaintenanceTimers(timers);
    }
  });

  it.each(["execution", "embedded", "queued"] as const)(
    "preserves a live %s owner without a chat abort controller until release",
    async (kind) => {
      const { startGatewayMaintenanceTimers, deps } = await createTimedMaintenanceScenario();
      const runId = `live-${kind}`;
      seedStaleRunBuffers(deps, runId);
      const handle = createEmbeddedRunHandle({ runId });
      const claim =
        kind === "execution"
          ? claimAgentRunContext(
              runId,
              { sessionKey: "main" },
              {
                trackOwner: true,
                ownsContext: true,
                protectFromSweep: true,
              },
            )
          : undefined;
      if (kind === "embedded") {
        setActiveEmbeddedRun("maintenance-session", handle, "main");
      }
      const controller = new AbortController();
      if (kind === "queued") {
        registerQueuedChatTurn({
          chatQueuedTurns: deps.chatQueuedTurns,
          runId,
          controller,
          sessionId: "maintenance-session",
          sessionKey: "main",
        });
      }
      const release = () => {
        releaseAgentRunContext(runId, claim);
        completeQueuedChatTurn(deps.chatQueuedTurns, runId, controller);
        if (kind === "embedded") {
          clearActiveEmbeddedRun("maintenance-session", handle, "main");
        }
      };
      const timers = startGatewayMaintenanceTimers(deps);
      try {
        await vi.advanceTimersByTimeAsync(60_000);
        expectStaleRunBuffersPresent(deps, runId);
        release();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(deps.chatRunState.runs.has(runId)).toBe(false);
      } finally {
        release();
        await stopMaintenanceTimers(timers);
      }
    },
  );

  it("sweeps orphaned stale agent throttle state once the abort controller is gone", async () => {
    const { startGatewayMaintenanceTimers, deps, now } = await createTimedMaintenanceScenario();
    const runId = "run-agent-orphaned";
    vi.setSystemTime(staleRunTimestamp());
    seedBufferedAgentEvent(deps, runId);
    const agentText = deps.chatRunState.getOrCreate(runId).agentText?.assistant;
    expect(agentText).toBeDefined();
    if (agentText) {
      agentText.lastSentAt = Date.now();
    }
    vi.setSystemTime(now);

    const timers = startGatewayMaintenanceTimers(deps);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(deps.chatRunState.runs.get(runId)?.agentText).toBeUndefined();

    await stopMaintenanceTimers(timers);
  });

  it("clears assistant snapshot scope when aborted runs age out", async () => {
    const { startGatewayMaintenanceTimers, deps } = await createTimedMaintenanceScenario();
    const runId = "run-aborted";
    deps.chatRunState.getOrCreate(runId).abortMarker = createChatAbortMarker(staleRunTimestamp());
    seedStaleRunBuffers(deps, runId);
    seedBufferedAgentEvent(deps, runId);
    const agentText = deps.chatRunState.getOrCreate(runId).agentText?.assistant;
    expect(agentText).toBeDefined();
    if (agentText) {
      agentText.lastSentAt = staleRunTimestamp();
    }

    const timers = startGatewayMaintenanceTimers(deps);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(deps.chatRunState.runs.get(runId)?.abortMarker).toBeUndefined();
    expectStaleRunBuffersSwept(deps, runId);
    expect(deps.chatRunState.runs.get(runId)?.agentText).toBeUndefined();

    await stopMaintenanceTimers(timers);
  });

  it("sweeps orphaned raw buffers that never emitted a delta", async () => {
    const { startGatewayMaintenanceTimers, deps, now } = await createTimedMaintenanceScenario();
    const runId = "run-raw-only";
    vi.setSystemTime(staleRunTimestamp());
    Object.assign(deps.chatRunState.getOrCreate(runId), {
      rawBuffer: "suppressed raw buffer",
      deltaLastBroadcastText: "suppressed raw buffer",
    });
    vi.setSystemTime(now);

    const timers = startGatewayMaintenanceTimers(deps);

    await vi.advanceTimersByTimeAsync(60_000);

    expect(deps.chatRunState.runs.has(runId)).toBe(false);

    await stopMaintenanceTimers(timers);
  });
});
