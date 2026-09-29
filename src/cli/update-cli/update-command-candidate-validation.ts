import { resolveStateDir } from "../../config/paths.js";
import { validateUpdateCandidateCanary } from "../../infra/update-candidate-canary.js";
import { recordUpdateRunStepAsync } from "../../infra/update-run-write.async.js";
import { defaultRuntime } from "../../runtime.js";
import { prepareOpenClawStateReadSource } from "../../state/openclaw-state-worker-context.js";
import type { UpdateDisplayProgress } from "./progress.js";
import type { UpdateCommandOptions } from "./shared.js";
import type { createUpdateCommandExecutionGuards } from "./update-command-execution-guards.js";

export function validateUpdateCandidateWithProgress(
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
    progress: UpdateDisplayProgress;
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
  return validateUpdateCandidateCanary({
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
    onStep: (step) => execution.progress?.onStepComplete?.({ ...step, index: 0, total: 0 }),
  });
}
