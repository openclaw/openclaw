import { mkdirSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { launchSupervisedOperationProcess } from "./supervised-operation.launch.js";
import {
  enqueueSupervisedOperation,
  getSupervisedOperation,
  getSupervisedOperationExecution,
} from "./supervised-operation.store.js";
import {
  claimSupervisedTask,
  createSupervisedTask,
  heartbeatTaskSupervisor,
  reserveSupervisedDispatch,
} from "./supervised-task.store.js";
import { readSupervisedWorkflow } from "./supervised-workflow.persistence.js";
import { encodeSupervisedWorkflowContract } from "./supervised-workflow.types.js";

// Real ChildProcess spawn/exit and real SQL. Force the pre-observation window:
// Node rejects its argv before loading any runner or starting descendants, and
// the parent's child-PID observation is unavailable. No model/systemd/runtime.
vi.mock("../infra/runtime-process-url.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/runtime-process-url.js")>()),
  resolveRuntimeProcessEntrypointUrl: () => new URL("file:///unused-bootstrap.mjs"),
}));
vi.mock("../infra/runtime-worker-url.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/runtime-worker-url.js")>()),
  resolveRuntimeWorkerArgv: () => ["--invalid-openclaw-bootstrap-option"],
}));
vi.mock("../node-host/node-worker-process-identity.js", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("../node-host/node-worker-process-identity.js")>();
  return {
    ...real,
    requireNodeWorkerProcessIdentity: (pid: number) => {
      if (pid !== process.pid) {
        throw new Error("Injected unavailable child identity");
      }
      return real.requireNodeWorkerProcessIdentity(pid);
    },
  };
});
const dirs = createTempDirTracker();
afterEach(() => {
  vi.useRealTimers();
  closeOpenClawStateDatabaseForTest();
  dirs.cleanup();
});

describe.skipIf(process.platform !== "linux")("real pre-observation bootstrap exits", () => {
  it("returns capacity after repeated bootstrap exits without fabricating execution outcomes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1002);
    const root = dirs.make("openclaw-bootstrap-exits-");
    const options = { env: { OPENCLAW_STATE_DIR: `${root}/state` } };
    const goal = {
      objective: "Run a check",
      success: [{ id: "correct", description: "Host check passes" }],
      partial: [],
    };
    heartbeatTaskSupervisor("coordinator", 1000, 10_000, options);
    for (let index = 0; index < 9; index++) {
      const workspace = `${root}/workspace-${index}`;
      mkdirSync(workspace);
      const workflow = encodeSupervisedWorkflowContract(
        {
          version: 1,
          workspace,
          profiles: [
            {
              kind: "command",
              id: "check",
              executable: process.execPath,
              executableSha256: "0".repeat(64),
              argv: ["--version"],
              timeoutMs: 1000,
            },
          ],
          acceptance: [{ kind: "receipts", criterionId: "correct", profiles: ["check"] }],
        },
        goal,
      ).contract;
      const task = createSupervisedTask(
        {
          flowId: `bootstrap-${index}`,
          agentId: "poc",
          runtime: "codex",
          model: "openai/test",
          prompt: "Check it",
          goal,
          workflow,
          policy: { deadlineAt: 100_000, maxAttempts: 10, attemptTimeoutMs: 10_000 },
        },
        "coordinator",
        1000,
        options,
      );
      const attempt = reserveSupervisedDispatch(
        claimSupervisedTask(task.flowId, "coordinator", 1000, options)!,
        1000,
        options,
      );
      const operation = enqueueSupervisedOperation(
        attempt,
        { key: "check", kind: "command", profile: "check" },
        1001,
        options,
      );
      await expect(
        launchSupervisedOperationProcess(operation.operationId, options),
      ).rejects.toThrow(/unavailable child identity/);
      const executionId = getSupervisedOperation(operation.operationId, options)!.executionId!;
      await expect
        .poll(
          () =>
            readSupervisedWorkflow(
              (db) =>
                executeSqliteQuerySync(
                  db,
                  getNodeSqliteKysely<DB>(db)
                    .selectFrom("task_flow_operation_launches")
                    .select("state")
                    .where("execution_id", "=", executionId),
                ).rows[0]?.state,
              options,
            ),
          { timeout: 5000, interval: 20 },
        )
        .toBe("gone");
      expect(getSupervisedOperationExecution(executionId, options)).toMatchObject({
        process: null,
        dispatchedAt: null,
        outcome: null,
      });
      closeOpenClawStateDatabaseForTest();
    }
  }, 15_000);
});
