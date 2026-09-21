// Imported by agent.test.ts to retain its shared mocked module graph.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { findTaskByRunId } from "../../tasks/task-registry.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import * as agentHandlerHelpers from "../agent-turn/agent-handler-helpers.js";
import { waitForAcceptedRunDispatch } from "./agent-clock.test-helpers.js";
import { spyDetachedCreateRunningTaskRun } from "./agent-task-tracking.test-helpers.js";
import {
  backendGatewayClient,
  describe0AfterEach0,
  getAgentTestMocks,
  invokeAgent,
  requireValue,
  resetAgentTaskRegistryForTests,
  useTestStateDir,
  waitForAgentCommandCall,
} from "./agent.test-harness.js";

const mocks = getAgentTestMocks();

describe("gateway accepted dispatch clock", () => {
  afterEach(describe0AfterEach0);
  it("fails an accepted request that never dispatches instead of starving the test timeout", async () => {
    vi.useFakeTimers();
    const respond = vi.fn();
    respond(true, { status: "accepted" });
    let pumps = 0;
    const pump = vi.spyOn(vi, "runOnlyPendingTimersAsync").mockImplementation(async () => {
      // Bound the broken implementation too, so the regression fails without hanging CI.
      if (++pumps === 2_000) {
        throw new Error("unbounded dispatch loop reached the regression guard");
      }
      return vi;
    });
    try {
      await expect(
        waitForAcceptedRunDispatch({
          respond,
          hasDispatched: () => false,
          initialRespondCallCount: 0,
        }),
      ).rejects.toThrow("Accepted agent request did not dispatch or return a terminal response");
    } finally {
      pump.mockRestore();
      vi.useRealTimers();
    }
  });
  it("keeps accepted native dispatch alive when preparation settles on the last fixture pump", async () => {
    await withTestDir({ prefix: "openclaw-gateway-native-dispatch-boundary-" }, async (root) => {
      useTestStateDir(root);
      resetAgentTaskRegistryForTests();
      const childSessionKey = "agent:main:subagent:native-delayed-child";
      const runId = "native-delayed-subagent-run";
      const baseClient = requireValue(backendGatewayClient(), "expected backend client");
      mocks.userTurnStorePath = "/tmp/sessions.json";
      mocks.loadSessionEntry.mockReturnValue({
        cfg: {},
        storePath: mocks.userTurnStorePath,
        entry: { sessionId: "spawned-child-session", updatedAt: Date.now() },
        canonicalKey: childSessionKey,
      });
      mocks.updateSessionStore.mockResolvedValue(undefined);
      mocks.agentCommand.mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: { durationMs: 100 },
      });
      const createRunningTaskRunSpy = spyDetachedCreateRunningTaskRun();
      const prepared = createDeferred();
      const originalYield = agentHandlerHelpers.yieldAfterAgentAcceptedAck;
      const advancePending = vi.runOnlyPendingTimersAsync.bind(vi);
      let pumps = 0;
      const pump = vi.spyOn(vi, "runOnlyPendingTimersAsync").mockImplementation(async () => {
        const advanced = await advancePending();
        // Release asynchronous preparation at the former final pump. Its acknowledgement
        // timer is now queued, but that pump's timer snapshot has already been drained.
        if (++pumps === 50) {
          prepared.resolve();
        }
        return advanced;
      });
      const yieldAck = vi
        .spyOn(agentHandlerHelpers, "yieldAfterAgentAcceptedAck")
        .mockImplementation(async () => {
          await prepared.promise;
          return originalYield();
        });
      const respond = vi.fn();
      try {
        await invokeAgent(
          {
            message: "delayed native subagent child run",
            sessionKey: childSessionKey,
            idempotencyKey: runId,
          },
          {
            reqId: runId,
            client: {
              connect: baseClient.connect,
              internal: { ...baseClient.internal, agentRunTracking: "native_subagent" },
            },
            respond,
          },
        );
        await waitForAgentCommandCall();
        expect(createRunningTaskRunSpy).not.toHaveBeenCalled();
        expect(findTaskByRunId(runId)).toBeUndefined();
      } finally {
        prepared.resolve();
        pump.mockRestore();
        yieldAck.mockRestore();
      }
    });
  });
});
