import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import {
  selectAcpSessionRowForRead,
  selectAcpSessionRows,
} from "../acp/runtime/session-meta-keys.js";
import {
  countMcpOAuthPrincipalsInDatabase,
  listMcpOAuthStoreKeysInDatabase,
  readMcpOAuthPendingInDatabase,
  readMcpOAuthStoreIfPresentInDatabase,
  readMcpOAuthStatusesInDatabase,
} from "../agents/mcp-oauth-store.kernel.js";
import {
  loadSubagentRunsByRunIdsFromSqlite,
  loadSubagentRunsForChildSessionFromSqlite,
  loadSubagentRunsForSessionFromSqlite,
  loadSubagentSessionListRunsFromSqlite,
} from "../agents/subagents/registry/subagent-registry.store.sqlite.js";
import { readWorkspaceStateSnapshotForDirectoryInDatabase } from "../agents/workspace-state-store.kernel.js";
import { isChannelIngressReadCommand } from "../channels/message/ingress-queue-read-contract.js";
import { readChannelIngressInDatabase } from "../channels/message/ingress-queue-read.worker.js";
import { readCronJobNamesInDatabase } from "../cron/store/job-name.js";
import { resolveCronJobsStorePath } from "../cron/store/paths.js";
import { readActiveCronRunReceiptOwnersInDatabase } from "../cron/store/run-receipt-read.js";
import { observeCronRunRecoveryInDatabase } from "../cron/store/run-recovery.read.js";
import {
  readGitHubPublicationRequest,
  readKnownGitHubPublicationPullRequestUrlsInDatabase,
} from "../gateway/github-publication-store.js";
import {
  readKnownRepositoryGitHubPublicationPullRequestUrlsInDatabase,
  readRepositoryGitHubPublicationInDatabase,
} from "../gateway/github-repository-publication-store.js";
import { listTerminalOperatorApprovalsInDatabase } from "../gateway/operator-approval-store.kernel.js";
import { readSessionGroupCatalogSnapshot } from "../gateway/session-group-catalog.kernel.js";
import { readSessionGroupMembership } from "../gateway/session-group-membership.read.js";
import { readWorkerSessionPlacementProjectionInDatabase } from "../gateway/worker-environments/placement-read-projection.js";
import { readWorkerPlacementChangeSnapshotInDatabase } from "../gateway/worker-environments/placement-row-codec.js";
import {
  readWorkerEnvironmentFacts,
  readWorkerEnvironmentPrunePage,
} from "../gateway/worker-environments/store-row-codec.js";
import { executeDevicePairingRead } from "../infra/device-pairing-read.kernel.js";
import { readExecApprovalsConfigRow } from "../infra/exec-approvals-sqlite.js";
import { inspectCurrentConversationBindingRecordInDatabase } from "../infra/outbound/current-conversation-bindings.kernel.js";
import { readOutboundDeliveriesInDatabase } from "../infra/outbound/delivery-queue-storage.kernel.js";
import { getAdmittedSqliteSchemaFacts } from "../infra/sqlite-schema-facts.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import { runWithSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import { withStateDatabaseCoordinatorRuntimeDirectory } from "../infra/state-database-coordinator.js";
import {
  readInterruptedUpdateCandidate,
  readUpdateRunRecord,
  readUpdateRuns,
} from "../infra/update-run-read.kernel.js";
import { serveOwnedWorkerTasks } from "../infra/worker-task-server.js";
import {
  pluginBlobLookupInDatabase,
  pluginBlobEntriesInDatabase,
} from "../plugin-state/plugin-blob-store.sqlite.js";
import {
  selectSkillLibraryRevisionMetadataBatch,
  selectSkillLibraryRevisionManifestsBatch,
} from "../skills/library/selection-read.kernel.js";
import { captureTaskRetentionSource } from "../tasks/task-registry-retention-source.js";
import {
  readTaskRecord,
  readTaskRegistryMutationSnapshotInDatabase,
  readTaskRegistrySnapshot,
} from "../tasks/task-registry.store.kernel.js";
import { isTuiLastSessionReadCommand } from "../tui/tui-last-session.contract.js";
import { readTuiLastSessionCommand } from "../tui/tui-last-session.kernel.js";
import {
  readAgentDatabaseDeletionSnapshotInDatabase,
  readAgentDeletionJournalStatusInDatabase,
} from "./agent-deletion-journal.read.js";
import { readConfigMachineStateRowInDatabase } from "./config-machine-state.js";
import { readGitHubPublicationSessionLifecycle } from "./github-publication-session-lifecycles.js";
import { readOnboardingRecommendationsInDatabase } from "./onboarding-recommendations.kernel.js";
import { readRegisteredAgentDatabaseRows } from "./openclaw-agent-db-registry.read.js";
import { openClawStateDatabaseCache } from "./openclaw-state-db-cache.js";
import {
  closeRetainedOpenClawStateReadConnections,
  readOpenClawStateReadOnlyLocation,
  withOpenClawStateReadOnlyLocation,
} from "./openclaw-state-db-read-connection.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import { assertOpenClawStateWriteAllowed } from "./openclaw-state-ownership.js";
import { readStateDiagnosticCommand } from "./openclaw-state-read-diagnostics.js";
import { readStateRegistryCommand } from "./openclaw-state-read-registry.js";
import type {
  OpenClawStateReadReply,
  OpenClawStateReadResult,
} from "./openclaw-state-read.types.js";
import { isReadRequest } from "./openclaw-state-read.validation.js";
import { encodeOpenClawStateWorkerError } from "./openclaw-state-worker-error.js";
import { findSessionRepositoryWorkspaceInDatabase } from "./session-repository-workspaces.js";
import {
  listUserChannelIdentitiesInDatabase,
  resolveUserChannelIdentityInDatabase,
} from "./user-channel-identities.js";
import { readUserChannelIdentityResult } from "./user-channel-identities.worker.js";
import { selectUserPreferenceValues } from "./user-preferences.store.js";
import { readUserProfileGitHubCommand } from "./user-profile-github-identity.js";
import {
  readUserProfileAuthorityInDatabase,
  readUserProfileEmailBindings,
  readUserProfileIdForEmail,
} from "./user-profile-identity.read.js";
import {
  readUserProfileAvatarCommand,
  selectProfileDisplayEntries,
} from "./user-profiles-internal.js";

