import { importSandboxRegistryRow } from "../agents/sandbox/registry-import.worker.js";
import { writeSandboxRegistry } from "../agents/sandbox/registry-write.worker.js";
import { writeSubagentRunValuesInDatabase } from "../agents/subagents/registry/subagent-registry.store.kernel.js";
import { replaceWorkspaceAttestationInDatabase } from "../agents/workspace-state-store.kernel.js";
import { readClawInstallSchemaVersionRows } from "../claws/provenance-runtime-read.kernel.js";
import { upsertConfigSnapshotAuditRecordInDatabase } from "../config/config-journal-snapshot.kernel.js";
import {
  patchConfigHealthEntryInDatabase,
  readConfigHealthSnapshotInDatabase,
} from "../config/io.health-state.kernel.js";
import {
  executeCronStateCommand,
  isCronStateWorkerCommand,
  prepareCronStateWorkerCommand,
} from "../cron/store/dispatch.worker.js";
import { readPendingRepositoryGitHubPublicationInDatabase } from "../gateway/github-repository-publication.kernel.js";
import { mutateSessionGroupCatalogInDatabase } from "../gateway/session-group-catalog.kernel.js";
import { isWorkerInferenceStoreCommand } from "../gateway/worker-environments/inference-store.worker-contract.js";
import { executeWorkerInferenceStoreCommand } from "../gateway/worker-environments/inference-store.worker.js";
import { startWorkerPlacementDispatchInWorker } from "../gateway/worker-environments/placement-dispatch-store.worker.js";
import { isPlacementSessionToolCommand } from "../gateway/worker-environments/placement-session-tool-operations.worker-contract.js";
import { executePlacementSessionToolCommand } from "../gateway/worker-environments/placement-session-tool-operations.worker.js";
import { isPlacementTurnClaimCommand } from "../gateway/worker-environments/placement-turn-claims.worker-contract.js";
import { executePlacementTurnClaimCommand } from "../gateway/worker-environments/placement-turn-claims.worker.js";
import { isWorkspaceJournalWriteCommand } from "../gateway/worker-environments/placement-workspace-journal.worker-contract.js";
import { executeWorkspaceJournalCommand } from "../gateway/worker-environments/placement-workspace-journal.worker.js";
import { isWorkerEnvironmentCommand } from "../gateway/worker-environments/store-worker-contract.js";
import { executeWorkerEnvironmentCommand } from "../gateway/worker-environments/store.worker.js";
import * as deviceAuth from "../infra/device-auth-store.kernel.js";
import { createSqliteAuditRecordKernel } from "../infra/sqlite-audit-record.kernel.js";
import {
  readStableSqliteFileGeneration,
  sameSqliteFileGeneration,
} from "../infra/sqlite-file-generation.js";
import { deferSqlitePostCommitPublication } from "../infra/sqlite-post-commit.js";
import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { getSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import { persistInterruptedUpdateObservation } from "../infra/update-run-interruption-store.js";
import { recordUpdateRunMutationInWorker } from "../infra/update-run-mutation.worker.js";
import { reconcileUpdateRunCandidatesInWorker } from "../infra/update-run-reconciliation.worker.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  executeProjectRegistryCommand,
  isProjectRegistryCommand,
} from "../projects/project-registry.worker.js";
import { writeSecretStoreEntryForConfigRefInDatabase } from "../secrets/store/secret-store-config-ref.kernel.js";
import { purgeExpiredSecretStoreEntriesInDatabase } from "../secrets/store/secret-store-expiry.kernel.js";
import { executeSessionStateCommand } from "../sessions/session-state-events.worker.js";
import { listWatchedSessionUpstreamLinksInDatabase } from "../sessions/session-upstream-links.kernel.js";
import { executeSessionUpstreamCommand } from "../sessions/session-upstream-links.worker.js";
import { executeTranscriptRead } from "../transcripts/store-worker-read.js";
import { clearRetiredTuiPointers } from "../tui/tui-last-session.kernel.js";
import {
  listAgentProvenanceInDatabase,
  readAgentProvenanceBatchInDatabase,
} from "./agent-provenance.kernel.js";
import { ensureAgentProvenanceSchema } from "./agent-provenance.schema.js";
import { recordBackupRunInDatabase } from "./backup-run-records.kernel.js";
import { writeConfigMachineState } from "./config-machine-state-write.js";
import {
  deletePersonalGitHubSessionReceiptsInDatabase,
  readSessionReceiptDeletionIdentitiesInDatabase,
} from "./github-personal-publication-lifecycle.js";
import type { OpenClawStateDatabase } from "./openclaw-state-db-contract.js";
import { assertOpenClawStateDatabaseOwner } from "./openclaw-state-db-maintenance.js";
import {
  withExistingOpenClawStateDatabaseArtifactPreservingReadOnly,
  withExistingOpenClawStateDatabaseReadOnly,
} from "./openclaw-state-db-readonly.js";
import { runOpenClawStateWriteTransaction } from "./openclaw-state-db.js";
import type {
  OpenClawStateWorkerBackend,
  OpenClawStateWorkerRuntimeCommand,
} from "./openclaw-state-worker-contract.js";
import { stateWorkerRegistry } from "./openclaw-state-worker-registry.js";
import {
  executeRepositoryWorkspaceCommand,
  isRepositoryWorkspaceCommand,
} from "./session-repository-workspaces.worker.js";
import { executeUserPreferenceCommand } from "./user-preferences.worker.js";

