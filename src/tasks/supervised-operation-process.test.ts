import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
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
  stopTaskSupervisor,
} from "./supervised-task.store.js";
import { encodeSupervisedWorkflowContract } from "./supervised-workflow.types.js";
import { resolveSupervisedWorkflowWorkspace } from "./supervised-workspace-versions.js";

const dirs = createTempDirTracker();
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  dirs.cleanup();
});

describe.skipIf(process.platform !== "linux")("independent durable command process", () => {
  it("writes one receipt without a live coordinator, despite duplicate launches", async () => {
    const root = dirs.make("openclaw-independent-operation-");
    const workspace = `${root}/work`;
    await fs.mkdir(workspace);
    await fs.writeFile(`${workspace}/source.txt`, "accepted source\n");
    const now = Date.now();
    const options = { env: { OPENCLAW_STATE_DIR: `${root}/state` } };
    const goal = {
      objective: "Exercise independent process custody",
      success: [{ id: "effect", description: "One observed effect" }],
      partial: [],
    };
    const workflow = encodeSupervisedWorkflowContract(
      {
        version: 1,
        workspace,
        sourcePaths: ["."],
        profiles: [
          {
            kind: "command",
            id: "effect",
            executable: process.execPath,
            executableSha256: createHash("sha256")
              .update(await fs.readFile(process.execPath))
              .digest("hex"),
            argv: [
              "--input-type=module",
              "-e",
              "import fs from 'node:fs'; setTimeout(() => { fs.appendFileSync('effects.txt', 'one\\n'); console.log('completed'); }, 500);",
            ],
            writable: true,
            timeoutMs: 10_000,
          },
        ],
        acceptance: [{ kind: "receipts", criterionId: "effect", profiles: ["effect"] }],
      },
      goal,
    ).contract;
    heartbeatTaskSupervisor("coordinator", now, 10_000, options);
    const task = createSupervisedTask(
      {
        agentId: "poc",
        runtime: "codex",
        model: "openai/test",
        prompt: "Run accepted operation",
        goal,
        workflow,
        policy: { deadlineAt: now + 60_000, attemptTimeoutMs: 10_000, maxAttempts: 4 },
      },
      "coordinator",
      now,
      options,
    );
    const attempt = reserveSupervisedDispatch(
      claimSupervisedTask(task.flowId, "coordinator", now, options)!,
      now,
      options,
    );
    const operation = enqueueSupervisedOperation(
      attempt,
      { key: "once", kind: "command", profile: "effect" },
      now,
      options,
    );
    await Promise.all([
      launchSupervisedOperationProcess(operation.operationId, options),
      launchSupervisedOperationProcess(operation.operationId, options),
    ]);
    stopTaskSupervisor("coordinator", Date.now(), options);
    await expect
      .poll(
        () => {
          const observed = getSupervisedOperation(operation.operationId, options);
          if (observed?.state === "reconciling") {
            throw new Error(
              JSON.stringify({
                operation: observed,
                execution: observed.executionId
                  ? getSupervisedOperationExecution(observed.executionId, options)
                  : null,
              }),
            );
          }
          return observed?.outcome;
        },
        {
          timeout: 45_000,
          interval: 250,
        },
      )
      .toBeTruthy();
    expect(getSupervisedOperation(operation.operationId, options)?.outcome).toMatchObject({
      status: "succeeded",
      facts: { exitCode: "0", stderr: "" },
    });
    await expect(fs.readFile(`${workspace}/effects.txt`, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    const accepted = resolveSupervisedWorkflowWorkspace(
      workflow,
      task.flowId,
      task.episode,
      options,
    );
    expect(await fs.readFile(`${accepted.workspace}/effects.txt`, "utf8")).toBe("one\n");
    const result = getSupervisedOperation(operation.operationId, options)!;
    expect(result.generation).toBe(1);
    expect(result.outcome?.facts).toMatchObject({
      exitCode: "0",
      stdout: "completed\n",
      cleanup: "observed",
    });
  }, 60_000);
});

describe("accepted command input identity", () => {
  // Changed accepted bytes are rejected at the live launch boundary: see
  // supervised-command-workspace.test.ts, which drives
  // prepareSupervisedCommandWorkspace through digest, symlink and hardlink
  // violations. Inputs are frozen into a read-only input root before dispatch,
  // so a mutation of the original cannot reach a running command.
  it("rejects path-only executable profiles instead of treating mutable paths as accepted bytes", () => {
    expect(() =>
      encodeSupervisedWorkflowContract({
        version: 1,
        workspace: "/fixture",
        profiles: [
          { kind: "command", id: "check", executable: "/runtime", argv: [], timeoutMs: 1000 },
        ],
        acceptance: [{ kind: "operator", criterionId: "correct" }],
      }),
    ).toThrow();
  });
});
