import { formatErrorMessage } from "../../infra/errors.js";
import { verifyPackageUpdateRecovery } from "../../infra/update-global.js";
import type { PluginCohortRecoveryPair } from "../../infra/update-plugin-cohort-schema.js";
import { withUpdateRunRead } from "../../infra/update-run-read-admission.js";
import { assertUpdateRecoveryAdmission } from "../../infra/update-run-recovery-admission.js";
import {
  decodeUpdateRecovery,
  isUpdateRecoveryPending,
} from "../../infra/update-run-recovery-schema.js";
import {
  inspectPluginCohortRecoveryRows,
  inspectRecoveryRows,
} from "../../infra/update-run-recovery-store.js";
import {
  assertNoPendingUpdateRecovery,
  loadUpdateRecovery,
  pluginCohortRecoveryMatchesSource,
  UpdateRecoveryRequiredError,
} from "../../infra/update-run-recovery.js";
import { readCurrentGitUpdateRecovery } from "../../infra/update-runner-git-recovery.js";
import { openDoctorStateSchemaReadAdmission } from "../../state/openclaw-state-db-doctor-schema.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import type { UpdateCommandOptions } from "./shared.js";
import type { MutableUpdateExecutionParams } from "./update-command-execution.types.js";
import { captureUpdateCommandExecutorAuthority } from "./update-command-executor-capabilities.js";
import type { FinishUpdateParams } from "./update-command-finish-types.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery-error.js";
import { UpdateCommandPendingRecoveryFailure } from "./update-command-result.js";

export function readOriginalUpdateRecovery(
  params: Pick<MutableUpdateExecutionParams, "installKind" | "root">,
  timeoutMs: number,
) {
  return params.installKind === "git"
    ? readCurrentGitUpdateRecovery(params.root, timeoutMs)
    : verifyPackageUpdateRecovery(params.root);
}

export function assertUpdateCommandRecoveryState(
  opts: UpdateCommandOptions,
): { installKey: string; pair: PluginCohortRecoveryPair } | undefined {
  if (opts.recovery) {
    throw new UpdateCommandRecoveryPendingError(
      "Full-state checkpoint recovery is deferred; retained state was left unchanged.",
    );
  }
  const current =
    opts.run && loadUpdateRecovery(opts.run.runId, { env: opts.run.env, allowNativeRead: true });
  if (current) {
    const run = opts.run;
    if (run?.executorFence) {
      const pair = assertNoPendingUpdateRecovery({
        env: run.env,
        allowNativeRead: true,
        pluginCohort: { runId: run.runId, fence: run.executorFence },
      });
      if (pair) {
        return {
          installKey: captureUpdateCommandExecutorAuthority(run.executorFence, run.runId)
            .installKey,
          pair,
        };
      }
      throw new UpdateRecoveryRequiredError(current);
    }
    throw new UpdateRecoveryRequiredError(current);
  }
  return undefined;
}

/** Policy observation inside an already-admitted child interval. This never authorizes effects. */
export function assertUpdateCommandRecoveryObservation(
  opts: UpdateCommandOptions,
  admittedInstallKey: string | undefined,
  originalPair?: PluginCohortRecoveryPair,
): void {
  if (opts.recovery) {
    throw new UpdateCommandRecoveryPendingError(
      "Full-state checkpoint recovery is deferred; retained state was left unchanged.",
    );
  }
  const run = opts.run;
  if (!run) {
    return;
  }
  const options = { env: run.env, allowNativeRead: true as const };
  if (originalPair && !pluginCohortRecoveryMatchesSource(originalPair, options)) {
    throw new UpdateRecoveryRequiredError(originalPair.reservation);
  }
  const pending = withUpdateRunRead(
    ({ db }) => {
      const cohorts = inspectPluginCohortRecoveryRows(db);
      return inspectRecoveryRows(db).find((entry) => {
        if (!isUpdateRecoveryPending(entry.record)) {
          return false;
        }
        const pair =
          entry.record.runId === run.runId
            ? cohorts.find(({ cohort }) => cohort.runId === run.runId)
            : undefined;
        return (
          !pair ||
          admittedInstallKey !== pair.cohort.installKey ||
          (originalPair !== undefined &&
            originalPair.cohort.transactionId !== pair.cohort.transactionId) ||
          !pluginCohortRecoveryMatchesSource(pair, options)
        );
      });
    },
    options,
    openDoctorStateSchemaReadAdmission,
  );
  if (pending) {
    throw new UpdateRecoveryRequiredError(decodeUpdateRecovery(pending.raw, pending.record.runId));
  }
}

/** Package-only finalization cannot adopt a retained full-state claim. */
export async function assertUpdateCommandPackageFinalization(
  params: Pick<FinishUpdateParams, "opts" | "result" | "ownedManagedUpdateEnv">,
): Promise<void> {
  const run = params.opts.run;
  const executor = run?.executorFence;
  const assertCurrent = () => executor?.assertCurrent();
  try {
    assertCurrent();
    if (params.opts.recovery) {
      throw new Error(
        "Full-state checkpoint recovery is deferred; retained state was left unchanged.",
      );
    }
    const env = params.ownedManagedUpdateEnv ?? params.opts.run?.env;
    // Keep the first target stable if selectors change during admission.
    const targetPath = resolveOpenClawStateSqlitePath(env);
    const pluginCohort = run && executor ? { runId: run.runId, fence: executor } : undefined;
    await assertUpdateRecoveryAdmission({ env, path: targetPath, pluginCohort });
    assertCurrent();
    if (run && resolveOpenClawStateSqlitePath(run.env) !== targetPath) {
      await assertUpdateRecoveryAdmission({ env: run.env, pluginCohort });
      assertCurrent();
    }
  } catch (cause) {
    throw new UpdateCommandPendingRecoveryFailure(params.result, formatErrorMessage(cause), {
      cause,
    });
  }
}

/** Hold the originally admitted executor through package finalization awaits. */
export function createUpdateCommandFinalizationFence(
  params: Pick<FinishUpdateParams, "opts" | "result">,
): () => void {
  const originalRun = params.opts.run;
  const executor = originalRun?.executorFence;
  return () => {
    try {
      executor?.assertCurrent();
    } catch (cause) {
      throw new UpdateCommandPendingRecoveryFailure(params.result, formatErrorMessage(cause), {
        cause,
      });
    }
  };
}
