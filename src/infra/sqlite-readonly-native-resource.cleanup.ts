import fs from "node:fs/promises";
import { throwSqliteLifecycleErrors } from "./sqlite-lifecycle-errors.js";
import type { SqliteNativeSessionLaunch } from "./sqlite-readonly-native-resource.types.js";
import { runSqliteReadOnlyWorkerOnce } from "./sqlite-readonly-worker.js";

export type SqliteNativeSnapshotDirectory<Session> = {
  kind: "snapshot";
  preparationId: number;
  session: Session;
  announced: boolean;
  removed: boolean;
};

/** Snapshot sessions share creator locks; all their reader fences precede native close. */
export async function closeSqliteSnapshotNativeResources<
  Session extends { launch: SqliteNativeSessionLaunch },
>(options: {
  directories: ReadonlyMap<string, SqliteNativeSnapshotDirectory<Session> | { kind: "token" }>;
  sessions: ReadonlyArray<readonly [number, Session]>;
  announce(directory: string, owned: SqliteNativeSnapshotDirectory<Session>): Promise<void>;
  requestRetirement(directory: string): Promise<unknown>;
  closeSession(id: number, session: Session): Promise<void>;
  removed(directory: string): Promise<void>;
  tokenFailures: readonly unknown[];
  uncertainAllocations: readonly unknown[];
}) {
  const { directories, tokenFailures } = options;
  const fences = await Promise.allSettled(
    [...directories].map(async ([directory, owned]) => {
      if (owned.kind === "token") {
        return;
      }
      await options.announce(directory, owned);
      if (!owned.removed) {
        await options.requestRetirement(directory);
      }
    }),
  );
  const fenceFailures = fences.flatMap((outcome) =>
    outcome.status === "rejected" ? [outcome.reason] : [],
  );
  if (fenceFailures.length) {
    throwSqliteLifecycleErrors(
      [...tokenFailures, ...fenceFailures],
      "SQLite snapshot host cleanup admission failed",
    );
  }
  const outcomes = await Promise.allSettled(
    options.sessions.map(([id, session]) => options.closeSession(id, session)),
  );
  const closeFailures = outcomes.flatMap((outcome) =>
    outcome.status === "rejected" ? [outcome.reason] : [],
  );
  if (closeFailures.length) {
    throwSqliteLifecycleErrors(
      [...tokenFailures, ...closeFailures],
      "SQLite native resource cleanup failed",
    );
  }
  const failures: unknown[] = [...tokenFailures, ...options.uncertainAllocations];
  for (const [directory, owned] of directories) {
    if (owned.kind === "token") {
      continue;
    }
    try {
      if (!owned.removed) {
        await runSqliteReadOnlyWorkerOnce(
          directory,
          { mode: "staging-reconcile" },
          {
            env: owned.session.launch.env,
            cwd: owned.session.launch.cwd,
            deadlineOwnedByCaller: false,
          },
        );
        await fs.rm(directory, {
          force: true,
          recursive: true,
          maxRetries: 3,
          retryDelay: 20,
        });
      }
      await options.removed(directory);
    } catch (error) {
      failures.push(error);
    }
  }
  throwSqliteLifecycleErrors(failures, "SQLite snapshot native directory cleanup failed");
}
