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
import { writeSubagentRunValuesInDatabase } from "../agents/subagents/registry/subagent-registry.store.kernel.js";
import { listRegistryWorktreesInDatabase } from "../agents/worktrees/registry-read.kernel.js";
import { listAuditEventsInDatabase } from "../audit/audit-event-read.kernel.js";
import { executeAuditWriterCommand } from "../audit/audit-event-writer.worker.js";
import { readClawInstallSchemaVersionRows } from "../claws/provenance-runtime-read.kernel.js";
import { readSqliteDatabaseBloat } from "../commands/doctor-db-bloat.read.js";
import { readWorkshopMigrationRecordsInDatabase } from "../commands/doctor-skill-workshop-read.kernel.js";
import {
  patchConfigHealthEntryInDatabase,
  readConfigHealthSnapshotInDatabase,
} from "../config/io.health-state.kernel.js";
import {
  executeCronStateCommand,
  isCronStateWorkerCommand,
} from "../cron/store/dispatch.worker.js";
import {
  acquireFleetCellOperationInDatabase,
  assertFleetCellOperationInDatabase,
  deleteFleetCellInDatabase,
  heartbeatFleetCellOperationInDatabase,
  releaseFleetCellOperationInDatabase,
  reserveFleetCellInDatabase,
  updateFleetCellImageInDatabase,
} from "../fleet/registry.kernel.js";
import { readPendingRepositoryGitHubPublicationInDatabase } from "../gateway/github-repository-publication.kernel.js";
import {
  readManagedImageRecordInDatabase,
  listManagedImageRecordEntriesInDatabase,
  listManagedImageOriginalMediaIdsInDatabase,
} from "../gateway/managed-image-record-store.kernel.js";
import { registerSessionGroupInDatabase } from "../gateway/session-group-registration.kernel.js";
import { readDeferredPluginMigrations } from "../infra/deferred-plugin-migrations.js";
import * as deliveryQueue from "../infra/delivery-queue.worker.js";
import * as deviceAuth from "../infra/device-auth-store.kernel.js";
import { commitExecAuthorizationsInWorker } from "../infra/exec-approvals-authorization.worker.js";
import { executePromotionCommand } from "../infra/promotions-feed.worker.js";
import {
  readApnsRegistrationFromDatabase,
  readApnsRegistrationsFromDatabase,
} from "../infra/push-apns-store.js";
import { readPersistedVapidKeyPairInDatabase } from "../infra/push-web-store.kernel.js";
import { executeWebPushCommand } from "../infra/push-web-store.worker.js";
import { isSessionDeliveryCommand } from "../infra/session-delivery-queue.worker-contract.js";
import { executeSessionDeliveryCommand } from "../infra/session-delivery-queue.worker.js";
import { createSqliteAuditRecordKernel } from "../infra/sqlite-audit-record.kernel.js";
import {
  readStableSqliteFileGeneration,
  sameSqliteFileGeneration,
} from "../infra/sqlite-file-generation.js";
import { deferSqlitePostCommitPublication } from "../infra/sqlite-post-commit.js";
import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { getSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import {
  countRecentTelemetrySessionsInDatabase,
  persistTelemetrySuccessInDatabase,
  readTelemetryStateInWorker,
} from "../infra/telemetry-store.kernel.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { readRemoteModelCatalog } from "../model-catalog/remote-store.js";
import { isNodeWorkerJournalCommand } from "../node-host/node-worker-journal.worker-contract.js";
import { executeNodeWorkerJournalCommand } from "../node-host/node-worker-journal.worker.js";
import { executePluginBlobCommand } from "../plugin-state/plugin-blob-store.worker.js";
import { isPluginBlobWorkerCommand } from "../plugin-state/plugin-blob-worker-contract.js";
import { isPluginStateWorkerCommand } from "../plugin-state/plugin-state-worker-contract.js";
import { executePluginStateCommand } from "../plugin-state/plugin-state.worker.js";
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
  ensureProjectRegistrySchema,
  insertProjectRegistryInDatabase,
  listProjectRegistryInDatabase,
  removeProjectRegistryInDatabase,
  resolveProjectCloneRefreshOwnerInDatabase,
  resolveProjectRegistryInDatabase,
  resolveRecordedProjectRootInDatabase,
} from "../projects/project-registry.kernel.js";
import {
  pruneSessionStateEventsInDatabase,
  recordSessionStateEventInDatabase,
} from "../sessions/session-state-events.kernel.js";
import { listWatchedSessionUpstreamLinksInDatabase } from "../sessions/session-upstream-links.kernel.js";
import { commitSkillUploadInDatabase } from "../skills/lifecycle/upload-store-commit.js";
import * as skillWorkshop from "../skills/workshop/store.worker.js";
import { isTaskRegistryWorkerCommand } from "../tasks/task-registry.worker-contract.js";
import { executeTaskRegistryCommand } from "../tasks/task-registry.worker.js";
import { executeTranscriptRead } from "../transcripts/store-worker-read.js";
import { executeTranscriptWrite } from "../transcripts/store-worker-write.js";
import {
  listAgentProvenanceInDatabase,
  readAgentProvenanceBatchInDatabase,
} from "./agent-provenance.kernel.js";
import { ensureAgentProvenanceSchema } from "./agent-provenance.schema.js";
import { recordBackupRunInDatabase } from "./backup-run-records.kernel.js";
import { readConfigMachineState } from "./config-machine-state.js";
import { isOnboardingRecommendationWriteCommand } from "./onboarding-recommendations.contract.js";
import { executeOnboardingRecommendationCommand } from "./onboarding-recommendations.kernel.js";
import { executeAgentDatabaseCleanupCommand } from "./openclaw-agent-execution-cleanup.worker.js";
import type { OpenClawStateDatabase } from "./openclaw-state-db-contract.js";
import { assertOpenClawStateDatabaseOwner } from "./openclaw-state-db-maintenance.js";
import {
  withOpenClawStateDatabaseReadOnly,
  withArtifactPreservingStateReads,
  withExistingOpenClawStateDatabaseArtifactPreservingReadOnly,
  withExistingOpenClawStateDatabaseReadOnly,
} from "./openclaw-state-db-readonly.js";
import { runOpenClawStateWriteTransaction } from "./openclaw-state-db.js";
import { assertOpenClawStateLeaseWorkerOwnedInTransaction } from "./openclaw-state-lease-worker.js";
import type {
  OpenClawStateWorkerOperations,
  OpenClawStateWorkerInspectionOperations,
  OpenClawStateWorkerCleanupOperations,
} from "./openclaw-state-worker-contract.js";
import { readUserModelAuthProfile } from "./user-model-accounts.js";
import { executeUserPreferenceCommand } from "./user-preferences.worker.js";
import { executeUserProfileCommand } from "./user-profiles.worker.js";

