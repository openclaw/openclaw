// Registered in agent.test.ts's existing handler suite and cleanup lifetime.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findTaskByRunId } from "../../tasks/task-registry.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import {
  mockSpawnedChildSessionEntry,
  spyDetachedCreateRunningTaskRun,
} from "./agent-task-tracking.test-helpers.js";
import { nativeSubagentClient } from "./agent.spawned-child.test-support.js";
import {
  backendGatewayClient,
  expectRecordFields,
  getAgentTestMocks,
  invokeAgent,
  makeContext,
  mockCallArg,
  resetAgentTaskRegistryForTests,
  useTestStateDir,
  waitForAgentCommandCall,
} from "./agent.test-harness.js";

const mocks = getAgentTestMocks();

export function registerNativeSubagentTaskTrackingTests() {
  describe("native subagent child run task tracking", () => {
    it("suppresses the gateway CLI task row for native subagent child runs", async () => {
      await withTestDir({ prefix: "openclaw-gateway-native-subagent-" }, async (root) => {
        useTestStateDir(root);
        resetAgentTaskRegistryForTests();
        const childSessionKey = "agent:main:subagent:native-child";
        const runId = "native-subagent-run";
        mockSpawnedChildSessionEntry(childSessionKey, root);
        const createRunningTaskRunSpy = spyDetachedCreateRunningTaskRun();

        const context = makeContext();
        const trackExecution = context.trackExecution;
        let execution: Promise<unknown> | undefined;
        context.trackExecution = (run) => {
          const pending = trackExecution(run);
          execution = pending;
          return pending;
        };
        const respond = await invokeAgent(
          {
            message: "native subagent child run",
            sessionKey: childSessionKey,
            idempotencyKey: runId,
          },
          { reqId: runId, client: nativeSubagentClient(), context, flushDispatch: false },
        );
        // This case owns no clock semantics. Join the accepted run on real timers so
        // pre-dispatch failures also settle and the row assertion covers its full lifetime.
        expect(execution, JSON.stringify(respond.mock.calls)).toBeDefined();
        await execution;
        expect(respond.mock.calls.at(-1)?.slice(0, 2)).toEqual([
          true,
          expect.objectContaining({ runId, status: "ok" }),
        ]);
        expect(mocks.agentCommand).toHaveBeenCalledTimes(1);
        expect(mocks.stageSessionPendingInput).toHaveBeenCalledWith(
          expect.objectContaining({
            storePath: path.join(root, "agents", "main", "sessions", "sessions.json"),
          }),
          expect.anything(),
        );

        // src/agents/subagent-spawn.ts owns the `subagent` row for this runId.
        expect(createRunningTaskRunSpy).not.toHaveBeenCalled();
        expect(findTaskByRunId(runId)).toBeUndefined();
      });
    });

    it("keeps CLI tracking for an unmarked backend turn on a subagent session", async () => {
      await withTestDir({ prefix: "openclaw-gateway-native-subagent-unmarked-" }, async (root) => {
        useTestStateDir(root);
        resetAgentTaskRegistryForTests();
        const childSessionKey = "agent:main:subagent:unmarked-child";
        const runId = "native-subagent-unmarked";
        mockSpawnedChildSessionEntry(childSessionKey, root);
        const createRunningTaskRunSpy = spyDetachedCreateRunningTaskRun();

        // An operator follow-up to a subagent session owns no registry row, so
        // suppressing here would lose the run from the tasks rail entirely.
        await invokeAgent(
          { message: "operator follow-up", sessionKey: childSessionKey, idempotencyKey: runId },
          { reqId: runId, client: backendGatewayClient() },
        );
        await waitForAgentCommandCall();

        expect(createRunningTaskRunSpy).toHaveBeenCalledTimes(1);
        expectRecordFields(mockCallArg(createRunningTaskRunSpy), {
          runtime: "cli",
          runId,
          childSessionKey,
        });
      });
    });
  });
}
