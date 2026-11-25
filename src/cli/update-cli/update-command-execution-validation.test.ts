// Install the fixture mocks before loading the execution owner and its dependencies.
import "./update-command-execution.test-support.js";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  updateRunStepsFromResultStep,
  updateRunWarningMessages,
} from "../../infra/update-run-step.js";
import type { UpdateStepProgress } from "../../infra/update-runner-types.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { registerExecutionPhaseReceiptTests } from "./update-command-execution-phase.test-support.js";
import { executeMutableUpdate } from "./update-command-execution.js";
import { updateStep } from "./update-command-maintenance-fixtures.test-support.js";
import * as readiness from "./update-command-readiness.js";

const {
  bindExecutionGuards,
  executionParams,
  mocks,
  packageCandidate,
  readyCandidate,
  successfulUpdate,
} = await import("./update-command-execution.test-support.js");

const phaseAdmission = vi.hoisted(() => ({ active: false }));
const execute = async (params = executionParams("git")) =>
  executeMutableUpdate(await bindExecutionGuards(params));
function gitCandidate(onValidated: (steps: unknown) => void = () => {}, gitMode = false) {
  mocks.runGitUpdate.mockImplementation(
    async ({
      inspectGitTarget,
      validateCandidate,
    }: Parameters<typeof import("./update-command-git.js").updateGitInstall>[0]) => {
      expect(validateCandidate).toBeTypeOf("function");
      await inspectGitTarget({ sha: "a".repeat(40), version: "1.0.1" });
      onValidated(await validateCandidate!("/candidate"));
      return gitMode ? { ...successfulUpdate, mode: "git" } : successfulUpdate;
    },
  );
}
vi.mock("../../infra/sqlite-worker-operation-admission.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../infra/sqlite-worker-operation-admission.js")>();
  return {
    ...actual,
    createSqliteWorkerOperationAdmission: (
      ...args: Parameters<typeof actual.createSqliteWorkerOperationAdmission>
    ) => {
      const [admit, attachment] = args;
      return actual.createSqliteWorkerOperationAdmission((request, grant) => {
        phaseAdmission.active = true;
        try {
          admit(request, grant);
        } finally {
          phaseAdmission.active = false;
        }
      }, attachment);
    },
  };
});

registerExecutionPhaseReceiptTests({ executionParams, mocks, successfulUpdate, phaseAdmission });
it("leaves the checkout's artifact lock to the developer during a Git update", async () =>
  withTestDir({ prefix: "release-artifact-admission-" }, async (root) => {
    await fs.mkdir(path.join(root, ".git"));
    // A developer build in the preserved checkout holds its artifact lock.
    const lock = path.join(root, ".artifacts", "dist-artifacts.lock");
    await fs.mkdir(lock, { recursive: true });
    await fs.writeFile(
      path.join(lock, "owner.json"),
      JSON.stringify({ pid: 0x7fff_ffff, startedAt: "2026-09-20T01:00:00.000Z" }),
    );
    gitCandidate(undefined, true);

    const execution = await execute({ ...executionParams("git"), root });

    expect(execution?.result.status).toBe("ok");
    expect(mocks.runGitUpdate).toHaveBeenCalledOnce();
  }));

it("continues the update with its recorded candidate advisory", async () => {
  const message = "This version uses the current updater to finish installation";
  const step = updateStep("candidate-recovery", {
    command: "--check",
    cwd: "/candidate",
    exitCode: null,
    advisory: { kind: "candidate-runtime-unavailable", message },
  });
  mocks.checkCandidate.mockResolvedValue(readyCandidate([step]));
  gitCandidate();
  const onStepComplete = vi.fn<NonNullable<UpdateStepProgress["onStepComplete"]>>();

  const execution = await execute({ ...executionParams("git"), progress: { onStepComplete } });

  expect(execution?.result.status).toBe("ok");
  expect(onStepComplete).toHaveBeenCalledWith(expect.objectContaining(step));
  const recorded = onStepComplete.mock.calls.flatMap(([completed]) =>
    updateRunStepsFromResultStep(completed),
  );
  expect(updateRunWarningMessages(recorded)).toEqual([message]);
  expect(recorded.every((entry) => entry.status === "completed")).toBe(true);
});

it("reports the post-stop activation checks as a timed step", async () => {
  // Gateway readiness is outside this timed-step contract.
  vi.spyOn(readiness, "verifyPreviousGatewayForUpdate").mockResolvedValue(true);
  mocks.runPackageUpdate.mockImplementation(packageCandidate("/candidate"));
  const onStepComplete = vi.fn<NonNullable<UpdateStepProgress["onStepComplete"]>>();

  const execution = await execute({
    ...executionParams("package"),
    shouldRestart: false,
    progress: { onStepComplete },
  });

  expect(execution?.result.status).toBe("ok");
  const step = execution?.result.steps.find((entry) => entry.name === "post-stop-checks");
  expect(step).toMatchObject({ exitCode: 0, durationMs: expect.any(Number) });
  expect(onStepComplete).toHaveBeenCalledWith(expect.objectContaining({ ...step }));
});

it("retains rejected candidate check findings in the terminal result", async () => {
  const fact = {
    check: "runtime",
    code: "candidate-runtime-failed",
    message: "The update could not load its recovery runtime (exit 1).",
  };
  mocks.checkCandidate.mockResolvedValue({
    status: "error",
    steps: [
      updateStep("candidate-recovery", {
        command: "--check",
        cwd: "/candidate",
        exitCode: 1,
        stderrTail: fact.message,
        failureFacts: [fact],
      }),
    ],
  });
  gitCandidate(undefined, true);

  const execution = await execute();

  expect(execution?.result).toMatchObject({
    status: "error",
    reason: "runtime-verification-failed",
    steps: [{ failureFacts: [fact] }],
  });
  expect(mocks.serviceStopped).toBe(false);
});
