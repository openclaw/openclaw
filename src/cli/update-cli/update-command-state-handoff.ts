import { formatErrorMessage } from "../../infra/errors.js";
import { revokeSqliteDatabaseAdmissionsForPath } from "../../infra/sqlite-database-admission.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { maybeRestartService } from "./update-command-service.js";

export function restartServiceWithStateHandoff(
  suspendProgress: (() => () => void) | undefined,
  params: Parameters<typeof maybeRestartService>[0],
): ReturnType<typeof maybeRestartService> {
  return params.shouldRestart
    ? withUpdateStateReleasedAcrossRestart(
        params.opts.run?.env ?? process.env,
        suspendProgress,
        () => maybeRestartService(params),
      )
    : maybeRestartService(params);
}

/** Give the successor's boot upgrade custody before reopening shared state by path. */
async function withUpdateStateReleasedAcrossRestart<T>(
  env: NodeJS.ProcessEnv,
  suspendProgress: (() => () => void) | undefined,
  restart: () => Promise<T>,
): Promise<T> {
  const statePath = resolveOpenClawStateSqlitePath(env);
  const resumeProgress = suspendProgress?.();
  const reopen = async () => {
    try {
      // Service probing can have opened handles while the new build was starting.
      await closeOpenClawStateDatabaseByPathAsync(statePath);
    } finally {
      revokeSqliteDatabaseAdmissionsForPath(statePath);
    }
  };
  try {
    await closeOpenClawStateDatabaseByPathAsync(statePath);
    let result: T;
    try {
      result = await restart();
    } catch (error) {
      await reopen().catch((cleanupError: unknown) => {
        throw new AggregateError([error, cleanupError], formatErrorMessage(error), {
          cause: error,
        });
      });
      throw error;
    }
    await reopen();
    return result;
  } finally {
    resumeProgress?.();
  }
}
