import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { SKILL_LIBRARY_MAX_SELECTIONS } from "../../packages/gateway-protocol/src/schema/skill-library.js";
import {
  readSandboxBrowserRegistryInDatabase,
  readSandboxRegistryEntryInDatabase,
  readSandboxRegistryInDatabase,
  readSandboxRuntimeIdsInDatabase,
} from "../agents/sandbox/registry.kernel.js";
import { readWorkspaceStateSnapshotForDirectoryInDatabase } from "../agents/workspace-state-store.kernel.js";
import { ExecutionDecisionCursorError } from "../audit/execution-decision-receipts.js";
import { inspectExecutionIdentityRunInDatabase } from "../audit/execution-identity-context.js";
import { observeCronRunRecoveryInDatabase } from "../cron/store/run-recovery.read.js";
import { getFleetCellInDatabase, listFleetCellsInDatabase } from "../fleet/registry.kernel.js";
import { listTerminalOperatorApprovalsInDatabase } from "../gateway/operator-approval-store.kernel.js";
import { readWorkerSessionPlacementProjectionInDatabase } from "../gateway/worker-environments/placement-read-projection.js";
import { readWorkerPlacementChangeSnapshotInDatabase } from "../gateway/worker-environments/placement-row-codec.js";
import { hasWorkerEnvironmentSessionAttachment } from "../gateway/worker-environments/session-attachment-store.js";
import { executeDevicePairingRead } from "../infra/device-pairing-read.kernel.js";
import { readExecApprovalsConfigRow } from "../infra/exec-approvals-sqlite.js";
import { inspectCurrentConversationBindingRecordInDatabase } from "../infra/outbound/current-conversation-bindings.kernel.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import { runWithSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import { withStateDatabaseCoordinatorRuntimeDirectory } from "../infra/state-database-coordinator.js";
import { readUpdateRunRecord, readUpdateRuns } from "../infra/update-run-read.kernel.js";
import { serveOwnedWorkerTasks } from "../infra/worker-task-server.js";
import {
  pluginBlobLookupInDatabase,
  pluginBlobEntriesInDatabase,
} from "../plugin-state/plugin-blob-store.sqlite.js";
import { isPluginBlobReadCommand } from "../plugin-state/plugin-blob-worker-contract.js";
import {
  selectSkillLibraryRevisionMetadataBatch,
  selectSkillLibraryRevisionManifestsBatch,
} from "../skills/library/selection-read.kernel.js";
import { readConfigMachineStateRowInDatabase } from "./config-machine-state.js";
import { readOnboardingRecommendationsInDatabase } from "./onboarding-recommendations.kernel.js";
import { readRegisteredAgentDatabaseRows } from "./openclaw-agent-db-registry.read.js";
import { openClawStateDatabaseCache } from "./openclaw-state-db-cache.js";
import {
  closeRetainedOpenClawStateReadConnections,
  readOpenClawStateReadOnlyLocation,
  withOpenClawStateReadOnlyLocation,
} from "./openclaw-state-db-read-connection.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import type {
  OpenClawStateReadReply,
  OpenClawStateReadRequest,
} from "./openclaw-state-read.types.js";
import { encodeOpenClawStateWorkerError } from "./openclaw-state-worker-error.js";
import { readUserProfileIdForEmail } from "./user-profile-identity.read.js";
import { selectProfileDisplayEntries } from "./user-profiles-internal.js";

