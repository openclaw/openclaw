import { readPackageVersion } from "../../infra/package-json.js";
import { assertNoPendingPackageActivation } from "../../infra/package-update-activation.js";
import { UPDATE_RUN_ID_ENV } from "../../infra/update-control-plane-sentinel.js";
import { readBuiltGatewayBuildId } from "../../infra/update-git-runtime.js";
import type { PluginCohortRecoveryPair } from "../../infra/update-plugin-cohort-schema.js";
import { getUpdateRun } from "../../infra/update-run-ledger.js";
import {
  assertUpdateRecoveryAdmission,
  inspectPluginCohortRecoveryAdmission,
} from "../../infra/update-run-recovery-admission.js";
import { assertPluginCohortRecoveryContinuation } from "../../infra/update-run-recovery.js";
import type { OpenClawStateDatabaseOptions } from "../../state/openclaw-state-db-contract.js";
import {
  assertUpdateRequesterContinuationOwner,
  withUpdateCommandExecutor,
} from "./update-command-executor.js";

function hasPendingPackageRecovery(installKey: string): boolean {
  try {
    assertNoPendingPackageActivation(installKey, { dryRun: true });
    return false;
  } catch {
    return true;
  }
}

/**
 * Settle an interrupted run's saved plugin cohort under the caller's installation
 * ownership. Unless its candidate verified serving and the original core is gone,
 * a pending cohort rolls back; finalization then converges plugins to whichever core
 * is installed. A recorded commit requires its candidate.
 */
export async function settleInterruptedUpdatePluginCohort(params: {
  expected: PluginCohortRecoveryPair;
  root: string;
  options: OpenClawStateDatabaseOptions & { env: NodeJS.ProcessEnv };
  assertCurrent: () => void;
}): Promise<void> {
  const { expected, options, assertCurrent } = params;
  assertCurrent();
  const current = await inspectPluginCohortRecoveryAdmission(options, expected.cohort.runId);
  assertCurrent();
  if (
    !current ||
    current.cohort.transactionId !== expected.cohort.transactionId ||
    current.cohort.installKey !== expected.cohort.installKey
  ) {
    throw new Error("Plugin cohort recovery changed before repair acquired ownership.");
  }
  const [version, buildId] = await Promise.all([
    readPackageVersion(params.root),
    readBuiltGatewayBuildId(params.root),
  ]);
  assertCurrent();
  const installed = (core: { version: string; buildId: string | null }) =>
    version === core.version && (buildId ?? null) === core.buildId;
  const { from, to } = current.reservation;
  if (current.cohort.disposition === "commit" && !installed(to)) {
    throw new Error(
      "Plugin cohort commit does not match the installed candidate version and build.",
    );
  }
  // Rollback restores plugin state for the original core. Once the candidate has
  // verified serving and the original core is no longer installed, rollback would
  // only be converged forward again, and it refuses obligations a later Doctor
  // decided. A rollback that has settled no publication has not changed state.
  // Pending package recovery could still restore the original core.
  const verification = getUpdateRun(current.cohort.runId, options)?.verification;
  const forward =
    current.cohort.disposition !== "commit" &&
    current.cohort.settledPublications === 0 &&
    version !== null &&
    !installed(from) &&
    !hasPendingPackageRecovery(current.cohort.installKey) &&
    verification?.serviceRunning === true &&
    verification.versionMatch === true &&
    verification.runningVersion === to.version &&
    (to.buildId === null || verification.runningBuildId === to.buildId);
  const { settleUpdatePluginCohort } = await import("../../plugins/update-cohort-recovery.js");
  assertCurrent();
  await settleUpdatePluginCohort({
    runId: current.cohort.runId,
    action: current.cohort.disposition === "commit" || forward ? "commit" : "rollback",
    ...(forward ? { supersedeUnsettledRollback: true as const } : {}),
    env: options.env,
    fence: { assertCurrent },
  });
  assertCurrent();
  // The plugin reservation is gone before ordinary history reconciliation.
  await assertUpdateRecoveryAdmission(options);
  assertCurrent();
}

/**
 * The managed handoff helper finalizes its own run after the updater died. Its
 * borrowed executor is that run's live owner, so it settles the run's saved
 * plugin cohort as repair would. Other pending recovery still refuses.
 */
export async function settleManagedHandoffPluginCohort(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const runId = env[UPDATE_RUN_ID_ENV]?.trim();
  if (env.OPENCLAW_UPDATE_RUN_HANDOFF !== "1" || !runId) {
    return;
  }
  let pair: PluginCohortRecoveryPair | undefined;
  try {
    await assertUpdateRecoveryAdmission({ env });
    return;
  } catch (error) {
    pair = await inspectPluginCohortRecoveryAdmission({ env }, runId);
    if (!pair) {
      throw error;
    }
  }
  const expected = pair;
  await withUpdateCommandExecutor(runId, async (executor) => {
    const fence = await executor.enter(expected.cohort.installKey);
    assertUpdateRequesterContinuationOwner(fence, runId);
    assertPluginCohortRecoveryContinuation(expected, { runId, fence }, { env });
    await settleInterruptedUpdatePluginCohort({
      expected,
      root: expected.cohort.installKey,
      options: { env },
      assertCurrent: fence.assertCurrent,
    });
  });
}
