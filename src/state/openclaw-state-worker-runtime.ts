import { isMcpOAuthWorkerCommand } from "../agents/mcp-oauth-store.types.js";
import { isWorktreeRegistryReadCommand } from "../agents/worktrees/registry-read.worker-contract.js";
import { isCronStateWorkerCommand } from "../cron/store/dispatch-worker-contract.js";
import { isOperatorApprovalCommand } from "../gateway/operator-approval-store.worker-contract.js";
import { isWorkerEnvironmentCommand } from "../gateway/worker-environments/store-worker-contract.js";
import { isDeliveryQueueCommand } from "../infra/delivery-queue.worker-contract.js";
import { isDevicePairingMutationCommand } from "../infra/device-pairing-worker-contract.js";
import { isApnsRegistrationWorkerCommand } from "../infra/push-apns-store.worker-contract.js";
import { isSessionDeliveryCommand } from "../infra/session-delivery-queue.worker-contract.js";
import {
  readStableSqliteFileGeneration,
  sameSqliteFileGeneration,
} from "../infra/sqlite-file-generation.js";
import { deferSqlitePostCommitPublication } from "../infra/sqlite-post-commit.js";
import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { getSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isNodeWorkerJournalCommand } from "../node-host/node-worker-journal.worker-contract.js";
import { isPluginBlobWorkerCommand } from "../plugin-state/plugin-blob-worker-contract.js";
import { isPluginStateWorkerCommand } from "../plugin-state/plugin-state-worker-contract.js";
import { isProjectRegistryCommand } from "../projects/project-registry.worker-contract.js";
import { isSkillUploadCommand } from "../skills/lifecycle/upload-store.worker-contract.js";
import { isSkillWorkshopCommand } from "../skills/workshop/store.worker-contract.js";
import { isTaskRegistryWorkerCommand } from "../tasks/task-registry.worker-contract.js";
import { isTranscriptWriteCommand } from "../transcripts/store-worker-contract.js";
import { isOnboardingRecommendationWriteCommand } from "./onboarding-recommendations.contract.js";
import type { OpenClawStateDatabase } from "./openclaw-state-db-contract.js";
import { assertOpenClawStateDatabaseOwner } from "./openclaw-state-db-maintenance.js";
import {
  withOpenClawStateDatabaseReadOnly,
  withArtifactPreservingStateReads,
  withExistingOpenClawStateDatabaseArtifactPreservingReadOnly,
  withExistingOpenClawStateDatabaseReadOnly,
} from "./openclaw-state-db-readonly.js";
import { runOpenClawStateWriteTransaction } from "./openclaw-state-db.js";
import {
  sharedStateCommandRuntimes as runtimes,
  type PreparedSharedStateCommand,
} from "./openclaw-state-worker-command-runtime.js";
import type { OpenClawStateWorkerRuntimeCommand } from "./openclaw-state-worker-contract.js";
import { isUserProfileCommand } from "./user-profiles.types.js";

const log = createSubsystemLogger("state/worker");

function isCommand<Type extends OpenClawStateWorkerRuntimeCommand["type"]>(
  command: { type: string },
  ...types: Type[]
): command is Extract<OpenClawStateWorkerRuntimeCommand, { type: Type }> {
  return types.some((type) => command.type === type);
}

function writeOptions(context: { databasePath: string }, open: () => OpenClawStateDatabase) {
  return {
    database: open(),
    path: context.databasePath,
    env: getSqliteWorkerStateContext().environment,
  };
}

export function prepareSharedStateCommand(type: PropertyKey): void | Promise<void> {
  if (typeof type === "string") {
    return selectSharedStateCommand({ type })?.prepare();
  }
}

export function executeSharedStateCommand(
  command: OpenClawStateWorkerRuntimeCommand,
  context: { databasePath: string },
  open: () => OpenClawStateDatabase,
  hasNativeDatabase: boolean,
) {
  const selected = selectSharedStateCommand(command);
  if (selected) {
    return selected.execute(context, open, hasNativeDatabase);
  }
  writeOptions(context, open);
  throw new Error("Unknown shared-state SQLite command");
}

