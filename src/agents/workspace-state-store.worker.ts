import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import {
  deferSqliteWorkerCommitReceipt,
  requestSqliteWorkerOperationAdmission,
} from "../infra/sqlite-worker-operation-admission.js";
import { assertAgentDeletionRecoveryHoldPredicate } from "../state/agent-deletion-journal-recovery.kernel.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import {
  assertCanonicalIntegerTimestamp,
  assertCanonicalTimestamp,
  deleteWorkspaceStateRowsInDatabase,
  readWorkspaceStateSnapshotFromDatabase,
  registerWorkspaceStateAliasIdentitiesInTransaction,
  resolveWorkspaceIdentityFromDatabase,
  hasRecentWorkspaceSetupState,
  recentWorkspaceAttestation,
  WORKSPACE_SETUP_STATE_VERSION,
  type WorkspaceSetupState,
  type WorkspaceStateDatabase,
  type WorkspaceStateDatabaseHandle,
} from "./workspace-state-store.kernel.js";
import type { WorkspaceStateWorkerCommand } from "./workspace-state-store.worker-contract.js";

function mergeSetup(
  database: WorkspaceStateDatabaseHandle,
  workspaceDir: string,
  next: Partial<Omit<WorkspaceSetupState, "version">>,
  nowMs: number,
): WorkspaceSetupState {
  assertCanonicalIntegerTimestamp(nowMs, "setup update");
  if (next.bootstrapSeededAt) {
    assertCanonicalTimestamp(next.bootstrapSeededAt, "bootstrap seeded");
  }
  if (next.setupCompletedAt) {
    assertCanonicalTimestamp(next.setupCompletedAt, "setup completed");
  }
  const resolution = resolveWorkspaceIdentityFromDatabase({ workspaceDir, database });
  const identity = resolution.identity;
  const snapshot = readWorkspaceStateSnapshotFromDatabase({ identity, database });
  const bootstrapSeededAt = snapshot.setup.bootstrapSeededAt ?? next.bootstrapSeededAt;
  const setupCompletedAt = snapshot.setup.setupCompletedAt ?? next.setupCompletedAt;
  const merged: WorkspaceSetupState = {
    version: WORKSPACE_SETUP_STATE_VERSION,
    ...(bootstrapSeededAt ? { bootstrapSeededAt } : {}),
    ...(setupCompletedAt ? { setupCompletedAt } : {}),
  };
  const kysely = getNodeSqliteKysely<WorkspaceStateDatabase>(database.db);
  executeSqliteQuerySync(
    database.db,
    kysely
      .insertInto("workspace_setup_state")
      .values({
        workspace_key: identity.workspaceKey,
        workspace_path: identity.workspacePath,
        version: WORKSPACE_SETUP_STATE_VERSION,
        bootstrap_seeded_at: merged.bootstrapSeededAt ?? null,
        setup_completed_at: merged.setupCompletedAt ?? null,
        updated_at: nowMs,
      })
      .onConflict((conflict) =>
        conflict.column("workspace_key").doUpdateSet({
          workspace_path: identity.workspacePath,
          version: WORKSPACE_SETUP_STATE_VERSION,
          bootstrap_seeded_at: merged.bootstrapSeededAt ?? null,
          setup_completed_at: merged.setupCompletedAt ?? null,
          updated_at: nowMs,
        }),
      ),
  );
  registerWorkspaceStateAliasIdentitiesInTransaction({
    database,
    identity,
    aliases: resolution.aliases,
    updatedAtMs: nowMs,
  });
  return merged;
}

function expire(
  database: WorkspaceStateDatabaseHandle,
  workspaceDir: string,
  nowMs: number,
): string | false {
  assertCanonicalIntegerTimestamp(nowMs, "workspace expiry check");
  const resolution = resolveWorkspaceIdentityFromDatabase({ workspaceDir, database });
  const identity = resolution.identity;
  const snapshot = readWorkspaceStateSnapshotFromDatabase({ identity, database });
  const preserveRecentState = () => {
    registerWorkspaceStateAliasIdentitiesInTransaction({
      database,
      identity,
      aliases: resolution.aliases,
      updatedAtMs: nowMs,
    });
    return false as const;
  };
  if (
    recentWorkspaceAttestation(snapshot.attestation, nowMs) ||
    hasRecentWorkspaceSetupState(snapshot, nowMs)
  ) {
    return preserveRecentState();
  }
  deleteWorkspaceStateRowsInDatabase(database, identity);
  return identity.workspacePath;
}

export function executeWorkspaceStateCommand(
  command: WorkspaceStateWorkerCommand,
  database: WorkspaceStateDatabaseHandle,
  options: OpenClawStateDatabaseOptions,
) {
  if (command.type === "workspace.snapshotAndRegister") {
    const initial = runSqliteDeferredTransactionSync(database.db, () => {
      assertAgentDeletionRecoveryHoldPredicate(database, command.input.recoveryHoldPredicate);
      const resolution = resolveWorkspaceIdentityFromDatabase({
        workspaceDir: command.input.workspaceDir,
        database,
      });
      return {
        resolution,
        snapshot: readWorkspaceStateSnapshotFromDatabase({
          identity: resolution.identity,
          database,
        }),
      };
    });
    if (
      initial.resolution.missingAliasKeys.length === 0 ||
      (!initial.snapshot.setupExists && !initial.snapshot.attestation)
    ) {
      return initial.snapshot;
    }
    return runOpenClawStateWriteTransaction((writer) => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
      const resolution = resolveWorkspaceIdentityFromDatabase({
        workspaceDir: command.input.workspaceDir,
        database: writer,
      });
      if (resolution.identity.workspaceKey !== initial.resolution.identity.workspaceKey) {
        throw new Error("Workspace state identity changed before alias registration");
      }
      const snapshot = readWorkspaceStateSnapshotFromDatabase({
        identity: resolution.identity,
        database: writer,
      });
      if (snapshot.setupExists || snapshot.attestation) {
        registerWorkspaceStateAliasIdentitiesInTransaction({
          database: writer,
          identity: resolution.identity,
          aliases: resolution.aliases,
          updatedAtMs: Date.now(),
        });
      }
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
      assertAgentDeletionRecoveryHoldPredicate(writer, command.input.recoveryHoldPredicate);
      return snapshot;
    }, options);
  }
  return runOpenClawStateWriteTransaction((writer) => {
    requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
    const result =
      command.type === "workspace.mergeSetup"
        ? mergeSetup(writer, command.input.workspaceDir, command.input.next, command.input.nowMs)
        : expire(writer, command.input.workspaceDir, command.input.nowMs);
    requestSqliteWorkerOperationAdmission({
      stage: "commit",
      facts: command.type === "workspace.expire" ? result : undefined,
    });
    assertAgentDeletionRecoveryHoldPredicate(writer, command.input.recoveryHoldPredicate);
    if (command.type === "workspace.expire") {
      deferSqliteWorkerCommitReceipt(writer.db, result);
    }
    return result;
  }, options);
}