type Operations = OpenClawStateWorkerOperations &
  OpenClawStateWorkerInspectionOperations &
  OpenClawStateWorkerCleanupOperations;

const log = createSubsystemLogger("state/worker");

export function executeSharedStateCommand(
  command: Exclude<
    SqliteWorkerCommand<Operations>,
    { type: "plugins.metadata.read" | "database.inspectIdle" | "stateLease.acquire" }
  >,
  context: { databasePath: string },
  open: () => OpenClawStateDatabase,
  hasNativeDatabase: boolean,
): Operations[keyof Operations]["output"] {
  if (command.type === "execApprovals.commitAuthorizations") {
    return commitExecAuthorizationsInWorker(command.input, {
      database: open(),
      path: context.databasePath,
      env: getSqliteWorkerStateContext().environment,
    });
  }
  if (command.type === "agentDatabases.releaseExitedLease") {
    return executeAgentDatabaseCleanupCommand(
      command,
      open(),
      getSqliteWorkerStateContext().environment,
    );
  }
  if (command.type === "audit.events.list") {
    return listAuditEventsInDatabase(open().db, command.input);
  }
  if (command.type === "audit.writer.process" || command.type === "audit.writer.prune") {
    return executeAuditWriterCommand(
      command,
      { path: context.databasePath, env: getSqliteWorkerStateContext().environment },
      open,
    );
  }
  if (
    command.type === "authProfiles.read" ||
    command.type === "authProfiles.sharedOwnership" ||
    command.type === "authProfiles.personal"
  ) {
    const read = () => {
      const options = {
        path: context.databasePath,
        env: getSqliteWorkerStateContext().environment,
      };
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
    return executePromotionCommand(
      command,
      { path: context.databasePath, env: getSqliteWorkerStateContext().environment },
      open,
    );
  }
  if (command.type === "doctor.databaseBloat") {
    return readSqliteDatabaseBloat({
      path: context.databasePath,
      env: getSqliteWorkerStateContext().environment,
    });
  }
  if (command.type === "telemetry.readState") {
    return readTelemetryStateInWorker({
      path: context.databasePath,
      env: getSqliteWorkerStateContext().environment,
    });
  }
  if (command.type === "telemetry.countRecentSessions") {
    return (
      withExistingOpenClawStateDatabaseReadOnly(
        ({ db }) => countRecentTelemetrySessionsInDatabase(db, command.input.sinceMs),
        { path: context.databasePath, env: getSqliteWorkerStateContext().environment },
      ) ?? 0
    );
  }
  if (command.type === "webPush.readPersistedVapidKeyPair") {
    return readPersistedVapidKeyPairInDatabase({
      path: context.databasePath,
      env: getSqliteWorkerStateContext().environment,
    });
  }
  if (
    command.type === "webPush.findBoundWebPushSubscriptionByEndpoint" ||
    command.type === "webPush.setWebPushSubscriptionPreferences" ||
    command.type === "webPush.listWebPushSubscriptions" ||
    command.type === "webPush.hasBoundWebPushSubscriptions" ||
    command.type === "webPush.listBoundWebPushSubscriptions" ||
    command.type === "webPush.prepareWebPushApprovalDeliveries" ||
    command.type === "webPush.listWebPushApprovalDeliveryTargets" ||
    command.type === "webPush.deleteWebPushApprovalDeliveryTargets" ||
    command.type === "webPush.listTerminalWebPushApprovalDeliveryIds" ||
    command.type === "webPush.upsertWebPushSubscription" ||
    command.type === "webPush.deleteBoundWebPushSubscription" ||
    command.type === "webPush.deleteWebPushSubscriptionIfCurrent" ||
    command.type === "webPush.insertVapidKeyPairIfAbsent"
  ) {
    return executeWebPushCommand(command, open());
  }
  if (command.type === "nativeHookRelay.read") {
    return withOpenClawStateDatabaseReadOnly(
      (database) =>
        readNativeHookRelayBridgeSnapshotFromDatabase({
          database,
          relayId: command.input.relayId,
        })?.record,
      { path: context.databasePath, env: getSqliteWorkerStateContext().environment },
    );
  }
  if (isTaskRegistryWorkerCommand(command)) {
    return executeTaskRegistryCommand(
      command,
      {
        path: context.databasePath,
        env: getSqliteWorkerStateContext().environment,
      },
      open,
    );
  }
  if (command.type === "doctor.workshopMigrationRecords.read") {
    return withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(
      ({ db }) => readWorkshopMigrationRecordsInDatabase(db, command.input.includeEvents),
      { path: context.databasePath, env: getSqliteWorkerStateContext().environment },
    );
  }
  if (command.type === "modelCatalog.remote.read") {
    const read = () =>
      readRemoteModelCatalog({
        path: context.databasePath,
        env: getSqliteWorkerStateContext().environment,
      });
    return command.input.artifactPreservingReadOnly
      ? withArtifactPreservingStateReads(read)
      : read();
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
  if (command.type === "plugins.deferredMigrations.read") {
    return readDeferredPluginMigrations({
      path: context.databasePath,
      env: getSqliteWorkerStateContext().environment,
      artifactPreservingReadOnly: command.input.artifactPreservingReadOnly,
    });
  }
  if (command.type === "claws.install-schema-versions") {
    const read = command.input.artifactPreservingReadOnly
      ? withExistingOpenClawStateDatabaseArtifactPreservingReadOnly
      : withExistingOpenClawStateDatabaseReadOnly;
    return read(
      ({ db, path: pathname }) => {
        assertOpenClawStateDatabaseOwner(db, { pathname });
        return readClawInstallSchemaVersionRows(db);
      },
      { path: context.databasePath, env: getSqliteWorkerStateContext().environment },
    );
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
      path: context.databasePath,
      env: getSqliteWorkerStateContext().environment,
    });
  }
  if (command.type === "userPreferences.read" || command.type === "userPreferences.write") {
    return executeUserPreferenceCommand(command, {
      database: open(),
      path: context.databasePath,
      env: getSqliteWorkerStateContext().environment,
    });
  }
  if (
    command.type === "userProfiles.list" ||
    command.type === "userProfiles.directory" ||
    command.type === "userProfiles.avatar.inspect" ||
    command.type === "userProfiles.avatar.adopt"
  ) {
    return executeUserProfileCommand(command, {
      database: open(),
      path: context.databasePath,
      env: getSqliteWorkerStateContext().environment,
    });
  }
  if (isPluginBlobWorkerCommand(command)) {
    return executePluginBlobCommand(command, context.databasePath, open);
  }
  if (isPluginStateWorkerCommand(command)) {
    return executePluginStateCommand(
      command,
      {
        path: context.databasePath,
        env: getSqliteWorkerStateContext().environment,
      },
      open,
      hasNativeDatabase,
    );
  }
  if (command.type === "config.health.read") {
    const read = command.input.artifactPreserving
      ? withExistingOpenClawStateDatabaseArtifactPreservingReadOnly
      : withExistingOpenClawStateDatabaseReadOnly;
    return (
      read(({ db }) => readConfigHealthSnapshotInDatabase(db), {
        path: context.databasePath,
        env: getSqliteWorkerStateContext().environment,
      }) ?? { state: {}, basis: {} }
    );
  }
  if (command.type === "deviceAuth.read" || command.type === "deviceAuth.readOrigin") {
    const read = (db: OpenClawStateDatabase["db"]) =>
      command.type === "deviceAuth.read"
        ? deviceAuth.readDeviceAuthTokenObservationFromDatabase(db, command.input)
        : deviceAuth.readOriginDeviceTokenObservationFromDatabase(db, command.input);
    return command.input.readOnly
      ? (withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(({ db }) => read(db), {
          path: context.databasePath,
          env: getSqliteWorkerStateContext().environment,
        }) ?? { entry: null, expectedToken: null })
      : read(open().db);
  }
  const database = open();
  if (command.type === "githubRepository.personalPending") {
    return readPendingRepositoryGitHubPublicationInDatabase(database.db, command.input);
  }
  if (skillWorkshop.isSkillWorkshopCommand(command)) {
    return skillWorkshop.executeSkillWorkshopCommand(command, database, context.databasePath);
  }
  if (command.type === "deviceAuth.list") {
    return deviceAuth.readDeviceAuthTokensFromDatabase(database.db, command.input);
  }
  if (command.type === "transcripts.append" || command.type === "transcripts.writeSummary") {
    return executeTranscriptWrite(command, { database, path: context.databasePath });
  }
  switch (command.type) {
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
    case "transcripts.summary": {
      return executeTranscriptRead({ database, path: context.databasePath }, command);
    }
    default:
      break;
  }
  if (command.type === "managedImages.read") {
    return readManagedImageRecordInDatabase(database.db, command.input.attachmentId);
  }
  if (command.type === "managedImages.entries") {
    return listManagedImageRecordEntriesInDatabase(database.db, command.input.sessionKey);
  }
  if (command.type === "managedImages.originalMediaIds") {
    return listManagedImageOriginalMediaIdsInDatabase(database.db);
  }
  if (command.type === "apns.registration.read") {
    return readApnsRegistrationFromDatabase(database.db, command.input);
  }
  if (command.type === "apns.registrations.read") {
    return readApnsRegistrationsFromDatabase(database.db, command.input);
  }
  if (command.type === "plugins.catalogSnapshot.read") {
    return readHostedCatalogSnapshotInDatabase(database.db, command.input.url);
  }
  if (command.type === "nativeHookRelay.listSnapshots") {
    return listNativeHookRelayBridgeSnapshotsInDatabase(database);
  }
  if (
    command.type === "nativeHookRelay.write" ||
    command.type === "nativeHookRelay.renew" ||
    command.type === "nativeHookRelay.deleteOwned" ||
    command.type === "nativeHookRelay.prune"
  ) {
    return executeNativeHookRelayMutation(command, {
      database,
      path: context.databasePath,
      env: getSqliteWorkerStateContext().environment,
    });
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
    path: context.databasePath,
    env: getSqliteWorkerStateContext().environment,
  };
  if (isNodeWorkerJournalCommand(command)) {
    return executeNodeWorkerJournalCommand(command, writeOptions);
  }
  if (command.type === "sessionGroups.register") {
    return registerSessionGroupInDatabase(database, command.input.name, writeOptions.env);
  }
  if (deliveryQueue.isDeliveryQueueCommand(command)) {
    return deliveryQueue.executeDeliveryQueueCommand(command, writeOptions);
  }
  if (command.type === "skillUploads.commit") {
    return commitSkillUploadInDatabase(command.input, writeOptions);
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
    return runOpenClawStateWriteTransaction(({ db }) => {
      switch (command.type) {
        case "fleet.cell.reserve":
          assertFleetCellOperationInDatabase(
            db,
            command.input.tenantId,
            command.input.operationOwner,
          );
          return reserveFleetCellInDatabase(db, command.input);
        case "fleet.cell.updateImage":
          assertFleetCellOperationInDatabase(
            db,
            command.input.tenantId,
            command.input.operationOwner,
          );
          return updateFleetCellImageInDatabase(db, command.input.tenantId, command.input.image);
        case "fleet.cell.delete":
          assertFleetCellOperationInDatabase(
            db,
            command.input.tenantId,
            command.input.operationOwner,
          );
          return deleteFleetCellInDatabase(db, command.input.tenantId);
        case "fleet.operation.acquire":
          return acquireFleetCellOperationInDatabase(db, command.input);
        case "fleet.operation.heartbeat":
          return heartbeatFleetCellOperationInDatabase(db, command.input);
        case "fleet.operation.release":
          return releaseFleetCellOperationInDatabase(db, command.input);
      }
    }, writeOptions);
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
  if (command.type === "sessionState.recordGoalChange") {
    return runOpenClawStateWriteTransaction(
      ({ db }) =>
        recordSessionStateEventInDatabase(db, command.input.event, command.input.now).notices,
      writeOptions,
    );
  }
  if (command.type === "sessionState.prune") {
    return runOpenClawStateWriteTransaction(
      ({ db }) => pruneSessionStateEventsInDatabase(db, command.input.now),
      writeOptions,
    );
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
  if (command.type === "projects.findRoot") {
    ensureProjectRegistrySchema(writeOptions);
    return resolveRecordedProjectRootInDatabase(database.db, command.input.repoRoot);
  }
  if (command.type === "projects.list") {
    ensureProjectRegistrySchema(writeOptions);
    return listProjectRegistryInDatabase(database.db);
  }
  if (command.type === "worktrees.list") {
    return listRegistryWorktreesInDatabase(database.db);
  }
  if (command.type === "projects.resolve") {
    ensureProjectRegistrySchema(writeOptions);
    return resolveProjectRegistryInDatabase(database.db, command.input.id);
  }
  if (command.type === "projects.insert") {
    ensureProjectRegistrySchema(writeOptions);
    return runOpenClawStateWriteTransaction(
      ({ db }) => {
        const { project, lease } = command.input;
        if (lease.scope !== "projects.checkout" || lease.key !== project.repoRoot) {
          throw new Error("Project registry mutation requires its checkout lifecycle lease");
        }
        assertOpenClawStateLeaseWorkerOwnedInTransaction(db, lease);
        return insertProjectRegistryInDatabase(db, project);
      },
      writeOptions,
      { operationLabel: "projects.registry.insert" },
    );
  }
  if (command.type === "projects.resolveRefreshOwner") {
    ensureProjectRegistrySchema(writeOptions);
    return runOpenClawStateWriteTransaction(
      ({ db }) => {
        const { project, lease } = command.input;
        if (lease.scope !== "projects.checkout" || lease.key !== project.repoRoot) {
          throw new Error("Project refresh requires its checkout lifecycle lease");
        }
        assertOpenClawStateLeaseWorkerOwnedInTransaction(db, lease);
        return resolveProjectCloneRefreshOwnerInDatabase(db, project);
      },
      writeOptions,
      { operationLabel: "projects.registry.refresh-owner.resolve" },
    );
  }
  if (command.type === "projects.remove") {
    return runOpenClawStateWriteTransaction(
      ({ db }) => {
        const { project, lease } = command.input;
        if (lease.scope !== "projects.checkout" || lease.key !== project.repoRoot) {
          throw new Error("Project registry mutation requires its checkout lifecycle lease");
        }
        assertOpenClawStateLeaseWorkerOwnedInTransaction(db, lease);
        return removeProjectRegistryInDatabase(db, project);
      },
      writeOptions,
      { operationLabel: "projects.registry.remove" },
    );
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
  throw new Error("Unknown shared-state SQLite command");
}
