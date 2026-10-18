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

// mock-isolation: Chat-state timers must not start the unrelated device expiry worker.
vi.mock("../infra/device-bootstrap.js", () => ({
  startDevicePairSetupMaintenance: vi.fn(async () => 0),
}));

const ABORTED_RUN_TTL_MS = 60 * 60_000;
const assistantScope = {
  itemId: "assistant-1",
  prefix: "",
  boundaryNewlines: 0,
  separatorLength: 0,
};

async function createScenario() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-22T00:00:00Z"));
  const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
  const deps = {
    ...createGatewayMaintenanceStateForTest(),
    runWorktreeGc: async () => undefined,
    runManagedOutgoingMediaGc: async () => undefined,
  };
  let timers: ReturnType<typeof startGatewayMaintenanceTimers> | undefined;
  return {
    ...deps,
    start: () => {
      timers = startGatewayMaintenanceTimers(deps);
    },
    [Symbol.asyncDispose]: async () => {
      await timers?.stopPeriodicTasks();
      await timers?.skillUsageCleanup();
    },
  };
}

type MaintenanceTimerDeps = Awaited<ReturnType<typeof createScenario>>;

function seedStaleRunBuffers(deps: MaintenanceTimerDeps, runId: string, aborted = false): void {
  const now = Date.now();
  vi.setSystemTime(Date.now() - ABORTED_RUN_TTL_MS - 1);
  deps.chatRunState.updateBuffer(runId, { delta: "buffer" });
  deps.chatRunState.takeBufferDelta(runId, "buffer");
  Object.assign(deps.chatRunState.getOrCreate(runId), {
    buffer: "buffer",
    rawBuffer: "buffer",
    deltaSentAt: Date.now(),
    assistantScope: { ...assistantScope },
  });
  if (aborted) {
    const run = deps.chatRunState.getOrCreate(runId);
    run.abortMarker = createChatAbortMarker(Date.now());
    const payload = { runId, seq: 1, stream: "assistant" as const, ts: now, data: {} };
    run.agentText = { assistant: { lastSentAt: Date.now(), bufferedEvent: { payload } } };
  }
  vi.setSystemTime(now);
}

describe("gateway chat-state maintenance", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(["progress", "registration", "aborted", "recent"] as const)(
    "sweeps abandoned records while retaining recent activity (%s)",
    async (kind) => {
      await using deps = await createScenario();
      const now = Date.now();
      const runId = `orphan-${kind}`;
      vi.setSystemTime(Date.now() - ABORTED_RUN_TTL_MS - 1);
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
        seedStaleRunBuffers(deps, runId, true);
      }
      deps.start();
      expect(deps.chatRunState.runs.has(runId)).toBe(true);
      await vi.advanceTimersByTimeAsync(60_000);
      if (kind === "recent") {
        expect(deps.chatRunState.resolveBuffer(runId).text).toBe("Fresh output");
      } else {
        expect(deps.chatRunState.runs.has(runId)).toBe(false);
      }
    },
  );

  it.each(["execution", "embedded", "queued", "abort"] as const)(
    "preserves a live %s owner until release",
    async (kind) => {
      await using deps = await createScenario();
      const runId = `live-${kind}`;
      seedStaleRunBuffers(deps, runId);
      const handle = createEmbeddedRunHandle({ runId });
      const claim =
        kind === "execution"
          ? claimAgentRunContext(
              runId,
              { sessionKey: "main" },
              { trackOwner: true, ownsContext: true, protectFromSweep: true },
            )
          : undefined;
      if (kind === "embedded") {
        setActiveEmbeddedRun("maintenance-session", handle, "main");
      }
      const controller = new AbortController();
      const owner = { controller, sessionId: "maintenance-session", sessionKey: "main" };
      if (kind === "abort") {
        deps.chatAbortControllers.set(runId, {
          ...owner,
          startedAtMs: Date.now(),
          expiresAtMs: Date.now() + ABORTED_RUN_TTL_MS,
        });
      }
      if (kind === "queued") {
        registerQueuedChatTurn({ chatQueuedTurns: deps.chatQueuedTurns, runId, ...owner });
      }
      const release = () => {
        deps.chatAbortControllers.delete(runId);
        releaseAgentRunContext(runId, claim);
        completeQueuedChatTurn(deps.chatQueuedTurns, runId, controller);
        if (kind === "embedded") {
          clearActiveEmbeddedRun("maintenance-session", handle, "main");
        }
      };
      using _ = { [Symbol.dispose]: release };
      deps.start();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(deps.chatRunState.runs.get(runId)).toMatchObject({
        buffer: "buffer",
        rawBuffer: "buffer",
        display: expect.any(Object),
        deltaSentAt: expect.any(Number),
        assistantScope,
      });
      release();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(deps.chatRunState.runs.has(runId)).toBe(false);
    },
  );
  it("prunes idle tool-event recipients while preserving grace and registered run state", async () => {
    await using deps = await createScenario();
    const { toolEventRecipients, registry, runs } = deps.chatRunState;
    toolEventRecipients.add("active-expired", "conn-active");
    toolEventRecipients.add("registered-expired", "conn-registered");
    registry.add("registered-expired", { sessionKey: "session-1", clientRunId: "client-1" });

    await vi.advanceTimersByTimeAsync(9 * 60_000 + 2_000);
    deps.start();
    await vi.advanceTimersByTimeAsync(27_000);
    toolEventRecipients.add("finalized-expired", "conn-final");
    toolEventRecipients.markFinal("finalized-expired");
    toolEventRecipients.add("recent", "conn-recent");
    await vi.advanceTimersByTimeAsync(2_000);
    toolEventRecipients.add("finalized-grace", "conn-grace");
    toolEventRecipients.markFinal("finalized-grace");

    // The aligned tick at minute ten falls between the two finalization deadlines.
    await vi.advanceTimersByTimeAsync(29_000);
    expect(runs.has("active-expired")).toBe(false);
    expect(runs.has("finalized-expired")).toBe(false);
    expect(runs.get("registered-expired")?.toolRecipient).toBeUndefined();
    expect(registry.peek("registered-expired")?.clientRunId).toBe("client-1");
    expect(toolEventRecipients.get("finalized-grace")).toEqual(new Set(["conn-grace"]));
    expect(toolEventRecipients.get("recent")).toEqual(new Set(["conn-recent"]));

    await vi.advanceTimersByTimeAsync(60_000);
    expect(runs.has("finalized-grace")).toBe(false);
    expect(runs.has("recent")).toBe(true);
  });
});
