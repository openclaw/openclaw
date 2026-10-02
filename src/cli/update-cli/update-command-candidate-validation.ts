import { isDeepStrictEqual } from "node:util";
import { resolveStateDir } from "../../config/paths.js";
import { validateUpdateCandidateCanary } from "../../infra/update-candidate-canary.js";
import { createUpdateDoctorConfigWarningStep } from "../../infra/update-doctor-config.js";
import { isFailedUpdateStep } from "../../infra/update-run-step.js";
import { recordUpdateRunStepAsync } from "../../infra/update-run-write.async.js";
import { reportUpdateStepCompletion } from "../../infra/update-runner-command.js";
import type { UpdateRunResult, UpdateStepProgress } from "../../infra/update-runner-types.js";
import { defaultRuntime } from "../../runtime.js";
import { prepareOpenClawStateReadSource } from "../../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import { UpdatePreMutationError, type UpdateCommandOptions } from "./shared.js";
import type { createUpdateCommandExecutionGuards } from "./update-command-execution-guards.js";
import type { readUpdateCandidateSource } from "./update-command-managed-context.js";
import { isUpdatedInstallGatewayExecutorSupported } from "./update-command-service-command.js";
import { resolveUpdatedInstallCommandEnv } from "./update-command-service-env.js";

export async function validateUpdateCandidateWithProgress(
  params: Pick<Parameters<typeof validateUpdateCandidateCanary>[0], "root" | "config"> & {
    env: NodeJS.ProcessEnv;
    assertCurrent: () => void;
    writeOptions: ReturnType<
      ReturnType<typeof createUpdateCommandExecutionGuards>["captureWriteOptions"]
    >;
  },
  execution: {
    packageUpdateNodeRunner?: string;
    timeoutMs?: number;
    opts: Pick<UpdateCommandOptions, "json">;
    progress: UpdateStepProgress;
  },
  run: UpdateCommandOptions["run"],
) {
  const assertCurrent = params.assertCurrent;
  const writeOptions = run ? { ...params.writeOptions } : undefined;
  const originalContext = writeOptions?.context;
  const source = originalContext
    ? prepareOpenClawStateReadSource({
        path: originalContext.admission.databasePath,
        env: writeOptions?.env,
      })
    : undefined;
  if (originalContext && source) {
    const initial = source.current();
    originalContext.admission.assertCurrent();
    if (
      initial.admission.identity.key !== originalContext.admission.identity.key ||
      initial.admission.identity.birthtime !== originalContext.admission.identity.birthtime ||
      initial.maintenanceScope !== originalContext.maintenanceScope ||
      initial.existingSchemaPath !== originalContext.existingSchemaPath
    ) {
      throw new Error("Candidate progress lost its original state source.");
    }
  }
  const validate = () =>
    validateUpdateCandidateCanary({
      ...params,
      assertCurrent,
      stateDir: resolveStateDir(params.env),
      nodeRunner: execution.packageUpdateNodeRunner,
      timeoutMs: execution.timeoutMs,
      onProgress: async (step) => {
        assertCurrent();
        if (run) {
          await recordUpdateRunStepAsync(run.runId, step, {
            ...writeOptions,
            context: source?.workerContext(),
          });
        }
        assertCurrent();
        defaultRuntime[execution.opts.json ? "error" : "log"](
          `${step.step}: ${step.detail ?? step.status}`,
        );
      },
      onStep: (step) =>
        reportUpdateStepCompletion(execution.progress, { ...step, index: 0, total: 0 }),
    });
  const validation =
    source && run
      ? await runOpenClawStateWorkerOperation(
          source.workerContext(),
          // Keep the actual progress writer alive throughout even a silent copy.
          validate,
          { existingOnly: true, assertCurrent },
        )
      : await validate();
  if (!validation) {
    throw new Error("Candidate progress database disappeared before snapshot admission.");
  }
  assertCurrent();
  const changes = validation.doctorConfigChanges ?? [];
  if (validation.status === "ok" && validation.doctorConfigWrites !== true && changes.length) {
    const warning = createUpdateDoctorConfigWarningStep(params.root, changes);
    validation.steps.push(warning);
    await reportUpdateStepCompletion(execution.progress, { ...warning, index: 0, total: 0 });
    assertCurrent();
  }
  return validation;
}

export function assertUpdateCandidateSteps(steps: UpdateRunResult["steps"]): void {
  const failed = steps.find(isFailedUpdateStep);
  if (failed) {
    throw new UpdatePreMutationError(failed.name, failed.stderrTail ?? "Update checks failed.", {
      failureFacts: failed.failureFacts,
    });
  }
}

type CandidateSource = Awaited<ReturnType<typeof readUpdateCandidateSource>>;

/** Rehearse each new source generation within one activation budget. */
export function createUpdateCandidateConfigRefresh(params: {
  read: () => Promise<CandidateSource>;
  getValidated: () => CandidateSource | undefined;
  validate: () => Promise<UpdateRunResult["steps"]>;
  assertCurrent: () => void;
  timeoutMs: number;
}) {
  const deadline = Date.now() + params.timeoutMs;
  return async () => {
    const snapshot = await params.read();
    params.assertCurrent();
    const validated = params.getValidated();
    if (!validated || isDeepStrictEqual(snapshot.source, validated.source)) {
      return snapshot;
    }
    if (Date.now() >= deadline) {
      throw new UpdatePreMutationError(
        "invalid-config",
        "Configuration kept changing throughout the update validation budget; activation cannot safely use an unvalidated configuration.",
      );
    }
    defaultRuntime.error(
      "Warning: Configuration changed during update checks; validating the current configuration before activation.",
    );
    assertUpdateCandidateSteps(await params.validate());
    return undefined;
  };
}

/** Reject candidates that cannot retain the installed updater's native authority. */
export async function assertUpdateCandidateExecutor(params: {
  root: string;
  env: NodeJS.ProcessEnv;
  run: UpdateCommandOptions["run"];
  shouldRestart: boolean;
  serviceOwned: boolean;
  invocationCwd?: string;
  timeoutMs: number;
  nodeRunner?: string;
  assertCurrent: () => void;
}): Promise<void> {
  if (!params.shouldRestart || !params.run || !params.serviceOwned) {
    return;
  }
  params.assertCurrent();
  const executor = params.run.executorFence;
  if (!executor) {
    throw new UpdatePreMutationError(
      "target-native-unsupported",
      "Starting the update requires its original update process.",
    );
  }
  const supported = await isUpdatedInstallGatewayExecutorSupported({
    root: params.root,
    env: resolveUpdatedInstallCommandEnv({
      processEnv: params.env,
      invocationCwd: params.invocationCwd,
    }),
    executor,
    timeoutMs: params.timeoutMs,
    nodeRunner: params.nodeRunner,
  });
  params.assertCurrent();
  if (!supported) {
    throw new UpdatePreMutationError(
      "target-native-unsupported",
      "Target runtime cannot fence update-owned native commands; refusing before Gateway stop or package activation.",
    );
  }
}
