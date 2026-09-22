import { hasSubagentSessionRecoveryOwner } from "../agents/subagents/registry/subagent-session-reconciliation.js";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import { readSessionEntriesByStatus } from "../config/sessions/session-accessor.sqlite-status.js";
import {
  runSessionStartupMigration,
  type SessionStartupMigrationLogger,
} from "../config/sessions/startup-migration.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readActiveGatewayLockIdentity } from "../infra/gateway-lock.js";
import { readGatewayOwnerLease } from "../infra/gateway-owner-lease.js";
import { hasGatewayLifecycleCoordinator } from "../infra/state-database-coordinator.js";
import {
  isSubagentSessionKey,
  isIncognitoSessionKey,
  resolveAgentIdFromSessionKey,
} from "../routing/session-key.js";
import {
  openOpenClawAgentDatabase,
  type OpenClawAgentDatabaseOptions,
} from "../state/openclaw-agent-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";

type SessionMigrationDeps = Parameters<typeof runSessionStartupMigration>[0]["deps"] & {
  reconcileSessionTranscriptIndexes?: typeof import("../config/sessions/session-transcript-reconcile.js").reconcileSessionTranscriptIndexes;
};

function isUnsettledPredecessor(entry: InternalSessionEntry): boolean {
  // Age selects the predecessor boundary; it is never sufficient evidence of lost ownership.
  return (
    entry.status === "running" &&
    !entry.incognito &&
    !entry.abortedLastRun &&
    typeof entry.startedAt === "number" &&
    Number.isFinite(entry.startedAt) &&
    entry.startedAt < performance.timeOrigin &&
    Number.isFinite(entry.updatedAt) &&
    entry.updatedAt < performance.timeOrigin &&
    !entry.restartRecoveryRuns?.length &&
    !entry.restartRecoveryForceSafeTools &&
    !entry.subagentRecovery &&
    !entry.mainRestartRecovery &&
    !entry.pendingFinalDelivery &&
    !entry.pendingDeliveryNotice &&
    !entry.initializationPending &&
    !entry.restartRecoveryBeforeAgentReplyState &&
    !entry.restartRecoveryDeliveryReceiptState &&
    !entry.restartRecoveryDeliveryRunId &&
    !entry.restartRecoveryDeliverySourceRunId
  );
}

async function reconcileStartupOrphans(
  database: OpenClawAgentDatabaseOptions,
  log: SessionStartupMigrationLogger,
  assertCurrent?: () => void,
) {
  const env = database.env ?? process.env;
  const statePath = resolveOpenClawStateSqlitePath(env);
  if (!hasGatewayLifecycleCoordinator({ databasePath: statePath })) {
    return;
  }
  const lock = await readActiveGatewayLockIdentity({ env, requireInspection: true });
  if (lock?.pid !== process.pid || !lock.ownerId) {
    return;
  }
  const assertGatewayOwner = () => {
    assertCurrent?.();
    const lease = readGatewayOwnerLease({ env, current: true });
    if (
      !hasGatewayLifecycleCoordinator({ databasePath: statePath }) ||
      lease?.state !== "live" ||
      lease.pid !== process.pid ||
      lease.owner !== lock.ownerId
    ) {
      throw new Error("startup Gateway ownership changed or could not be verified");
    }
  };
  assertGatewayOwner();
  // Consume this admitted physical database, not a second global target scan.
  const connection = openOpenClawAgentDatabase(database);
  const selected = readSessionEntriesByStatus(connection, ["running"]);
  let count = 0;
  for (const { entry, sessionKey } of selected) {
    if (
      !isSubagentSessionKey(sessionKey) ||
      isIncognitoSessionKey(sessionKey) ||
      !isUnsettledPredecessor(entry)
    ) {
      continue;
    }
    const identity = { sessionKey, sessionId: entry.sessionId, env };
    const assertOwnerless = () => {
      assertGatewayOwner();
      if (hasSubagentSessionRecoveryOwner(identity)) {
        throw new Error("a current or retained run/task owns this session");
      }
    };
    try {
      assertOwnerless();
      const updated = await patchSessionEntryCore(
        {
          agentId: resolveAgentIdFromSessionKey(sessionKey),
          env,
          sessionKey,
          storePath: connection.path,
        },
        (current) =>
          current.sessionId === entry.sessionId &&
          current.lifecycleRevision === entry.lifecycleRevision &&
          current.lifecycleRunId === entry.lifecycleRunId &&
          current.updatedAt === entry.updatedAt &&
          current.startedAt === entry.startedAt &&
          isUnsettledPredecessor(current)
            ? {
                status: "interrupted",
                abortedLastRun: true,
                lastRunError:
                  "subagent run was interrupted before a terminal lifecycle event was persisted",
              }
            : null,
        { preserveActivity: true, skipMaintenance: true, assertCommitAllowed: assertOwnerless },
      );
      if (updated?.status === "interrupted") {
        count++;
      }
    } catch (error) {
      log.warn(`session: retained startup subagent ${sessionKey}: ${String(error)}`);
    }
  }
  if (count > 0) {
    log.info(`session: marked ${count} prior-process subagent run(s) interrupted`);
  }
}

/** Await SQLite maintenance and projection repair before serving session history. */
export async function runStartupSessionMigration(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  agentIds?: ReadonlySet<string>;
  assertCurrent?: () => void;
  log: SessionStartupMigrationLogger;
  deps?: SessionMigrationDeps;
}): Promise<void> {
  let reconcile = params.deps?.reconcileSessionTranscriptIndexes;
  let reconciledSessions = 0;
  await runSessionStartupMigration({
    ...params,
    handoffDatabase: async (database) => {
      try {
        await reconcileStartupOrphans(database, params.log, params.assertCurrent);
      } catch (error) {
        params.assertCurrent?.();
        params.log.warn(
          `session: retained startup orphans because ownership could not be verified: ${String(error)}`,
        );
      }
      reconcile ??= (await import("../config/sessions/session-transcript-reconcile.js"))
        .reconcileSessionTranscriptIndexes;
      params.assertCurrent?.();
      const result = await reconcile(database);
      params.assertCurrent?.();
      reconciledSessions += result.reconciledSessions;
    },
  });
  if (reconciledSessions > 0) {
    params.log.info(
      `session: rebuilt ${reconciledSessions} transcript projection(s) before serving history`,
    );
  }
}
