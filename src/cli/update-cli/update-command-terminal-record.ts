import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
} from "../../infra/sqlite-worker-identity.js";
import type { UpdateRunRecord } from "../../infra/update-run-record.js";
import { assertUpdateRecoveryDirectoryAdmission } from "../../infra/update-run-recovery-admission.js";
import { captureCompletedUpdateRun } from "../../infra/update-run-terminal-record.js";
import { isUpdateRunVerificationConfirmed } from "../../infra/update-run-verification.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { openClawStateDatabaseCache } from "../../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import type { FinishUpdateParams } from "./update-command-finish-types.js";

type Params = Pick<FinishUpdateParams, "opts" | "ownedManagedUpdateEnv">;
type Run = NonNullable<Params["opts"]["run"]>;

/** Process-local publication data, never serialized or accepted as an update grant. */
export type UpdateCommandTerminalRecord = {
  run: Run;
  executor: NonNullable<Run["executorFence"]>;
  path: string;
  identity: string;
  record: UpdateRunRecord;
};

function matchesResult(record: UpdateRunRecord, result: UpdateRunResult): boolean {
  if (result.status !== "ok" || (result.runId && result.runId !== record.runId)) {
    return false;
  }
  const verification = record.verification;
  if (!isUpdateRunVerificationConfirmed(verification)) {
    return false;
  }
  for (const key of ["version", "sha", "buildId"] as const) {
    const expected = result.after?.[key];
    const actual = record.after[key];
    if (expected && actual) {
      if (expected !== actual) {
        return false;
      }
    }
  }
  const observedVersion = verification.runningVersion;
  const observedBuild = verification.runningBuildId;
  if (
    (record.after.version && observedVersion && record.after.version !== observedVersion) ||
    (record.after.buildId && observedBuild && record.after.buildId !== observedBuild)
  ) {
    return false;
  }
  if (
    (result.after?.version && observedVersion && result.after.version !== observedVersion) ||
    (result.after?.buildId
      ? observedBuild !== result.after.buildId
      : !result.after?.version || observedVersion !== result.after.version)
  ) {
    return false;
  }
  // Gateway verification compares the exact build ID. Its committed row need
  // not repeat the Git SHA already represented by that same verified build.
  // Version equality alone cannot fill in an expected build ID or Git SHA.
  const key = result.after?.buildId ? "buildId" : result.after?.sha ? "sha" : "version";
  return Boolean(result.after?.[key] && record.after[key] === result.after[key]);
}

/** Capture an already completed outcome while its real executor still owns state. */
export async function captureUpdateCommandTerminalRecord(
  params: Params,
  result: UpdateRunResult,
  assertCurrent: () => void,
): Promise<UpdateCommandTerminalRecord | undefined> {
  const run = params.opts.run;
  const executor = run?.executorFence;
  if (!run || !executor || result.status !== "ok") {
    return undefined;
  }
  const pathname = resolveOpenClawStateSqlitePath(run.env);
  if (resolveOpenClawStateSqlitePath(params.ownedManagedUpdateEnv ?? run.env) !== pathname) {
    return undefined;
  }
  assertCurrent();
  if (!(await assertUpdateRecoveryDirectoryAdmission(pathname))) {
    return undefined;
  }
  assertCurrent();
  const identity = readDatabasePathIdentitySync(pathname).key;
  const record = captureCompletedUpdateRun(run.runId, assertCurrent, {
    env: run.env,
    path: pathname,
  });
  assertCurrent();
  if (!record || !matchesResult(record, result)) {
    return undefined;
  }
  const captured = { run, executor, path: pathname, identity, record };
  readUpdateCommandTerminalRecord(params, result, captured);
  return captured;
}

/** Recheck identity without reopening released state or taking a live snapshot. */
export function readUpdateCommandTerminalRecord(
  params: Params,
  result: UpdateRunResult,
  captured: UpdateCommandTerminalRecord,
): UpdateRunRecord {
  const run = params.opts.run;
  if (
    run !== captured.run ||
    run.executorFence !== captured.executor ||
    run.runId !== captured.record.runId ||
    resolveOpenClawStateSqlitePath(run.env) !== captured.path ||
    resolveOpenClawStateSqlitePath(params.ownedManagedUpdateEnv ?? run.env) !== captured.path ||
    !matchesResult(captured.record, result)
  ) {
    throw new Error("Update terminal publication lost its captured outcome.");
  }
  assertExistingDatabaseIdentity(captured.path, captured.identity);
  openClawStateDatabaseCache.assertOpenClawStateDatabaseFreshOpenAllowedAtPath(
    captured.path,
    run.env,
  );
  return captured.record;
}
