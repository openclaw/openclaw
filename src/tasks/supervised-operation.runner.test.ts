import { mkdirSync } from "node:fs";
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
} from "./supervised-operation.store.js";
import {
  claimSupervisedTask,
  createSupervisedTask,
  getSupervisedTask,
  heartbeatTaskSupervisor,
} from "./supervised-task.store.js";
import { encodeSupervisedWorkflowContract } from "./supervised-workflow.types.js";

const adapter = vi.hoisted(() => vi.fn());
vi.mock("./supervised-operation.publication.js", () => ({ runSupervisedPublication: adapter }));
vi.mock("./supervised-operation.ci.js", () => ({ runSupervisedCI: adapter }));
vi.mock("./supervised-workspace-versions.js", () => ({
  prepareSupervisedOperationWorkspace: async (_execution: unknown, contract: unknown) => ({
    contract,
  }),
}));
const dirs = createTempDirTracker();
afterEach(() => {
  vi.useRealTimers();
  closeOpenClawStateDatabaseForTest();
  dirs.cleanup();
});

it.each(["publication", "ci"] as const)(
  "leaves interrupted %s dispatch for reconciliation, not a cancelled receipt",
  async (kind) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1000);
    const root = dirs.make("supervised-runner-stop-");
    mkdirSync(`${root}/workspace`);
    const options = { path: `${root}/state.sqlite` };
    const workflow = encodeSupervisedWorkflowContract({
      version: 1,
      workspace: `${root}/workspace`,
      profiles: [
        {
          kind: "publication",
          id: "publication",
          repository: "upstream/repo",
          pushRepository: "author/repo",
          branch: "work",
          baseBranch: "main",
          baseCommit: "b".repeat(40),
          title: "Task update",
          body: "Evidence",
          timeoutMs: 60_000,
          publisher: {
            agentId: "poc",
            accountId: 1,
            login: "author",
            source: "system-detected",
            signingKey: "A".repeat(40),
            gitAuthor: { name: "Accepted Author", email: "accepted@example.test" },
          },
        },
        {
          kind: "ci",
          id: "ci",
          publicationProfile: "publication",
          requiredChecks: [{ name: "check", appId: 1 }],
          timeoutMs: 60_000,
        },
      ],
      acceptance: [{ kind: "receipts", criterionId: "published", profiles: ["publication", "ci"] }],
    }).contract;
    heartbeatTaskSupervisor("supervisor", 1000, 10_000, options);
    createSupervisedTask(
      {
        flowId: "work",
        agentId: "poc",
        runtime: "codex",
        model: "openai/test",
        prompt: "Publish accepted work",
        goal: {
          objective: "Publish",
          success: [{ id: "published", description: "Verified publication" }],
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
      { key: kind, kind, profile: kind },
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
    adapter
      .mockReset()
      .mockImplementation(
        async ({
          reserveDispatch,
          signal,
        }: {
          reserveDispatch: () => void;
          signal: AbortSignal;
        }) => {
          reserveDispatch();
          // Exercise the runner's actual signal handler after the effect boundary.
          process.emit("SIGTERM");
          signal.throwIfAborted();
        },
      );
    await runSupervisedOperationProcess(operation.operationId, execution.executionId, options);
    expect(adapter).toHaveBeenCalledOnce();
    expect(getSupervisedOperation(operation.operationId, options)).toMatchObject({
      state: "reconciling",
      outcome: null,
    });
    expect(getSupervisedOperationExecution(execution.executionId, options)).toMatchObject({
      dispatchedAt: 1000,
      outcome: null,
      leaseExpiresAt: 1000,
    });
    expect(getSupervisedTask("work", options)).toMatchObject({ phase: "waiting", endpoint: null });
  },
);
