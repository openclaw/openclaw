import {
  prepareAcpSessionMetadataRead,
  readAcpSessionCommand,
} from "../acp/runtime/session-meta-read.worker.js";
import {
  readSandboxBrowserRegistryInDatabase,
  readSandboxRegistryEntryInDatabase,
  readSandboxRegistryInDatabase,
  readSandboxRuntimeIdsInDatabase,
} from "../agents/sandbox/registry.kernel.js";
import { loadSubagentSessionListRunsFromSqlite } from "../agents/subagents/registry/subagent-registry.store.sqlite.js";
import { readSubagentRunsInWorker } from "../agents/subagents/registry/subagent-registry.store.worker.js";
import { readWorkspaceStateSnapshotForDirectoryInDatabase } from "../agents/workspace-state-store.kernel.js";
import { listRegistryWorktreesInDatabase } from "../agents/worktrees/registry-read.kernel.js";
import { readWorktreeRunLeaseStateInDatabase } from "../agents/worktrees/run-lease-owner.js";
import { ExecutionDecisionCursorError } from "../audit/execution-decision-receipts.js";
import { inspectExecutionIdentityRunInDatabase } from "../audit/execution-identity-context.js";
import type { ExecutionIdentityInspectionOutcome } from "../audit/execution-identity-inspection.types.js";
import { isChannelIngressReadCommand } from "../channels/message/ingress-queue-read-contract.js";
import { readChannelIngressInDatabase } from "../channels/message/ingress-queue-read.worker.js";
import { readClawStateCommandInDatabase } from "../claws/state-read.kernel.js";
import { readConfigSnapshotAuditRecordInDatabase } from "../config/config-journal-snapshot.kernel.js";
import {
  isCronStateReadCommand,
  readCronStateCommandInDatabase,
} from "../cron/store/read-command.js";
import {
  readGitHubPublicationRequest,
  readKnownGitHubPublicationPullRequestUrlsInDatabase,
} from "../gateway/github-publication-store.worker.js";
import { readKnownRepositoryGitHubPublicationPullRequestUrlsInDatabase } from "../gateway/github-repository-publication-store.worker.js";
import { readPlacementGrantRows } from "../gateway/operator-approval-placement-grants.read.worker.js";
import {
  listCronStandingGrantsInDatabase,
  lookupCronStandingGrantInDatabase,
} from "../gateway/operator-approval-standing-grants.worker.js";
import {
  readOperatorApprovalReplayInDatabase,
  readOperatorApprovalPendingSnapshotInDatabase,
  readPendingOperatorApprovalsInDatabase,
  listTerminalOperatorApprovalsInDatabase,
} from "../gateway/operator-approval-store.kernel.worker.js";
import { readSessionGroupCatalogSnapshot } from "../gateway/session-group-catalog.kernel.js";
import { readSessionGroupMembership } from "../gateway/session-group-membership.read.js";
import {
  readWorkerPlacementEnvironmentOwnerInDatabase,
  readWorkerPlacementRecoveryCandidatesInDatabase,
  readWorkerSessionPlacementProjectionInDatabase,
} from "../gateway/worker-environments/placement-read-projection.js";
import {
  readWorkerPlacementChangeSnapshotInDatabase,
  readWorkerPlacementsForReconcileInDatabase,
} from "../gateway/worker-environments/placement-row-codec.js";
import { readWorkspaceJournalInDatabase } from "../gateway/worker-environments/placement-workspace-journal.js";
import { isWorkspaceJournalReadCommand } from "../gateway/worker-environments/placement-workspace-journal.types.js";
import { listPendingWorkerWorkspaceResultsInDatabase } from "../gateway/worker-environments/placement-workspace-result.js";
import { readPreparedPoolPresenceDemandInDatabase } from "../gateway/worker-environments/prepared-pool-presence-store.worker.js";
import { readWorkerEnvironmentFacts } from "../gateway/worker-environments/store-row-codec.js";
import { executeDevicePairingRead } from "../infra/device-pairing-read.kernel.js";
import { readExecApprovalsConfigRow } from "../infra/exec-approvals-sqlite.js";
import { inspectCurrentConversationBindingRecordInDatabase } from "../infra/outbound/current-conversation-bindings.kernel.js";
import { readOutboundDeliveriesInDatabase } from "../infra/outbound/delivery-queue-storage.kernel.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { runSqliteReadSnapshotSync } from "../infra/sqlite-transaction.js";
import {
  readInterruptedUpdateCandidate,
  readUpdateRunStatusInDatabase,
  readUpdateRunHistoryStatusInDatabase,
  readUpdateRunRecord,
  readUpdateRuns,
} from "../infra/update-run-read.kernel.js";
import {
  inspectUpdateRunReconciliation,
  readUpdateRunReconciliationCandidates,
} from "../infra/update-run-reconciliation.read.js";
import {
  pluginBlobLookupInDatabase,
  pluginBlobEntriesInDatabase,
} from "../plugin-state/plugin-blob-store.sqlite.js";
import { isPluginStateReadCommand } from "../plugin-state/plugin-state-worker-contract.js";
import { readPluginStateCommand } from "../plugin-state/plugin-state.worker.js";
import {
  readDebugProxyCaptureBlob,
  readDebugProxyCaptureSessionEvents,
} from "../proxy-capture/store-readonly.js";
import {
  selectSkillLibraryRevisionMetadataBatch,
  selectSkillLibraryRevisionManifestsBatch,
} from "../skills/library/selection-read.kernel.js";
import { isTuiLastSessionReadCommand } from "../tui/tui-last-session.contract.js";
import { readTuiLastSessionCommand } from "../tui/tui-last-session.kernel.js";
import { readAgentDeletionJournalStatusInDatabase } from "./agent-deletion-journal.read.js";
import {
  readAgentDatabaseDeletionWorkerSnapshot,
  readRetainedAgentDeletionIds,
} from "./agent-deletion-journal.snapshot.worker.js";
import { readBackupRunsInDatabase } from "./backup-run-records.kernel.js";
import {
  isConfigMachineStateReadCommand,
  readConfigMachineStateCommandInDatabase,
} from "./config-machine-state.js";
import { readGitHubPublicationSessionLifecycle } from "./github-publication-session-lifecycles.worker.js";
import { readOnboardingRecommendationsInDatabase } from "./onboarding-recommendations.kernel.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import { assertOpenClawStateWriteAllowed } from "./openclaw-state-ownership.js";
import { readMcpOAuthStateCommand } from "./openclaw-state-read-mcp-oauth.js";
import type { RegisteredStateReadCommand } from "./openclaw-state-read-operation-registry.js";
import { readSessionRowsSharedFacts } from "./openclaw-state-read-session-rows.worker.js";
import type { OpenClawStateReadRequest } from "./openclaw-state-read.types.js";
import { findSessionRepositoryWorkspaceInDatabase } from "./session-repository-workspaces.kernel.js";
import { readUserBackgroundCommand } from "./user-background.kernel.js";
import { readUserModelAccountCommand } from "./user-model-accounts.read.worker.js";
import {
  readUserPreferences,
  selectPersonalPinnedSessionKeys,
  selectUserPreferenceValues,
} from "./user-preferences.store.js";
import { readUserProfileCommand } from "./user-profile-read.worker.js";
import { selectResolvedUserProfileMetadataById } from "./user-profiles-internal.js";

