import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import {
  prepareAcpSessionMetadataRead,
  readAcpSessionCommand,
} from "../acp/runtime/session-meta-read.worker.js";
import {
  loadSubagentRunsForChildSessionFromSqlite,
  loadSubagentSessionListRunsFromSqlite,
} from "../agents/subagents/registry/subagent-registry.store.sqlite.js";
import { readSubagentRunsInWorker } from "../agents/subagents/registry/subagent-registry.store.worker.js";
import { readWorkspaceStateSnapshotForDirectoryInDatabase } from "../agents/workspace-state-store.kernel.js";
import { isChannelIngressReadCommand } from "../channels/message/ingress-queue-read-contract.js";
import { readChannelIngressInDatabase } from "../channels/message/ingress-queue-read.worker.js";
import {
  readClawInstallRecordFromDatabase,
  readClawInstallRecordsInDatabase,
  readClawOrphanWorkspaceInDatabase,
  readClawPackageRefsInDatabase,
} from "../claws/provenance-read.kernel.js";
import {
  isCronStateReadCommand,
  readCronStateCommandInDatabase,
} from "../cron/store/read-command.js";
import {
  readSharedGitHubPublicationRequestInDatabase,
  readSharedRepositoryGitHubPublicationInDatabase,
} from "../gateway/github-publication-shared-read.kernel.js";
import {
  readGitHubPublicationRequest,
  readKnownGitHubPublicationPullRequestUrlsInDatabase,
} from "../gateway/github-publication-store.js";
import {
  readKnownRepositoryGitHubPublicationPullRequestUrlsInDatabase,
  readRepositoryGitHubPublicationInDatabase,
} from "../gateway/github-repository-publication-store.js";
import { readPlacementGrantRows } from "../gateway/operator-approval-placement-grants.read.js";
import {
  listCronStandingGrantsInDatabase,
  lookupCronStandingGrantInDatabase,
} from "../gateway/operator-approval-standing-grants.js";
import { listTerminalOperatorApprovalsInDatabase } from "../gateway/operator-approval-store.kernel.js";
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
import { getSqliteRuntimeCapabilities } from "../infra/bun-sqlite-library.js";
import { executeDevicePairingRead } from "../infra/device-pairing-read.kernel.js";
import { readExecApprovalsConfigRow } from "../infra/exec-approvals-sqlite.js";
import { inspectGatewayOwnerLeaseForMaintenance } from "../infra/gateway-owner-lease.worker.js";
import { bunSqliteNativeCleanupPending } from "../infra/node-sqlite.js";
import { inspectCurrentConversationBindingRecordInDatabase } from "../infra/outbound/current-conversation-bindings.kernel.js";
import { readOutboundDeliveriesInDatabase } from "../infra/outbound/delivery-queue-storage.kernel.js";
import { withSqliteReaderOwner } from "../infra/sqlite-reader-lifecycle.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import { runWithSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
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
import { serveOwnedWorkerTasks } from "../infra/worker-task-server.js";
import {
  pluginBlobLookupInDatabase,
  pluginBlobEntriesInDatabase,
} from "../plugin-state/plugin-blob-store.sqlite.js";
import {
  selectSkillLibraryRevisionMetadataBatch,
  selectSkillLibraryRevisionManifestsBatch,
} from "../skills/library/selection-read.kernel.js";
import { isTuiLastSessionReadCommand } from "../tui/tui-last-session.contract.js";
import { readTuiLastSessionCommand } from "../tui/tui-last-session.kernel.js";
import { readAgentDatabaseDeletionWorkerSnapshot } from "./agent-deletion-journal.snapshot.worker.js";
import { readBackupRunsInDatabase } from "./backup-run-records.kernel.js";
import {
  isConfigMachineStateReadCommand,
  readConfigMachineStateCommandInDatabase,
} from "./config-machine-state.js";
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
import {
  isStateDiagnosticCommand,
  readStateDiagnosticCommand,
} from "./openclaw-state-read-diagnostics.js";
import { readMcpOAuthStateCommand } from "./openclaw-state-read-mcp-oauth.js";
import { stateReadRegistry } from "./openclaw-state-read-operation-registry.js";
import { readStateRegistryCommand } from "./openclaw-state-read-registry.js";
import { readSessionRowsSharedFacts } from "./openclaw-state-read-session-rows.worker.js";
import { readStateStream } from "./openclaw-state-read-stream.js";
import type {
  OpenClawStateReadReply,
  OpenClawStateReadResult,
} from "./openclaw-state-read.types.js";
import { isReadRequest } from "./openclaw-state-read.validation.js";
import { encodeOpenClawStateWorkerError } from "./openclaw-state-worker-error.js";
import { findSessionRepositoryWorkspaceInDatabase } from "./session-repository-workspaces.kernel.js";
import { readUserBackgroundCommand } from "./user-background.kernel.js";
import { readUserModelAccountCommand } from "./user-model-accounts.read.worker.js";
import { selectUserPreferenceValues } from "./user-preferences.store.js";
import { readUserProfileCommand } from "./user-profile-read.worker.js";

