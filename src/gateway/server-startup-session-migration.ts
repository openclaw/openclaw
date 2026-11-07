import { setImmediate as nextTurn } from "node:timers/promises";
import type { SessionTranscriptFactsBackfill } from "../config/sessions/session-transcript-facts-backfill.js";
import {
  runSessionStartupMigration,
  type SessionStartupMigrationLogger,
} from "../config/sessions/startup-migration-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
} from "../infra/sqlite-worker-identity.js";
import { getQueueSize } from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";
import { captureAgentDatabaseAdmission } from "../state/agent-database-admission.js";
import type { OpenClawAgentDatabaseOptions } from "../state/openclaw-agent-db-contract.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { captureOpenClawStateReadContext } from "../state/openclaw-state-worker-context.js";
import { scheduleGatewayIdleTask } from "./server-idle-task.js";
import { measureStartup, type GatewayStartupTrace } from "./server-startup-trace.js";

export type PreparedStartupSessionDatabase = {
  database: OpenClawAgentDatabaseOptions & { path: string };
  assertCurrent: () => void;
};

export type GatewaySessionFactsBackfillScheduler = (
  databases: readonly PreparedStartupSessionDatabase[],
) => void;

/** Normal and deferred admission share one pass per physical database per Gateway. */
export function createGatewaySessionFactsBackfillScheduler(params: {
  scheduler: GatewayScheduler;
  signal: AbortSignal;
  waitForReady?: () => Promise<void>;
  log: SessionStartupMigrationLogger;
}): GatewaySessionFactsBackfillScheduler {
  const scheduled = new Set<string>();
  return (databases) => {
    for (const { database, assertCurrent } of databases) {
      if (scheduled.has(database.path)) {
        continue;
      }
      // Same-ID jobs replace queued ticks, but cannot replace an already running pass.
      scheduled.add(database.path);
      let complete = false;
      let delayMs = 250;
      let backfill: SessionTranscriptFactsBackfill | undefined;
      scheduleGatewayIdleTask({
        id: `maintenance:transcript-facts:${database.path}`,
        scheduler: params.scheduler,
        delayMs: 250,
        repeatDelayMs: () => delayMs,
        retryDelayMs: 1_000,
        waitForReady: params.waitForReady,
        isClosing: () => complete || params.signal.aborted,
        isBusy: () => getQueueSize(CommandLane.RestartRecovery) > 0,
        log: params.log,
        errorMessage: "Transcript facts backfill failed",
        run: async (signal) => {
          signal.throwIfAborted();
          params.signal.throwIfAborted();
          assertCurrent();
          if (!backfill) {
            const { createSessionTranscriptFactsBackfill } =
              await import("../config/sessions/session-transcript-facts-backfill.js");
            backfill = createSessionTranscriptFactsBackfill({
              database,
              assertCurrent,
              signal: AbortSignal.any([signal, params.signal]),
              log: params.log,
            });
          }
          // A foreground arrival can wait for this bounded transaction. One indivisible
          // cold read can exceed its soft budget; the next delay limits writer duty cycle.
          ({ complete, delayMs } = await backfill.runBatch());
          if (complete) {
            backfill = undefined;
          }
        },
      });
    }
  };
}

/** Normalize legacy outcomes before readiness; retain admitted stores for later transcript repair. */
export async function prepareGatewayStartupSessions(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  agentIds?: ReadonlySet<string>;
  assertCurrent?: () => void;
  log: SessionStartupMigrationLogger;
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
  startupTrace?: GatewayStartupTrace;
}): Promise<void> {
  let reconcile:
    | typeof import("../config/sessions/session-transcript-reconcile.js").reconcileSessionTranscriptIndexes
    | undefined;
  let reconciledSessions = 0;
  // One worker-backed repair at a time leaves admission and foreground writers capacity.
  for (const { database, assertCurrent: assertDatabaseCurrent } of params.databases) {
    await nextTurn();
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
  }
  if (reconciledSessions > 0) {
    params.log.info(`session: rebuilt ${reconciledSessions} transcript projection(s)`);
  }
}
