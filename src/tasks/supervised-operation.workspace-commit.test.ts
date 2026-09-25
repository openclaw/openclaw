import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeWorkerProcessIdentity } from "../node-host/node-worker-process-identity.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { runSupervisedOperationProcess } from "./supervised-operation.runner.js";
import {
  claimSupervisedOperation,
  enqueueSupervisedOperation,
  getSupervisedOperation,
  getSupervisedOperationExecution,
  reserveSupervisedOperationDispatch,
} from "./supervised-operation.store.js";
import {
  claimSupervisedTask,
  createSupervisedTask,
  heartbeatTaskSupervisor,
} from "./supervised-task.store.js";
import { writeSupervisedWorkflow } from "./supervised-workflow.persistence.js";
import { encodeSupervisedWorkflowContract } from "./supervised-workflow.types.js";
import {
  getSupervisedWorkspaceHead,
  prepareSupervisedOperationWorkspace,
  supervisedWorkspaceVersionPath,
} from "./supervised-workspace-versions.js";

const command = vi.hoisted(() => vi.fn());
vi.mock("./supervised-operation.command.js", () => ({ runSupervisedCommand: command }));
const dirs = createTempDirTracker();
afterEach(() => {
  vi.useRealTimers();
  closeOpenClawStateDatabaseForTest();
  dirs.cleanup();
});

it.each([false, true])(
  "commits command output and receipt together (write failure: %s)",
  async (fail) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1000);
    const root = dirs.make("supervised-command-commit-");
    const workspace = `${root}/workspace`;
    mkdirSync(workspace);
    writeFileSync(`${workspace}/answer.txt`, "before");
    const options = { path: `${root}/state.sqlite` };
    const workflow = encodeSupervisedWorkflowContract({
      version: 1,
      workspace,
      profiles: [
        {
          kind: "command",
          id: "repair",
          executable: process.execPath,
          executableSha256: "0".repeat(64),
          argv: ["--version"],
          timeoutMs: 1000,
          writable: true,
        },
      ],
      acceptance: [{ kind: "operator", criterionId: "correct" }],
    }).contract;
    heartbeatTaskSupervisor("supervisor", 1000, 10_000, options);
    createSupervisedTask(
      {
        flowId: "work",
        agentId: "poc",
        runtime: "codex",
        model: "openai/test",
        prompt: "Repair the accepted workspace",
        goal: {
          objective: "Repair",
          success: [{ id: "correct", description: "Accepted repair" }],
          partial: [],
        },
        policy: { deadlineAt: 100_000, maxAttempts: 10, attemptTimeoutMs: 10_000 },
        workflow,
      },
      "supervisor",
      1000,
      options,
    );
    const attempt = claimSupervisedTask("work", "supervisor", 1000, options)!;
    const operation = enqueueSupervisedOperation(
      attempt,
      { key: "repair", kind: "command", profile: "repair", input: {} },
      1000,
      options,
    );
    const execution = claimSupervisedOperation(
      operation.operationId,
      "runner",
      1000,
      options,
      requireNodeWorkerProcessIdentity(process.pid),
    )!;
    let originalHead: ReturnType<typeof getSupervisedWorkspaceHead>;
    const outcome = { status: "succeeded", summary: "Repaired", facts: {}, artifacts: [] };
    command
      .mockReset()
      .mockImplementation(async ({ assertCurrent }: { assertCurrent: () => void }) => {
        const draft = await prepareSupervisedOperationWorkspace(
          execution,
          workflow,
          options,
          true,
          assertCurrent,
        );
        originalHead = getSupervisedWorkspaceHead("work", 1, options);
        writeFileSync(`${draft.contract.workspace}/answer.txt`, "after");
        reserveSupervisedOperationDispatch(execution, 1000, options);
        if (fail) {
          writeSupervisedWorkflow((db) => {
            // sqlite-allow-raw -- Inject a real receipt write failure, after command dispatch, in the isolated test database.
            db.exec(
              "CREATE TRIGGER reject_receipt BEFORE UPDATE ON task_flow_operation_executions WHEN json_extract(NEW.record_json, '$.outcome') IS NOT NULL BEGIN SELECT RAISE(ABORT, 'receipt write failed'); END",
            );
          }, options);
        }
        return { workspace: draft.contract.workspace, outcome };
      });
    const run = runSupervisedOperationProcess(
      operation.operationId,
      execution.executionId,
      options,
    );
    if (fail) {
      await expect(run).rejects.toThrow("receipt write failed");
    } else {
      await run;
    }
    expect(command).toHaveBeenCalledOnce();
    // Reopen the database: neither an in-memory receipt nor a copied file is acceptance.
    closeOpenClawStateDatabaseForTest();
    const head = getSupervisedWorkspaceHead("work", 1, options)!;
    expect(head.version_id === originalHead?.version_id).toBe(fail);
    expect(
      readFileSync(
        `${supervisedWorkspaceVersionPath(head.version_id, options)}/answer.txt`,
        "utf8",
      ),
    ).toBe(fail ? "before" : "after");
    expect(getSupervisedOperation(operation.operationId, options)?.outcome).toEqual(
      fail ? null : outcome,
    );
    expect(getSupervisedOperationExecution(execution.executionId, options)?.outcome).toEqual(
      fail ? null : outcome,
    );
  },
);
