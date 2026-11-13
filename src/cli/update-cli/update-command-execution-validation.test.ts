// Install the fixture mocks before loading the execution owner and its dependencies.
import "./update-command-execution.test-support.js";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createUpdateRun } from "../../infra/update-run-ledger.js";
import {
  updateRunStepsFromResultStep,
  updateRunWarningMessages,
} from "../../infra/update-run-step.js";
import type { UpdateStepProgress } from "../../infra/update-runner-types.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { registerExecutionPhaseReceiptTests } from "./update-command-execution-phase.test-support.js";
import { executeMutableUpdate } from "./update-command-execution.js";
import { admitSourceUpdateArtifacts } from "./update-command-git-admission.js";
import { updateStep } from "./update-command-maintenance-fixtures.test-support.js";
import * as readiness from "./update-command-readiness.js";
import { withUpdateCommandTerminalResult } from "./update-command-terminal.js";

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
it.each([
  { owner: "dead", changed: false },
  { owner: "absent", changed: false },
  { owner: "absent", changed: true },
])(
  "admits installed artifacts before Git mutation (owner=$owner, changed=$changed)",
  async ({ owner, changed }) =>
    withTestDir({ prefix: "source-artifact-admission-" }, async (root) => {
      await fs.mkdir(path.join(root, ".git"));
      await fs.mkdir(path.join(root, "scripts"));
      await fs.writeFile(
        path.join(root, "scripts", "stage-bundled-plugin-runtime.mts"),
        `import fs from "node:fs";
import path from "node:path";
export function prepareBundledPluginRuntime({ repoRoot }) {
  const stage = path.join(repoRoot, ".artifacts", "admission-stage");
  fs.mkdirSync(stage);
  return {
    changed: ${changed},
    publish: async () => { throw new Error("Admission must not publish runtime"); },
    cleanup: async () => fs.rmSync(stage, { recursive: true }),
  };
}
`,
      );
      const lock = path.join(root, ".artifacts", "dist-artifacts.lock");
      const ownerFile = path.join(lock, "owner.json");
      const pid = 0x7fff_ffff;
      const ownerRecord = JSON.stringify({
        pid,
        startedAt: "2026-09-20T01:00:00.000Z",
        startIdentity: "fixture-build-owner",
        heartbeatAt: "2026-09-20T01:01:00.000Z",
      });
      if (owner !== "absent") {
        await fs.mkdir(lock, { recursive: true });
        await fs.writeFile(ownerFile, ownerRecord);
      }
      const onActivation = vi.fn();
      const env = { OPENCLAW_STATE_DIR: path.join(root, "state") };
      const run = { runId: createUpdateRun({ trigger: "cli" }, { env }).runId, env };
      const execution = await withUpdateCommandTerminalResult(async (registerRun) => {
        registerRun(run);
        const result = await execute({
          ...executionParams("git"),
          root,
          opts: { json: true, run },
          onActivation,
        });
        if (owner === "absent") {
          await expect(admitSourceUpdateArtifacts(root, run)).rejects.toThrow(
            `retained by PID ${process.pid}`,
          );
        }
        return result;
      });

      expect(mocks.serviceStopped).toBe(false);
      expect(
        mocks.maybeStopService.mock.calls.every(([params]) => params.phase === "inspect"),
      ).toBe(true);
      expect(mocks.prepareMutableUpdate).not.toHaveBeenCalled();
      expect(onActivation).not.toHaveBeenCalled();
      expect(execution?.mutationStarted).toBe(false);
      if (owner !== "absent") {
        expect(mocks.runGitUpdate).not.toHaveBeenCalled();
        expect(execution?.result).toMatchObject({
          status: "error",
          reason: "source-artifact-ownership",
        });
        expect(execution?.failure?.detail).toContain(lock);
        expect(execution?.failure?.detail).toContain(`retained by PID ${pid}`);
        expect(execution?.failure?.detail).toContain("to release and retry");
        expect(await fs.readFile(ownerFile, "utf8")).toBe(ownerRecord);
      } else {
        expect(execution?.result.status, execution?.failure?.detail).toBe("ok");
        expect(mocks.runGitUpdate).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ sourceRuntimePrepared: !changed }),
        );
        await expect(fs.stat(ownerFile)).rejects.toMatchObject({ code: "ENOENT" });
      }
      await expect(fs.stat(path.join(root, ".artifacts", "admission-stage"))).rejects.toMatchObject(
        {
          code: "ENOENT",
        },
      );
    }),
);

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
