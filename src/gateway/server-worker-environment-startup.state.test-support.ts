import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withEnvAsync } from "../test-utils/env.js";

export async function withGatewayWorkerEnvironmentStartupState<T>(
  stateDir: string,
  run: () => Promise<T>,
): Promise<T> {
  const databasePath = resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: stateDir });
  return await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
    let result: T;
    try {
      result = await run();
    } catch (bodyError) {
      const [cleanup] = await Promise.allSettled([
        closeOpenClawStateDatabaseByPathAsync(databasePath),
      ]);
      if (cleanup.status === "rejected") {
        throw new AggregateError(
          [bodyError, cleanup.reason],
          "Worker environment startup fixture and database cleanup failed",
          { cause: bodyError },
        );
      }
      throw bodyError;
    }
    await closeOpenClawStateDatabaseByPathAsync(databasePath);
    return result;
  });
}
