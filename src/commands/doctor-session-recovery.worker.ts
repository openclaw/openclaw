import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { selectMainSessionRecoveryCheckpoint } from "../agents/main-session-recovery/main-session-recovery-checkpoint.js";
import type { GoalRecoveryIntent } from "../config/sessions/main-session-recovery.types.js";
import { readSessionEntryRow } from "../config/sessions/session-accessor.sqlite-entry-read.js";
import { readCurrentProjectionSnapshot } from "../config/sessions/session-accessor.sqlite-projection-read.js";
import {
  iterateVisibleMessageRange,
  resolveVisibleMessagePositions,
} from "../config/sessions/session-accessor.sqlite-reset-window.js";
import { getSessionKysely } from "../config/sessions/session-accessor.sqlite-scope.js";
import { readCommittedRecoveryInputInDatabase } from "../config/sessions/session-committed-input-recovery.worker.js";
import { readPendingInputRecoveryIntent } from "../config/sessions/session-pending-input-recovery-intent.js";
import { find as findPlacement } from "../gateway/worker-environments/placement-row-codec.js";
import {
  isFailedWorkerPlacementEnvironmentGone,
  isNeverActivatedWorkerPlacement,
  isWorkerPlacementDestroyedBeforeActivation,
} from "../gateway/worker-environments/placement-target.js";
import { findWorkerEnvironment } from "../gateway/worker-environments/store-row-codec.js";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import type {
  DoctorSessionRecoveryDiagnostic,
  DoctorSessionRecoveryInput,
  RecoveryIssuerDiagnostic,
} from "./doctor-session-recovery.types.js";

