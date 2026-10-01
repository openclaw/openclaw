import { isWorkerInferenceStoreCommand } from "../gateway/worker-environments/inference-store.worker-contract.js";
import { isPlacementSessionToolCommand } from "../gateway/worker-environments/placement-session-tool-operations.worker-contract.js";
import { isPlacementTurnClaimCommand } from "../gateway/worker-environments/placement-turn-claims.worker-contract.js";
import { isWorkspaceJournalWriteCommand } from "../gateway/worker-environments/placement-workspace-journal.worker-contract.js";
import { isWorkerEnvironmentCommand } from "../gateway/worker-environments/store-worker-contract.js";
import {
  readStableSqliteFileGeneration,
  sameSqliteFileGeneration,
} from "../infra/sqlite-file-generation.js";
import { deferSqlitePostCommitPublication } from "../infra/sqlite-post-commit.js";
import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { getSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
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
  sharedStateCommandRuntimes as runtimes,
  requirePreparedSharedStateCommand,
} from "./openclaw-state-worker-runtime-loaders.js";

export { prepareSharedStateCommand } from "./openclaw-state-worker-runtime-loaders.js";

const log = createSubsystemLogger("state/worker");

export function executeSharedStateCommand(
  command: OpenClawStateWorkerRuntimeCommand,
  context: { databasePath: string },
  open: () => OpenClawStateDatabase,
): ReturnType<OpenClawStateWorkerBackend["execute"]> {
  const prepared = requirePreparedSharedStateCommand(command);
  // Dispatch preparation has loaded the token kernel; do not open or observe token state.
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
    return runtimes.workerInference.get().executeWorkerInferenceStoreCommand(command, open());
  }
  if (isWorkspaceJournalWriteCommand(command)) {
    return runtimes.placementJournals.get().executeWorkspaceJournalCommand(command, open());
  }
  if (isPlacementSessionToolCommand(command)) {
    return runtimes.placementTools.get().executePlacementSessionToolCommand(command, open());
  }
  if (isPlacementTurnClaimCommand(command)) {
    return runtimes.placementTurns.get().executePlacementTurnClaimCommand(command, open());
  }
  if (isWorkerEnvironmentCommand(command)) {
    return runtimes.workerEnvironments.get().executeWorkerEnvironmentCommand(command, open());
  }
  if (command.type === "workerPlacements.startDispatch") {
    return runtimes.workerPlacements
      .get()
      .startWorkerPlacementDispatchInWorker(command.input, open());
  }
  if (command.type === "updateRuns.recordStep" || command.type === "updateRuns.recordPhase") {
    return runtimes.updateMutation
      .get()
      .recordUpdateRunMutationInWorker(command, stateOptions(), (stage) =>
        requestSqliteWorkerOperationAdmission({ stage, facts: undefined }),
      );
  }
  if (command.type === "updateRuns.reconcile") {
    return runtimes.updateReconcile
      .get()
      .reconcileUpdateRunCandidatesInWorker(command.input, stateOptions(), (stage) =>
        requestSqliteWorkerOperationAdmission({ stage, facts: undefined }),
      );
  }
  if (command.type === "updateRuns.reconcileInterrupted") {
    return runtimes.updateInterrupted
      .get()
      .persistInterruptedUpdateObservation(command.input, stateOptions(), (stage) =>
        requestSqliteWorkerOperationAdmission({ stage, facts: undefined }),
      );
  }
  if (command.type === "claws.install-schema-versions") {
    const read = command.input.artifactPreservingReadOnly
      ? withExistingOpenClawStateDatabaseArtifactPreservingReadOnly
      : withExistingOpenClawStateDatabaseReadOnly;
    return read(({ db, path: pathname }) => {
      assertOpenClawStateDatabaseOwner(db, { pathname });
      return runtimes.claws.get().readClawInstallSchemaVersionRows(db);
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
    return runtimes.userPreferences.get().executeUserPreferenceCommand(command, {
      database: open(),
      ...stateOptions(),
    });
  }
  if (
    prepared === runtimes.repositoryWorkspaces &&
    runtimes.repositoryWorkspaces.get().isRepositoryWorkspaceCommand(command)
  ) {
    return runtimes.repositoryWorkspaces.get().executeRepositoryWorkspaceCommand(command, open());
  }
  if (command.type === "config.health.read") {
    const read = command.input.artifactPreserving
      ? withExistingOpenClawStateDatabaseArtifactPreservingReadOnly
      : withExistingOpenClawStateDatabaseReadOnly;
    return (
      read(
        ({ db }) => runtimes.configHealth.get().readConfigHealthSnapshotInDatabase(db),
        stateOptions(),
      ) ?? {
        state: {},
        basis: {},
      }
    );
  }
  if (command.type === "deviceAuth.read" || command.type === "deviceAuth.readOrigin") {
    const read = (db: OpenClawStateDatabase["db"]) =>
      command.type === "deviceAuth.read"
        ? runtimes.deviceAuth.get().readDeviceAuthTokenObservationFromDatabase(db, command.input)
        : runtimes.deviceAuth.get().readOriginDeviceTokenObservationFromDatabase(db, command.input);
    return command.input.readOnly
      ? (withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(
          ({ db }) => read(db),
          stateOptions(),
        ) ?? { entry: null, expectedToken: null })
      : read(open().db);
  }
  if (command.type === "tui.lastSession.clear") {
    return runtimes.tuiClear
      .get()
      .clearRetiredTuiPointers(new Set(command.input.retiredSessionKeys), stateOptions(), open);
  }
  const database = open();
  if (command.type === "githubPublication.prepareSessionReceiptDeletion") {
    return runtimes.githubPublication
      .get()
      .readSessionReceiptDeletionIdentitiesInDatabase(database, command.input);
  }
  if (command.type === "githubPublication.deleteSessionReceipts") {
    return runtimes.githubPublication
      .get()
      .deletePersonalGitHubSessionReceiptsInDatabase(database, command.input);
  }
  if (command.type === "githubRepository.personalPending") {
    return runtimes.githubRepository
      .get()
      .readPendingRepositoryGitHubPublicationInDatabase(database.db, command.input);
  }
  if (command.type === "deviceAuth.list") {
    return runtimes.deviceAuth.get().readDeviceAuthTokensFromDatabase(database.db, command.input);
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
      return runtimes.transcripts
        .get()
        .executeTranscriptRead({ database, path: context.databasePath }, command);
    }
    default:
      break;
  }
  if (command.type === "sessionUpstream.listWatched") {
    return runtimes.sessionUpstreamRead
      .get()
      .listWatchedSessionUpstreamLinksInDatabase(database.db);
  }
  if (prepared === runtimes.cron && runtimes.cron.get().isCronStateWorkerCommand(command)) {
    return runtimes.cron.get().executeCronStateCommand(command, database);
  }
  const writeOptions = {
    database,
    ...stateOptions(),
  };
  if (command.type === "tui.lastSession.write") {
    return runtimes.tuiWrite
      .get()
      .writeConfigMachineState(command.input.stateKey, command.input.sessionKey, writeOptions);
  }
  if (command.type === "sandboxRegistry.insertIfMissing") {
    return runtimes.sandboxImport.get().importSandboxRegistryRow(command.input, writeOptions);
  }
  if (command.type === "workspace.replaceAttestation") {
    return runOpenClawStateWriteTransaction((writer) => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
      const result = runtimes.workspace
        .get()
        .replaceWorkspaceAttestationInDatabase(writer, command.input);
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
      return result;
    }, writeOptions);
  }
  if (command.type === "sandboxRegistry.write") {
    return runtimes.sandboxWrite.get().writeSandboxRegistry(command.input, writeOptions);
  }
  if (command.type === "secrets.purge") {
    return runtimes.secretsPurge
      .get()
      .purgeExpiredSecretStoreEntriesInDatabase(command.input, writeOptions);
  }
  if (command.type === "secrets.writeForConfigRef") {
    return runtimes.secretsConfigRef
      .get()
      .writeSecretStoreEntryForConfigRefInDatabase(command.input, writeOptions, (stage) =>
        requestSqliteWorkerOperationAdmission({ stage, facts: undefined }),
      );
  }
  if (command.type === "sessionGroups.mutate") {
    return runtimes.sessionGroups
      .get()
      .mutateSessionGroupCatalogInDatabase(database, command.input, writeOptions.env);
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
          ? runtimes.deviceAuth.get().storeDeviceAuthTokenInDatabase(db, command.input)
          : command.type === "deviceAuth.storeOrigin"
            ? runtimes.deviceAuth.get().storeOriginDeviceTokenInDatabase(db, command.input)
            : command.type === "deviceAuth.clear"
              ? runtimes.deviceAuth.get().clearDeviceAuthTokenFromDatabase(db, command.input)
              : runtimes.deviceAuth.get().clearOriginDeviceTokenInDatabase(db, command.input);
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
      return result;
    }, writeOptions);
  }
  if (command.type === "agentProvenance.readBatch" || command.type === "agentProvenance.list") {
    runtimes.agentProvenance.get().ensureAgentProvenanceSchema(writeOptions);
    return command.type === "agentProvenance.readBatch"
      ? runtimes.agentProvenance
          .get()
          .readAgentProvenanceBatchInDatabase(database.db, command.input.agentIds)
      : runtimes.agentProvenance.get().listAgentProvenanceInDatabase(database.db);
  }
  if (command.type === "sessionUpstream.current" || command.type === "sessionUpstream.settle") {
    return runtimes.sessionUpstream.get().executeSessionUpstreamCommand(command, writeOptions);
  }
  if (command.type === "sessionState.record" || command.type === "sessionState.prune") {
    return runtimes.sessionState.get().executeSessionStateCommand(command, writeOptions);
  }
  if (command.type === "subagents.persistChanges") {
    const { writeId, values, deleteRunIds } = command.input;
    let committed = false;
    try {
      runOpenClawStateWriteTransaction((writer) => {
        requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: writeId });
        runtimes.subagents.get().writeSubagentRunValuesInDatabase(writer, values, deleteRunIds);
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
      ({ db }) => runtimes.backup.get().recordBackupRunInDatabase(db, command.input),
      writeOptions,
    );
  }
  if (prepared === runtimes.projects && runtimes.projects.get().isProjectRegistryCommand(command)) {
    return runtimes.projects.get().executeProjectRegistryCommand(command, writeOptions);
  }
  if (command.type === "config.health.patch") {
    const { configPath, patch, expected, updatedAtMs } = command.input;
    return runOpenClawStateWriteTransaction(({ db }) => {
      return runtimes.configHealth
        .get()
        .patchConfigHealthEntryInDatabase(db, configPath, patch, expected, updatedAtMs);
    }, writeOptions);
  }
  if (command.type === "diagnostic.register") {
    const { scope, maxEntries, record } = command.input;
    return runOpenClawStateWriteTransaction(({ db }) => {
      runtimes.diagnostic
        .get()
        .createSqliteAuditRecordKernel(db, { scope, maxEntries })
        .register(record);
    }, writeOptions);
  }
  if (command.type === "config.snapshot.upsert") {
    return runOpenClawStateWriteTransaction(
      ({ db }) =>
        runtimes.configSnapshot.get().upsertConfigSnapshotAuditRecordInDatabase(db, command.input),
      writeOptions,
    );
  }
  throw new Error("Unknown shared-state SQLite command");
}
