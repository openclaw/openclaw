import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearTestEmbeddedRun as clearActiveEmbeddedRun,
  registerTestEmbeddedRun as setActiveEmbeddedRun,
  createEmbeddedRunHandle,
} from "../agents/embedded-agent-runner/runs.test-support.js";
import { claimAgentRunContext, releaseAgentRunContext } from "../infra/agent-run-registry.js";
import { retireSessionControllerInput } from "../sessions/session-controller.mailbox.js";
import { rpcSourceTesting } from "../sessions/session-lifecycle-admission.test-support.js";
import { createChatAbortMarker } from "./server-chat-state.js";
import { createGatewayMaintenanceStateForTest } from "./test-helpers.maintenance-state.js";
import { createRpcSourceForTest } from "./test-helpers.rpc-source.js";

// mock-isolation: Chat-state timers must not start the unrelated device expiry worker.
vi.mock("../infra/device-bootstrap.js", () => ({
  startDevicePairSetupMaintenance: vi.fn(async () => 0),
}));

const ABORTED_RUN_TTL_MS = 60 * 60_000;
async function createScenario() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-22T00:00:00Z"));
  const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
  const deps = createGatewayMaintenanceStateForTest();
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
  if (aborted) {
    deps.chatRunState.getOrCreate(runId).abortMarker = createChatAbortMarker(Date.now());
  }
  vi.setSystemTime(now);
}

describe("gateway chat-state maintenance", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(["progress", "aborted", "recent"] as const)(
    "sweeps abandoned records while retaining recent activity (%s)",
    async (kind) => {
      await using deps = await createScenario();
      const now = Date.now();
      const runId = `orphan-${kind}`;
      vi.setSystemTime(Date.now() - ABORTED_RUN_TTL_MS - 1);
      if (kind === "progress") {
        deps.chatRunState.registry.add(runId, { sessionKey: "main", clientRunId: runId });
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

  it.each(["execution", "embedded", "queued", "preparing"] as const)(
    "preserves a live %s owner until release",
    async (kind) => {
      await using deps = await createScenario();
      const runId = `live-${kind}`;
      seedStaleRunBuffers(deps, runId);
      let release: () => void;
      if (kind === "execution") {
        const claim = claimAgentRunContext(
          runId,
          { sessionKey: "main" },
          { trackOwner: true, ownsContext: true, protectFromSweep: true },
        );
        release = () => releaseAgentRunContext(runId, claim);
      } else if (kind === "embedded") {
        const handle = createEmbeddedRunHandle({ runId });
        setActiveEmbeddedRun("maintenance-session", handle, "main");
        release = () => clearActiveEmbeddedRun("maintenance-session", handle, "main");
      } else {
        const source = createRpcSourceForTest(
          {},
          {
            phase: kind === "queued" ? "waiting" : "preparing",
            sessionId: "maintenance-session",
            sessionKey: "main",
          },
        );
        rpcSourceTesting.set(runId, source);
        release = () => retireSessionControllerInput(source.input);
      }
      using _ = { [Symbol.dispose]: release };
      deps.start();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(deps.chatRunState.resolveBuffer(runId).text).toBe("buffer");
      release();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(deps.chatRunState.runs.has(runId)).toBe(false);
    },
  );
  it("prunes idle recipients on a timer without removing registered runs", async () => {
    await using deps = await createScenario();
    const { toolEventRecipients, registry, runs } = deps.chatRunState;
    toolEventRecipients.add("active-expired", "conn-active");
    toolEventRecipients.add("registered-expired", "conn-registered");
    registry.add("registered-expired", { sessionKey: "session-1", clientRunId: "client-1" });

    deps.start();
    // Grace boundaries are covered by server-chat-state.test.ts; exercise the periodic owner here.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(runs.has("active-expired")).toBe(false);
    expect(runs.get("registered-expired")?.toolRecipient).toBeUndefined();
    expect(registry.peek("registered-expired")?.clientRunId).toBe("client-1");
  });
});