/** Runs in the existing read-only history worker; never restores custody or issues authority. */
export function readDoctorSessionRecovery(
  request: DoctorSessionRecoveryInput,
): DoctorSessionRecoveryDiagnostic {
  const { target } = request;
  const unavailable = { status: "unavailable" } as const;
  const mismatch = { status: "identity-mismatch" } as const;
  const issuer = (
    intent: Omit<GoalRecoveryIntent, "goalId"> | undefined,
  ): RecoveryIssuerDiagnostic | null =>
    intent
      ? {
          profileId: intent.issuer.profileId,
          factoryActor: {
            host: intent.issuer.factoryActor.host,
            accountId: intent.issuer.factoryActor.accountId,
          },
          matchesLifecycle:
            intent.sessionId === target.sessionId &&
            intent.sessionKey === target.sessionKey &&
            intent.lifecycleRevision === target.lifecycleRevision,
        }
      : null;
  let agent: DoctorSessionRecoveryDiagnostic["agent"] = unavailable;
  let source: DoctorSessionRecoveryDiagnostic["source"] = unavailable;
  try {
    const read = withOpenClawAgentDatabaseReadOnly(
      (database): DoctorSessionRecoveryDiagnostic["agent"] =>
        runSqliteDeferredTransactionSync(database.db, () => {
          const entry = readSessionEntryRow(database, target.sessionKey)?.entry;
          if (
            database.agentId !== target.agentId ||
            entry?.sessionId !== target.sessionId ||
            entry.lifecycleRevision !== target.lifecycleRevision
          ) {
            return mismatch;
          }
          const restart = entry.mainRestartRecovery;
          let effects: Extract<
            DoctorSessionRecoveryDiagnostic["agent"],
            { status: "read" }
          >["effects"] = unavailable;
          let committed: Extract<
            DoctorSessionRecoveryDiagnostic["agent"],
            { status: "read" }
          >["committed"] = unavailable;
          let pending: Extract<
            DoctorSessionRecoveryDiagnostic["agent"],
            { status: "read" }
          >["pending"] = unavailable;
          try {
            const checkpoint = readCurrentProjectionSnapshot(
              database,
              { ...target, path: database.path },
              (projection) => {
                const visit = (readMessage: (message: unknown) => void) => {
                  for (const item of iterateVisibleMessageRange(
                    projection,
                    0,
                    resolveVisibleMessagePositions(projection).total,
                  )) {
                    if (isRecord(item.event) && item.event.message !== undefined) {
                      readMessage(item.event.message);
                    }
                  }
                };
                return {
                  status: "read" as const,
                  unresolvedEffect: Boolean(
                    selectMainSessionRecoveryCheckpoint(visit).unresolvedEffect,
                  ),
                  unresolvedAcrossTurns: Boolean(
                    selectMainSessionRecoveryCheckpoint(visit, undefined, undefined, true)
                      .unresolvedEffect,
                  ),
                };
              },
            );
            if (checkpoint.kind === "value") {
              effects = checkpoint.value;
            }
          } catch {
            // Missing/unadmitted projection is unknown, never an effects-clear verdict.
          }
          try {
            const snapshot = readCommittedRecoveryInputInDatabase(database, target);
            committed = {
              status: "read",
              current: snapshot.current,
              blocked: snapshot.blocked === true,
              effectHold: snapshot.effectHold === true ? true : snapshot.input ? false : null,
              candidate: snapshot.input
                ? {
                    inputId: snapshot.input.inputId,
                    runId: snapshot.input.runId,
                    profileId: snapshot.input.profileId,
                  }
                : null,
            };
          } catch {
            // The canonical selector owns its admission and effect evaluation.
          }
          try {
            const rows = executeSqliteQuerySync(
              database.db,
              getSessionKysely(database.db)
                .selectFrom("session_pending_inputs")
                .selectAll()
                .where("session_key", "=", target.sessionKey)
                .where("session_id", "=", target.sessionId)
                .where("consumed_event_id", "is", null)
                .where("state", "!=", "cancelled")
                .orderBy("seq", "asc")
                .limit(51),
            ).rows;
            pending = {
              status: "read",
              truncated: rows.length > 50,
              inputs: rows.slice(0, 50).map((row) => {
                const capture = readPendingInputRecoveryIntent(row);
                return {
                  inputId: row.input_id,
                  runId: row.run_id,
                  state: row.state,
                  lifecycleGeneration: row.lifecycle_generation,
                  capture:
                    row.recovery_intent_json == null ? "absent" : capture ? "decoded" : "invalid",
                  issuer: issuer(capture?.intent),
                };
              }),
            };
          } catch {
            // Older or unavailable pending-input storage cannot prove there are no inputs.
          }
          return {
            status: "read",
            sessionStatus: entry.status ?? null,
            goalId: entry.goal?.id ?? null,
            goalStatus: entry.goal?.status ?? null,
            goalPauseOrigin: entry.goalPauseOrigin ?? null,
            archived: entry.archivedAt !== undefined,
            restart: {
              pause: restart?.pause !== undefined,
              acknowledgedPause: restart?.acknowledgedPause !== undefined,
              tombstone: restart?.tombstone !== undefined,
              reservation: restart?.reservation !== undefined,
              startedAttempt: restart?.startedAttempt !== undefined,
              foregroundClaims: Boolean(restart?.foregroundClaims?.tokens.length),
              turnIssuer: issuer(restart?.turnIntent),
              goalIssuer: issuer(restart?.goalIntent),
            },
            effects,
            committed,
            pending,
          };
        }),
      { ...request.database, env: request.env },
    );
    if (read.found) {
      agent = read.value;
    }
  } catch {
    // No raw storage errors, transcript bytes, hashes, or credentials leave this reader.
  }
  try {
    source =
      withExistingOpenClawStateDatabaseReadOnly(
        ({ db }): DoctorSessionRecoveryDiagnostic["source"] =>
          runSqliteDeferredTransactionSync(db, () => {
            const placement = findPlacement(db, target.sessionId);
            if (
              !placement ||
              placement.agentId !== target.agentId ||
              placement.sessionKey !== target.sessionKey ||
              placement.generation !== target.placementGeneration
            ) {
              return mismatch;
            }
            const environment = placement.environmentId
              ? findWorkerEnvironment(db, placement.environmentId)
              : undefined;
            const cleanup = environment?.recoveryHold?.cleanup;
            return {
              status: "read",
              state: placement.state,
              environmentId: placement.environmentId,
              profileId: environment?.profileId ?? null,
              providerId: environment?.providerId ?? null,
              activeOwnerEpoch: placement.activeOwnerEpoch,
              turnClaimRunId: placement.turnClaim?.runId ?? null,
              neverActivated: isNeverActivatedWorkerPlacement(placement),
              environmentGone:
                placement.state === "failed" &&
                isFailedWorkerPlacementEnvironmentGone({
                  placement,
                  environmentService: { get: () => environment },
                }),
              destroyedBeforeActivation: isWorkerPlacementDestroyedBeforeActivation(
                placement,
                environment,
              ),
              environment: environment
                ? {
                    state: environment.state,
                    ownerEpoch: environment.ownerEpoch,
                    leasePresent: environment.leaseId !== null,
                    recoveryHoldPhase: environment.recoveryHold?.phase ?? null,
                    providerReleaseRecorded: cleanup
                      ? cleanup.providerReleasedAtMs !== undefined
                      : null,
                    cleanupSettlementRecorded: cleanup ? cleanup.settledAtMs !== undefined : null,
                  }
                : null,
            };
          }),
        { path: request.statePath, env: request.env },
      ) ?? unavailable;
  } catch {
    // Failed reads cannot be treated as a gone environment or a released provider.
  }
  return { kind: request.kind, diagnosticOnly: true, target, agent, source };
}
