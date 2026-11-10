import type { ExecutionIdentityInspectionOutcome } from "../audit/execution-identity-inspection.types.js";
import { isChannelIngressReadCommand } from "../channels/message/ingress-queue-read-contract.js";
import {
  isCronStateReadCommand,
  readCronStateCommandInDatabase,
} from "../cron/store/read-command.js";
import { isWorkspaceJournalReadCommand } from "../gateway/worker-environments/placement-workspace-journal.types.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { isUpdateRunAdmissionReadCommand } from "../infra/update-run-admission.types.js";
import { isPluginStateReadCommand } from "../plugin-state/plugin-state-worker-contract.js";
import { isTuiLastSessionReadCommand } from "../tui/tui-last-session.contract.js";
import {
  isConfigMachineStateReadCommand,
  readConfigMachineStateCommandInDatabase,
} from "./config-machine-state.js";
import type { OpenClawStateReadRequest } from "./openclaw-state-read.types.js";
/** Load only the selected query owner before entering its synchronous database read. */
export async function prepareOpenClawStateRead(
  input: OpenClawStateReadRequest,
  command: OpenClawStateReadRequest["command"],
  metadataRead:
    | ReturnType<
        typeof import("../acp/runtime/session-meta-read.worker.js").prepareAcpSessionMetadataRead
      >
    | undefined,
) {
  if (command.type === "templates.inventory") {
    const { readTemplateStateCommandInDatabase } =
      await import("../templates/state-read.kernel.js");
    return (db: EngineConnection) => readTemplateStateCommandInDatabase(db, command);
  }
  if (command.type === "deliveryQueue.outbound") {
    const { assertOpenClawStateWriteAllowed } = await import("./openclaw-state-ownership.js");
    const { readOutboundDeliveriesInDatabase } =
      await import("../infra/outbound/delivery-queue-storage.kernel.js");
    return (db: EngineConnection) => {
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
    };
  }
  if (
    command.type === "acpSessions.resume" ||
    command.type === "acpSessions.list" ||
    command.type === "acpSessions.metadata"
  ) {
    const { readAcpSessionCommand } = await import("../acp/runtime/session-meta-read.worker.js");
    return (db: EngineConnection) =>
      metadataRead ? metadataRead.read(db) : readAcpSessionCommand(db, command);
  }
  if (isChannelIngressReadCommand(command)) {
    const { readChannelIngressInDatabase } =
      await import("../channels/message/ingress-queue-read.worker.js");
    return (db: EngineConnection) => readChannelIngressInDatabase(db, command);
  }
  if (command.type === "subagents.runs") {
    const { readSubagentRunsInWorker } =
      await import("../agents/subagents/registry/subagent-registry.store.worker.js");
    return (db: EngineConnection) => readSubagentRunsInWorker(db, command);
  }
  if (
    command.type === "mcpOAuth.statuses" ||
    command.type === "mcpOAuth.readOnly" ||
    command.type === "mcpOAuth.keys" ||
    command.type === "mcpOAuth.pending" ||
    command.type === "mcpOAuth.countPrincipals"
  ) {
    const { readMcpOAuthStateCommand } = await import("./openclaw-state-read-mcp-oauth.js");
    return (db: EngineConnection) => readMcpOAuthStateCommand(db, command);
  }
  if (command.type === "sessionGroups.snapshot") {
    const { readSessionGroupCatalogSnapshot } =
      await import("../gateway/session-group-catalog.kernel.js");
    return (db: EngineConnection) => ({
      type: command.type,
      snapshot: readSessionGroupCatalogSnapshot(db),
    });
  }
  if (command.type === "sessionGroups.members") {
    const { readSessionGroupMembership } =
      await import("../gateway/session-group-membership.read.js");
    return () => ({
      type: command.type,
      snapshot: readSessionGroupMembership(command.cfg, input.context.environment),
    });
  }
  if (command.type === "conversationBindings.inspect") {
    const { inspectCurrentConversationBindingRecordInDatabase } =
      await import("../infra/outbound/current-conversation-bindings.kernel.js");
    return (db: EngineConnection) => ({
      type: command.type,
      record: inspectCurrentConversationBindingRecordInDatabase(db, command.conversation),
    });
  }
  if (command.type === "backup.runs") {
    const { readBackupRunsInDatabase } = await import("./backup-run-records.kernel.js");
    return (db: EngineConnection) => ({ type: command.type, runs: readBackupRunsInDatabase(db) });
  }
  if (isCronStateReadCommand(command)) {
    return (db: EngineConnection) => readCronStateCommandInDatabase(db, command);
  }
  if (
    command.type === "devicePairing.list" ||
    command.type === "devicePairing.lookup" ||
    command.type === "devicePairing.pending" ||
    command.type === "devicePairing.bootstrapContext"
  ) {
    const { executeDevicePairingRead } = await import("../infra/device-pairing-read.kernel.js");
    return (db: EngineConnection) => executeDevicePairingRead(db, input.databasePath, command);
  }
  if (isPluginStateReadCommand(command)) {
    const { readPluginStateCommand } = await import("../plugin-state/plugin-state.worker.js");
    return (db: EngineConnection) =>
      readPluginStateCommand({ db, path: input.databasePath }, command);
  }
  if (command.type === "pluginBlob.lookup") {
    const { pluginBlobLookupInDatabase } =
      await import("../plugin-state/plugin-blob-store.sqlite.js");
    return (db: EngineConnection) => ({
      type: command.type,
      value: pluginBlobLookupInDatabase(db, {
        ...command.input,
        env: input.context.environment,
        path: input.databasePath,
      }),
    });
  }
  if (command.type === "capture.readOnlyEvents") {
    const { readDebugProxyCaptureSessionEvents } =
      await import("../proxy-capture/store-readonly.js");
    return (db: EngineConnection) => ({
      type: command.type,
      events: readDebugProxyCaptureSessionEvents(db, command.sessionId, command.limit),
    });
  }
  if (command.type === "capture.readOnlyBlob") {
    const { readDebugProxyCaptureBlob } = await import("../proxy-capture/store-readonly.js");
    return (db: EngineConnection) => ({
      type: command.type,
      blob: readDebugProxyCaptureBlob(db, command.blobId),
    });
  }
  if (command.type === "config.snapshot.read") {
    const { readConfigSnapshotAuditRecordInDatabase } =
      await import("../config/config-journal-snapshot.kernel.js");
    return (db: EngineConnection) => ({
      type: command.type,
      snapshot: readConfigSnapshotAuditRecordInDatabase(db),
    });
  }
  if (command.type === "audit.run.inspect") {
    const { runSqliteReadSnapshotSync } = await import("../infra/sqlite-transaction.js");
    const { inspectExecutionIdentityRunInDatabase } =
      await import("../audit/execution-identity-context.js");
    const { tableExists } = await import("./openclaw-state-db-schema-helpers.js");
    const { ExecutionDecisionCursorError } =
      await import("../audit/execution-decision-receipts.js");
    return (db: EngineConnection) => {
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
    };
  }
  if (command.type === "pluginBlob.entries") {
    const { pluginBlobEntriesInDatabase } =
      await import("../plugin-state/plugin-blob-store.sqlite.js");
    return (db: EngineConnection) => ({
      type: command.type,
      value: pluginBlobEntriesInDatabase(db, {
        ...command.input,
        env: input.context.environment,
        path: input.databasePath,
      }),
    });
  }
  if (command.type === "updateRuns.get") {
    const { tableExists } = await import("./openclaw-state-db-schema-helpers.js");
    const { readUpdateRunRecord } = await import("../infra/update-run-read.kernel.js");
    return (db: EngineConnection) => ({
      type: command.type,
      run: tableExists(db, "update_runs") ? readUpdateRunRecord(db, command.runId) : undefined,
    });
  }
  if (command.type === "updateRuns.list") {
    const { readUpdateRuns } = await import("../infra/update-run-read.kernel.js");
    return (db: EngineConnection) => ({
      type: command.type,
      runs: readUpdateRuns(db, command.input),
    });
  }
  if (isUpdateRunAdmissionReadCommand(command)) {
    const { readUpdateRunAdmissionCommand } = await import("../infra/update-run-admission.read.js");
    return (db: EngineConnection) => readUpdateRunAdmissionCommand(db, command);
  }
  if (command.type === "updateRuns.status") {
    const { runSqliteReadSnapshotSync } = await import("../infra/sqlite-transaction.js");
    const { readUpdateRunStatusInDatabase } = await import("../infra/update-run-read.kernel.js");
    return (db: EngineConnection) => ({
      type: command.type,
      status: runSqliteReadSnapshotSync(db, () => readUpdateRunStatusInDatabase(db)),
    });
  }
  if (command.type === "updateRuns.historyStatus") {
    const { runSqliteReadSnapshotSync } = await import("../infra/sqlite-transaction.js");
    const { readUpdateRunHistoryStatusInDatabase } =
      await import("../infra/update-run-read.kernel.js");
    return (db: EngineConnection) => ({
      type: command.type,
      status: runSqliteReadSnapshotSync(db, () => readUpdateRunHistoryStatusInDatabase(db)),
    });
  }
  if (command.type === "updateRuns.interruptedCandidate") {
    const { readInterruptedUpdateCandidate } = await import("../infra/update-run-read.kernel.js");
    return (db: EngineConnection) => ({
      type: command.type,
      run: readInterruptedUpdateCandidate(db),
    });
  }
  if (command.type === "updateRuns.pluginCohortRecoveries") {
    const { runSqliteReadSnapshotSync } = await import("../infra/sqlite-transaction.js");
    const { inspectPluginCohortRecoveryRows } =
      await import("../infra/update-run-recovery-store.js");
    return (db: EngineConnection) => ({
      type: command.type,
      pairs: runSqliteReadSnapshotSync(db, () => inspectPluginCohortRecoveryRows(db)),
    });
  }
  if (command.type === "updateRuns.pluginSnapshotCollection") {
    const { runSqliteReadSnapshotSync } = await import("../infra/sqlite-transaction.js");
    const { canCollectPluginSourceSnapshotsInDatabase } =
      await import("../infra/update-run-recovery-store.js");
    return (db: EngineConnection) => ({
      type: command.type,
      allowed: runSqliteReadSnapshotSync(db, () => canCollectPluginSourceSnapshotsInDatabase(db)),
    });
  }
  if (command.type === "exec-approvals.read") {
    const { readExecApprovalsConfigRow } = await import("../infra/exec-approvals-sqlite.js");
    return (db: EngineConnection) => ({
      type: command.type,
      row: readExecApprovalsConfigRow(db),
    });
  }
  if (command.type === "skills.library.descriptions") {
    const { tableExists } = await import("./openclaw-state-db-schema-helpers.js");
    const { selectSkillLibraryRevisionMetadataBatch } =
      await import("../skills/library/selection-read.kernel.js");
    return (db: EngineConnection) => ({
      type: command.type,
      value: tableExists(db, "skill_library_entries")
        ? selectSkillLibraryRevisionMetadataBatch(db, command.input)
        : undefined,
    });
  }
  if (command.type === "skills.library.manifests") {
    const { tableExists } = await import("./openclaw-state-db-schema-helpers.js");
    const { selectSkillLibraryRevisionManifestsBatch } =
      await import("../skills/library/selection-read.kernel.js");
    return (db: EngineConnection) => ({
      type: command.type,
      value: tableExists(db, "skill_library_entries")
        ? selectSkillLibraryRevisionManifestsBatch(db, command.input)
        : undefined,
    });
  }
  if (command.type === "operatorApprovals.placementGrant") {
    const { readPlacementGrantRows } =
      await import("../gateway/operator-approval-placement-grants.read.worker.js");
    return (db: EngineConnection) => ({
      type: command.type,
      rows: readPlacementGrantRows(db, command.input),
    });
  }
  if (command.type === "operatorApprovals.pendingSnapshot") {
    const { readOperatorApprovalPendingSnapshotInDatabase } =
      await import("../gateway/operator-approval-store.kernel.worker.js");
    return (db: EngineConnection) => ({
      type: command.type,
      page: readOperatorApprovalPendingSnapshotInDatabase(command.input, db),
    });
  }
  if (command.type === "operatorApprovals.pending") {
    const { readPendingOperatorApprovalsInDatabase } =
      await import("../gateway/operator-approval-store.kernel.worker.js");
    return (db: EngineConnection) => ({
      type: command.type,
      pending: readPendingOperatorApprovalsInDatabase(command.input, db),
    });
  }
  if (command.type === "operatorApprovals.prepareReplay") {
    const { readOperatorApprovalReplayInDatabase } =
      await import("../gateway/operator-approval-store.kernel.worker.js");
    return (db: EngineConnection) => ({
      type: command.type,
      replay: readOperatorApprovalReplayInDatabase(command.input, db),
    });
  }
  if (command.type === "operatorApprovals.history") {
    const { listTerminalOperatorApprovalsInDatabase } =
      await import("../gateway/operator-approval-store.kernel.worker.js");
    return (db: EngineConnection) => ({
      type: command.type,
      history: listTerminalOperatorApprovalsInDatabase(command.input, db),
    });
  }
  if (command.type === "operatorApprovals.validateCronGrant") {
    const { lookupCronStandingGrantInDatabase } =
      await import("../gateway/operator-approval-standing-grants.worker.js");
    return (db: EngineConnection) => ({
      type: command.type,
      result: lookupCronStandingGrantInDatabase(db, command.input, false),
    });
  }
  if (command.type === "operatorApprovals.listCronGrants") {
    const { listCronStandingGrantsInDatabase } =
      await import("../gateway/operator-approval-standing-grants.worker.js");
    return (db: EngineConnection) => ({
      type: command.type,
      grants: listCronStandingGrantsInDatabase(db, command.input),
    });
  }
  if (command.type === "onboardingRecommendations.read") {
    const { readOnboardingRecommendationsInDatabase } =
      await import("./onboarding-recommendations.kernel.js");
    return (db: EngineConnection) => ({
      type: command.type,
      record: readOnboardingRecommendationsInDatabase(db, command.configKey),
    });
  }
  if (isConfigMachineStateReadCommand(command)) {
    return (db: EngineConnection) => readConfigMachineStateCommandInDatabase(db, command);
  }
  if (command.type === "workspace.snapshot") {
    const { readWorkspaceStateSnapshotForDirectoryInDatabase } =
      await import("../agents/workspace-state-store.kernel.js");
    return (db: EngineConnection) => ({
      type: command.type,
      snapshot: readWorkspaceStateSnapshotForDirectoryInDatabase({
        workspaceDir: command.workspaceDir,
        database: { db, path: input.databasePath },
      }),
    });
  }
  if (command.type === "githubPublication.lifecycle") {
    const { readGitHubPublicationSessionLifecycle } =
      await import("./github-publication-session-lifecycles.worker.js");
    return (db: EngineConnection) => ({
      type: command.type,
      lifecycle: readGitHubPublicationSessionLifecycle(command, db),
    });
  }
  if (command.type === "githubPublication.request") {
    const { readGitHubPublicationRequest } =
      await import("../gateway/github-publication-store.worker.js");
    return (db: EngineConnection) => ({
      type: command.type,
      row: readGitHubPublicationRequest(db, { requestId: command.requestId }),
    });
  }
  if (command.type === "githubPublication.knownPullRequestUrls") {
    const { readKnownGitHubPublicationPullRequestUrlsInDatabase } =
      await import("../gateway/github-publication-store.worker.js");
    return (db: EngineConnection) => ({
      type: command.type,
      urls: readKnownGitHubPublicationPullRequestUrlsInDatabase(db, command.input),
    });
  }
  if (command.type === "githubRepository.knownPullRequestUrls") {
    const { readKnownRepositoryGitHubPublicationPullRequestUrlsInDatabase } =
      await import("../gateway/github-repository-publication-store.worker.js");
    return (db: EngineConnection) => ({
      type: command.type,
      urls: readKnownRepositoryGitHubPublicationPullRequestUrlsInDatabase(db, command.input),
    });
  }
  if (
    command.type === "userProfiles.catalogIdentity" ||
    command.type === "userProfiles.identity" ||
    command.type === "userProfiles.githubIdentity.cached" ||
    command.type === "userProfiles.githubAttribution.resolve" ||
    command.type === "userProfiles.channelIdentity.list" ||
    command.type === "userProfiles.channelIdentity.resolve" ||
    command.type === "userProfiles.tailscaleIdentity.resolve" ||
    command.type === "userProfiles.reconcile" ||
    command.type === "userProfiles.catalog" ||
    command.type === "userProfiles.avatar.inspect" ||
    command.type === "userProfiles.avatar.read"
  ) {
    const { readUserProfileCommand } = await import("./user-profile-read.worker.js");
    return (db: EngineConnection) => readUserProfileCommand(db, command);
  }
  if (command.type === "userBackground.snapshot" || command.type === "userBackground.image") {
    const { readUserBackgroundCommand } = await import("./user-background.kernel.js");
    return (db: EngineConnection) => readUserBackgroundCommand(db, command);
  }
  if (command.type === "userPreferences.sessionPins") {
    const { selectPersonalPinnedSessionKeys } = await import("./user-preferences.store.js");
    return (db: EngineConnection) => ({
      type: command.type,
      sessionKeys: selectPersonalPinnedSessionKeys(db),
    });
  }
  if (command.type === "userPreferences.values") {
    const { selectUserPreferenceValues } = await import("./user-preferences.store.js");
    return (db: EngineConnection) => ({
      type: command.type,
      values: selectUserPreferenceValues(db, command.profileIds, command.key),
    });
  }
  if (command.type === "userPreferences.read") {
    const { runSqliteReadSnapshotSync } = await import("../infra/sqlite-transaction.js");
    const { tableExists } = await import("./openclaw-state-db-schema-helpers.js");
    const { selectResolvedUserProfileMetadataById } = await import("./user-profiles-internal.js");
    const { readUserPreferences } = await import("./user-preferences.store.js");
    return (db: EngineConnection) => ({
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
    });
  }
  if (
    command.type === "userModelAccounts.authorization" ||
    command.type === "userModelAccounts.links" ||
    command.type === "userModelAccounts.summary" ||
    command.type === "userModelAccounts.selection" ||
    command.type === "userModelAccounts.catalog"
  ) {
    const { readUserModelAccountCommand } = await import("./user-model-accounts.read.worker.js");
    return (db: EngineConnection) => readUserModelAccountCommand(db, command);
  }
  if (command.type === "sessionRepositoryWorkspaces.find") {
    const { tableExists } = await import("./openclaw-state-db-schema-helpers.js");
    const { runSqliteReadSnapshotSync } = await import("../infra/sqlite-transaction.js");
    const { findSessionRepositoryWorkspaceInDatabase } =
      await import("./session-repository-workspaces.kernel.js");
    return (db: EngineConnection) => {
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
    };
  }
  if (command.type === "sessionRows.sharedFacts") {
    const { readSessionRowsSharedFacts } =
      await import("./openclaw-state-read-session-rows.worker.js");
    return (db: EngineConnection) => readSessionRowsSharedFacts(db, command);
  }
  if (command.type === "workerPlacements.changeSnapshot") {
    const { readWorkerPlacementChangeSnapshotInDatabase } =
      await import("../gateway/worker-environments/placement-row-codec.js");
    return (db: EngineConnection) => ({
      type: command.type,
      placements: readWorkerPlacementChangeSnapshotInDatabase(db, command.profileIds),
    });
  }
  if (isWorkspaceJournalReadCommand(command)) {
    const { readWorkspaceJournalInDatabase } =
      await import("../gateway/worker-environments/placement-workspace-journal.js");
    return (db: EngineConnection) => readWorkspaceJournalInDatabase(db, command);
  }
  if (command.type === "workers.placementPreservation") {
    const { readWorkerPlacementsForReconcileInDatabase } =
      await import("../gateway/worker-environments/placement-row-codec.js");
    return (db: EngineConnection) => ({
      type: command.type,
      placements: readWorkerPlacementsForReconcileInDatabase(db),
    });
  }
  if (command.type === "workers.placementEnvironmentOwner") {
    const { readWorkerPlacementEnvironmentOwnerInDatabase } =
      await import("../gateway/worker-environments/placement-read-projection.js");
    return (db: EngineConnection) => ({
      type: command.type,
      placement: readWorkerPlacementEnvironmentOwnerInDatabase(db, command.environmentId),
    });
  }
  if (command.type === "workers.placementPendingResults") {
    const { listPendingWorkerWorkspaceResultsInDatabase } =
      await import("../gateway/worker-environments/placement-workspace-result.js");
    return (db: EngineConnection) => ({
      type: command.type,
      pendingResults: listPendingWorkerWorkspaceResultsInDatabase(db, command.sessionId),
    });
  }
  if (command.type === "workers.placementProjection") {
    const { readWorkerSessionPlacementProjectionInDatabase } =
      await import("../gateway/worker-environments/placement-read-projection.js");
    return (db: EngineConnection) => ({
      type: command.type,
      result: readWorkerSessionPlacementProjectionInDatabase(
        db,
        command.sessionIds,
        command.conflictBindings,
      ),
    });
  }
  if (isTuiLastSessionReadCommand(command)) {
    const { readTuiLastSessionCommand } = await import("../tui/tui-last-session.kernel.js");
    return (db: EngineConnection) => readTuiLastSessionCommand(db, command);
  }
  if (command.type === "agentDeletionJournal.status") {
    const { readAgentDeletionJournalStatusInDatabase } =
      await import("./agent-deletion-journal.read.js");
    return (db: EngineConnection) => ({
      type: command.type,
      status: readAgentDeletionJournalStatusInDatabase(db, command.agentId),
    });
  }
  if (command.type === "agentDeletionJournal.retainedIds") {
    const { readRetainedAgentDeletionIds } =
      await import("./agent-deletion-journal.snapshot.worker.js");
    return (db: EngineConnection) => ({
      type: command.type,
      agentIds: readRetainedAgentDeletionIds(db),
    });
  }
  if (command.type === "worktrees.cleanupState") {
    const { listRegistryWorktreesInDatabase } =
      await import("../agents/worktrees/registry-read.kernel.js");
    const { readWorktreeRunLeaseStateInDatabase } =
      await import("../agents/worktrees/run-lease-owner.js");
    return (db: EngineConnection) => ({
      type: command.type,
      records: listRegistryWorktreesInDatabase(db),
      leases: readWorktreeRunLeaseStateInDatabase(db),
    });
  }
  throw new Error("Unsupported shared-state read command: " + command.type);
}
