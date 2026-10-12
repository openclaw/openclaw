import { importSandboxRegistryRow } from "../agents/sandbox/registry-import.worker.js";
import { executeSandboxRegistryCommand } from "../agents/sandbox/registry-write.worker.js";
import { persistSubagentRunChangesInWorker } from "../agents/subagents/registry/subagent-registry.store.worker.js";
import { captureWorkspaceStateReceipt } from "../agents/workspace-state-publication.js";
import { replaceWorkspaceAttestationInDatabase } from "../agents/workspace-state-store.kernel.js";
import { executeWorkspaceStateCommand } from "../agents/workspace-state-store.worker.js";
import { readClawInstallSchemaVersionRows } from "../claws/provenance-runtime-read.kernel.js";
import { patchConfigHealthEntryInDatabase } from "../config/io.health-state.kernel.js";
import {
  executeCronStateCommand,
  isCronStateWorkerCommand,
  prepareCronStateWorkerCommand,
} from "../cron/store/dispatch.worker.js";
import { readPendingRepositoryGitHubPublicationInDatabase } from "../gateway/github-repository-publication-read.worker.js";
import { mutateSessionGroupCatalogInDatabase } from "../gateway/session-group-catalog.kernel.js";
import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { getSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import { persistInterruptedUpdateObservation } from "../infra/update-run-interruption-store.js";
import { recordUpdateRunMutationInWorker } from "../infra/update-run-mutation.worker.js";
import { reconcileUpdateRunCandidatesInWorker } from "../infra/update-run-reconciliation.worker.js";
import { writeSecretStoreEntryForConfigRefInDatabase } from "../secrets/store/secret-store-config-ref.kernel.js";
import { purgeExpiredSecretStoreEntriesInDatabase } from "../secrets/store/secret-store-expiry.kernel.js";
import {
  writeSecretStoreEntriesInDatabase,
  rollbackSecretStoreEntryWriteInDatabase,
  deleteSecretStoreEntryInDatabase,
  updateSecretStoreAllowedHostsInDatabase,
} from "../secrets/store/secret-store-write.js";
import { executeSessionStateCommand } from "../sessions/session-state-events.worker.js";
import { listWatchedSessionUpstreamLinksInDatabase } from "../sessions/session-upstream-links.kernel.js";
import { executeSessionUpstreamCommand } from "../sessions/session-upstream-links.worker.js";
import { executeTranscriptRead } from "../transcripts/store-worker-read.js";
import { clearRetiredTuiPointers } from "../tui/tui-last-session.kernel.js";
import { assertAgentDeletionRecoveryHoldPredicate } from "./agent-deletion-journal-recovery.kernel.js";
import {
  listAgentProvenanceInDatabase,
  readAgentProvenanceBatchInDatabase,
  recordAgentProvenanceInDatabase,
} from "./agent-provenance.kernel.js";
import { ensureAgentProvenanceSchema } from "./agent-provenance.schema.js";
import { recordBackupRunInDatabase } from "./backup-run-records.kernel.js";
import { writeConfigMachineState } from "./config-machine-state-write.js";
import {
  deletePersonalGitHubSessionReceiptsInDatabase,
  readSessionReceiptDeletionIdentitiesInDatabase,
} from "./github-personal-publication-lifecycle.js";
import type { OpenClawStateDatabase } from "./openclaw-state-db-contract.js";
import type { ExistingOpenClawStateWriter } from "./openclaw-state-db-existing-write.js";
import { assertOpenClawStateDatabaseOwner } from "./openclaw-state-db-maintenance.js";
import {
  withExistingOpenClawStateDatabaseArtifactPreservingReadOnly,
  withExistingOpenClawStateDatabaseReadOnly,
} from "./openclaw-state-db-readonly.js";
import {
  isOpenClawStateDatabaseOpen,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import type {
  OpenClawStateWorkerBackend,
  OpenClawStateWorkerRuntimeCommand,
} from "./openclaw-state-worker-contract.js";
import { stateWorkerRegistry } from "./openclaw-state-worker-registry.js";
import { executeUserPreferenceCommand } from "./user-preferences.worker.js";
import type { WorkerWriteOperationContext } from "./worker-operation-registry.js";

export { openUpdateRunWriter } from "../infra/update-run-mutation.worker.js";

export function prepareSharedStateCommand(type: PropertyKey): Promise<void> | undefined {
  return stateWorkerRegistry.prepare(type) ?? prepareCronStateWorkerCommand(type);
}

export function executeSharedStateCommand(
  command: OpenClawStateWorkerRuntimeCommand,
  context: { databasePath: string },
  open: () => OpenClawStateDatabase,
  write: WorkerWriteOperationContext["write"],
  writeAdmitted: WorkerWriteOperationContext["writeAdmitted"],
  updateRunWriter: () => ExistingOpenClawStateWriter,
): ReturnType<OpenClawStateWorkerBackend["execute"]> {
  const stateOptions = () => ({
    path: context.databasePath,
    env: getSqliteWorkerStateContext().environment,
  });
  if (stateWorkerRegistry.has(command)) {
    return stateWorkerRegistry.execute(command, { open, write, writeAdmitted, stateOptions });
  }
  if (
    command.type === "updateRuns.recordStep" ||
    command.type === "updateRuns.recordPhase" ||
    command.type === "updateRuns.create" ||
    command.type === "updateRuns.finish" ||
    command.type === "updateRuns.recordVerification" ||
    command.type === "updateRuns.recordDiagnostics"
  ) {
    return recordUpdateRunMutationInWorker(
      command,
      stateOptions(),
      (stage) => requestSqliteWorkerOperationAdmission({ stage, facts: undefined }),
      updateRunWriter,
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
  if (command.type === "userPreferences.read" || command.type === "userPreferences.write") {
    return executeUserPreferenceCommand(command, {
      database: open(),
      ...stateOptions(),
    });
  }
  if (command.type === "tui.lastSession.clear") {
    return clearRetiredTuiPointers(new Set(command.input.retiredSessionKeys), stateOptions(), open);
  }
  if (command.type === "backup.recordOutcome") {
    // A best-effort ledger must not initialize or change a refused backup source.
    // An already-admitted writer carries ownership; cold admission stays read-only.
    if (!isOpenClawStateDatabaseOpen(context.databasePath)) {
      const existing = withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(({ db }) => {
        assertOpenClawStateDatabaseOwner(db, { pathname: context.databasePath });
        return true;
      }, stateOptions());
      if (!existing) {
        return undefined;
      }
    }
    return write(({ db }) => recordBackupRunInDatabase(db, command.input));
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
    return runOpenClawStateWriteTransaction(
      (writer) =>
        captureWorkspaceStateReceipt(writer.db, () => {
          requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
          const result = replaceWorkspaceAttestationInDatabase(writer, command.input);
          requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
          assertAgentDeletionRecoveryHoldPredicate(writer, command.input.recoveryHoldPredicate);
          return result;
        }),
      writeOptions,
    );
  }
  if (
    command.type === "workspace.snapshotAndRegister" ||
    command.type === "workspace.mergeSetup" ||
    command.type === "workspace.expire" ||
    command.type === "workspace.delete"
  ) {
    return executeWorkspaceStateCommand(command, database, writeOptions);
  }
  if (
    command.type === "sandboxRegistry.write" ||
    command.type === "sandboxRegistry.reserve" ||
    command.type === "sandboxRegistry.beginRemoval" ||
    command.type === "sandboxRegistry.finishRemoval"
  ) {
    return executeSandboxRegistryCommand(command, writeOptions);
  }
  if (command.type === "secrets.write") {
    return writeSecretStoreEntriesInDatabase(
      { ...command.input, database: writeOptions },
      command.input.capturePrevious,
      (stage) => requestSqliteWorkerOperationAdmission({ stage, facts: undefined }),
    );
  }
  if (command.type === "secrets.rollback" || command.type === "secrets.delete") {
    const admit = (stage: "transaction" | "commit") =>
      requestSqliteWorkerOperationAdmission({ stage, facts: undefined });
    return command.type === "secrets.rollback"
      ? rollbackSecretStoreEntryWriteInDatabase({ ...command.input, database: writeOptions }, admit)
      : deleteSecretStoreEntryInDatabase({ ...command.input, database: writeOptions }, admit);
  }
  if (command.type === "secrets.allowedHosts") {
    return updateSecretStoreAllowedHostsInDatabase(
      { ...command.input, database: writeOptions },
      (stage) => requestSqliteWorkerOperationAdmission({ stage, facts: undefined }),
    );
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
  if (command.type === "agentProvenance.readBatch" || command.type === "agentProvenance.list") {
    ensureAgentProvenanceSchema(writeOptions);
    return command.type === "agentProvenance.readBatch"
      ? readAgentProvenanceBatchInDatabase(database.db, command.input.agentIds)
      : listAgentProvenanceInDatabase(database.db);
  }
  if (command.type === "agentProvenance.record") {
    ensureAgentProvenanceSchema(writeOptions);
    return runOpenClawStateWriteTransaction(
      ({ db }) => recordAgentProvenanceInDatabase(db, command.input),
      writeOptions,
      { operationLabel: "agent-provenance.record" },
    );
  }
  if (
    command.type === "sessionUpstream.settle" ||
    command.type === "sessionUpstream.upsert" ||
    command.type === "sessionUpstream.delete"
  ) {
    return executeSessionUpstreamCommand(command, writeOptions);
  }
  if (
    command.type === "sessionState.sweep" ||
    command.type === "sessionState.cleanup" ||
    command.type === "sessionState.record" ||
    command.type === "sessionState.prune" ||
    command.type === "sessionState.registerWatch" ||
    command.type === "sessionState.acknowledge"
  ) {
    return executeSessionStateCommand(command, writeOptions);
  }
  if (command.type === "subagents.persistChanges") {
    return persistSubagentRunChangesInWorker(command.input, writeOptions);
  }
  if (command.type === "config.health.patch") {
    const { configPath, patch, expected, updatedAtMs } = command.input;
    return runOpenClawStateWriteTransaction(({ db }) => {
      return patchConfigHealthEntryInDatabase(db, configPath, patch, expected, updatedAtMs);
    }, writeOptions);
  }
  throw new Error("Unknown shared-state SQLite command");
}
