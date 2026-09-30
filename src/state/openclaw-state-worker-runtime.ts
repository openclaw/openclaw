import { executeAcpSessionMutationInWorker } from "../acp/runtime/session-meta-write.worker.js";
import {
  readAuthProfileRows,
  SHARED_AUTH_STORE_STATE_KEY,
} from "../agents/auth-profiles/sqlite-json.js";
import { isMissingDatabasePath } from "../agents/auth-profiles/sqlite-read-pool.js";
import type { AuthProfileRowRead } from "../agents/auth-profiles/types.js";
import {
  readNativeHookRelayBridgeSnapshotFromDatabase,
  listNativeHookRelayBridgeSnapshotsInDatabase,
} from "../agents/harness/native-hook-relay-store.kernel.js";
import { executeNativeHookRelayMutation } from "../agents/harness/native-hook-relay-store.worker.js";
import {
  isMcpOAuthWorkerCommand,
  executeMcpOAuthWorkerCommand,
} from "../agents/mcp-oauth-store.worker.js";
import { importSandboxRegistryRow } from "../agents/sandbox/registry-import.worker.js";
import { writeSandboxRegistry } from "../agents/sandbox/registry-write.worker.js";
import { writeSubagentRunValuesInDatabase } from "../agents/subagents/registry/subagent-registry.store.kernel.js";
import { replaceWorkspaceAttestationInDatabase } from "../agents/workspace-state-store.kernel.js";
import {
  isWorktreeWorkerCommand,
  executeWorktreeWorkerCommand,
} from "../agents/worktrees/dispatch.worker.js";
import { listAuditEventsInDatabase } from "../audit/audit-event-read.kernel.js";
import { executeAuditWriterCommand } from "../audit/audit-event-writer.worker.js";
import {
  isChannelIngressCommand,
  executeChannelIngressCommand,
} from "../channels/message/ingress-queue.worker.js";
import { readClawInstallSchemaVersionRows } from "../claws/provenance-runtime-read.kernel.js";
import { readSqliteDatabaseBloat } from "../commands/doctor-db-bloat.read.js";
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
import { executeFleetRegistryCommand } from "../fleet/registry.worker.js";
import { readPendingRepositoryGitHubPublicationInDatabase } from "../gateway/github-repository-publication.kernel.js";
import {
  executeManagedImageRecordCommand,
  isManagedImageRecordCommand,
} from "../gateway/managed-image-record-store.kernel.js";
import {
  executeOperatorApprovalCommand,
  isOperatorApprovalCommand,
} from "../gateway/operator-approval-store.worker.js";
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
import {
  readDeferredPluginMigrationsInWorker,
  recordDeferredPluginMigrationsInWorker,
} from "../infra/deferred-plugin-migrations.worker.js";
import * as deliveryQueue from "../infra/delivery-queue.worker.js";
import * as deviceAuth from "../infra/device-auth-store.kernel.js";
import { executeDevicePairingMutationInWorker } from "../infra/device-pairing-dispatch.worker.js";
import { isDevicePairingMutationCommand } from "../infra/device-pairing-worker-contract.js";
import { commitExecAuthorizationsInWorker } from "../infra/exec-approvals-authorization.worker.js";
import * as conversationBindings from "../infra/outbound/current-conversation-bindings.worker.js";
import { executePromotionCommand } from "../infra/promotions-feed.worker.js";
import { isApnsRegistrationWorkerCommand } from "../infra/push-apns-store.worker-contract.js";
import { executeApnsRegistrationCommand } from "../infra/push-apns-store.worker.js";
import { readPersistedVapidKeyPairInDatabase } from "../infra/push-web-store.kernel.js";
import { executeWebPushCommand, isWebPushCommand } from "../infra/push-web-store.worker.js";
import { isSessionDeliveryCommand } from "../infra/session-delivery-queue.worker-contract.js";
import { executeSessionDeliveryCommand } from "../infra/session-delivery-queue.worker.js";
import { createSqliteAuditRecordKernel } from "../infra/sqlite-audit-record.kernel.js";
import {
  readStableSqliteFileGeneration,
  sameSqliteFileGeneration,
} from "../infra/sqlite-file-generation.js";
import { deferSqlitePostCommitPublication } from "../infra/sqlite-post-commit.js";
import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { getSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import { isLegacyMcpOAuthWorkerCommand } from "../infra/state-migrations.mcp-oauth.worker-contract.js";
import { executeLegacyMcpOAuthWorkerCommand } from "../infra/state-migrations.mcp-oauth.worker.js";
import {
  countRecentTelemetrySessionsInDatabase,
  persistTelemetrySuccessInDatabase,
  readTelemetryStateInWorker,
} from "../infra/telemetry-store.kernel.js";
import { persistInterruptedUpdateObservation } from "../infra/update-run-interruption-store.js";
import { recordUpdateRunMutationInWorker } from "../infra/update-run-mutation.worker.js";
import { reconcileUpdateRunCandidatesInWorker } from "../infra/update-run-reconciliation.worker.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { readRemoteModelCatalog } from "../model-catalog/remote-store.js";
import { isNodeWorkerJournalCommand } from "../node-host/node-worker-journal.worker-contract.js";
import { executeNodeWorkerJournalCommand } from "../node-host/node-worker-journal.worker.js";
import { executePluginBlobCommand } from "../plugin-state/plugin-blob-store.worker.js";
import { isPluginBlobWorkerCommand } from "../plugin-state/plugin-blob-worker-contract.js";
import {
  readPluginBindingApprovalsInDatabase,
  upsertPluginBindingApprovalInDatabase,
} from "../plugins/conversation-binding-state.kernel.js";
import {
  readHostedCatalogSnapshotInDatabase,
  writeHostedCatalogSnapshotInDatabase,
} from "../plugins/official-external-plugin-catalog-snapshot-store.kernel.js";
import { HostedCatalogSignedFeedMonotonicityError } from "../plugins/official-external-plugin-catalog-source.js";
import {
  executeProjectRegistryCommand,
  isProjectRegistryCommand,
} from "../projects/project-registry.worker.js";
import { writeSecretStoreEntryForConfigRefInDatabase } from "../secrets/store/secret-store-config-ref.kernel.js";
import { purgeExpiredSecretStoreEntriesInDatabase } from "../secrets/store/secret-store-expiry.kernel.js";
import { executeSessionStateCommand } from "../sessions/session-state-events.worker.js";
import { listWatchedSessionUpstreamLinksInDatabase } from "../sessions/session-upstream-links.kernel.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import {
  isSkillUploadCommand,
  executeSkillUploadCommand,
} from "../skills/lifecycle/upload-store.worker.js";
import * as workshopChanges from "../skills/workshop/changes.worker.js";
import {
  readSkillUsageInDatabase,
  recordSkillUsageInDatabase,
} from "../skills/workshop/skill-usage.kernel.js";
import { executeTranscriptRead } from "../transcripts/store-worker-read.js";
import {
  executeTranscriptWrite,
  isTranscriptWriteCommand,
} from "../transcripts/store-worker-write.js";
import { clearRetiredTuiPointers } from "../tui/tui-last-session.kernel.js";
import {
  listAgentProvenanceInDatabase,
  readAgentProvenanceBatchInDatabase,
} from "./agent-provenance.kernel.js";
import { ensureAgentProvenanceSchema } from "./agent-provenance.schema.js";
import { recordBackupRunInDatabase } from "./backup-run-records.kernel.js";
import { writeConfigMachineState } from "./config-machine-state-write.js";
import { readConfigMachineState } from "./config-machine-state.js";
import {
  deletePersonalGitHubSessionReceiptsInDatabase,
  readSessionReceiptDeletionIdentitiesInDatabase,
} from "./github-personal-publication-lifecycle.js";
import { isOnboardingRecommendationWriteCommand } from "./onboarding-recommendations.contract.js";
import { executeOnboardingRecommendationCommand } from "./onboarding-recommendations.kernel.js";
import type { OpenClawStateDatabase } from "./openclaw-state-db-contract.js";
import { assertOpenClawStateDatabaseOwner } from "./openclaw-state-db-maintenance.js";
import {
  withOpenClawStateDatabaseReadOnly,
  withArtifactPreservingStateReads,
  withExistingOpenClawStateDatabaseArtifactPreservingReadOnly,
  withExistingOpenClawStateDatabaseReadOnly,
} from "./openclaw-state-db-readonly.js";
import { runOpenClawStateWriteTransaction } from "./openclaw-state-db.js";
import type {
  OpenClawStateWorkerBackend,
  OpenClawStateWorkerRuntimeCommand,
} from "./openclaw-state-worker-contract.js";
import {
  executeRepositoryWorkspaceCommand,
  isRepositoryWorkspaceCommand,
} from "./session-repository-workspaces.worker.js";
import { readUserModelAuthProfile } from "./user-model-accounts.js";
import { executeUserPreferenceCommand } from "./user-preferences.worker.js";
import { executeUserProfileCommand, isUserProfileCommand } from "./user-profiles.worker.js";

