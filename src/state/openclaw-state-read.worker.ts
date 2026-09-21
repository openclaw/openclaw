import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  readSandboxBrowserRegistryInDatabase,
  readSandboxRegistryEntryInDatabase,
  readSandboxRegistryInDatabase,
  readSandboxRuntimeIdsInDatabase,
} from "../agents/sandbox/registry.kernel.js";
import { readWorkspaceStateSnapshotForDirectoryInDatabase } from "../agents/workspace-state-store.kernel.js";
import { ExecutionDecisionCursorError } from "../audit/execution-decision-receipts.js";
import { inspectExecutionIdentityRunInDatabase } from "../audit/execution-identity-context.js";
import { getFleetCellInDatabase, listFleetCellsInDatabase } from "../fleet/registry.kernel.js";
import { readExecApprovalsConfigRow } from "../infra/exec-approvals-sqlite.js";
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
      input.command.type === "admit" ||
      input.command.type === "exec-approvals.read" ||
      input.command.type === "agentDatabaseRegistry.read" ||
      (input.command.type === "userProfiles.avatar.reconcile" &&
        typeof input.command.profileId === "string") ||
      (input.command.type === "audit.run.inspect" &&
        isRecord(input.command.input) &&
        typeof input.command.input.now === "number" &&
        (typeof input.command.input.runId === "string" ||
          typeof input.command.input.executionId === "string")) ||
      (input.command.type === "workspace.snapshot" &&
        typeof input.command.workspaceDir === "string") ||
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
      (input.command.type === "fleet.get" && typeof input.command.tenantId === "string"))
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
                if (command.type === "userProfiles.avatar.reconcile") {
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