serveOwnedWorkerTasks(
  async function read(input, channel, control): Promise<OpenClawStateReadReply> {
    let sourceAdmitted: true | undefined;
    let nativeCleanupFailure: OpenClawStateReadReply["nativeCleanupFailure"];
    try {
      if (!isReadRequest(input)) {
        throw new Error("Shared-state reader requires a captured state location and read command");
      }
      const prepared = stateReadRegistry.prepare(input.command.type);
      if (prepared) {
        return prepared.then(() => read(input, channel, control));
      }
      const executeRead = async (): Promise<OpenClawStateReadReply> => {
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
        if (command.type === "subagents.restore" || command.type === "meetingTranscripts.export") {
          return await control.runNativeSection(() =>
            readStateStream(input, command, channel, () => {
              sourceAdmitted = true;
            }),
          );
        }
        if (command.type === "doctor.gatewayOwnerLease.read") {
          const lease = inspectGatewayOwnerLeaseForMaintenance(input, () => {
            sourceAdmitted = true;
          });
          return { ok: true, type: command.type, sourceAdmitted: true, lease };
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
        const metadataRead =
          command.type === "acpSessions.metadata"
            ? prepareAcpSessionMetadataRead(command)
            : undefined;
        const result = withOpenClawStateReadOnlyLocation(
          ({ db }): OpenClawStateReadResult => {
            sourceAdmitted = true;
            if (command.type === "claws.packageOwnership") {
              const install =
                command.agentId === undefined
                  ? undefined
                  : readClawInstallRecordFromDatabase(db, command.agentId);
              return {
                type: command.type,
                install,
                installs: command.includeInstalls ? readClawInstallRecordsInDatabase(db) : [],
                packageRefs: readClawPackageRefsInDatabase(db, { agentId: command.agentId }),
                orphanWorkspace:
                  command.agentId !== undefined && !install
                    ? readClawOrphanWorkspaceInDatabase(db, command.agentId)
                    : undefined,
              };
            }
            if (command.type === "agentDatabaseDeletion.snapshot") {
              return {
                type: command.type,
                snapshot: readAgentDatabaseDeletionWorkerSnapshot(
                  db,
                  input.databasePath,
                  command.purpose,
                ),
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
            if ("input" in command && stateReadRegistry.has(command)) {
              return stateReadRegistry.execute(command, db);
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
            if (isStateDiagnosticCommand(command)) {
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
            if (command.type === "updateRuns.reconciliationCandidates") {
              return {
                type: command.type,
                candidates: readUpdateRunReconciliationCandidates(db, command.input),
              };
            }
            if (command.type === "updateRuns.reconciliationCandidate") {
              const run = tableExists(db, "update_runs")
                ? readUpdateRunRecord(db, command.runId)
                : undefined;
              return {
                type: command.type,
                candidate: run ? inspectUpdateRunReconciliation(db, run, {}) : undefined,
              };
            }
            if (command.type === "updateRuns.status") {
              return {
                type: command.type,
                status: runSqliteDeferredTransactionSync(db, () =>
                  readUpdateRunStatusInDatabase(db),
                ),
              };
            }
            if (command.type === "updateRuns.historyStatus") {
              return {
                type: command.type,
                status: runSqliteDeferredTransactionSync(db, () =>
                  readUpdateRunHistoryStatusInDatabase(db),
                ),
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
            if (command.type === "githubPublication.sharedObservation") {
              const { kind, session, selector, entry } = command.input;
              return {
                type: command.type,
                row:
                  kind === "repository"
                    ? readSharedRepositoryGitHubPublicationInDatabase(db, session, selector, entry)
                    : readSharedGitHubPublicationRequestInDatabase(db, session, selector, entry),
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
            if (
              command.type === "userProfiles.authority.resolve" ||
              command.type === "userProfiles.aliases.resolve" ||
              command.type === "userProfiles.catalogIdentity" ||
              command.type === "userProfiles.githubIdentity.cached" ||
              command.type === "userProfiles.githubAttribution.resolve" ||
              command.type === "userProfiles.channelIdentity.list" ||
              command.type === "userProfiles.channelIdentity.resolve" ||
              command.type === "userProfiles.reconcile" ||
              command.type === "userProfiles.catalog" ||
              command.type === "userProfiles.avatar.inspect" ||
              command.type === "userProfiles.avatar.read" ||
              command.type === "userProfiles.email.resolve"
            ) {
              return readUserProfileCommand(db, command);
            }
            if (
              command.type === "userBackground.snapshot" ||
              command.type === "userBackground.image"
            ) {
              return readUserBackgroundCommand(db, command);
            }
            if (command.type === "userPreferences.values") {
              return {
                type: command.type,
                values: selectUserPreferenceValues(db, command.profileIds, command.key),
              };
            }
            if (
              command.type === "userModelAccounts.links" ||
              command.type === "userModelAccounts.summary" ||
              command.type === "userModelAccounts.selection" ||
              command.type === "userModelAccounts.catalog"
            ) {
              return readUserModelAccountCommand(db, command);
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
            return isTuiLastSessionReadCommand(command)
              ? readTuiLastSessionCommand(db, command)
              : readStateRegistryCommand(db, command);
          },
          ...locationArgs,
          metadataRead?.readContentVersionRow,
        );
        return { ok: true, sourceAdmitted: true, ...result };
      };
      const reply = await withSqliteReaderOwner(
        { operation: input.command.type, ownerKind: "worker" },
        () => runWithSqliteWorkerStateContext(input.context, executeRead),
      );
      if (
        !getSqliteRuntimeCapabilities().explicitSqliteCloseReleasesNativeResources &&
        bunSqliteNativeCleanupPending
      ) {
        nativeCleanupFailure ??= { error: undefined };
      }
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