const log = createSubsystemLogger("state/worker");

const loadPluginIndexWriter = createLazyRuntimeModule(
  () => import("../plugins/installed-plugin-index-store-write.js"),
);
let pluginIndexWriter: Awaited<ReturnType<typeof loadPluginIndexWriter>> | undefined;

export function prepareSharedStateCommand(type: PropertyKey): Promise<void> | undefined {
  if (type === "plugins.metadata.sourceAdmission.publish" && !pluginIndexWriter) {
    return loadPluginIndexWriter().then((loaded) => {
      pluginIndexWriter = loaded;
    });
  }
  return prepareCronStateWorkerCommand(type);
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
  if (isMcpOAuthWorkerCommand(command)) {
    return executeMcpOAuthWorkerCommand(open(), command);
  }
  if (isLegacyMcpOAuthWorkerCommand(command)) {
    return executeLegacyMcpOAuthWorkerCommand(open(), command);
  }
  if (command.type === "execApprovals.commitAuthorizations" || isOperatorApprovalCommand(command)) {
    const databaseOptions = {
      database: open(),
      ...stateOptions(),
    };
    return command.type === "execApprovals.commitAuthorizations"
      ? commitExecAuthorizationsInWorker(command.input, databaseOptions)
      : executeOperatorApprovalCommand(command, databaseOptions);
  }
  if (isDevicePairingMutationCommand(command)) {
    return executeDevicePairingMutationInWorker(command, open());
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
  if (command.type === "audit.events.list") {
    return listAuditEventsInDatabase(open().db, command.input);
  }
  if (command.type === "conversationBindings.readSelection") {
    return conversationBindings.readSelection(command.input, context.databasePath);
  }
  if (command.type === "audit.writer.process" || command.type === "audit.writer.prune") {
    return executeAuditWriterCommand(command, stateOptions(), open);
  }
  if (
    command.type === "authProfiles.read" ||
    command.type === "authProfiles.sharedOwnership" ||
    command.type === "authProfiles.personal"
  ) {
    const read = () => {
      const options = stateOptions();
      if (command.type === "authProfiles.sharedOwnership") {
        return readConfigMachineState(SHARED_AUTH_STORE_STATE_KEY, options);
      }
      if (command.type === "authProfiles.personal") {
        return readUserModelAuthProfile(command.input.profileId, options);
      }
      const missing: AuthProfileRowRead = {
        store: { status: "missing", reason: "database" },
        state: { status: "missing", reason: "database" },
        cacheable: false,
      };
      try {
        return (
          withExistingOpenClawStateDatabaseReadOnly(
            ({ db }) => readAuthProfileRows(db, context.databasePath, "shared-state"),
            options,
          ) ?? missing
        );
      } catch {
        return isMissingDatabasePath(context.databasePath)
          ? missing
          : {
              store: { status: "unreadable" as const },
              state: { status: "unreadable" as const },
              cacheable: false,
            };
      }
    };
    return command.input.artifactPreserving ? withArtifactPreservingStateReads(read) : read();
  }
  if (command.type === "promotions.markNotified" || command.type === "promotions.recordClaim") {
    return executePromotionCommand(command, stateOptions(), open);
  }
  if (command.type === "doctor.databaseBloat") {
    return readSqliteDatabaseBloat(stateOptions());
  }
  if (command.type === "telemetry.readState") {
    return readTelemetryStateInWorker(stateOptions());
  }
  if (command.type === "telemetry.countRecentSessions") {
    return (
      withExistingOpenClawStateDatabaseReadOnly(
        ({ db }) => countRecentTelemetrySessionsInDatabase(db, command.input.sinceMs),
        stateOptions(),
      ) ?? 0
    );
  }
  if (command.type === "webPush.readPersistedVapidKeyPair") {
    return readPersistedVapidKeyPairInDatabase(stateOptions());
  }
  if (isWebPushCommand(command)) {
    return executeWebPushCommand(command, open());
  }
  if (command.type === "nativeHookRelay.read") {
    return withOpenClawStateDatabaseReadOnly(
      (database) =>
        readNativeHookRelayBridgeSnapshotFromDatabase({
          database,
          relayId: command.input.relayId,
        })?.record,
      stateOptions(),
    );
  }
  if (command.type === "modelCatalog.remote.read") {
    const read = () => readRemoteModelCatalog(stateOptions());
    return command.input.artifactPreservingReadOnly
      ? withArtifactPreservingStateReads(read)
      : read();
  }
  if (command.type === "acp.prepareMutation" || command.type === "acp.commitMutation") {
    return executeAcpSessionMutationInWorker(open(), command);
  }
  if (command.type === "plugins.conversationBindingApprovals.read") {
    return readPluginBindingApprovalsInDatabase(open().db);
  }
  if (command.type === "plugins.conversationBindingApprovals.upsert") {
    const database = open();
    return runOpenClawStateWriteTransaction(
      ({ db }) => upsertPluginBindingApprovalInDatabase(db, command.input),
      { database, path: context.databasePath, env: getSqliteWorkerStateContext().environment },
    );
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
  if (
    command.type === "plugins.deferredMigrations.read" ||
    command.type === "plugins.deferredMigrations.completions.read"
  ) {
    return readDeferredPluginMigrationsInWorker(command, stateOptions());
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
  if (isOnboardingRecommendationWriteCommand(command)) {
    return executeOnboardingRecommendationCommand(command, {
      database: open(),
      ...stateOptions(),
    });
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
  if (isUserProfileCommand(command)) {
    return executeUserProfileCommand(command, {
      database: open(),
      ...stateOptions(),
    });
  }
  if (isPluginBlobWorkerCommand(command)) {
    return executePluginBlobCommand(command, context.databasePath, open);
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
  if (isNodeWorkerJournalCommand(command)) {
    return executeNodeWorkerJournalCommand(command, context.databasePath, open);
  }
  if (isChannelIngressCommand(command)) {
    return executeChannelIngressCommand(
      command,
      { path: context.databasePath, env: getSqliteWorkerStateContext().environment },
      open,
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
  if (workshopChanges.isWorkshopChangesCommand(command)) {
    return workshopChanges.executeWorkshopChangesCommand(command, database, context.databasePath);
  }
  if (command.type === "skills.usage.read") {
    return readSkillUsageInDatabase(database, command.input.skillFiles);
  }
  if (command.type === "skills.usage.record") {
    return runOpenClawStateWriteTransaction(
      (current) => recordSkillUsageInDatabase(current, command.input),
      { database, path: context.databasePath, env: getSqliteWorkerStateContext().environment },
    );
  }
  if (command.type === "deviceAuth.list") {
    return deviceAuth.readDeviceAuthTokensFromDatabase(database.db, command.input);
  }
  if (isTranscriptWriteCommand(command)) {
    return executeTranscriptWrite(command, { database, path: context.databasePath });
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
  if (isManagedImageRecordCommand(command)) {
    return executeManagedImageRecordCommand(command, database);
  }
  if (isApnsRegistrationWorkerCommand(command)) {
    return executeApnsRegistrationCommand(command, database);
  }
  if (command.type === "plugins.catalogSnapshot.read") {
    return readHostedCatalogSnapshotInDatabase(database.db, command.input.url);
  }
  if (command.type === "nativeHookRelay.listSnapshots") {
    return listNativeHookRelayBridgeSnapshotsInDatabase(database);
  }
  if (command.type === "sessionUpstream.listWatched") {
    return listWatchedSessionUpstreamLinksInDatabase(database.db);
  }
  if (isCronStateWorkerCommand(command)) {
    return executeCronStateCommand(command, database);
  }
  if (isSessionDeliveryCommand(command)) {
    return executeSessionDeliveryCommand(command, database);
  }
  const writeOptions = {
    database,
    ...stateOptions(),
  };
  if (command.type === "plugins.deferredMigrations.record") {
    return recordDeferredPluginMigrationsInWorker(command.input, writeOptions);
  }
  if (
    command.type === "nativeHookRelay.write" ||
    command.type === "nativeHookRelay.renew" ||
    command.type === "nativeHookRelay.deleteOwned" ||
    command.type === "nativeHookRelay.prune"
  ) {
    return executeNativeHookRelayMutation(command, writeOptions);
  }
  if (command.type === "tui.lastSession.write") {
    return writeConfigMachineState(command.input.stateKey, command.input.sessionKey, writeOptions);
  }
  if (command.type === "tui.lastSession.clear") {
    return clearRetiredTuiPointers(
      command.input.stateKeys,
      new Set(command.input.retiredSessionKeys),
      writeOptions,
    );
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
  if (conversationBindings.isWriteCommand(command)) {
    return conversationBindings.executeCommand(command, writeOptions);
  }
  if (command.type === "sessionGroups.mutate") {
    return mutateSessionGroupCatalogInDatabase(database, command.input, writeOptions.env);
  }
  if (deliveryQueue.isDeliveryQueueCommand(command)) {
    return deliveryQueue.executeDeliveryQueueCommand(command, writeOptions);
  }
  if (isSkillUploadCommand(command)) {
    return executeSkillUploadCommand(command, writeOptions);
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
  if (
    command.type === "fleet.cell.reserve" ||
    command.type === "fleet.cell.updateImage" ||
    command.type === "fleet.cell.delete" ||
    command.type === "fleet.operation.acquire" ||
    command.type === "fleet.operation.heartbeat" ||
    command.type === "fleet.operation.release"
  ) {
    return executeFleetRegistryCommand(command, writeOptions);
  }
  if (command.type === "agentProvenance.readBatch" || command.type === "agentProvenance.list") {
    ensureAgentProvenanceSchema(writeOptions);
    return command.type === "agentProvenance.readBatch"
      ? readAgentProvenanceBatchInDatabase(database.db, command.input.agentIds)
      : listAgentProvenanceInDatabase(database.db);
  }
  if (command.type === "telemetry.persistSuccess") {
    return runOpenClawStateWriteTransaction(
      ({ db }) =>
        persistTelemetrySuccessInDatabase(db, command.input.state, command.input.updatedAtMs),
      writeOptions,
      { operationLabel: "config-machine-state.update" },
    );
  }
  if (command.type === "sessionState.record" || command.type === "sessionState.prune") {
    return executeSessionStateCommand(command, writeOptions);
  }
  if (command.type === "plugins.catalogSnapshot.write") {
    try {
      runOpenClawStateWriteTransaction(
        ({ db }) =>
          writeHostedCatalogSnapshotInDatabase(db, command.input.snapshot, command.input.now),
        writeOptions,
      );
      return { ok: true };
    } catch (error) {
      if (error instanceof HostedCatalogSignedFeedMonotonicityError) {
        return { ok: false, message: error.message };
      }
      throw error;
    }
  }
  if (command.type === "plugins.metadata.sourceAdmission.publish") {
    if (!pluginIndexWriter) {
      throw new Error("Plugin source admission writer is not prepared");
    }
    const { publishPluginSourceAdmissionInDatabase } = pluginIndexWriter;
    return runOpenClawStateWriteTransaction(
      ({ db }) => publishPluginSourceAdmissionInDatabase(db, command.input),
      writeOptions,
    );
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
  if (isWorktreeWorkerCommand(command)) {
    return executeWorktreeWorkerCommand(command, writeOptions);
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
