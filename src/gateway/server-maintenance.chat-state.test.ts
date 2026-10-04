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
  deps.chatRunState.updateBuffer(runId, { delta: "buffer" });
  deps.chatRunState.takeBufferDelta(runId, "buffer");
  Object.assign(deps.chatRunState.getOrCreate(runId), {
    buffer: "buffer",
    rawBuffer: "buffer",
    deltaSentAt: Date.now(),
    assistantScope: { itemId: "assistant-1", prefix: "", boundaryNewlines: 0, separatorLength: 0 },
  });
  vi.setSystemTime(now);
}

function expectStaleRunBuffersPresent(deps: MaintenanceTimerDeps, runId: string): void {
  expect(deps.chatRunState.runs.get(runId)).toMatchObject({
    buffer: "buffer",
    rawBuffer: "buffer",
    display: expect.any(Object),
    deltaSentAt: expect.any(Number),
    assistantScope: { itemId: "assistant-1", prefix: "", boundaryNewlines: 0, separatorLength: 0 },
  });
}

function expectStaleRunBuffersSwept(deps: MaintenanceTimerDeps, runId: string): void {
  const run = deps.chatRunState.runs.get(runId);
  expect(run?.buffer).toBeUndefined();
  expect(run?.rawBuffer).toBeUndefined();
  expect(run?.deltaSentAt).toBeUndefined();
  expect(run?.assistantScope).toBeUndefined();
  expect(run?.display).toBeUndefined();
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

  it.each(["progress", "registration", "aborted", "recent"] as const)(
    "sweeps abandoned records while retaining recent activity (%s)",
    async (kind) => {
      const { startGatewayMaintenanceTimers, deps, now } = await createTimedMaintenanceScenario();
      const runId = `orphan-${kind}`;
      vi.setSystemTime(staleRunTimestamp());
      if (kind === "registration") {
        deps.chatRunState.registry.add(runId, { sessionKey: "main", clientRunId: runId });
      } else if (kind === "progress") {
        deps.chatRunState.recordProgressEvent(runId, {
          runId,
          seq: 1,
          ts: Date.now(),
          stream: "tool",
          data: { phase: "start", toolCallId: "read-1", name: "read" },
        });
      } else if (kind === "recent") {
        deps.chatRunState.getOrCreate(runId).agentText = { thinking: { lastSentAt: Date.now() } };
      }
      vi.setSystemTime(now);
      if (kind === "recent") {
        deps.chatRunState.getOrCreate(runId).rawBuffer = "Fresh output";
      } else if (kind === "aborted") {
        deps.chatRunState.getOrCreate(runId).abortMarker =
          createChatAbortMarker(staleRunTimestamp());
        seedStaleRunBuffers(deps, runId);
        seedBufferedAgentEvent(deps, runId);
        const assistant = deps.chatRunState.getOrCreate(runId).agentText?.assistant;
        expect(assistant).toBeDefined();
        if (assistant) {
          assistant.lastSentAt = staleRunTimestamp();
        }
      }
      const timers = startGatewayMaintenanceTimers(deps);
      try {
        expect(deps.chatRunState.runs.has(runId)).toBe(true);
        await vi.advanceTimersByTimeAsync(60_000);
        if (kind === "recent") {
          expect(deps.chatRunState.resolveBuffer(runId).text).toBe("Fresh output");
        } else {
          expect(deps.chatRunState.runs.has(runId)).toBe(false);
          if (kind === "aborted") {
            expectStaleRunBuffersSwept(deps, runId);
            expect(deps.chatRunState.runs.get(runId)?.abortMarker).toBeUndefined();
            expect(deps.chatRunState.runs.get(runId)?.agentText).toBeUndefined();
          }
        }
      } finally {
        await stopMaintenanceTimers(timers);
      }
    },
  );

  it.each(["execution", "embedded", "queued", "abort"] as const)(
    "preserves a live %s owner until release",
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
      if (kind === "abort") {
        deps.chatAbortControllers.set(runId, {
          controller,
          sessionId: "maintenance-session",
          sessionKey: "main",
          startedAtMs: Date.now(),
          expiresAtMs: Date.now() + ABORTED_RUN_TTL_MS,
        });
      }
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
        deps.chatAbortControllers.delete(runId);
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
});
