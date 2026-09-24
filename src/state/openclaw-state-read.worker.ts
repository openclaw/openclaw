import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import { selectAcpSessionRowForRead } from "../acp/runtime/session-meta-keys.js";
import {
  countMcpOAuthPrincipalsInDatabase,
  listMcpOAuthStoreKeysInDatabase,
  readMcpOAuthPendingInDatabase,
  readMcpOAuthStoreIfPresentInDatabase,
  readMcpOAuthStatusesInDatabase,
} from "../agents/mcp-oauth-store.kernel.js";
import {
  readSandboxBrowserRegistryInDatabase,
  readSandboxRegistryEntryInDatabase,
  readSandboxRegistryInDatabase,
  readSandboxRuntimeIdsInDatabase,
} from "../agents/sandbox/registry.kernel.js";
import {
  loadSubagentRunsByRunIdsFromSqlite,
  loadSubagentRunsForChildSessionFromSqlite,
  loadSubagentRunsForSessionFromSqlite,
  loadSubagentSessionListRunsFromSqlite,
} from "../agents/subagents/registry/subagent-registry.store.sqlite.js";
import { readWorkspaceStateSnapshotForDirectoryInDatabase } from "../agents/workspace-state-store.kernel.js";
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
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import { inspectCurrentConversationBindingRecordInDatabase } from "../infra/outbound/current-conversation-bindings.kernel.js";
import { readOutboundDeliveriesInDatabase } from "../infra/outbound/delivery-queue-storage.kernel.js";
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
import {
  readTaskRegistryMutationSnapshotInDatabase,
  readTaskRegistrySnapshot,
} from "../tasks/task-registry.store.kernel.js";
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
import type { OpenClawStateReadReply } from "./openclaw-state-read.types.js";
import { isReadRequest } from "./openclaw-state-read.validation.js";
import { encodeOpenClawStateWorkerError } from "./openclaw-state-worker-error.js";
import { findSessionRepositoryWorkspaceInDatabase } from "./session-repository-workspaces.js";
import {
  listUserChannelIdentitiesInDatabase,
  resolveUserChannelIdentityInDatabase,
} from "./user-channel-identities.js";
import { readUserChannelIdentityResult } from "./user-channel-identities.worker.js";
import { readUserProfileGitHubCommand } from "./user-profile-github-identity.js";
import {
  readUserProfileEmailBindings,
  readUserProfileIdForEmail,
} from "./user-profile-identity.read.js";
import { projectUserProfileDisplay } from "./user-profile-list.js";
import {
  selectProfileDisplayEntries,
  selectResolvedUserProfileMetadataById,
  userProfilesDb,
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
            if (command.type === "agentDatabaseRegistry.read") {
              const result = readOpenClawStateReadOnlyLocation(
                ({ db }) => {
                  sourceAdmitted = true;
                  return readRegisteredAgentDatabaseRows(db, input.databasePath, false);
                },
                input.databasePath,
                input.location,
                undefined,
                input.expectedIdentity,
                input.snapshotRoot,
                true,
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
                input.databasePath,
                input.location,
                undefined,
                input.expectedIdentity,
                input.snapshotRoot,
                true,
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
            return withOpenClawStateReadOnlyLocation(
              ({ db }) => {
                sourceAdmitted = true;
                if (command.type === "deliveryQueue.outbound") {
                  // Custody reads retain queue ownership admission even on a read-only connection.
                  assertOpenClawStateWriteAllowed({
                    database: db,
                    databasePath: input.databasePath,
                    env: input.context.environment,
                  });
                  return {
                    ok: true,
                    type: command.type,
                    sourceAdmitted,
                    entries: readOutboundDeliveriesInDatabase({ db }, command),
                  };
                }
                if (command.type === "acpSessions.metadata") {
                  return {
                    ok: true,
                    type: command.type,
                    sourceAdmitted,
                    rows: command.entries.map(
                      (entry) => selectAcpSessionRowForRead(db, entry) ?? null,
                    ),
                  };
                }
                if (command.type === "subagents.runs") {
                  const rows =
                    command.scope.kind === "session"
                      ? loadSubagentRunsForSessionFromSqlite(command.scope.sessionKey, { db })
                      : loadSubagentRunsByRunIdsFromSqlite(command.scope.runIds, { db });
                  return {
                    ok: true,
                    type: command.type,
                    sourceAdmitted,
                    runs: new Map(rows.map((entry) => [entry.runId, entry])),
                  };
                }
                if (command.type === "mcpOAuth.statuses") {
                  return {
                    ok: true,
                    type: command.type,
                    sourceAdmitted,
                    value: readMcpOAuthStatusesInDatabase(db, command.input),
                  };
                }
                if (command.type === "mcpOAuth.readOnly") {
                  return {
                    ok: true,
                    type: command.type,
                    sourceAdmitted,
                    value: readMcpOAuthStoreIfPresentInDatabase(db, command.input),
                  };
                }
                if (command.type === "mcpOAuth.keys") {
                  return {
                    ok: true,
                    type: command.type,
                    sourceAdmitted,
                    value: listMcpOAuthStoreKeysInDatabase(db, command.input),
                  };
                }
                if (command.type === "mcpOAuth.pending") {
                  return {
                    ok: true,
                    type: command.type,
                    sourceAdmitted,
                    value: readMcpOAuthPendingInDatabase(db, command.input),
                  };
                }
                if (command.type === "mcpOAuth.countPrincipals") {
                  return {
                    ok: true,
                    type: command.type,
                    sourceAdmitted,
                    value: countMcpOAuthPrincipalsInDatabase(db, command.input),
                  };
                }
                if (command.type === "sessionGroups.snapshot") {
                  return {
                    ok: true,
                    type: command.type,
                    sourceAdmitted: true,
                    snapshot: readSessionGroupCatalogSnapshot(db),
                  };
                }
                if (command.type === "sessionGroups.members") {
                  return {
                    ok: true,
                    type: command.type,
                    sourceAdmitted: true,
                    snapshot: readSessionGroupMembership(command.cfg, input.context.environment),
                  };
                }
                if (command.type === "conversationBindings.inspect") {
                  return {
                    ok: true,
                    type: command.type,
                    sourceAdmitted,
                    record: inspectCurrentConversationBindingRecordInDatabase(
                      db,
                      command.conversation,
                    ),
                  };
                }
                if (command.type === "cron.observeRunRecovery") {
                  return {
                    ok: true,
                    type: command.type,
                    sourceAdmitted,
                    observation: observeCronRunRecoveryInDatabase(db, command),
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
                    ok: true,
                    type: command.type,
                    sourceAdmitted,
                    snapshot:
                      command.input === undefined
                        ? readTaskRegistrySnapshot({ db, path: input.databasePath })
                        : readTaskRegistryMutationSnapshotInDatabase(db, command.input),
                  };
                }
                if (command.type === "subagents.forChildSession") {
                  return {
                    ok: true,
                    type: command.type,
                    sourceAdmitted,
                    runs: loadSubagentRunsForChildSessionFromSqlite(command.childSessionKey, {
                      db,
                    }),
                  };
                }
                if (command.type === "pluginBlob.lookup") {
                  return {
                    ok: true,
                    type: command.type,
                    sourceAdmitted,
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
                    ok: true,
                    type: command.type,
                    sourceAdmitted,
                    value: pluginBlobEntriesInDatabase(db, {
                      ...command.input,
                      env: input.context.environment,
                      path: input.databasePath,
                    }),
                  };
                }
                if (command.type === "updateRuns.get") {
                  return {
                    ok: true,
                    type: command.type,
                    sourceAdmitted,
                    run: tableExists(db, "update_runs")
                      ? readUpdateRunRecord(db, command.runId)
                      : undefined,
                  };
                }
                if (command.type === "updateRuns.list") {
                  return {
                    ok: true,
                    type: command.type,
                    sourceAdmitted,
                    runs: readUpdateRuns(db, command.input),
                  };
                }
                if (command.type === "updateRuns.interruptedCandidate") {
                  return {
                    ok: true,
                    type: command.type,
                    sourceAdmitted,
                    run: readInterruptedUpdateCandidate(db),
                  };
                }
                if (command.type === "exec-approvals.read") {
                  return {
                    ok: true,
                    type: command.type,
                    sourceAdmitted,
                    row: readExecApprovalsConfigRow(db),
                  };
                }
                if (command.type === "workerEnvironments.snapshot") {
                  return {
                    ok: true,
                    type: command.type,
                    sourceAdmitted,
                    facts: runSqliteDeferredTransactionSync(db, () =>
                      readWorkerEnvironmentFacts(db, command.ids),
                    ),
                  };
                }
                if (command.type === "workerEnvironments.pruneCandidates") {
                  return {
                    ok: true,
                    type: command.type,
                    sourceAdmitted,
                    page: readWorkerEnvironmentPrunePage(db, command.input),
                  };
                }
                if (command.type === "skills.library.descriptions") {
                  return {
                    ok: true,
                    type: command.type,
                    sourceAdmitted,
                    value: tableExists(db, "skill_library_entries")
                      ? selectSkillLibraryRevisionMetadataBatch(db, command.input)
                      : undefined,
                  };
                }
                if (command.type === "skills.library.manifests") {
                  return {
                    ok: true,
                    type: command.type,
                    sourceAdmitted,
                    value: tableExists(db, "skill_library_entries")
                      ? selectSkillLibraryRevisionManifestsBatch(db, command.input)
                      : undefined,
                  };
                }
                if (command.type === "operatorApprovals.history") {
                  return {
                    ok: true,
                    type: command.type,
                    sourceAdmitted,
                    history: listTerminalOperatorApprovalsInDatabase(command.input, db),
                  };
                }
                if (command.type === "onboardingRecommendations.read") {
                  return {
                    ok: true,
                    type: command.type,
                    sourceAdmitted,
                    record: readOnboardingRecommendationsInDatabase(db, command.configKey),
                  };
                }
                if (command.type === "nodeHost.config") {
                  return {
                    ok: true,
                    type: command.type,
                    sourceAdmitted,
                    row: readConfigMachineStateRowInDatabase(db, command.type),
                  };
                }
                if (command.type === "workspace.snapshot") {
                  return {
                    ok: true,
                    type: command.type,
                    sourceAdmitted,
                    snapshot: readWorkspaceStateSnapshotForDirectoryInDatabase({
                      workspaceDir: command.workspaceDir,
                      database: { db, path: input.databasePath },
                    }),
                  };
                }
                if (command.type === "githubPublication.lifecycle") {
                  return {
                    ok: true,
                    type: command.type,
                    sourceAdmitted,
                    lifecycle: readGitHubPublicationSessionLifecycle(command, db),
                  };
                }
                if (command.type === "githubPublication.request") {
                  return {
                    ok: true,
                    type: command.type,
                    sourceAdmitted,
                    row: readGitHubPublicationRequest(db, { requestId: command.requestId }),
                  };
                }
                if (command.type === "githubRepository.request") {
                  return {
                    ok: true,
                    type: command.type,
                    sourceAdmitted,
                    row: readRepositoryGitHubPublicationInDatabase(db, command.requestId),
                  };
                }
                if (
                  command.type === "githubPublication.knownPullRequestUrls" ||
                  command.type === "githubRepository.knownPullRequestUrls"
                ) {
                  return {
                    ok: true,
                    type: command.type,
                    sourceAdmitted,
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
                  const profile = runSqliteDeferredTransactionSync(db, () => {
                    const current = tableExists(db, "user_profiles")
                      ? selectResolvedUserProfileMetadataById(db, command.profileId)
                      : undefined;
                    if (!current) {
                      return undefined;
                    }
                    const display = selectProfileDisplayEntries(db, [current.id])[0]?.[1];
                    if (!display) {
                      return undefined;
                    }
                    const aliases = executeSqliteQuerySync(
                      db,
                      userProfilesDb(db)
                        .selectFrom("user_profiles")
                        .select("id")
                        .where("merged_into", "=", current.id)
                        .orderBy("id", "asc"),
                    ).rows;
                    return {
                      profileId: current.id,
                      role: current.role ?? null,
                      aliases: [current.id, ...aliases.map((alias) => alias.id)],
                      display: projectUserProfileDisplay(display),
                    };
                  });
                  return {
                    ok: true,
                    type: command.type,
                    sourceAdmitted,
                    profile,
                  };
                }
                if (
                  command.type === "userProfiles.githubIdentity.cached" ||
                  command.type === "userProfiles.githubAttribution.resolve"
                ) {
                  return { ok: true, ...readUserProfileGitHubCommand(db, command), sourceAdmitted };
                }
                if (command.type === "userProfiles.channelIdentity.list") {
                  return {
                    ok: true,
                    type: command.type,
                    sourceAdmitted,
                    result: readUserChannelIdentityResult(() =>
                      listUserChannelIdentitiesInDatabase(db, command.profileId),
                    ),
                  };
                }
                if (command.type === "userProfiles.channelIdentity.resolve") {
                  return {
                    ok: true,
                    type: command.type,
                    sourceAdmitted,
                    linked: resolveUserChannelIdentityInDatabase(db, command.identity),
                  };
                }
                if (command.type === "userProfiles.reconcile") {
                  const facts = runSqliteDeferredTransactionSync(db, () => ({
                    profile: selectProfileDisplayEntries(db, [command.profileId])[0]?.[1],
                    emailBindings: readUserProfileEmailBindings(db, command.profileId),
                  }));
                  return { ok: true, type: command.type, sourceAdmitted, ...facts };
                }
                if (command.type === "userProfiles.catalog") {
                  const facts = runSqliteDeferredTransactionSync(db, () => ({
                    profiles: tableExists(db, "user_profiles")
                      ? selectProfileDisplayEntries(db)
                      : [],
                    emailBindings: readUserProfileEmailBindings(db),
                  }));
                  return { ok: true, type: command.type, sourceAdmitted, ...facts };
                }
                if (command.type === "userProfiles.email.resolve") {
                  return {
                    ok: true,
                    type: command.type,
                    sourceAdmitted,
                    profileId: runSqliteDeferredTransactionSync(db, () =>
                      readUserProfileIdForEmail(db, command.email),
                    ),
                  };
                }
                if (command.type === "sessionRepositoryWorkspaces.find") {
                  return {
                    ok: true,
                    type: command.type,
                    sourceAdmitted,
                    workspaces: runSqliteDeferredTransactionSync(db, () =>
                      command.owners.flatMap((owner) => {
                        const workspace = findSessionRepositoryWorkspaceInDatabase(db, owner);
                        return workspace ? [workspace] : [];
                      }),
                    ),
                  };
                }
                if (command.type === "sandboxRegistry.list") {
                  return {
                    ok: true,
                    type: command.type,
                    sourceAdmitted,
                    entries: readSandboxRegistryInDatabase(db),
                  };
                }
                if (command.type === "sandboxRegistry.get") {
                  return {
                    ok: true,
                    type: command.type,
                    sourceAdmitted,
                    entry: readSandboxRegistryEntryInDatabase(db, command.containerName),
                  };
                }
                if (command.type === "sandboxRegistry.runtimeIds") {
                  return {
                    ok: true,
                    type: command.type,
                    sourceAdmitted,
                    runtimeIds: readSandboxRuntimeIdsInDatabase(db, command),
                  };
                }
                if (command.type === "sandboxRegistry.browsers") {
                  return {
                    ok: true,
                    type: command.type,
                    sourceAdmitted,
                    entries: readSandboxBrowserRegistryInDatabase(db),
                  };
                }
                if (command.type === "workerPlacements.changeSnapshot") {
                  return {
                    ok: true,
                    type: command.type,
                    sourceAdmitted,
                    placements: readWorkerPlacementChangeSnapshotInDatabase(db, command.profileIds),
                  };
                }
                if (command.type === "workers.placementProjection") {
                  return {
                    ok: true,
                    type: command.type,
                    sourceAdmitted,
                    result: readWorkerSessionPlacementProjectionInDatabase(
                      db,
                      command.sessionIds,
                      command.conflictBindings,
                    ),
                  };
                }
                return readStateRegistryCommand(db, command);
              },
              input.databasePath,
              input.location,
              undefined,
              input.expectedIdentity,
              input.snapshotRoot,
              true,
            );
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
