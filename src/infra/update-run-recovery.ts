import { captureUpdateCommandExecutorAuthority } from "../cli/update-cli/update-command-executor-capabilities.js";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import { openDoctorStateSchemaReadAdmission } from "../state/openclaw-state-db-doctor-schema.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { resolveIdentityPathViaExistingAncestorSync } from "./boundary-path.js";
import type { PluginCohortRecoveryPair } from "./update-plugin-cohort-schema.js";
import { withUpdateRunRead } from "./update-run-read-admission.js";
import {
  isUpdateRecoveryPending,
  decodeUpdateRecovery,
  UpdateRecoveryRequiredError,
  type UpdateRecoveryRecord,
} from "./update-run-recovery-schema.js";
import {
  inspectPluginCohortRecoveryRows,
  inspectRecoveryRows,
  readRecovery,
} from "./update-run-recovery-store.js";
import type { PluginCohortRecoveryContinuation } from "./update-run-recovery-types.js";
export type { UpdateRecoveryFence, UpdateRecoveryHandoff } from "./update-run-recovery-types.js";
export { UpdateRecoveryRequiredError } from "./update-run-recovery-schema.js";
export type { UpdateRecoveryRecord } from "./update-run-recovery-schema.js";
export { inspectUpdateRecoveries } from "./update-run-recovery-store.js";
export type UpdateRecoveryAdmissionOptions = OpenClawStateDatabaseOptions & {
  pluginCohort?: PluginCohortRecoveryContinuation;
  allowNativeRead?: true;
};
export function loadUpdateRecovery(
  runId: string,
  options: OpenClawStateDatabaseOptions & { allowNativeRead?: true } = {},
): UpdateRecoveryRecord | undefined {
  return withUpdateRunRead(({ db }) => readRecovery(db, runId), options);
}
export function pluginCohortRecoveryMatchesSource(
  pair: PluginCohortRecoveryPair,
  options: OpenClawStateDatabaseOptions,
): boolean {
  const source = pair.reservation.source;
  if (!source) {
    return false;
  }
  const env = options.env ?? process.env;
  const stateDir = resolveStateDir(env);
  const identity = resolveIdentityPathViaExistingAncestorSync;
  return (
    identity(source.stateDir) === identity(stateDir) &&
    identity(source.configPath) === identity(resolveConfigPath(env, stateDir)) &&
    identity(options.path ?? resolveOpenClawStateSqlitePath(env)) ===
      identity(resolveOpenClawStateSqlitePath({ ...env, OPENCLAW_STATE_DIR: source.stateDir }))
  );
}

/** Saved facts narrow the selection; only this process's original live executor permits effects. */
export function assertPluginCohortRecoveryContinuation(
  pair: PluginCohortRecoveryPair,
  continuation: PluginCohortRecoveryContinuation,
  options: OpenClawStateDatabaseOptions,
): void {
  const authority = captureUpdateCommandExecutorAuthority(continuation.fence, continuation.runId);
  if (
    pair.cohort.runId !== continuation.runId ||
    authority.installKey !== pair.cohort.installKey ||
    !pluginCohortRecoveryMatchesSource(pair, options)
  ) {
    throw new UpdateRecoveryRequiredError(pair.reservation);
  }
  continuation.fence.assertCurrent();
}

/** Detection never claims or retires recovery; a live owner may continue only its exact plugin pair. */
export function assertNoPendingUpdateRecovery(
  options: UpdateRecoveryAdmissionOptions = {},
): PluginCohortRecoveryPair | undefined {
  let admittedCohort: PluginCohortRecoveryPair | undefined;
  // Candidate children can migrate the ledger after this updater admitted its original format.
  const pending = withUpdateRunRead(
    ({ db }) => {
      // Validate companions too: an orphan must not disappear merely because its reservation is absent.
      const cohorts = inspectPluginCohortRecoveryRows(db);
      return inspectRecoveryRows(db).find((entry) => {
        if (!isUpdateRecoveryPending(entry.record)) {
          return false;
        }
        const continuation = options.pluginCohort;
        const pair =
          continuation?.runId === entry.record.runId
            ? cohorts.find(({ cohort }) => cohort.runId === entry.record.runId)
            : undefined;
        if (!continuation || !pair) {
          return true;
        }
        assertPluginCohortRecoveryContinuation(pair, continuation, options);
        admittedCohort = pair;
        return false;
      });
    },
    options,
    openDoctorStateSchemaReadAdmission,
  );
  if (pending) {
    // Historical completion does not grant current execution authority. An
    // unfinished legacy operation still requires explicit compatible recovery.
    throw new UpdateRecoveryRequiredError(decodeUpdateRecovery(pending.raw, pending.record.runId));
  }
  return admittedCohort;
}