export { prepareAcpSessionMetadataRead, loadSubagentSessionListRunsFromSqlite };

/** Non-metadata query owners load only when the shared worker receives one of their commands. */
export function readOpenClawStateDatabaseCommand(
  db: EngineConnection,
  input: OpenClawStateReadRequest,
  command: Exclude<
    OpenClawStateReadRequest["command"],
    | RegisteredStateReadCommand
    | {
        type:
          | "admit"
          | "plugins.metadata.read"
          | "subagents.restore"
          | "meetingTranscripts.export"
          | "gatewayOwnerLease.read"
          | "agentDatabaseRegistry.read"
          | "localWorkspace.manifest"
          | "subagents.sessionList";
      }
  >,
  metadataRead: ReturnType<typeof prepareAcpSessionMetadataRead> | undefined,
) {
  if (command.type === "claws.inventory") {
    return readClawStateCommandInDatabase(db, command);
  }
  if (command.type === "agentDatabaseDeletion.snapshot") {
    return {
      type: command.type,
      snapshot: readAgentDatabaseDeletionWorkerSnapshot(db, input.databasePath, command.purpose),
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
  if (
    command.type === "acpSessions.resume" ||
    command.type === "acpSessions.list" ||
    command.type === "acpSessions.metadata"
  ) {
    return metadataRead ? metadataRead.read(db) : readAcpSessionCommand(db, command);
  }
  if (isChannelIngressReadCommand(command)) {
    return readChannelIngressInDatabase(db, command);
  }
  if (command.type === "subagents.runs") {
    return readSubagentRunsInWorker(db, command);
  }
  if (
    command.type === "mcpOAuth.statuses" ||
    command.type === "mcpOAuth.readOnly" ||
    command.type === "mcpOAuth.keys" ||
    command.type === "mcpOAuth.pending" ||
    command.type === "mcpOAuth.countPrincipals"
  ) {
    return readMcpOAuthStateCommand(db, command);
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
      record: inspectCurrentConversationBindingRecordInDatabase(db, command.conversation),
    };
  }
  if (command.type === "backup.runs") {
    return { type: command.type, runs: readBackupRunsInDatabase(db) };
  }
  if (isCronStateReadCommand(command)) {
    return readCronStateCommandInDatabase(db, command);
  }
  if (
    command.type === "devicePairing.list" ||
    command.type === "devicePairing.lookup" ||
    command.type === "devicePairing.pending" ||
    command.type === "devicePairing.bootstrapContext"
  ) {
    return executeDevicePairingRead(db, input.databasePath, command);
  }
  if (isPluginStateReadCommand(command)) {
    return readPluginStateCommand({ db, path: input.databasePath }, command);
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
  if (command.type === "capture.readOnlyEvents") {
    return {
      type: command.type,
      events: readDebugProxyCaptureSessionEvents(db, command.sessionId, command.limit),
    };
  }
  if (command.type === "capture.readOnlyBlob") {
    return { type: command.type, blob: readDebugProxyCaptureBlob(db, command.blobId) };
  }
  if (command.type === "config.snapshot.read") {
    return {
      type: command.type,
      snapshot: readConfigSnapshotAuditRecordInDatabase(db),
    };
  }
  if (command.type === "audit.run.inspect") {
    try {
      return {
        type: command.type,
        result: {
          status: "inspected",
          inspection: runSqliteReadSnapshotSync(db, () =>
            inspectExecutionIdentityRunInDatabase(db, command.input, {
              executionIdentityContexts: tableExists(db, "execution_identity_contexts"),
              auditEvents: tableExists(db, "audit_events"),
              cronRunReceipts: tableExists(db, "cron_run_receipts"),
              executionOwnerLifecycleBindings: tableExists(
                db,
                "execution_owner_lifecycle_bindings",
              ),
            }),
          ),
        } satisfies ExecutionIdentityInspectionOutcome,
      };
    } catch (error) {
      if (!(error instanceof ExecutionDecisionCursorError)) {
        throw error;
      }
      return {
        type: command.type,
        result: {
          status: "invalid-cursor",
          message: error.message,
        } satisfies ExecutionIdentityInspectionOutcome,
      };
    }
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
      run: tableExists(db, "update_runs") ? readUpdateRunRecord(db, command.runId) : undefined,
    };
  }
  if (command.type === "updateRuns.list") {
    return {
      type: command.type,
      runs: readUpdateRuns(db, command.input),
    };
  }
  if (command.type === "updateRuns.reconciliationCandidates") {
    return {
      type: command.type,
      candidates: readUpdateRunReconciliationCandidates(db, command.input),
    };
  }
  if (command.type === "updateRuns.reconciliationCandidate") {
    const run = tableExists(db, "update_runs") ? readUpdateRunRecord(db, command.runId) : undefined;
    return {
      type: command.type,
      candidate: run ? inspectUpdateRunReconciliation(db, run, {}) : undefined,
    };
  }
  if (command.type === "updateRuns.status") {
    return {
      type: command.type,
      status: runSqliteReadSnapshotSync(db, () => readUpdateRunStatusInDatabase(db)),
    };
  }
  if (command.type === "updateRuns.historyStatus") {
    return {
      type: command.type,
      status: runSqliteReadSnapshotSync(db, () => readUpdateRunHistoryStatusInDatabase(db)),
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
  if (command.type === "operatorApprovals.placementGrant") {
    return { type: command.type, rows: readPlacementGrantRows(db, command.input) };
  }
  if (command.type === "operatorApprovals.pendingSnapshot") {
    return {
      type: command.type,
      page: readOperatorApprovalPendingSnapshotInDatabase(command.input, db),
    };
  }
  if (command.type === "operatorApprovals.pending") {
    return {
      type: command.type,
      pending: readPendingOperatorApprovalsInDatabase(command.input, db),
    };
  }
  if (command.type === "operatorApprovals.prepareReplay") {
    return { type: command.type, replay: readOperatorApprovalReplayInDatabase(command.input, db) };
  }
  if (command.type === "operatorApprovals.history") {
    return {
      type: command.type,
      history: listTerminalOperatorApprovalsInDatabase(command.input, db),
    };
  }
  if (command.type === "operatorApprovals.validateCronGrant") {
    return {
      type: command.type,
      result: lookupCronStandingGrantInDatabase(db, command.input, false),
    };
  }
  if (command.type === "operatorApprovals.listCronGrants") {
    return {
      type: command.type,
      grants: listCronStandingGrantsInDatabase(db, command.input),
    };
  }
  if (command.type === "onboardingRecommendations.read") {
    return {
      type: command.type,
      record: readOnboardingRecommendationsInDatabase(db, command.configKey),
    };
  }
  if (isConfigMachineStateReadCommand(command)) {
    return readConfigMachineStateCommandInDatabase(db, command);
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
  if (command.type === "githubPublication.knownPullRequestUrls") {
    return {
      type: command.type,
      urls: readKnownGitHubPublicationPullRequestUrlsInDatabase(db, command.input),
    };
  }
  if (command.type === "githubRepository.knownPullRequestUrls") {
    return {
      type: command.type,
      urls: readKnownRepositoryGitHubPublicationPullRequestUrlsInDatabase(db, command.input),
    };
  }
  if (
    command.type === "userProfiles.catalogIdentity" ||
    command.type === "userProfiles.githubIdentity.cached" ||
    command.type === "userProfiles.githubAttribution.resolve" ||
    command.type === "userProfiles.channelIdentity.list" ||
    command.type === "userProfiles.channelIdentity.resolve" ||
    command.type === "userProfiles.reconcile" ||
    command.type === "userProfiles.catalog" ||
    command.type === "userProfiles.avatar.inspect" ||
    command.type === "userProfiles.avatar.read"
  ) {
    return readUserProfileCommand(db, command);
  }
  if (command.type === "userBackground.snapshot" || command.type === "userBackground.image") {
    return readUserBackgroundCommand(db, command);
  }
  if (command.type === "userPreferences.sessionPins") {
    return { type: command.type, sessionKeys: selectPersonalPinnedSessionKeys(db) };
  }
  if (command.type === "userPreferences.values") {
    return {
      type: command.type,
      values: selectUserPreferenceValues(db, command.profileIds, command.key),
    };
  }
  if (command.type === "userPreferences.read") {
    return {
      type: command.type,
      preferences: runSqliteReadSnapshotSync(db, () => {
        const profile = tableExists(db, "user_profiles")
          ? selectResolvedUserProfileMetadataById(db, command.profileId)
          : undefined;
        return profile
          ? {
              profileId: profile.id,
              entries: tableExists(db, "user_preferences")
                ? readUserPreferences(db, profile.id, command.keys)
                : {},
            }
          : undefined;
      }),
    };
  }
  if (
    command.type === "userModelAccounts.authorization" ||
    command.type === "userModelAccounts.links" ||
    command.type === "userModelAccounts.summary" ||
    command.type === "userModelAccounts.selection" ||
    command.type === "userModelAccounts.catalog"
  ) {
    return readUserModelAccountCommand(db, command);
  }
  if (command.type === "sessionRepositoryWorkspaces.find") {
    if (command.owners.length === 0 || !tableExists(db, "session_repository_workspaces")) {
      return { type: command.type, workspaces: [] };
    }
    return {
      type: command.type,
      workspaces: runSqliteReadSnapshotSync(db, () =>
        command.owners.flatMap((owner) => {
          const workspace = findSessionRepositoryWorkspaceInDatabase(db, owner);
          return workspace ? [workspace] : [];
        }),
      ),
    };
  }
  if (command.type === "sessionRows.sharedFacts") {
    return readSessionRowsSharedFacts(db, command);
  }
  if (command.type === "workerPlacements.changeSnapshot") {
    return {
      type: command.type,
      placements: readWorkerPlacementChangeSnapshotInDatabase(db, command.profileIds),
    };
  }
  if (isWorkspaceJournalReadCommand(command)) {
    return readWorkspaceJournalInDatabase(db, command);
  }
  if (command.type === "workers.placementRecoveryCandidates") {
    return {
      type: command.type,
      candidates: readWorkerPlacementRecoveryCandidatesInDatabase(db),
    };
  }
  if (command.type === "workers.placementPreservation") {
    return {
      type: command.type,
      placements: readWorkerPlacementsForReconcileInDatabase(db),
    };
  }
  if (command.type === "workers.placementEnvironmentOwner") {
    return {
      type: command.type,
      placement: readWorkerPlacementEnvironmentOwnerInDatabase(db, command.environmentId),
    };
  }
  if (command.type === "workers.placementPendingResults") {
    return {
      type: command.type,
      pendingResults: listPendingWorkerWorkspaceResultsInDatabase(db, command.sessionId),
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
  if (isTuiLastSessionReadCommand(command)) {
    return readTuiLastSessionCommand(db, command);
  }
  if (command.type === "preparedPoolPresence.read") {
    return { type: command.type, demand: readPreparedPoolPresenceDemandInDatabase(db) };
  }
  if (command.type === "workerEnvironments.snapshot") {
    return {
      type: command.type,
      facts: runSqliteReadSnapshotSync(db, () => readWorkerEnvironmentFacts(db, command.ids)),
    };
  }
  if (command.type === "agentDeletionJournal.status") {
    return {
      type: command.type,
      status: readAgentDeletionJournalStatusInDatabase(db, command.agentId),
    };
  }
  if (command.type === "agentDeletionJournal.retainedIds") {
    return { type: command.type, agentIds: readRetainedAgentDeletionIds(db) };
  }
  if (command.type === "sandboxRegistry.list") {
    return { type: command.type, entries: readSandboxRegistryInDatabase(db) };
  }
  if (command.type === "sandboxRegistry.get") {
    return {
      type: command.type,
      entry: readSandboxRegistryEntryInDatabase(db, command.containerName),
    };
  }
  if (command.type === "sandboxRegistry.runtimeIds") {
    return {
      type: command.type,
      runtimeIds: readSandboxRuntimeIdsInDatabase(db, command),
    };
  }
  if (command.type === "sandboxRegistry.browsers") {
    return { type: command.type, entries: readSandboxBrowserRegistryInDatabase(db) };
  }
  return {
    type: command.type,
    records: listRegistryWorktreesInDatabase(db),
    leases: readWorktreeRunLeaseStateInDatabase(db),
  };
}
