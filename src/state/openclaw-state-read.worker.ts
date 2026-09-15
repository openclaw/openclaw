import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { SKILL_LIBRARY_MAX_SELECTIONS } from "../../packages/gateway-protocol/src/schema/skill-library.js";
import {
  countMcpOAuthPrincipalsInDatabase,
  listMcpOAuthStoreKeysInDatabase,
  readMcpOAuthPendingInDatabase,
  readMcpOAuthStoreIfPresentInDatabase,
  readMcpOAuthStatusesInDatabase,
} from "../agents/mcp-oauth-store.kernel.js";
import { getFleetCellInDatabase, listFleetCellsInDatabase } from "../fleet/registry.kernel.js";
import { withStateDatabaseCoordinatorRuntimeDirectory } from "../infra/state-database-coordinator.js";
import { serveWorkerTasks } from "../infra/worker-task-pool.js";
import {
  selectSkillLibraryRevisionMetadataBatch,
  selectSkillLibraryRevisionManifestsBatch,
} from "../skills/library/selection-read.kernel.js";
import { openClawStateDatabaseCache } from "./openclaw-state-db-cache.js";
import { withOpenClawStateReadOnlyLocation } from "./openclaw-state-db-readonly.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import type {
  OpenClawStateReadReply,
  OpenClawStateReadRequest,
} from "./openclaw-state-read.types.js";
import { encodeOpenClawStateWorkerError } from "./openclaw-state-worker-error.js";

function isReadRequest(input: unknown): input is OpenClawStateReadRequest {
  if (!isRecord(input) || !isRecord(input.context) || !isRecord(input.command)) {
    return false;
  }
  const { environment, coordinatorRuntime } = input.context;
  return (
    typeof input.databasePath === "string" &&
    typeof input.location === "string" &&
    typeof input.checkFreshAdmission === "boolean" &&
    isRecord(environment) &&
    typeof environment.OPENCLAW_STATE_DIR === "string" &&
    (environment.OPENCLAW_SUPERVISOR_MODE === undefined ||
      environment.OPENCLAW_SUPERVISOR_MODE === "external") &&
    isRecord(coordinatorRuntime) &&
    typeof coordinatorRuntime.directory === "string" &&
    typeof coordinatorRuntime.keepAlive === "boolean" &&
    (input.command.type === "admit" ||
      ((input.command.type === "skills.library.descriptions" ||
        input.command.type === "skills.library.manifests") &&
        Array.isArray(input.command.input) &&
        input.command.input.length <= SKILL_LIBRARY_MAX_SELECTIONS &&
        input.command.input.every(
          (pin) =>
            isRecord(pin) && typeof pin.skillId === "string" && typeof pin.revision === "string",
        )) ||
      input.command.type === "fleet.list" ||
      (input.command.type === "fleet.get" && typeof input.command.tenantId === "string") ||
      (input.command.type === "mcpOAuth.statuses" &&
        Array.isArray(input.command.input) &&
        input.command.input.every((key) => typeof key === "string")) ||
      ((input.command.type === "mcpOAuth.readOnly" ||
        input.command.type === "mcpOAuth.keys" ||
        input.command.type === "mcpOAuth.pending" ||
        input.command.type === "mcpOAuth.countPrincipals") &&
        typeof input.command.input === "string"))
  );
}

function unexpectedReadCommand(_command: never): never {
  throw new Error("Unexpected shared-state read command");
}

serveWorkerTasks((input): OpenClawStateReadReply => {
  let sourceAdmitted: true | undefined;
  try {
    if (!isReadRequest(input)) {
      throw new Error("Shared-state reader requires a captured state location and read command");
    }
    return withStateDatabaseCoordinatorRuntimeDirectory(input.context.coordinatorRuntime, () => {
      if (input.checkFreshAdmission) {
        openClawStateDatabaseCache.assertOpenClawStateDatabaseFreshOpenAllowedAtPath(
          input.databasePath,
          input.context.environment,
        );
      }
      const { command } = input;
      if (command.type === "admit") {
        return { ok: true, type: "admit" };
      }
      return withOpenClawStateReadOnlyLocation(
        ({ db }) => {
          sourceAdmitted = true;
          switch (command.type) {
            case "skills.library.descriptions":
              return {
                ok: true,
                type: command.type,
                sourceAdmitted,
                value: tableExists(db, "skill_library_entries")
                  ? selectSkillLibraryRevisionMetadataBatch(db, command.input)
                  : undefined,
              };
            case "skills.library.manifests":
              return {
                ok: true,
                type: command.type,
                sourceAdmitted,
                value: tableExists(db, "skill_library_entries")
                  ? selectSkillLibraryRevisionManifestsBatch(db, command.input)
                  : undefined,
              };
            case "fleet.list":
              return {
                ok: true,
                type: command.type,
                sourceAdmitted,
                cells: listFleetCellsInDatabase(db),
              };
            case "fleet.get":
              return {
                ok: true,
                type: command.type,
                sourceAdmitted,
                cell: getFleetCellInDatabase(db, command.tenantId),
              };
            case "mcpOAuth.statuses":
              return {
                ok: true,
                type: command.type,
                sourceAdmitted,
                value: readMcpOAuthStatusesInDatabase(db, command.input),
              };
            case "mcpOAuth.readOnly":
              return {
                ok: true,
                type: command.type,
                sourceAdmitted,
                value: readMcpOAuthStoreIfPresentInDatabase(db, command.input),
              };
            case "mcpOAuth.keys":
              return {
                ok: true,
                type: command.type,
                sourceAdmitted,
                value: listMcpOAuthStoreKeysInDatabase(db, command.input),
              };
            case "mcpOAuth.pending":
              return {
                ok: true,
                type: command.type,
                sourceAdmitted,
                value: readMcpOAuthPendingInDatabase(db, command.input),
              };
            case "mcpOAuth.countPrincipals":
              return {
                ok: true,
                type: command.type,
                sourceAdmitted,
                value: countMcpOAuthPrincipalsInDatabase(db, command.input),
              };
          }
          return unexpectedReadCommand(command);
        },
        input.databasePath,
        input.location,
      );
    });
  } catch (value) {
    const error = toStringifiedError(value);
    return {
      ok: false,
      sourceAdmitted,
      message: error.message,
      error: encodeOpenClawStateWorkerError(error, { includeOrdinary: true }),
    };
  }
});
