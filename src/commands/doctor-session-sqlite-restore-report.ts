/** Builds doctor reports for session SQLite migration restore mode. */
import type { SessionStoreTarget } from "../config/sessions/targets.js";
import { resolveSessionSqliteMigrationRunsDir } from "../infra/session-sqlite-migration-manifest.js";
import {
  readSqliteEntryCount,
  resolveTargetSqlitePath,
} from "../infra/session-sqlite-migration-readers.js";
import { restoreSessionSqliteMigrationRuns } from "./doctor-session-sqlite-restore.js";
import {
  createDoctorSessionSqliteTargetReport,
  createDoctorSessionSqliteTotals,
  type DoctorSessionSqliteReport,
} from "./doctor-session-sqlite-types.js";

export async function restoreDoctorSessionSqliteTargets(params: {
  env: NodeJS.ProcessEnv;
  targets: readonly SessionStoreTarget[];
}): Promise<DoctorSessionSqliteReport> {
  const targetReports = params.targets.map((target) =>
    createDoctorSessionSqliteTargetReport({
      agentId: target.agentId,
      sqliteEntries: readSqliteEntryCount(target),
      sqlitePath: resolveTargetSqlitePath(target),
      storePath: target.storePath,
    }),
  );
  const trustedTargets = params.targets.map((target) => ({
    ...target,
    sqlitePath: resolveTargetSqlitePath(target),
  }));
  const restore = await restoreSessionSqliteMigrationRuns({
    env: params.env,
    trustedTargets,
  });
  const reportTarget =
    targetReports[0] ??
    createDoctorSessionSqliteTargetReport({
      agentId: "restore",
      sqlitePath: "",
      storePath: restore.manifestPaths[0] || resolveSessionSqliteMigrationRunsDir(params.env),
    });
  reportTarget.restore = restore;
  reportTarget.issues.push(
    ...restore.conflicts.map((conflict) => ({
      code: "restore_conflict",
      message: `${conflict.sourcePath}: ${conflict.reason}`,
    })),
  );
  const targets = targetReports.length > 0 ? targetReports : [reportTarget];
  return {
    mode: "restore",
    targets,
    totals: createDoctorSessionSqliteTotals(targets),
  };
}