function isReadRequest(input: unknown): input is OpenClawStateReadRequest {
  if (!isRecord(input) || !isRecord(input.context) || !isRecord(input.command)) {
    return false;
  }
  const { environment, coordinatorRuntime } = input.context;
  return (
    typeof input.databasePath === "string" &&
    typeof input.location === "string" &&
    typeof input.checkFreshAdmission === "boolean" &&
    (input.expectedIdentity === undefined || typeof input.expectedIdentity === "string") &&
    (input.snapshotRoot === undefined || typeof input.snapshotRoot === "string") &&
    (input.context.existingSchemaPath === undefined ||
      typeof input.context.existingSchemaPath === "string") &&
    isRecord(environment) &&
    typeof environment.OPENCLAW_STATE_DIR === "string" &&
    (environment.OPENCLAW_SUPERVISOR_MODE === undefined ||
      environment.OPENCLAW_SUPERVISOR_MODE === "external") &&
    isRecord(coordinatorRuntime) &&
    typeof coordinatorRuntime.directory === "string" &&
    typeof coordinatorRuntime.keepAlive === "boolean" &&
    (isPluginBlobReadCommand(input.command) ||
      (input.command.type === "conversationBindings.inspect" &&
        isRecord(input.command.conversation) &&
        typeof input.command.conversation.channel === "string" &&
        typeof input.command.conversation.accountId === "string" &&
        typeof input.command.conversation.conversationId === "string" &&
        (input.command.conversation.parentConversationId === undefined ||
          typeof input.command.conversation.parentConversationId === "string")) ||
      (input.command.type === "cron.observeRunRecovery" &&
        typeof input.command.storeKey === "string" &&
        Array.isArray(input.command.proposals) &&
        input.command.proposals.every(
          (proposal: unknown) =>
            isRecord(proposal) &&
            typeof proposal.jobId === "string" &&
            (proposal.queuedAtMs === undefined || typeof proposal.queuedAtMs === "number") &&
            (proposal.runningAtMs === undefined || typeof proposal.runningAtMs === "number"),
        )) ||
      (input.command.type === "devicePairing.list" && typeof input.command.nowMs === "number") ||
      (input.command.type === "devicePairing.lookup" &&
        typeof input.command.deviceId === "string") ||
      (input.command.type === "devicePairing.pending" &&
        typeof input.command.requestId === "string" &&
        typeof input.command.nowMs === "number") ||
      (input.command.type === "devicePairing.bootstrapContext" &&
        isRecord(input.command.input) &&
        typeof input.command.input.token === "string" &&
        typeof input.command.input.deviceId === "string" &&
        typeof input.command.input.publicKey === "string" &&
        typeof input.command.input.nowMs === "number") ||
      input.command.type === "admit" ||
      input.command.type === "exec-approvals.read" ||
      ((input.command.type === "skills.library.descriptions" ||
        input.command.type === "skills.library.manifests") &&
        Array.isArray(input.command.input) &&
        input.command.input.length <= SKILL_LIBRARY_MAX_SELECTIONS &&
        input.command.input.every(
          (pin) =>
            isRecord(pin) && typeof pin.skillId === "string" && typeof pin.revision === "string",
        )) ||
      input.command.type === "agentDatabaseRegistry.read" ||
      (input.command.type === "userProfiles.reconcile" &&
        typeof input.command.profileId === "string") ||
      (input.command.type === "userProfiles.email.resolve" &&
        typeof input.command.email === "string") ||
      (input.command.type === "audit.run.inspect" &&
        isRecord(input.command.input) &&
        typeof input.command.input.now === "number" &&
        (typeof input.command.input.runId === "string" ||
          typeof input.command.input.executionId === "string")) ||
      (input.command.type === "workspace.snapshot" &&
        typeof input.command.workspaceDir === "string") ||
      (input.command.type === "workerEnvironments.hasSessionAttachment" &&
        typeof input.command.environmentId === "string") ||
      (input.command.type === "updateRuns.get" && typeof input.command.runId === "string") ||
      (input.command.type === "updateRuns.list" &&
        isRecord(input.command.input) &&
        (input.command.input.limit === undefined ||
          typeof input.command.input.limit === "number") &&
        (input.command.input.active === undefined ||
          typeof input.command.input.active === "boolean") &&
        (input.command.input.reason === undefined ||
          typeof input.command.input.reason === "string") &&
        (input.command.input.includeRunId === undefined ||
          typeof input.command.input.includeRunId === "string")) ||
      input.command.type === "fleet.list" ||
      (input.command.type === "operatorApprovals.history" && isRecord(input.command.input)) ||
      input.command.type === "nodeHost.config" ||
      (input.command.type === "onboardingRecommendations.read" &&
        typeof input.command.configKey === "string") ||
      input.command.type === "sandboxRegistry.list" ||
      input.command.type === "sandboxRegistry.browsers" ||
      (input.command.type === "sandboxRegistry.get" &&
        typeof input.command.containerName === "string") ||
      (input.command.type === "sandboxRegistry.runtimeIds" &&
        typeof input.command.backendId === "string" &&
        typeof input.command.scopeKey === "string") ||
      (input.command.type === "fleet.get" && typeof input.command.tenantId === "string") ||
      input.command.type === "workerPlacements.changeSnapshot" ||
      (input.command.type === "workers.placementProjection" &&
        Array.isArray(input.command.sessionIds) &&
        input.command.sessionIds.every((id) => typeof id === "string") &&
        Array.isArray(input.command.conflictBindings)))
  );
}

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
            return withOpenClawStateReadOnlyLocation(
              ({ db }) => {
                sourceAdmitted = true;
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
                if (command.type === "exec-approvals.read") {
                  return {
                    ok: true,
                    type: command.type,
                    sourceAdmitted,
                    row: readExecApprovalsConfigRow(db),
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
                if (command.type === "audit.run.inspect") {
                  try {
                    return {
                      ok: true,
                      type: command.type,
                      sourceAdmitted,
                      result: {
                        status: "inspected",
                        inspection: inspectExecutionIdentityRunInDatabase(db, command.input),
                      },
                    };
                  } catch (error) {
                    if (!(error instanceof ExecutionDecisionCursorError)) {
                      throw error;
                    }
                    return {
                      ok: true,
                      type: command.type,
                      sourceAdmitted,
                      result: { status: "invalid-cursor", message: error.message },
                    };
                  }
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
                if (command.type === "workerEnvironments.hasSessionAttachment") {
                  return {
                    ok: true,
                    type: command.type,
                    sourceAdmitted,
                    attached: hasWorkerEnvironmentSessionAttachment(db, command.environmentId),
                  };
                }
                if (command.type === "userProfiles.reconcile") {
                  return {
                    ok: true,
                    type: command.type,
                    sourceAdmitted,
                    profile: runSqliteDeferredTransactionSync(
                      db,
                      () => selectProfileDisplayEntries(db, [command.profileId])[0]?.[1],
                    ),
                  };
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
                    placements: readWorkerPlacementChangeSnapshotInDatabase(db),
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
                return command.type === "fleet.list"
                  ? {
                      ok: true,
                      type: "fleet.list",
                      sourceAdmitted,
                      cells: listFleetCellsInDatabase(db),
                    }
                  : {
                      ok: true,
                      type: "fleet.get",
                      sourceAdmitted,
                      cell: getFleetCellInDatabase(db, command.tenantId),
                    };
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
