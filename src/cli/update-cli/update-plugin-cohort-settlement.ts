import { readPackageVersion } from "../../infra/package-json.js";
import { readBuiltGatewayBuildId } from "../../infra/update-git-runtime.js";
import type { PluginCohortRecoveryPair } from "../../infra/update-plugin-cohort-schema.js";
import {
  assertUpdateRecoveryAdmission,
  inspectPluginCohortRecoveryAdmission,
} from "../../infra/update-run-recovery-admission.js";
import type { OpenClawStateDatabaseOptions } from "../../state/openclaw-state-db-contract.js";

/**
 * Settle an interrupted run's saved plugin cohort under the caller's installation
 * ownership. A pending cohort rolls back; finalization then converges plugins to
 * whichever core is installed. A recorded commit requires its candidate.
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
  if (current.cohort.disposition === "commit") {
    const [version, buildId] = await Promise.all([
      readPackageVersion(params.root),
      readBuiltGatewayBuildId(params.root),
    ]);
    assertCurrent();
    if (
      version !== current.reservation.to.version ||
      (buildId ?? null) !== current.reservation.to.buildId
    ) {
      throw new Error(
        "Plugin cohort commit does not match the installed candidate version and build.",
      );
    }
  }
  const { settleUpdatePluginCohort } = await import("../../plugins/update-cohort-recovery.js");
  assertCurrent();
  await settleUpdatePluginCohort({
    runId: current.cohort.runId,
    action: current.cohort.disposition === "commit" ? "commit" : "rollback",
    env: options.env,
    fence: { assertCurrent },
  });
  assertCurrent();
  // The plugin reservation is gone before ordinary history reconciliation.
  await assertUpdateRecoveryAdmission(options);
  assertCurrent();
}
