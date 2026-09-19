import { SHARED_AUTH_STORE_STATE_KEY } from "../agents/auth-profiles/path-resolve.js";
import { readAuthProfileRows } from "../agents/auth-profiles/sqlite-json.js";
import { isMissingDatabasePath } from "../agents/auth-profiles/sqlite-read-pool.js";
import type { AuthProfileRowRead } from "../agents/auth-profiles/types.js";
import {
  readNativeHookRelayBridgeSnapshotFromDatabase,
  listNativeHookRelayBridgeSnapshotsInDatabase,
} from "../agents/harness/native-hook-relay-store.kernel.js";
import { executeNativeHookRelayMutation } from "../agents/harness/native-hook-relay-store.worker.js";
import { listAuditEventsInDatabase } from "../audit/audit-event-read.kernel.js";
import { readClawInstallSchemaVersionRows } from "../claws/provenance-runtime-read.kernel.js";
import { readSqliteDatabaseBloat } from "../commands/doctor-db-bloat.read.js";
import { readWorkshopMigrationRecordsInDatabase } from "../commands/doctor-skill-workshop-read.kernel.js";
import {
  patchConfigHealthEntryInDatabase,
  readConfigHealthSnapshotInDatabase,
} from "../config/io.health-state.kernel.js";
import { loadMutableCronStoreInWorker } from "../cron/store/load.worker.js";
import { executeCronStoreSaveCommand } from "../cron/store/save.worker.js";
import {
  acquireFleetCellOperationInDatabase,
  assertFleetCellOperationInDatabase,
  deleteFleetCellInDatabase,
  heartbeatFleetCellOperationInDatabase,
  releaseFleetCellOperationInDatabase,
  reserveFleetCellInDatabase,
  updateFleetCellImageInDatabase,
} from "../fleet/registry.kernel.js";
import {
  readManagedImageRecordInDatabase,
  listManagedImageRecordEntriesInDatabase,
  listManagedImageOriginalMediaIdsInDatabase,
} from "../gateway/managed-image-record-store.kernel.js";
import { readDeferredPluginMigrations } from "../infra/deferred-plugin-migrations.js";
import { countFailedDeliveryQueueEntriesInDatabase } from "../infra/delivery-queue-sqlite.kernel.js";
import * as deviceAuth from "../infra/device-auth-store.kernel.js";
import { executePromotionCommand } from "../infra/promotions-feed.worker.js";
import {
  readApnsRegistrationFromDatabase,
  readApnsRegistrationsFromDatabase,
} from "../infra/push-apns-store.js";
import { readPersistedVapidKeyPairInDatabase } from "../infra/push-web-store.kernel.js";
import { executeWebPushCommand } from "../infra/push-web-store.worker.js";
import { executeSessionDeliveryCommand } from "../infra/session-delivery-queue.worker.js";
import { createSqliteAuditRecordKernel } from "../infra/sqlite-audit-record.kernel.js";
import {
  readStableSqliteFileGeneration,
  sameSqliteFileGeneration,
} from "../infra/sqlite-file-generation.js";
import { assertNoActiveSqliteReaders } from "../infra/sqlite-reader-lifecycle.js";
import { assertTransactionUsable } from "../infra/sqlite-transaction.js";
import type { SqliteWorkerBackend } from "../infra/sqlite-worker-contract.js";
import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { getSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import {
  countRecentTelemetrySessionsInDatabase,
  persistTelemetrySuccessInDatabase,
  readTelemetryStateInWorker,
} from "../infra/telemetry-store.kernel.js";
import { readRemoteModelCatalog } from "../model-catalog/remote-store.js";
import { isPluginStateWorkerCommand } from "../plugin-state/plugin-state-worker-contract.js";
import { executePluginStateCommand } from "../plugin-state/plugin-state.worker.js";
import {
  readPluginBindingApprovalsInDatabase,
  upsertPluginBindingApprovalInDatabase,
} from "../plugins/conversation-binding-state.kernel.js";
import { readPluginMetadataStateRowSync } from "../plugins/installed-plugin-index-row.js";
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
import { listStoredSkillProposalEventsInDatabase } from "../skills/workshop/store-sqlite-event.js";
import { ensureSkillWorkshopSchemaInDatabase } from "../skills/workshop/store-sqlite-schema.js";
import { isTaskRegistryWorkerCommand } from "../tasks/task-registry.worker-contract.js";
import { executeTaskRegistryCommand } from "../tasks/task-registry.worker.js";
import { ensureMeetingTranscriptsSchema } from "../transcripts/sqlite-schema.js";
import { executeTranscriptRead } from "../transcripts/store-worker-read.js";
import {
  listAgentProvenanceInDatabase,
  readAgentProvenanceBatchInDatabase,
} from "./agent-provenance.kernel.js";
import { ensureAgentProvenanceSchema } from "./agent-provenance.schema.js";
import { recordBackupRunInDatabase } from "./backup-run-records.kernel.js";
import { readConfigMachineState } from "./config-machine-state.js";
import {
  openClawStateDatabaseCache,
  retainOpenClawStateDatabase,
} from "./openclaw-state-db-cache.js";
import type { OpenClawStateDatabase } from "./openclaw-state-db-contract.js";
import { assertOpenClawStateDatabaseOwner } from "./openclaw-state-db-maintenance.js";
import {
  withOpenClawStateDatabaseReadOnly,
  withArtifactPreservingStateReads,
  withExistingOpenClawStateDatabaseArtifactPreservingReadOnly,
  withExistingOpenClawStateDatabaseReadOnly,
} from "./openclaw-state-db-readonly.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import { assertOpenClawStateLeaseWorkerOwnedInTransaction } from "./openclaw-state-lease-worker.js";
import type {
  OpenClawStateWorkerOperations,
  OpenClawStateWorkerInspectionOperations,
} from "./openclaw-state-worker-contract.js";
import { readUserModelAuthProfile } from "./user-model-accounts.js";
import { executeUserPreferenceCommand } from "./user-preferences.worker.js";
import { executeUserProfileReadCommand } from "./user-profiles.worker.js";

export function createSqliteWorkerBackend(
  _input: undefined,
  context: { databasePath: string },
): SqliteWorkerBackend<OpenClawStateWorkerOperations & OpenClawStateWorkerInspectionOperations> {
  const database = openOpenClawStateDatabase({
    path: context.databasePath,
    env: getSqliteWorkerStateContext().environment,
  });
  return createSharedStateWorkerBackend(context, database);
}

export function openExistingSqliteWorkerBackend(
  _input: undefined,
  context: { databasePath: string },
): SqliteWorkerBackend<OpenClawStateWorkerOperations & OpenClawStateWorkerInspectionOperations> {
  return createSharedStateWorkerBackend(context);
}

function createSharedStateWorkerBackend(
  context: { databasePath: string },
  initialDatabase?: OpenClawStateDatabase,
): SqliteWorkerBackend<OpenClawStateWorkerOperations & OpenClawStateWorkerInspectionOperations> {
  let nativeDatabase = initialDatabase;
  let borrow = nativeDatabase ? retainOpenClawStateDatabase(nativeDatabase) : undefined;
  let closed = false;
  const open = (): OpenClawStateDatabase => {
    if (!nativeDatabase) {
      const opened = openOpenClawStateDatabase({
        path: context.databasePath,
        env: getSqliteWorkerStateContext().environment,
      });
      borrow = retainOpenClawStateDatabase(opened);
      nativeDatabase = opened;
    }
    if (
      !nativeDatabase.db.isOpen ||
      openClawStateDatabaseCache.getCachedOpenClawStateDatabase(nativeDatabase.path) !==
        nativeDatabase
    ) {
      throw new Error("Shared-state worker lost its retained native database");
    }
    return openOpenClawStateDatabase({
      database: nativeDatabase,
      path: context.databasePath,
      env: getSqliteWorkerStateContext().environment,
    });
  };
  return {
    execute(command) {
      if (closed) {
        throw new Error("Shared-state worker is closed");
      }
      if (command.type === "audit.events.list") {
        return listAuditEventsInDatabase(open().db, command.input);
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
      if (command.type === "plugins.metadata.read") {
        return readPluginMetadataStateRowSync(
          command.input.selector,
          { path: context.databasePath, env: getSqliteWorkerStateContext().environment },
          command.input.artifactPreservingReadOnly,
        );
      }
      if (command.type === "plugins.deferredMigrations.read") {
        return readDeferredPluginMigrations({
          path: context.databasePath,
          env: getSqliteWorkerStateContext().environment,
        });
      }
      if (command.type === "claws.install-schema-versions") {
        return withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(
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
      if (command.type === "database.inspectIdle") {
        // Idle maintenance must never materialize a connection for an artifact-preserving reader.
        if (
          !nativeDatabase?.db.isOpen ||
          openClawStateDatabaseCache.getCachedOpenClawStateDatabase(nativeDatabase.path) !==
            nativeDatabase
        ) {
          return "retire";
        }
        assertOpenClawStateDatabaseOwner(nativeDatabase.db, { pathname: nativeDatabase.path });
        return nativeDatabase.walMaintenance.inspectIdle?.() ?? "retire";
      }
      if (command.type === "userPreferences.read" || command.type === "userPreferences.write") {
        return executeUserPreferenceCommand(command, {
          database: open(),
          path: context.databasePath,
          env: getSqliteWorkerStateContext().environment,
        });
      }
      if (command.type === "userProfiles.list" || command.type === "userProfiles.directory") {
        return executeUserProfileReadCommand(command, {
          database: open(),
          path: context.databasePath,
          env: getSqliteWorkerStateContext().environment,
        });
      }
      if (isPluginStateWorkerCommand(command)) {
        return executePluginStateCommand(
          command,
          {
            path: context.databasePath,
            env: getSqliteWorkerStateContext().environment,
          },
          open,
          nativeDatabase?.db.isOpen === true,
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
      if (command.type === "deviceAuth.list") {
        return deviceAuth.readDeviceAuthTokensFromDatabase(database.db, command.input);
      }
      switch (command.type) {
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
          ensureMeetingTranscriptsSchema({
            database,
            path: context.databasePath,
            env: getSqliteWorkerStateContext().environment,
            readOnly: command.input.readOnly,
          });
          return executeTranscriptRead(database.db, command);
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
      if (command.type === "cron.loadMutable") {
        return loadMutableCronStoreInWorker(database, command.input.storeKey);
      }
      if (command.type === "cron.save" || command.type === "cron.saveChanges") {
        return executeCronStoreSaveCommand(command, database);
      }
      if (command.type === "deliveryQueue.countFailed") {
        return countFailedDeliveryQueueEntriesInDatabase(database);
      }
      if (
        command.type === "sessionDelivery.enqueue" ||
        command.type === "sessionDelivery.enqueueClaimed" ||
        command.type === "sessionDelivery.releaseClaim" ||
        command.type === "sessionDelivery.defer" ||
        command.type === "sessionDelivery.advanceAgentRun" ||
        command.type === "sessionDelivery.mergePreparedMedia" ||
        command.type === "sessionDelivery.markAttemptStarted" ||
        command.type === "sessionDelivery.markSettlement" ||
        command.type === "sessionDelivery.complete" ||
        command.type === "sessionDelivery.fail" ||
        command.type === "sessionDelivery.load" ||
        command.type === "sessionDelivery.list" ||
        command.type === "sessionDelivery.moveToFailed"
      ) {
        return executeSessionDeliveryCommand(command, database);
      }
      const writeOptions = {
        database,
        path: context.databasePath,
        env: getSqliteWorkerStateContext().environment,
      };
      if (command.type === "workshop.events.list") {
        ensureSkillWorkshopSchemaInDatabase(database, writeOptions);
        return listStoredSkillProposalEventsInDatabase(database.db, command.input);
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
              return updateFleetCellImageInDatabase(
                db,
                command.input.tenantId,
                command.input.image,
              );
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
    },
    assertSettled() {
      if (nativeDatabase) {
        assertTransactionUsable(nativeDatabase.db);
        if (nativeDatabase.db.isOpen && nativeDatabase.db.isTransaction) {
          throw new Error("Shared-state worker retained an unsettled transaction");
        }
        if (nativeDatabase.db.isOpen) {
          assertNoActiveSqliteReaders(nativeDatabase.db, "Shared-state worker");
        }
      }
    },
    close() {
      closed = true;
      borrow?.release();
    },
  };
}