serveOwnedWorkerTasks(
  (input): OpenClawStateReadReply => {
    let sourceAdmitted: true | undefined;
    let nativeCleanupFailure: OpenClawStateReadReply["nativeCleanupFailure"];
    try {
      if (!isReadRequest(input)) {
        throw new Error("Shared-state reader requires a captured state location and read command");
      }
      const reply = runWithSqliteWorkerStateContext(input.context, () =>
        withStateDatabaseCoordinatorRuntimeDirectory(
          input.context.coordinatorRuntime,
          (): OpenClawStateReadReply => {
            if (input.checkFreshAdmission) {
              openClawStateDatabaseCache.assertOpenClawStateDatabaseFreshOpenAllowedAtPath(
                input.databasePath,
                input.context.environment,
                (error) => {
                  nativeCleanupFailure = {
                    error: encodeOpenClawStateWorkerError(error, { includeOrdinary: true }),
                  };
                },
              );
            }
            const { command } = input;
            if (command.type === "admit") {
              return { ok: true, type: "admit" };
            }
            const locationArgs = [
              input.databasePath,
              input.location,
              undefined,
              input.expectedIdentity,
              input.snapshotRoot,
              true,
            ] as const;
            if (command.type === "agentDatabaseRegistry.read") {
              const result = readOpenClawStateReadOnlyLocation(
                ({ db }) => {
                  sourceAdmitted = true;
                  return readRegisteredAgentDatabaseRows(db, input.databasePath, false);
                },
                ...locationArgs,
              );
              return {
                ok: true,
                type: command.type,
                sourceAdmitted,
                result:
                  result.status === "available"
                    ? { status: "available", entries: result.value }
                    : { status: "unavailable" },
              };
            }
            if (command.type === "subagents.sessionList") {
              const result = readOpenClawStateReadOnlyLocation(
                ({ db }) => {
                  sourceAdmitted = true;
                  return loadSubagentSessionListRunsFromSqlite(undefined, { db });
                },
                ...locationArgs,
              );
              if (result.status === "unavailable" && sourceAdmitted !== true) {
                throw result.error;
              }
              return result.status === "available"
                ? { ok: true, type: command.type, sourceAdmitted: true, runs: result.value }
                : {
                    ok: true,
                    type: command.type,
                    sourceAdmitted: true,
                    unavailable: {
                      message: String(result.error),
                      error: encodeOpenClawStateWorkerError(result.error, {
                        includeOrdinary: true,
                      }),
                    },
                  };
            }
            const result = withOpenClawStateReadOnlyLocation(
              ({ db }): OpenClawStateReadResult => {
                sourceAdmitted = true;
                if (command.type === "agentDatabaseDeletion.snapshot") {
                  return {
                    type: command.type,
                    snapshot: readAgentDatabaseDeletionSnapshotInDatabase(
                      db,
                      input.databasePath,
                      command.purpose,
                    ),
                  };
                }
                if (command.type === "agentDeletionJournal.status") {
                  return {
                    type: command.type,
                    status: readAgentDeletionJournalStatusInDatabase(db, command.agentId),
                  };
                }
                if (command.type === "deliveryQueue.outbound") {
                  // Custody reads retain queue ownership admission even on a read-only connection.
                  assertOpenClawStateWriteAllowed({
                    database: db,
                    databasePath: input.databasePath,
                    env: input.context.environment,
                  });
                  return {
                    type: command.type,
                    entries: readOutboundDeliveriesInDatabase({ db }, command),
                  };
                }
                if (command.type === "acpSessions.list") {
                  return {
                    type: command.type,
                    rows: selectAcpSessionRows(db),
                  };
                }
                if (command.type === "acpSessions.metadata") {
                  return {
                    type: command.type,
                    rows: command.entries.map(
                      (entry) => selectAcpSessionRowForRead(db, entry) ?? null,
                    ),
                  };
                }
                if (isChannelIngressReadCommand(command)) {
                  return readChannelIngressInDatabase(db, command);
                }
                if (command.type === "subagents.runs") {
                  const rows =
                    command.scope.kind === "session"
                      ? loadSubagentRunsForSessionFromSqlite(command.scope.sessionKey, { db })
                      : loadSubagentRunsByRunIdsFromSqlite(command.scope.runIds, { db });
                  return {
                    type: command.type,
                    runs: new Map(rows.map((entry) => [entry.runId, entry])),
                  };
                }
                if (command.type === "mcpOAuth.statuses") {
                  return {
                    type: command.type,
                    value: readMcpOAuthStatusesInDatabase(db, command.input),
                  };
                }
                if (command.type === "mcpOAuth.readOnly") {
                  return {
                    type: command.type,
                    value: readMcpOAuthStoreIfPresentInDatabase(db, command.input),
                  };
                }
                if (command.type === "mcpOAuth.keys") {
                  return {
                    type: command.type,
                    value: listMcpOAuthStoreKeysInDatabase(db, command.input),
                  };
                }
                if (command.type === "mcpOAuth.pending") {
                  return {
                    type: command.type,
                    value: readMcpOAuthPendingInDatabase(db, command.input),
                  };
                }
                if (command.type === "mcpOAuth.countPrincipals") {
                  return {
                    type: command.type,
                    value: countMcpOAuthPrincipalsInDatabase(db, command.input),
                  };
                }
                if (command.type === "sessionGroups.snapshot") {
                  return {
                    type: command.type,
                    snapshot: readSessionGroupCatalogSnapshot(db),
                  };
                }
                if (command.type === "sessionGroups.members") {
                  return {
                    type: command.type,
                    snapshot: readSessionGroupMembership(command.cfg, input.context.environment),
                  };
                }
                if (command.type === "conversationBindings.inspect") {
                  return {
                    type: command.type,
                    record: inspectCurrentConversationBindingRecordInDatabase(
                      db,
                      command.conversation,
                    ),
                  };
                }
                if (command.type === "cron.observeRunRecovery") {
                  return {
                    type: command.type,
                    observation: observeCronRunRecoveryInDatabase(db, command),
                  };
                }
                if (command.type === "cron.jobNames") {
                  const storePath = command.storePath ?? resolveCronJobsStorePath();
                  return {
                    type: command.type,
                    names: readCronJobNamesInDatabase(db, command.jobIds, storePath),
                  };
                }
                if (command.type === "cron.activeReceiptOwners") {
                  return {
                    type: command.type,
                    owners: readActiveCronRunReceiptOwnersInDatabase(db, command.agentId),
                  };
                }
                if (
                  command.type === "devicePairing.list" ||
                  command.type === "devicePairing.lookup" ||
                  command.type === "devicePairing.pending" ||
                  command.type === "devicePairing.bootstrapContext"
                ) {
                  return executeDevicePairingRead(db, input.databasePath, command);
                }
                if (command.type === "tasks.mutationSnapshot") {
                  return {
                    type: command.type,
                    snapshot:
                      command.input === undefined
                        ? readTaskRegistrySnapshot({ db, path: input.databasePath })
                        : readTaskRegistryMutationSnapshotInDatabase(db, command.input),
                  };
                }
                if (command.type === "tasks.retentionSource") {
                  const task = readTaskRecord(db, command.taskId);
                  return {
                    type: command.type,
                    source: task ? captureTaskRetentionSource(task) : undefined,
                  };
                }
                if (command.type === "subagents.forChildSession") {
                  return {
                    type: command.type,
                    runs: loadSubagentRunsForChildSessionFromSqlite(command.childSessionKey, {
                      db,
                    }),
                  };
                }
                if (command.type === "pluginBlob.lookup") {
                  return {
                    type: command.type,
                    value: pluginBlobLookupInDatabase(db, {
                      ...command.input,
                      env: input.context.environment,
                      path: input.databasePath,
                    }),
                  };
                }
                if (
                  command.type === "config.snapshot.read" ||
                  command.type === "audit.run.inspect"
                ) {
                  return readStateDiagnosticCommand(db, command);
                }
                if (command.type === "pluginBlob.entries") {
                  return {
                    type: command.type,
                    value: pluginBlobEntriesInDatabase(db, {
                      ...command.input,
                      env: input.context.environment,
                      path: input.databasePath,
                    }),
                  };
                }
                if (command.type === "updateRuns.get") {
                  return {
                    type: command.type,
                    run: tableExists(db, "update_runs")
                      ? readUpdateRunRecord(db, command.runId)
                      : undefined,
                  };
                }
                if (command.type === "updateRuns.list") {
                  return {
                    type: command.type,
                    runs: readUpdateRuns(db, command.input),
                  };
                }
                if (command.type === "updateRuns.interruptedCandidate") {
                  return {
                    type: command.type,
                    run: readInterruptedUpdateCandidate(db),
                  };
                }
                if (command.type === "exec-approvals.read") {
                  return {
                    type: command.type,
                    row: readExecApprovalsConfigRow(db),
                  };
                }
                if (command.type === "workerEnvironments.snapshot") {
                  return {
                    type: command.type,
                    facts: runSqliteDeferredTransactionSync(db, () =>
                      readWorkerEnvironmentFacts(db, command.ids),
                    ),
                  };
                }
                if (command.type === "workerEnvironments.pruneCandidates") {
                  return {
                    type: command.type,
                    page: readWorkerEnvironmentPrunePage(db, command.input),
                  };
                }
                if (command.type === "skills.library.descriptions") {
                  return {
                    type: command.type,
                    value: tableExists(db, "skill_library_entries")
                      ? selectSkillLibraryRevisionMetadataBatch(db, command.input)
                      : undefined,
                  };
                }
                if (command.type === "skills.library.manifests") {
                  return {
                    type: command.type,
                    value: tableExists(db, "skill_library_entries")
                      ? selectSkillLibraryRevisionManifestsBatch(db, command.input)
                      : undefined,
                  };
                }
                if (command.type === "operatorApprovals.history") {
                  return {
                    type: command.type,
                    history: listTerminalOperatorApprovalsInDatabase(command.input, db),
                  };
                }
                if (command.type === "onboardingRecommendations.read") {
                  return {
                    type: command.type,
                    record: readOnboardingRecommendationsInDatabase(db, command.configKey),
                  };
                }
                if (
                  command.type === "nodeHost.config" ||
                  command.type === "operator.channelPolicy"
                ) {
                  return {
                    type: command.type,
                    // Activation may precede deferred publication; never issue authority before v19.
                    row:
                      command.type === "operator.channelPolicy" &&
                      (getAdmittedSqliteSchemaFacts(db)?.userVersion ?? 0) < 19
                        ? undefined
                        : readConfigMachineStateRowInDatabase(db, command.type),
                  };
                }
                if (command.type === "workspace.snapshot") {
                  return {
                    type: command.type,
                    snapshot: readWorkspaceStateSnapshotForDirectoryInDatabase({
                      workspaceDir: command.workspaceDir,
                      database: { db, path: input.databasePath },
                    }),
                  };
                }
                if (command.type === "githubPublication.lifecycle") {
                  return {
                    type: command.type,
                    lifecycle: readGitHubPublicationSessionLifecycle(command, db),
                  };
                }
                if (command.type === "githubPublication.request") {
                  return {
                    type: command.type,
                    row: readGitHubPublicationRequest(db, { requestId: command.requestId }),
                  };
                }
                if (command.type === "githubRepository.request") {
                  return {
                    type: command.type,
                    row: readRepositoryGitHubPublicationInDatabase(db, command.requestId),
                  };
                }
                if (
                  command.type === "githubPublication.knownPullRequestUrls" ||
                  command.type === "githubRepository.knownPullRequestUrls"
                ) {
                  return {
                    type: command.type,
                    urls:
                      command.type === "githubPublication.knownPullRequestUrls"
                        ? readKnownGitHubPublicationPullRequestUrlsInDatabase(db, command.input)
                        : readKnownRepositoryGitHubPublicationPullRequestUrlsInDatabase(
                            db,
                            command.input,
                          ),
                  };
                }
                if (command.type === "userProfiles.authority.resolve") {
                  return {
                    type: command.type,
                    profile: readUserProfileAuthorityInDatabase(db, command.profileId),
                  };
                }
                if (
                  command.type === "userProfiles.githubIdentity.cached" ||
                  command.type === "userProfiles.githubAttribution.resolve"
                ) {
                  return readUserProfileGitHubCommand(db, command);
                }
                if (command.type === "userProfiles.channelIdentity.list") {
                  return {
                    type: command.type,
                    result: readUserChannelIdentityResult(() =>
                      listUserChannelIdentitiesInDatabase(db, command.profileId),
                    ),
                  };
                }
                if (command.type === "userProfiles.channelIdentity.resolve") {
                  return {
                    type: command.type,
                    linked: resolveUserChannelIdentityInDatabase(db, command.identity),
                  };
                }
                if (command.type === "userProfiles.reconcile") {
                  const facts = runSqliteDeferredTransactionSync(db, () => ({
                    profile: selectProfileDisplayEntries(db, [command.profileId])[0]?.[1],
                    emailBindings: readUserProfileEmailBindings(db, command.profileId),
                  }));
                  return { type: command.type, ...facts };
                }
                if (
                  command.type === "userProfiles.avatar.inspect" ||
                  command.type === "userProfiles.avatar.read"
                ) {
                  return readUserProfileAvatarCommand(db, command);
                }
                if (command.type === "userProfiles.catalog") {
                  const facts = runSqliteDeferredTransactionSync(db, () => ({
                    profiles: tableExists(db, "user_profiles")
                      ? selectProfileDisplayEntries(db)
                      : [],
                    emailBindings: readUserProfileEmailBindings(db),
                  }));
                  return { type: command.type, ...facts };
                }
                if (command.type === "userPreferences.values") {
                  return {
                    type: command.type,
                    values: selectUserPreferenceValues(db, command.profileIds, command.key),
                  };
                }
                if (command.type === "userProfiles.email.resolve") {
                  return {
                    type: command.type,
                    profileId: runSqliteDeferredTransactionSync(db, () =>
                      readUserProfileIdForEmail(db, command.email),
                    ),
                  };
                }
                if (command.type === "sessionRepositoryWorkspaces.find") {
                  return {
                    type: command.type,
                    workspaces: runSqliteDeferredTransactionSync(db, () =>
                      command.owners.flatMap((owner) => {
                        const workspace = findSessionRepositoryWorkspaceInDatabase(db, owner);
                        return workspace ? [workspace] : [];
                      }),
                    ),
                  };
                }
                if (command.type === "workerPlacements.changeSnapshot") {
                  return {
                    type: command.type,
                    placements: readWorkerPlacementChangeSnapshotInDatabase(db, command.profileIds),
                  };
                }
                if (command.type === "workers.placementProjection") {
                  return {
                    type: command.type,
                    result: readWorkerSessionPlacementProjectionInDatabase(
                      db,
                      command.sessionIds,
                      command.conflictBindings,
                    ),
                  };
                }
                return isTuiLastSessionReadCommand(command)
                  ? readTuiLastSessionCommand(db, command)
                  : readStateRegistryCommand(db, command);
              },
              ...locationArgs,
            );
            return { ok: true, sourceAdmitted: true, ...result };
          },
        ),
      );
      return nativeCleanupFailure ? { ...reply, nativeCleanupFailure } : reply;
    } catch (value) {
      const error = toStringifiedError(value);
      return {
        ok: false,
        sourceAdmitted,
        message: error.message,
        error: encodeOpenClawStateWorkerError(error, { includeOrdinary: true }),
        ...(nativeCleanupFailure ? { nativeCleanupFailure } : {}),
      };
    }
  },
  { closeResource: closeRetainedOpenClawStateReadConnections },
);
