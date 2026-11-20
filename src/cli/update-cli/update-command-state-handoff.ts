import { formatErrorMessage } from "../../infra/errors.js";
import { revokeSqliteDatabaseAdmissionsForPath } from "../../infra/sqlite-database-admission.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { suspendUpdateProgressForDoctor } from "./progress.js";
import type { UpdateCommandOptions } from "./shared.js";

/**
 * Restart the Gateway into the updated build without holding the updater's shared-state
 * handles, then reopen by path. The new build's boot upgrade can copy and swap
 * `state/openclaw.sqlite` (the old file stays as `.pre-<build>`); a retained worker owner
 * would pin the old file under the same pathname, so every later open is refused. Once
 * `restart` settles (the new Gateway is verified or the restart failed), handles opened
 * meanwhile are retired and path admissions revoked, so the remaining steps and the run
 * record use the current file. Update Doctor children use the same close, revoke and
 * progress suspension around their exclusive custody.
 */
export async function withUpdateStateReleasedAcrossRestart<T>(
  run: UpdateCommandOptions["run"],
  restart: () => Promise<T>,
): Promise<T> {
  const statePath = resolveOpenClawStateSqlitePath(run?.env ?? process.env);
  const resumeProgress = run ? await suspendUpdateProgressForDoctor(run.runId) : () => {};
  const reopen = async () => {
    try {
      await closeOpenClawStateDatabaseByPathAsync(statePath);
    } finally {
      try {
        revokeSqliteDatabaseAdmissionsForPath(statePath);
      } finally {
        resumeProgress();
      }
    }
  };
  let result: T;
  try {
    await closeOpenClawStateDatabaseByPathAsync(statePath);
    result = await restart();
  } catch (error) {
    // A failed reopen must not hide why the restart stopped.
    await reopen().catch((reopenError: unknown) => {
      throw new AggregateError([error, reopenError], formatErrorMessage(error), { cause: error });
    });
    throw error;
  }
  await reopen();
  return result;
}
