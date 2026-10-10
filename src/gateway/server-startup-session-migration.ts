import {
  runSessionStartupMigration,
  type SessionStartupMigrationLogger,
} from "../config/sessions/startup-migration.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
} from "../infra/sqlite-worker-identity.js";
import { captureAgentDatabaseAdmission } from "../state/agent-database-admission.js";
import { AGENT_DATABASE_PREFLIGHT_CONCURRENCY } from "../state/openclaw-agent-db-contract.js";
import type { OpenClawAgentDatabaseOptions } from "../state/openclaw-agent-db-contract.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { captureOpenClawStateReadContext } from "../state/openclaw-state-worker-context.js";
import { runTasksWithConcurrency } from "../utils/run-with-concurrency.js";
import { measureStartup, type GatewayStartupTrace } from "./server-startup-trace.js";

type SessionMigrationDeps = Parameters<typeof runSessionStartupMigration>[0]["deps"] & {
  reconcileSessionTranscriptIndexes?: typeof import("../config/sessions/session-transcript-reconcile.js").reconcileSessionTranscriptIndexes;
};

export type PreparedStartupSessionDatabase = {
  database: OpenClawAgentDatabaseOptions & { path: string };
  assertCurrent: () => void;
};

/** Normalize legacy outcomes before readiness; retain admitted stores for later transcript repair. */
export async function prepareGatewayStartupSessions(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  agentIds?: ReadonlySet<string>;
  assertCurrent?: () => void;
  log: SessionStartupMigrationLogger;
  deps?: SessionMigrationDeps;
}): Promise<PreparedStartupSessionDatabase[]> {
  const databases: PreparedStartupSessionDatabase[] = [];
  await runSessionStartupMigration({
    ...params,
    handoffDatabase: async (database) => {
      params.assertCurrent?.();
      const identity = readDatabasePathIdentitySync(resolveOpenClawAgentSqlitePath(database));
      const state = captureOpenClawStateReadContext(resolveOpenClawStateSqlitePath(database.env));
      const assertAdmitted = captureAgentDatabaseAdmission(database.agentId, { env: database.env });
      databases.push({
        database: { ...database, path: identity.canonicalPath },
        assertCurrent: () => {
          state.admission.assertCurrent();
          assertAdmitted();
          assertExistingDatabaseIdentity(identity.canonicalPath, identity.key, identity.birthtime);
        },
      });
    },
  });
  return databases;
}

/** Repair admitted startup targets without rediscovering stores or repeating admission. */
export async function runGatewaySessionStartupMaintenance(params: {
  databases: readonly PreparedStartupSessionDatabase[];
  assertCurrent?: () => void;
  signal?: AbortSignal;
  log: SessionStartupMigrationLogger;
  deps?: Pick<SessionMigrationDeps, "reconcileSessionTranscriptIndexes">;
  startupTrace?: GatewayStartupTrace;
}): Promise<void> {
  let reconcile = params.deps?.reconcileSessionTranscriptIndexes;
  let reconciledSessions = 0;
  const outcome = await runTasksWithConcurrency({
    limit: AGENT_DATABASE_PREFLIGHT_CONCURRENCY,
    errorMode: "stop",
    tasks: params.databases.map(
      ({ database, assertCurrent: assertDatabaseCurrent }) =>
        async () => {
          const assertCurrent = () => {
            params.signal?.throwIfAborted();
            params.assertCurrent?.();
            assertDatabaseCurrent();
          };
          assertCurrent();
          const result = await measureStartup(
            params.startupTrace,
            "startup.maintenance.session-transcripts",
            async () => {
              reconcile ??= (await import("../config/sessions/session-transcript-reconcile.js"))
                .reconcileSessionTranscriptIndexes;
              assertCurrent();
              return reconcile({ ...database, assertCurrent, signal: params.signal });
            },
          );
          assertCurrent();
          reconciledSessions += result.reconciledSessions;
        },
    ),
  });
  if (outcome.hasError) {
    throw outcome.firstError;
  }
  if (reconciledSessions > 0) {
    params.log.info(`session: rebuilt ${reconciledSessions} transcript projection(s)`);
  }
}
