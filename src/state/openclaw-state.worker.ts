import {
  readNativeHookRelayBridgeSnapshotFromDatabase,
  listNativeHookRelayBridgeSnapshotsInDatabase,
} from "../agents/harness/native-hook-relay-store.kernel.js";
import { executeNativeHookRelayMutation } from "../agents/harness/native-hook-relay-store.worker.js";
import { readClawInstallSchemaVersionRows } from "../claws/provenance-runtime-read.kernel.js";
import { readSqliteDatabaseBloat } from "../commands/doctor-db-bloat.read.js";
import {
  patchConfigHealthEntryInDatabase,
  readConfigHealthSnapshotInDatabase,
} from "../config/io.health-state.kernel.js";
import { loadMutableCronStoreInWorker } from "../cron/store/load.worker.js";
import { executeCronStoreSaveCommand } from "../cron/store/save.worker.js";
import { readDeferredPluginMigrations } from "../infra/deferred-plugin-migrations.js";
import { countFailedDeliveryQueueEntriesInDatabase } from "../infra/delivery-queue-sqlite.kernel.js";
import {
  loadDeviceIdentityIfPresent,
  loadOrCreateDeviceIdentity,
} from "../infra/device-identity.js";
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
import type { SqliteWorkerBackend } from "../infra/sqlite-worker-contract.js";
import { getSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
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
  resolveRecordedProjectRootInDatabase,
} from "../projects/project-registry.kernel.js";
import {
  pruneSessionStateEventsInDatabase,
  recordSessionStateEventInDatabase,
} from "../sessions/session-state-events.kernel.js";
import { isTaskRegistryWorkerCommand } from "../tasks/task-registry.worker-contract.js";
import { executeTaskRegistryCommand } from "../tasks/task-registry.worker.js";
import {
  listAgentProvenanceInDatabase,
  readAgentProvenanceInDatabase,
} from "./agent-provenance.kernel.js";
import { ensureAgentProvenanceSchema } from "./agent-provenance.schema.js";
import { recordBackupRunInDatabase } from "./backup-run-records.kernel.js";
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
  OpenClawStateWorkerOpenPreparation,
} from "./openclaw-state-worker-contract.js";
import { executeUserPreferenceCommand } from "./user-preferences.worker.js";

export function createSqliteWorkerBackend(
  _input: undefined,
  context: { databasePath: string; preparation?: OpenClawStateWorkerOpenPreparation },
): SqliteWorkerBackend<OpenClawStateWorkerOperations & OpenClawStateWorkerInspectionOperations> {
  if (context.preparation?.type === "deviceIdentity") {
    loadOrCreateDeviceIdentity({
      path: context.databasePath,
      env: getSqliteWorkerStateContext().environment,
      identityKey: context.preparation.identityKey,
    });
  }
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
      if (command.type === "deviceIdentity.read") {
        return loadDeviceIdentityIfPresent({
          path: context.databasePath,
          identityKey: command.input.identityKey,
          env: getSqliteWorkerStateContext().environment,
        });
      }
      if (command.type === "deviceIdentity.load") {
        try {
          return loadOrCreateDeviceIdentity({
            path: context.databasePath,
            identityKey: command.input.identityKey,
            env: getSqliteWorkerStateContext().environment,
          });
        } finally {
          // An existing-only actor may acquire its first writable handle through this owner.
          const database = openClawStateDatabaseCache.getCachedOpenClawStateDatabase(
            context.databasePath,
          );
          if (!nativeDatabase && database) {
            borrow = retainOpenClawStateDatabase(database);
            nativeDatabase = database;
          }
        }
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
      if (command.type === "userPreferences.read" || command.type === "userPreferences.write") {
        return executeUserPreferenceCommand(command, {
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
      const database = open();
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
      if (command.type === "agentProvenance.read" || command.type === "agentProvenance.list") {
        ensureAgentProvenanceSchema(writeOptions);
        return command.type === "agentProvenance.read"
          ? readAgentProvenanceInDatabase(database.db, command.input.agentId)
          : listAgentProvenanceInDatabase(database.db);
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
    close() {
      closed = true;
      borrow?.release();
    },
  };
}