const log = createSubsystemLogger("state/worker");

export function prepareSharedStateCommand(type: PropertyKey): Promise<void> | undefined {
  return stateWorkerRegistry.prepare(type) ?? prepareCronStateWorkerCommand(type);
}

export function executeSharedStateCommand(
  command: OpenClawStateWorkerRuntimeCommand,
  context: { databasePath: string },
  open: () => OpenClawStateDatabase,
): ReturnType<OpenClawStateWorkerBackend["execute"]> {
  // Dispatch preparation has loaded this module; do not open or observe token state.
  if (command.type === "deviceAuth.prepare") {
    return undefined;
  }
  const stateOptions = () => ({
    path: context.databasePath,
    env: getSqliteWorkerStateContext().environment,
  });
  if (stateWorkerRegistry.has(command)) {
    return stateWorkerRegistry.execute(command, { open, stateOptions });
  }
  if (isWorkerInferenceStoreCommand(command)) {
    return executeWorkerInferenceStoreCommand(command, open());
  }
  if (isWorkspaceJournalWriteCommand(command)) {
    return executeWorkspaceJournalCommand(command, open());
  }
  if (isPlacementSessionToolCommand(command)) {
    return executePlacementSessionToolCommand(command, open());
  }
  if (isPlacementTurnClaimCommand(command)) {
    return executePlacementTurnClaimCommand(command, open());
  }
  if (isWorkerEnvironmentCommand(command)) {
    return executeWorkerEnvironmentCommand(command, open());
  }
  if (command.type === "workerPlacements.startDispatch") {
    return startWorkerPlacementDispatchInWorker(command.input, open());
  }
  if (command.type === "updateRuns.recordStep" || command.type === "updateRuns.recordPhase") {
    return recordUpdateRunMutationInWorker(command, stateOptions(), (stage) =>
      requestSqliteWorkerOperationAdmission({ stage, facts: undefined }),
    );
  }
  if (command.type === "updateRuns.reconcile") {
    return reconcileUpdateRunCandidatesInWorker(command.input, stateOptions(), (stage) =>
      requestSqliteWorkerOperationAdmission({ stage, facts: undefined }),
    );
  }
  if (command.type === "updateRuns.reconcileInterrupted") {
    return persistInterruptedUpdateObservation(command.input, stateOptions(), (stage) =>
      requestSqliteWorkerOperationAdmission({ stage, facts: undefined }),
    );
  }
  if (command.type === "claws.install-schema-versions") {
    const read = command.input.artifactPreservingReadOnly
      ? withExistingOpenClawStateDatabaseArtifactPreservingReadOnly
      : withExistingOpenClawStateDatabaseReadOnly;
    return read(({ db, path: pathname }) => {
      assertOpenClawStateDatabaseOwner(db, { pathname });
      return readClawInstallSchemaVersionRows(db);
    }, stateOptions());
  }
  if (command.type === "database.generationMatches") {
    // Unavailable inspection retains the known failure; only a stable mismatch expires it.
    return sameSqliteFileGeneration(
      command.input.generation,
      readStableSqliteFileGeneration(context.databasePath),
    );
  }
  if (command.type === "userPreferences.read" || command.type === "userPreferences.write") {
    return executeUserPreferenceCommand(command, {
      database: open(),
      ...stateOptions(),
    });
  }
  if (isRepositoryWorkspaceCommand(command)) {
    return executeRepositoryWorkspaceCommand(command, open());
  }
  if (command.type === "config.health.read") {
    const read = command.input.artifactPreserving
      ? withExistingOpenClawStateDatabaseArtifactPreservingReadOnly
      : withExistingOpenClawStateDatabaseReadOnly;
    return (
      read(({ db }) => readConfigHealthSnapshotInDatabase(db), stateOptions()) ?? {
        state: {},
        basis: {},
      }
    );
  }
  if (command.type === "deviceAuth.read" || command.type === "deviceAuth.readOrigin") {
    const read = (db: OpenClawStateDatabase["db"]) =>
      command.type === "deviceAuth.read"
        ? deviceAuth.readDeviceAuthTokenObservationFromDatabase(db, command.input)
        : deviceAuth.readOriginDeviceTokenObservationFromDatabase(db, command.input);
    return command.input.readOnly
      ? (withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(
          ({ db }) => read(db),
          stateOptions(),
        ) ?? { entry: null, expectedToken: null })
      : read(open().db);
  }
  if (command.type === "tui.lastSession.clear") {
    return clearRetiredTuiPointers(new Set(command.input.retiredSessionKeys), stateOptions(), open);
  }
  const database = open();
  if (command.type === "githubPublication.prepareSessionReceiptDeletion") {
    return readSessionReceiptDeletionIdentitiesInDatabase(database, command.input);
  }
  if (command.type === "githubPublication.deleteSessionReceipts") {
    return deletePersonalGitHubSessionReceiptsInDatabase(database, command.input);
  }
  if (command.type === "githubRepository.personalPending") {
    return readPendingRepositoryGitHubPublicationInDatabase(database.db, command.input);
  }
  if (command.type === "deviceAuth.list") {
    return deviceAuth.readDeviceAuthTokensFromDatabase(database.db, command.input);
  }
  switch (command.type) {
    case "transcripts.canonicalSessionRow":
    case "transcripts.readEntries":
    case "transcripts.exportOwnership":
    case "transcripts.exportPathCollisions":
    case "transcripts.exportPathOwners":
    case "transcripts.sessionEntries":
    case "transcripts.matches":
    case "transcripts.session":
    case "transcripts.entry":
    case "transcripts.latest":
    case "transcripts.notes":
    case "transcripts.libraryEntry":
    case "transcripts.recentStopped":
    case "transcripts.summaryRevision":
    case "transcripts.summarySnapshot":
    case "transcripts.utterances":
    case "transcripts.exportDigest":
    case "transcripts.summary": {
      return executeTranscriptRead({ database, path: context.databasePath }, command);
    }
    default:
      break;
  }
  if (command.type === "sessionUpstream.listWatched") {
    return listWatchedSessionUpstreamLinksInDatabase(database.db);
  }
  if (isCronStateWorkerCommand(command)) {
    return executeCronStateCommand(command, database);
  }
  const writeOptions = {
    database,
    ...stateOptions(),
  };
  if (command.type === "tui.lastSession.write") {
    return writeConfigMachineState(command.input.stateKey, command.input.sessionKey, writeOptions);
  }
  if (command.type === "sandboxRegistry.insertIfMissing") {
    return importSandboxRegistryRow(command.input, writeOptions);
  }
  if (command.type === "workspace.replaceAttestation") {
    return runOpenClawStateWriteTransaction((writer) => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
      const result = replaceWorkspaceAttestationInDatabase(writer, command.input);
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
      return result;
    }, writeOptions);
  }
  if (command.type === "sandboxRegistry.write") {
    return writeSandboxRegistry(command.input, writeOptions);
  }
  if (command.type === "secrets.purge") {
    return purgeExpiredSecretStoreEntriesInDatabase(command.input, writeOptions);
  }
  if (command.type === "secrets.writeForConfigRef") {
    return writeSecretStoreEntryForConfigRefInDatabase(command.input, writeOptions, (stage) =>
      requestSqliteWorkerOperationAdmission({ stage, facts: undefined }),
    );
  }
  if (command.type === "sessionGroups.mutate") {
    return mutateSessionGroupCatalogInDatabase(database, command.input, writeOptions.env);
  }
  if (
    command.type === "deviceAuth.store" ||
    command.type === "deviceAuth.storeOrigin" ||
    command.type === "deviceAuth.clear" ||
    command.type === "deviceAuth.clearOrigin"
  ) {
    return runOpenClawStateWriteTransaction(({ db }) => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
      const result =
        command.type === "deviceAuth.store"
          ? deviceAuth.storeDeviceAuthTokenInDatabase(db, command.input)
          : command.type === "deviceAuth.storeOrigin"
            ? deviceAuth.storeOriginDeviceTokenInDatabase(db, command.input)
            : command.type === "deviceAuth.clear"
              ? deviceAuth.clearDeviceAuthTokenFromDatabase(db, command.input)
              : deviceAuth.clearOriginDeviceTokenInDatabase(db, command.input);
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
      return result;
    }, writeOptions);
  }
  if (command.type === "agentProvenance.readBatch" || command.type === "agentProvenance.list") {
    ensureAgentProvenanceSchema(writeOptions);
    return command.type === "agentProvenance.readBatch"
      ? readAgentProvenanceBatchInDatabase(database.db, command.input.agentIds)
      : listAgentProvenanceInDatabase(database.db);
  }
  if (command.type === "sessionUpstream.current" || command.type === "sessionUpstream.settle") {
    return executeSessionUpstreamCommand(command, writeOptions);
  }
  if (command.type === "sessionState.record" || command.type === "sessionState.prune") {
    return executeSessionStateCommand(command, writeOptions);
  }
  if (command.type === "subagents.persistChanges") {
    const { writeId, values, deleteRunIds } = command.input;
    let committed = false;
    try {
      runOpenClawStateWriteTransaction((writer) => {
        requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: writeId });
        writeSubagentRunValuesInDatabase(writer, values, deleteRunIds);
        requestSqliteWorkerOperationAdmission({ stage: "commit", facts: writeId });
        deferSqlitePostCommitPublication(writer.db, () => {
          committed = true;
        });
      }, writeOptions);
    } catch (error) {
      if (!committed) {
        throw error;
      }
      log.warn("Subagent registry write committed before cleanup failed", { error });
    }
    return { writeId };
  }
  if (command.type === "backup.recordOutcome") {
    return runOpenClawStateWriteTransaction(
      ({ db }) => recordBackupRunInDatabase(db, command.input),
      writeOptions,
    );
  }
  if (isProjectRegistryCommand(command)) {
    return executeProjectRegistryCommand(command, writeOptions);
  }
  if (command.type === "config.health.patch") {
    const { configPath, patch, expected, updatedAtMs } = command.input;
    return runOpenClawStateWriteTransaction(({ db }) => {
      return patchConfigHealthEntryInDatabase(db, configPath, patch, expected, updatedAtMs);
    }, writeOptions);
  }
  if (command.type === "diagnostic.register") {
    const { scope, maxEntries, record } = command.input;
    return runOpenClawStateWriteTransaction(({ db }) => {
      createSqliteAuditRecordKernel(db, { scope, maxEntries }).register(record);
    }, writeOptions);
  }
  if (command.type === "config.snapshot.upsert") {
    return runOpenClawStateWriteTransaction(
      ({ db }) => upsertConfigSnapshotAuditRecordInDatabase(db, command.input),
      writeOptions,
    );
  }
  throw new Error("Unknown shared-state SQLite command");
}
