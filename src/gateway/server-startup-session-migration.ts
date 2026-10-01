import { buildAgentRunTerminalOutcome } from "../agents/agent-run-terminal-outcome.js";
import { hasSubagentSessionRecoveryOwner } from "../agents/subagents/registry/subagent-session-reconciliation.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { readSessionEntryRow } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import {
  hasSessionEntriesByStatus,
  readSessionEntriesByStatus,
} from "../config/sessions/session-accessor.sqlite-status.js";
import {
  runSessionStartupMigration,
  type SessionStartupMigrationLogger,
} from "../config/sessions/startup-migration.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readActiveGatewayLockIdentity } from "../infra/gateway-lock.js";
import { readGatewayOwnerLease } from "../infra/gateway-owner-lease.js";
import { hasActiveGatewayStateOwner } from "../infra/gateway-state-owner.js";
import {
  isSubagentSessionKey,
  isIncognitoSessionKey,
  resolveAgentIdFromSessionKey,
} from "../routing/session-key.js";
import { isSessionWorkAdmissionActive } from "../sessions/session-lifecycle-admission.js";
import { recordGatewaySessionRunFailure } from "../sessions/session-run-error.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import {
  withOpenClawAgentDatabaseAsync,
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
  if (!hasActiveGatewayStateOwner(statePath)) {
    return undefined;
  }
  try {
    const running = withOpenClawAgentDatabaseReadOnly(
      (connection) => hasSessionEntriesByStatus(connection, ["running"]),
      database,
    );
    if (running.found && !running.value) {
      return undefined;
    }
  } catch {
    // The writable owner retains schema repair and integrity diagnosis for uncertain reads.
  }
  const lock = await readActiveGatewayLockIdentity({ env, requireInspection: true });
  if (lock?.pid !== process.pid || !lock.ownerId) {
    return undefined;
  }
  const assertGatewayOwner = () => {
    assertCurrent?.();
    const lease = readGatewayOwnerLease({ env, current: true });
    if (
      !hasActiveGatewayStateOwner(statePath) ||
      lease?.state !== "live" ||
      lease.pid !== process.pid ||
      lease.owner !== lock.ownerId
    ) {
      throw new Error("startup Gateway ownership changed or could not be verified");
    }
  };
  // A foreign native lease can prevent readiness from lending its integrity proof.
  // Admit asynchronously and retain this exact connection through receipt settlement.
  return withOpenClawAgentDatabaseAsync(
    database,
    async (connection) => {
      const selected = readSessionEntriesByStatus(connection, ["running"]);
      let interrupted = 0;
      let retained = 0;
      for (const { entry, sessionKey } of selected) {
        if (
          !isSubagentSessionKey(sessionKey) ||
          isIncognitoSessionKey(sessionKey) ||
          !isUnsettledPredecessor(entry)
        ) {
          continue;
        }
        const identity = { sessionKey, sessionId: entry.sessionId, env };
        const target = {
          agentId: resolveAgentIdFromSessionKey(sessionKey),
          env,
          sessionKey,
          storePath: connection.path,
        };
        const matchesPredecessor = (current: InternalSessionEntry | undefined) =>
          current !== undefined &&
          current.sessionId === entry.sessionId &&
          current.lifecycleRevision === entry.lifecycleRevision &&
          current.lifecycleRunId === entry.lifecycleRunId &&
          current.updatedAt === entry.updatedAt &&
          current.startedAt === entry.startedAt &&
          isUnsettledPredecessor(current);
        const hasOwner = () =>
          hasSubagentSessionRecoveryOwner(identity) ||
          isSessionWorkAdmissionActive(connection.path, [sessionKey, entry.sessionId]);
        const assertOwnerless = () => {
          assertGatewayOwner();
          if (hasOwner()) {
            throw new Error("a current or retained run/task owns this session");
          }
        };
        try {
          assertGatewayOwner();
          // Retained runs belong to registry recovery; only session-only orphans settle here.
          if (hasOwner()) {
            retained++;
            continue;
          }
          const outcome = buildAgentRunTerminalOutcome({
            status: "error",
            error: "subagent run was interrupted before a terminal lifecycle event was persisted",
            startedAt: entry.startedAt,
            // This is the repair observation, not a reconstructed execution finish time.
            endedAt: Date.now(),
          });
          await recordGatewaySessionRunFailure({
            target: {
              ...target,
              sessionId: entry.sessionId,
              expectedLifecycleRevision: entry.lifecycleRevision,
            },
            // A recovery-only receipt identity must not suppress the notice after partial output.
            runId: `startup-orphan:${entry.sessionId}:${entry.lifecycleRunId ?? entry.startedAt}`,
            error: outcome.error,
            assertCommitAllowed: assertOwnerless,
            settleStartupSession: () => {
              const current = readSessionEntryRow(connection, sessionKey)?.entry;
              if (!current || !matchesPredecessor(current)) {
                throw new Error("startup subagent session changed before interruption receipt");
              }
              // The receipt owner holds the outer transaction; either both writes commit or neither does.
              replaceSessionEntrySync(target, {
                ...current,
                status: "interrupted",
                abortedLastRun: true,
                endedAt: outcome.endedAt,
                lastRunError: outcome.error,
              });
            },
          });
          interrupted++;
        } catch (error) {
          log.warn(`session: retained startup subagent ${sessionKey}: ${String(error)}`);
        }
      }
      return { interrupted, retained };
    },
    assertGatewayOwner,
  );
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
  let interruptedSubagents = 0;
  let retainedSubagents = 0;
  await runSessionStartupMigration({
    ...params,
    handoffDatabase: async (database) => {
      try {
        const result = await reconcileStartupOrphans(database, params.log, params.assertCurrent);
        interruptedSubagents += result?.interrupted ?? 0;
        retainedSubagents += result?.retained ?? 0;
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
  if (interruptedSubagents > 0 || retainedSubagents > 0) {
    params.log.info(
      `session: startup subagents: ${interruptedSubagents} interrupted, ${retainedSubagents} retained by run/task owners`,
    );
  }
  if (reconciledSessions > 0) {
    params.log.info(
      `session: rebuilt ${reconciledSessions} transcript projection(s) before serving history`,
    );
  }
}
