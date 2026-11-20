import { afterEach, expect, it, vi } from "vitest";
import { captureAgentHarnessCompletionCustody } from "../agents/agent-harness-completion-custody.js";
import { createAgentHarnessCompletionScope } from "../agents/agent-harness-completion-scope.js";
import { createSubagentRunRecord } from "../agents/subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { loadExactSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { startGatewayMaintenanceTimers } from "./server-maintenance.js";
import { captureOperatorToolGatewayContinuationContext } from "./server-plugin-in-process-authority.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";
import { persistGatewaySessionLifecycleEvent } from "./session-lifecycle-state.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjectionFixture } from "./session-row-projection.test-support.js";
import { createGatewayMaintenanceStateForTest } from "./test-helpers.maintenance-state.js";

// mock-isolation: This scheduler regression does not own device-pair expiry workers.
vi.mock("../infra/device-bootstrap.js", () => ({
  startDevicePairSetupMaintenance: vi.fn(async () => 0),
}));

afterEach(() => vi.restoreAllMocks());

it.for(["direct", "kept-child", "pending-child", "retained-continuation", "native-child"] as const)(
  "settles only an unreachable parked lifecycle (%s)",
  (shape) =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = { agents: { entries: { main: {} } } };
      setRuntimeConfigSnapshot(cfg);
      const sessionKey = "agent:main:subagent:kept-synthetic";
      const runId = "direct-human-followup";
      const target = {
        agentId: "main",
        sessionKey,
        sessionId: "kept-synthetic",
        storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
      };
      await replaceSessionEntry(target, {
        sessionId: target.sessionId,
        updatedAt: 100,
        lifecycleRevision: "synthetic-revision",
        activeWriterRunId: runId,
        ...(shape !== "direct"
          ? { createdVia: "spawn" as const, spawnedBy: "agent:main:main" }
          : {}),
      });
      for (const event of [
        { ts: 100, data: { phase: "start", startedAt: 100 } },
        {
          ts: 120,
          data: { phase: "end", yielded: true, livenessState: "paused", stopReason: "end_turn" },
        },
      ]) {
        await persistGatewaySessionLifecycleEvent({
          sessionKey,
          agentId: "main",
          event: { ...event, runId, sessionId: target.sessionId },
        });
      }
      const entry = loadExactSessionEntry(target)!.entry;
      expect(entry.status).toBeUndefined();
      expect(subagentRuns.get(runId)).toBeUndefined();
      subagentRuns.set(
        "completed-original-task",
        createSubagentRunRecord({
          runId: "completed-original-task",
          childSessionKey: sessionKey,
          childAgentId: "main",
          cleanup: "keep",
          execution: { status: "terminal", endedAt: 90, outcome: { status: "ok" } },
          delivery: { status: "delivered" },
          cleanupCompletedAt: 95,
        }),
      );
      if (shape === "pending-child") {
        subagentRuns.set(
          "synthetic-grandchild",
          createSubagentRunRecord({
            runId: "synthetic-grandchild",
            childSessionKey: "agent:main:subagent:grandchild",
            childAgentId: "main",
            requesterSessionKey: sessionKey,
            requesterAgentId: "main",
            expectsCompletionMessage: true,
            execution: { status: "running", startedAt: 110 },
            requesterSettleWake: {
              status: "pending",
              attemptCount: 0,
              requesterYieldBatch: true,
              requesterRunId: runId,
              batchRunIds: ["synthetic-grandchild"],
            },
          }),
        );
      }
      const context = createContext([], () => cfg);
      const resolveGatewayContext = () => context;
      context.resolveGatewayContext = resolveGatewayContext;
      const projection = createSessionRowProjectionFixture({
        cfg,
        store: { [sessionKey]: entry },
        storePath: target.storePath,
      });
      bindSessionRowProjection(context, () => projection);
      const retained =
        shape === "retained-continuation" || shape === "native-child"
          ? await withPluginRuntimeGatewayRequestScope(
              { context, resolveGatewayContext, isWebchatConnect: () => false },
              () =>
                shape === "native-child"
                  ? captureAgentHarnessCompletionCustody(
                      createAgentHarnessCompletionScope({
                        requesterSessionKey: sessionKey,
                        requesterAgentId: "main",
                        gatewayContextResolver: resolveGatewayContext,
                      }),
                    )
                  : captureOperatorToolGatewayContinuationContext({ sessionKey, agentId: "main" }),
            )
          : undefined;
      const clock = createGatewaySchedulerClock();
      const timers = startGatewayMaintenanceTimers({
        ...createGatewayMaintenanceStateForTest(),
        scheduler: createTestGatewayScheduler(clock.clock),
        resolveGatewayContext,
      });
      try {
        await clock.advanceBy(60_000);
        const settled = loadExactSessionEntry(target)!.entry;
        if (
          shape === "pending-child" ||
          shape === "retained-continuation" ||
          shape === "native-child"
        ) {
          expect(settled.status).toBeUndefined();
          if (retained) {
            expect(retained).toBeDefined();
            retained!.release();
            await clock.advanceBy(60_000);
            expect(loadExactSessionEntry(target)!.entry.status).toBe("failed");
          }
        } else {
          expect(settled.status).toBe("failed");
          expect(settled.lastRunError).toContain("no registered continuation");
          expect(settled.lastRunError).not.toContain("restarted");
        }
      } finally {
        await timers.stopPeriodicTasks();
        await timers.skillUsageCleanup();
        retained?.release();
        subagentRuns.delete("completed-original-task");
        subagentRuns.delete("synthetic-grandchild");
        projection.dispose();
      }
    }),
);