// Preparation selects code by type only. Execution binds the complete command again
// under current broker authority; no payload, database, or authority is cached.
function selectSharedStateCommand(command: {
  type: string;
}): PreparedSharedStateCommand | undefined {
  if (isCommand(command, "deviceAuth.prepare")) {
    // Loading the family must not open or observe token state.
    return runtimes.deviceAuth.bind(() => undefined);
  }
  if (isMcpOAuthWorkerCommand(command)) {
    return runtimes.mcpOAuth.bind((runtime, _context, open) =>
      runtime.executeMcpOAuthWorkerCommand(open(), command),
    );
  }
  if (isCommand(command, "execApprovals.commitAuthorizations")) {
    return runtimes.execApprovals.bind((runtime, context, open) =>
      runtime.commitExecAuthorizationsInWorker(command.input, writeOptions(context, open)),
    );
  }
  if (isOperatorApprovalCommand(command)) {
    return runtimes.operatorApprovals.bind((runtime, context, open) =>
      runtime.executeOperatorApprovalCommand(command, writeOptions(context, open)),
    );
  }
  if (isDevicePairingMutationCommand(command)) {
    return runtimes.pairing.bind((runtime, _context, open) =>
      runtime.executeDevicePairingMutationInWorker(command, open()),
    );
  }
  if (isWorkerEnvironmentCommand(command)) {
    return runtimes.workerEnvironments.bind((runtime, _context, open) =>
      runtime.executeWorkerEnvironmentCommand(command, open()),
    );
  }
  if (isCommand(command, "audit.events.list")) {
    return runtimes.auditRead.bind((runtime, _context, open) =>
      runtime.listAuditEventsInDatabase(open().db, command.input),
    );
  }
  if (isCommand(command, "conversationBindings.readSelection")) {
    return runtimes.conversationBindings.bind((runtime, context) =>
      runtime.readCurrentConversationBindingSelectionInWorker(command.input, context.databasePath),
    );
  }
  if (isCommand(command, "audit.writer.process", "audit.writer.prune")) {
    return runtimes.auditWrite.bind((runtime, context, open) =>
      runtime.executeAuditWriterCommand(
        command,
        { path: context.databasePath, env: getSqliteWorkerStateContext().environment },
        open,
      ),
    );
  }
  if (
    isCommand(command, "authProfiles.read", "authProfiles.sharedOwnership", "authProfiles.personal")
  ) {
    return runtimes.authProfiles.bind((runtime, context) =>
      runtime.executeSharedAuthProfileCommand(command, context),
    );
  }
  if (isCommand(command, "promotions.markNotified", "promotions.recordClaim")) {
    return runtimes.promotions.bind((runtime, context, open) =>
      runtime.executePromotionCommand(
        command,
        { path: context.databasePath, env: getSqliteWorkerStateContext().environment },
        open,
      ),
    );
  }
  if (isCommand(command, "doctor.databaseBloat")) {
    return runtimes.databaseBloat.bind((runtime, context) =>
      runtime.readSqliteDatabaseBloat({
        path: context.databasePath,
        env: getSqliteWorkerStateContext().environment,
      }),
    );
  }
  if (isCommand(command, "telemetry.readState")) {
    return runtimes.telemetry.bind((runtime, context) =>
      runtime.readTelemetryStateInWorker({
        path: context.databasePath,
        env: getSqliteWorkerStateContext().environment,
      }),
    );
  }
  if (isCommand(command, "telemetry.countRecentSessions")) {
    return runtimes.telemetry.bind(
      (runtime, context) =>
        withExistingOpenClawStateDatabaseReadOnly(
          ({ db }) => runtime.countRecentTelemetrySessionsInDatabase(db, command.input.sinceMs),
          { path: context.databasePath, env: getSqliteWorkerStateContext().environment },
        ) ?? 0,
    );
  }
  if (isCommand(command, "webPush.readPersistedVapidKeyPair")) {
    return runtimes.webPushRead.bind((runtime, context) =>
      runtime.readPersistedVapidKeyPairInDatabase({
        path: context.databasePath,
        env: getSqliteWorkerStateContext().environment,
      }),
    );
  }
  if (
    isCommand(
      command,
      "webPush.findBoundWebPushSubscriptionByEndpoint",
      "webPush.setWebPushSubscriptionPreferences",
      "webPush.listWebPushSubscriptions",
      "webPush.hasBoundWebPushSubscriptions",
      "webPush.listBoundWebPushSubscriptions",
      "webPush.prepareWebPushApprovalDeliveries",
      "webPush.listWebPushApprovalDeliveryTargets",
      "webPush.deleteWebPushApprovalDeliveryTargets",
      "webPush.listTerminalWebPushApprovalDeliveryIds",
      "webPush.upsertWebPushSubscription",
      "webPush.deleteBoundWebPushSubscription",
      "webPush.deleteWebPushSubscriptionIfCurrent",
      "webPush.insertVapidKeyPairIfAbsent",
    )
  ) {
    return runtimes.webPush.bind((runtime, _context, open) =>
      runtime.executeWebPushCommand(command, open()),
    );
  }
  if (isCommand(command, "nativeHookRelay.read")) {
    return runtimes.nativeHookRead.bind((runtime, context) =>
      withOpenClawStateDatabaseReadOnly(
        (database) =>
          runtime.readNativeHookRelayBridgeSnapshotFromDatabase({
            database,
            relayId: command.input.relayId,
          })?.record,
        { path: context.databasePath, env: getSqliteWorkerStateContext().environment },
      ),
    );
  }
  if (isTaskRegistryWorkerCommand(command)) {
    return runtimes.tasks.bind((runtime, context, open) =>
      runtime.executeTaskRegistryCommand(
        command,
        { path: context.databasePath, env: getSqliteWorkerStateContext().environment },
        open,
      ),
    );
  }
  if (isCommand(command, "doctor.workshopMigrationRecords.read")) {
    return runtimes.workshopMigration.bind((runtime, context) =>
      withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(
        ({ db }) => runtime.readWorkshopMigrationRecordsInDatabase(db, command.input.includeEvents),
        { path: context.databasePath, env: getSqliteWorkerStateContext().environment },
      ),
    );
  }
  if (isCommand(command, "modelCatalog.remote.read")) {
    return runtimes.remoteCatalog.bind((runtime, context) => {
      const read = () =>
        runtime.readRemoteModelCatalog({
          path: context.databasePath,
          env: getSqliteWorkerStateContext().environment,
        });
      return command.input.artifactPreservingReadOnly
        ? withArtifactPreservingStateReads(read)
        : read();
    });
  }
  if (isCommand(command, "plugins.conversationBindingApprovals.read")) {
    return runtimes.bindingApprovals.bind((runtime, _context, open) =>
      runtime.readPluginBindingApprovalsInDatabase(open().db),
    );
  }
  if (isCommand(command, "plugins.conversationBindingApprovals.upsert")) {
    return runtimes.bindingApprovals.bind((runtime, context, open) =>
      runOpenClawStateWriteTransaction(
        ({ db }) => runtime.upsertPluginBindingApprovalInDatabase(db, command.input),
        writeOptions(context, open),
      ),
    );
  }
  if (isCommand(command, "updateRuns.reconcileInterrupted")) {
    return runtimes.interruptedUpdate.bind((runtime, context) =>
      runtime.persistInterruptedUpdateObservation(
        command.input,
        { path: context.databasePath, env: getSqliteWorkerStateContext().environment },
        (stage) => requestSqliteWorkerOperationAdmission({ stage, facts: undefined }),
      ),
    );
  }
  if (
    isCommand(
      command,
      "plugins.deferredMigrations.read",
      "plugins.deferredMigrations.completions.read",
    )
  ) {
    return runtimes.deferredMigrations.bind((runtime, context) =>
      runtime.readDeferredPluginMigrationsInWorker(command, {
        path: context.databasePath,
        env: getSqliteWorkerStateContext().environment,
      }),
    );
  }
  if (isCommand(command, "claws.install-schema-versions")) {
    return runtimes.clawProvenance.bind((runtime, context) => {
      const read = command.input.artifactPreservingReadOnly
        ? withExistingOpenClawStateDatabaseArtifactPreservingReadOnly
        : withExistingOpenClawStateDatabaseReadOnly;
      return read(
        ({ db, path: pathname }) => {
          assertOpenClawStateDatabaseOwner(db, { pathname });
          return runtime.readClawInstallSchemaVersionRows(db);
        },
        { path: context.databasePath, env: getSqliteWorkerStateContext().environment },
      );
    });
  }
  if (isCommand(command, "database.generationMatches")) {
    return {
      prepare() {},
      execute(context) {
        // Unavailable inspection retains the known failure; only a stable mismatch expires it.
        return sameSqliteFileGeneration(
          command.input.generation,
          readStableSqliteFileGeneration(context.databasePath),
        );
      },
    };
  }
  if (isOnboardingRecommendationWriteCommand(command)) {
    return runtimes.onboarding.bind((runtime, context, open) =>
      runtime.executeOnboardingRecommendationCommand(command, writeOptions(context, open)),
    );
  }
  if (isCommand(command, "userPreferences.read", "userPreferences.write")) {
    return runtimes.userPreferences.bind((runtime, context, open) =>
      runtime.executeUserPreferenceCommand(command, writeOptions(context, open)),
    );
  }
  if (isUserProfileCommand(command)) {
    return runtimes.userProfiles.bind((runtime, context, open) =>
      runtime.executeUserProfileCommand(command, writeOptions(context, open)),
    );
  }
  if (isPluginBlobWorkerCommand(command)) {
    return runtimes.pluginBlob.bind((runtime, context, open) =>
      runtime.executePluginBlobCommand(command, context.databasePath, open),
    );
  }
  if (isPluginStateWorkerCommand(command)) {
    return runtimes.pluginState.bind((runtime, context, open, hasNativeDatabase) =>
      runtime.executePluginStateCommand(
        command,
        { path: context.databasePath, env: getSqliteWorkerStateContext().environment },
        open,
        hasNativeDatabase,
      ),
    );
  }
  if (isCommand(command, "config.health.read")) {
    return runtimes.configHealth.bind((runtime, context) => {
      const read = command.input.artifactPreserving
        ? withExistingOpenClawStateDatabaseArtifactPreservingReadOnly
        : withExistingOpenClawStateDatabaseReadOnly;
      return (
        read(({ db }) => runtime.readConfigHealthSnapshotInDatabase(db), {
          path: context.databasePath,
          env: getSqliteWorkerStateContext().environment,
        }) ?? { state: {}, basis: {} }
      );
    });
  }
  if (isNodeWorkerJournalCommand(command)) {
    return runtimes.nodeJournal.bind((runtime, context, open) =>
      runtime.executeNodeWorkerJournalCommand(command, context.databasePath, open),
    );
  }
  if (isCommand(command, "deviceAuth.read", "deviceAuth.readOrigin")) {
    return runtimes.deviceAuth.bind((runtime, context, open) => {
      const read = (db: OpenClawStateDatabase["db"]) =>
        command.type === "deviceAuth.read"
          ? runtime.readDeviceAuthTokenObservationFromDatabase(db, command.input)
          : runtime.readOriginDeviceTokenObservationFromDatabase(db, command.input);
      return command.input.readOnly
        ? (withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(({ db }) => read(db), {
            path: context.databasePath,
            env: getSqliteWorkerStateContext().environment,
          }) ?? { entry: null, expectedToken: null })
        : read(open().db);
    });
  }
  // These commands historically opened the retained native handle before dispatch.
  // Keep that open inside synchronous execution, never in asynchronous preparation.
  if (isCommand(command, "githubRepository.personalPending")) {
    return runtimes.githubPublication.bind((runtime, _context, open) =>
      runtime.readPendingRepositoryGitHubPublicationInDatabase(open().db, command.input),
    );
  }
  if (isSkillWorkshopCommand(command)) {
    return runtimes.workshop.bind((runtime, context, open) =>
      runtime.executeSkillWorkshopCommand(command, open(), context.databasePath),
    );
  }
  if (isCommand(command, "deviceAuth.list")) {
    return runtimes.deviceAuth.bind((runtime, _context, open) =>
      runtime.readDeviceAuthTokensFromDatabase(open().db, command.input),
    );
  }
  if (isTranscriptWriteCommand(command)) {
    return runtimes.transcriptWrite.bind((runtime, context, open) =>
      runtime.executeTranscriptWrite(command, { database: open(), path: context.databasePath }),
    );
  }
  if (
    isCommand(
      command,
      "transcripts.canonicalSessionRow",
      "transcripts.readEntries",
      "transcripts.exportOwnership",
      "transcripts.exportPathCollisions",
      "transcripts.exportPathOwners",
      "transcripts.sessionEntries",
      "transcripts.matches",
      "transcripts.session",
      "transcripts.entry",
      "transcripts.latest",
      "transcripts.notes",
      "transcripts.libraryEntry",
      "transcripts.recentStopped",
      "transcripts.summaryRevision",
      "transcripts.summarySnapshot",
      "transcripts.utterances",
      "transcripts.exportDigest",
      "transcripts.summary",
    )
  ) {
    return runtimes.transcriptRead.bind((runtime, context, open) =>
      runtime.executeTranscriptRead({ database: open(), path: context.databasePath }, command),
    );
  }
  if (isCommand(command, "managedImages.read")) {
    return runtimes.managedImages.bind((runtime, _context, open) =>
      runtime.readManagedImageRecordInDatabase(open().db, command.input.attachmentId),
    );
  }
  if (isCommand(command, "managedImages.entries")) {
    return runtimes.managedImages.bind((runtime, _context, open) =>
      runtime.listManagedImageRecordEntriesInDatabase(open().db, command.input.sessionKey),
    );
  }
  if (isCommand(command, "managedImages.originalMediaIds")) {
    return runtimes.managedImages.bind((runtime, _context, open) =>
      runtime.listManagedImageOriginalMediaIdsInDatabase(open().db),
    );
  }
  if (isApnsRegistrationWorkerCommand(command)) {
    return runtimes.apns.bind((runtime, _context, open) =>
      runtime.executeApnsRegistrationCommand(command, open()),
    );
  }
  if (isCommand(command, "plugins.catalogSnapshot.read")) {
    return runtimes.catalogSnapshot.bind((runtime, _context, open) =>
      runtime.store.readHostedCatalogSnapshotInDatabase(open().db, command.input.url),
    );
  }
  if (isCommand(command, "nativeHookRelay.listSnapshots")) {
    return runtimes.nativeHookRead.bind((runtime, _context, open) =>
      runtime.listNativeHookRelayBridgeSnapshotsInDatabase(open()),
    );
  }
  if (isCommand(command, "sessionUpstream.listWatched")) {
    return runtimes.sessionUpstream.bind((runtime, _context, open) =>
      runtime.listWatchedSessionUpstreamLinksInDatabase(open().db),
    );
  }
  if (isCronStateWorkerCommand(command)) {
    return runtimes.cron.bind(
      (runtime, _context, open) => runtime.executeCronStateCommand(command, open()),
      (runtime) => runtime.prepareCronStateWorkerCommand(command.type),
    );
  }
  if (isSessionDeliveryCommand(command)) {
    return runtimes.sessionDelivery.bind((runtime, _context, open) =>
      runtime.executeSessionDeliveryCommand(command, open()),
    );
  }
  if (
    isCommand(
      command,
      "nativeHookRelay.write",
      "nativeHookRelay.renew",
      "nativeHookRelay.deleteOwned",
      "nativeHookRelay.prune",
    )
  ) {
    return runtimes.nativeHookWrite.bind((runtime, context, open) =>
      runtime.executeNativeHookRelayMutation(command, writeOptions(context, open)),
    );
  }
  if (isCommand(command, "sandboxRegistry.insertIfMissing")) {
    return runtimes.sandboxImport.bind((runtime, context, open) =>
      runtime.importSandboxRegistryRow(command.input, writeOptions(context, open)),
    );
  }
  if (isCommand(command, "sandboxRegistry.write")) {
    return runtimes.sandboxWrite.bind((runtime, context, open) =>
      runtime.writeSandboxRegistry(command.input, writeOptions(context, open)),
    );
  }
  if (isCommand(command, "secrets.purge")) {
    return runtimes.secrets.bind((runtime, context, open) =>
      runtime.purgeExpiredSecretStoreEntriesInDatabase(command.input, writeOptions(context, open)),
    );
  }
  if (isCommand(command, "conversationBindings.resolve", "conversationBindings.touch")) {
    return runtimes.conversationBindings.bind((runtime, context, open) =>
      runtime.executeCurrentConversationBindingCommand(command, writeOptions(context, open)),
    );
  }
  if (isCommand(command, "sessionGroups.mutate")) {
    return runtimes.sessionGroups.bind((runtime, context, open) => {
      const options = writeOptions(context, open);
      return runtime.mutateSessionGroupCatalogInDatabase(
        options.database,
        command.input,
        options.env,
      );
    });
  }
  if (isDeliveryQueueCommand(command)) {
    return runtimes.delivery.bind((runtime, context, open) =>
      runtime.executeDeliveryQueueCommand(command, writeOptions(context, open)),
    );
  }
  if (isSkillUploadCommand(command)) {
    return runtimes.skillUploads.bind((runtime, context, open) =>
      runtime.executeSkillUploadCommand(command, writeOptions(context, open)),
    );
  }
  if (
    isCommand(
      command,
      "deviceAuth.store",
      "deviceAuth.storeOrigin",
      "deviceAuth.clear",
      "deviceAuth.clearOrigin",
    )
  ) {
    return runtimes.deviceAuth.bind((runtime, context, open) =>
      runOpenClawStateWriteTransaction(
        ({ db }) => {
          requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
          const result =
            command.type === "deviceAuth.store"
              ? runtime.storeDeviceAuthTokenInDatabase(db, command.input)
              : command.type === "deviceAuth.storeOrigin"
                ? runtime.storeOriginDeviceTokenInDatabase(db, command.input)
                : command.type === "deviceAuth.clear"
                  ? runtime.clearDeviceAuthTokenFromDatabase(db, command.input)
                  : runtime.clearOriginDeviceTokenInDatabase(db, command.input);
          requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
          return result;
        },
        writeOptions(context, open),
      ),
    );
  }
  if (
    isCommand(
      command,
      "fleet.cell.reserve",
      "fleet.cell.updateImage",
      "fleet.cell.delete",
      "fleet.operation.acquire",
      "fleet.operation.heartbeat",
      "fleet.operation.release",
    )
  ) {
    return runtimes.fleet.bind((runtime, context, open) =>
      runtime.executeFleetRegistryCommand(command, writeOptions(context, open)),
    );
  }
  if (isCommand(command, "agentProvenance.readBatch", "agentProvenance.list")) {
    return runtimes.provenance.bind((runtime, context, open) => {
      const options = writeOptions(context, open);
      runtime.schema.ensureAgentProvenanceSchema(options);
      return command.type === "agentProvenance.readBatch"
        ? runtime.kernel.readAgentProvenanceBatchInDatabase(
            options.database.db,
            command.input.agentIds,
          )
        : runtime.kernel.listAgentProvenanceInDatabase(options.database.db);
    });
  }
  if (isCommand(command, "telemetry.persistSuccess")) {
    return runtimes.telemetry.bind((runtime, context, open) =>
      runOpenClawStateWriteTransaction(
        ({ db }) =>
          runtime.persistTelemetrySuccessInDatabase(
            db,
            command.input.state,
            command.input.updatedAtMs,
          ),
        writeOptions(context, open),
        { operationLabel: "config-machine-state.update" },
      ),
    );
  }
  if (isCommand(command, "sessionState.record", "sessionState.prune")) {
    return runtimes.sessionState.bind((runtime, context, open) =>
      runtime.executeSessionStateCommand(command, writeOptions(context, open)),
    );
  }
  if (isCommand(command, "plugins.catalogSnapshot.write")) {
    return runtimes.catalogSnapshot.bind((runtime, context, open) => {
      const options = writeOptions(context, open);
      try {
        runOpenClawStateWriteTransaction(
          ({ db }) =>
            runtime.store.writeHostedCatalogSnapshotInDatabase(
              db,
              command.input.snapshot,
              command.input.now,
            ),
          options,
        );
        return { ok: true };
      } catch (error) {
        if (error instanceof runtime.source.HostedCatalogSignedFeedMonotonicityError) {
          return { ok: false, message: error.message };
        }
        throw error;
      }
    });
  }
  if (isCommand(command, "subagents.persistChanges")) {
    return runtimes.subagents.bind((runtime, context, open) => {
      const options = writeOptions(context, open);
      const { writeId, values, deleteRunIds } = command.input;
      let committed = false;
      try {
        runOpenClawStateWriteTransaction((writer) => {
          requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: writeId });
          runtime.writeSubagentRunValuesInDatabase(writer, values, deleteRunIds);
          requestSqliteWorkerOperationAdmission({ stage: "commit", facts: writeId });
          deferSqlitePostCommitPublication(writer.db, () => {
            committed = true;
          });
        }, options);
      } catch (error) {
        if (!committed) {
          throw error;
        }
        log.warn("Subagent registry write committed before cleanup failed", { error });
      }
      return { writeId };
    });
  }
  if (isCommand(command, "backup.recordOutcome")) {
    return runtimes.backup.bind((runtime, context, open) =>
      runOpenClawStateWriteTransaction(
        ({ db }) => runtime.recordBackupRunInDatabase(db, command.input),
        writeOptions(context, open),
      ),
    );
  }
  if (isWorktreeRegistryReadCommand(command)) {
    return runtimes.worktreeRead.bind((runtime, context, open) => {
      const options = writeOptions(context, open);
      return runtime.executeWorktreeRegistryReadCommand(options.database.db, command);
    });
  }
  if (isCommand(command, "worktrees.releaseRunLease", "worktrees.reapRunLeases")) {
    return runtimes.worktreeLease.bind((runtime, context, open) =>
      runtime.executeWorktreeRunLeaseCommand(command, writeOptions(context, open)),
    );
  }
  if (isProjectRegistryCommand(command)) {
    return runtimes.projects.bind((runtime, context, open) =>
      runtime.executeProjectRegistryCommand(command, writeOptions(context, open)),
    );
  }
  if (isCommand(command, "config.health.patch")) {
    return runtimes.configHealth.bind((runtime, context, open) => {
      const options = writeOptions(context, open);
      const { configPath, patch, expected, updatedAtMs } = command.input;
      return runOpenClawStateWriteTransaction(({ db }) => {
        return runtime.patchConfigHealthEntryInDatabase(
          db,
          configPath,
          patch,
          expected,
          updatedAtMs,
        );
      }, options);
    });
  }
  if (isCommand(command, "diagnostic.register")) {
    return runtimes.diagnostic.bind((runtime, context, open) => {
      const options = writeOptions(context, open);
      const { scope, maxEntries, record } = command.input;
      return runOpenClawStateWriteTransaction(({ db }) => {
        runtime.createSqliteAuditRecordKernel(db, { scope, maxEntries }).register(record);
      }, options);
    });
  }
  return undefined;
}
