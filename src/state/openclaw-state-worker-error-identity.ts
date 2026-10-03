import { DuplicateAgentError } from "../agents/agent-create-error.js";
import { McpOAuthStoreCorruptionError } from "../agents/mcp-oauth-store-error.js";
import { WorkspaceAliasRepointedError } from "../agents/workspace-state-identity.js";
import {
  SESSION_GOAL_OPERATION_ERROR_CODES,
  SessionGoalOperationError,
  type SessionGoalOperationErrorCode,
} from "../config/sessions/goals-operations.types.js";
import { SessionPendingInputCustodyError } from "../config/sessions/session-pending-input-custody-error.js";
import { WorkerSessionAlreadyAttachedError } from "../gateway/worker-environments/session-attachment.js";
import { GatewayStateOwnerContentionError } from "../infra/gateway-state-owner.js";
import {
  SqliteCoordinatorError,
  OpenClawStateExternalOwnershipError,
  OpenClawStateOwnershipError,
  OpenClawStateOwnershipMetadataError,
} from "../infra/sqlite-lifecycle-errors.js";
import { SqliteSchemaVersionError } from "../infra/sqlite-user-version.js";
import {
  isStartupMaintenanceKind,
  StartupMaintenanceRequiredError,
} from "../infra/startup-maintenance-required.js";
import { PluginBlobStoreError } from "../plugin-state/plugin-blob-store.types.js";
import {
  SecretStoreValidationError,
  isSecretStoreValidationCode,
} from "../secrets/store/secret-store-validation-error.js";
import { SkillLibraryError, type SkillLibraryErrorCode } from "../skills/library/errors.js";
import { SkillUploadRequestError } from "../skills/lifecycle/upload-store-error.js";
import { OpenClawAgentDatabaseMediaMigrationRequiredError } from "./openclaw-agent-db-migration-required.js";
import { OpenClawStateDatabaseSchemaMigrationRequiredError } from "./openclaw-state-db-schema-migration-required.js";
import {
  isOpenClawStateLeaseErrorCode,
  OpenClawStateLeaseError,
  type OpenClawStateLeaseErrorCode,
} from "./openclaw-state-lease-error.js";
import { SessionMetadataUnavailableError } from "./session-metadata-unavailable-error.js";

type MaintenanceKind = ConstructorParameters<typeof StartupMaintenanceRequiredError>[0];
type StateMigrationKind = ConstructorParameters<
  typeof OpenClawStateDatabaseSchemaMigrationRequiredError
>[0];

export type ErrorIdentity =
  | { type: "secret-store-validation"; secretCode: SecretStoreValidationError["code"] }
  | { type: "session-goal-operation"; goalCode: SessionGoalOperationErrorCode }
  | { type: "worker-session-already-attached"; sessionId: string; environmentId: string }
  | {
      type: "workspace-alias-repointed";
      aliasPath: string;
      storedWorkspacePath: string;
      currentWorkspacePath: string;
    }
  | {
      type:
        | "error"
        | "aggregate"
        | "ownership"
        | "newer-schema"
        | "coordinator"
        | "range-error"
        | "syntax-error"
        | "type-error"
        | "duplicate-agent"
        | "skill-upload-request"
        | "mcp-oauth-corruption"
        | "session-pending-input-custody";
    }
  | { type: "state-owner-contention"; databasePath: string }
  | { type: "ownership-metadata"; databasePath: string }
  | { type: "external-ownership"; databasePath: string; managerId: string }
  | { type: "state-lease"; leaseCode: OpenClawStateLeaseErrorCode }
  | { type: "skill-library"; libraryCode: SkillLibraryErrorCode; currentRevision?: string }
  | {
      type: "plugin-blob";
      blobCode: PluginBlobStoreError["code"];
      operation: PluginBlobStoreError["operation"];
      path?: string;
    }
  | { type: "maintenance"; kind: MaintenanceKind }
  | { type: "state-migration"; kind: StateMigrationKind; pathname: string }
  | {
      type: "session-metadata";
      reason: SessionMetadataUnavailableError["reason"];
      missingTables: readonly string[];
    }
  | { type: "agent-media-migration"; pathname: string; schemaVersion: number };

export function identifyError(error: Error): ErrorIdentity {
  if (error instanceof SkillLibraryError) {
    return {
      type: "skill-library",
      libraryCode: error.code,
      ...(error.currentRevision === undefined ? {} : { currentRevision: error.currentRevision }),
    };
  }
  if (error instanceof SecretStoreValidationError) {
    return { type: "secret-store-validation", secretCode: error.code };
  }
  if (error instanceof DuplicateAgentError) {
    return { type: "duplicate-agent" };
  }
  if (error instanceof WorkerSessionAlreadyAttachedError) {
    return {
      type: "worker-session-already-attached",
      sessionId: error.sessionId,
      environmentId: error.environmentId,
    };
  }
  if (error instanceof PluginBlobStoreError) {
    return {
      type: "plugin-blob",
      blobCode: error.code,
      operation: error.operation,
      ...(error.path === undefined ? {} : { path: error.path }),
    };
  }
  if (error instanceof WorkspaceAliasRepointedError) {
    return {
      type: "workspace-alias-repointed",
      aliasPath: error.aliasPath,
      storedWorkspacePath: error.storedWorkspacePath,
      currentWorkspacePath: error.currentWorkspacePath,
    };
  }
  if (error instanceof McpOAuthStoreCorruptionError) {
    return { type: "mcp-oauth-corruption" };
  }
  if (error instanceof SessionGoalOperationError) {
    return { type: "session-goal-operation", goalCode: error.code };
  }
  if (error instanceof SessionPendingInputCustodyError) {
    return { type: "session-pending-input-custody" };
  }
  if (error instanceof SessionMetadataUnavailableError) {
    return {
      type: "session-metadata",
      reason: error.reason,
      missingTables: [...error.missingTables],
    };
  }
  if (error instanceof SkillUploadRequestError) {
    return { type: "skill-upload-request" };
  }
  if (error instanceof GatewayStateOwnerContentionError) {
    return { type: "state-owner-contention", databasePath: error.databasePath };
  }
  if (error instanceof SqliteCoordinatorError) {
    return { type: "coordinator" };
  }
  if (error instanceof OpenClawStateLeaseError) {
    return { type: "state-lease", leaseCode: error.code };
  }
  if (error instanceof OpenClawStateOwnershipMetadataError) {
    return { type: "ownership-metadata", databasePath: error.databasePath };
  }
  if (error instanceof OpenClawStateExternalOwnershipError) {
    return {
      type: "external-ownership",
      databasePath: error.databasePath,
      managerId: error.managerId,
    };
  }
  if (error instanceof OpenClawStateOwnershipError) {
    return { type: "ownership" };
  }
  if (error instanceof SqliteSchemaVersionError) {
    return { type: "newer-schema" };
  }
  if (error instanceof OpenClawStateDatabaseSchemaMigrationRequiredError) {
    return { type: "state-migration", kind: error.kind, pathname: error.pathname };
  }
  if (error instanceof OpenClawAgentDatabaseMediaMigrationRequiredError) {
    return {
      type: "agent-media-migration",
      pathname: error.pathname,
      schemaVersion: error.schemaVersion,
    };
  }
  if (error instanceof StartupMaintenanceRequiredError) {
    return { type: "maintenance", kind: error.kind };
  }
  if (error instanceof RangeError) {
    return { type: "range-error" };
  }
  if (error instanceof SyntaxError) {
    return { type: "syntax-error" };
  }
  if (error instanceof TypeError) {
    return { type: "type-error" };
  }
  return { type: error instanceof AggregateError ? "aggregate" : "error" };
}

function isBlobCode(value: unknown): value is PluginBlobStoreError["code"] {
  return (
    value === "PLUGIN_BLOB_OPEN_FAILED" ||
    value === "PLUGIN_BLOB_WRITE_FAILED" ||
    value === "PLUGIN_BLOB_READ_FAILED" ||
    value === "PLUGIN_BLOB_CORRUPT" ||
    value === "PLUGIN_BLOB_LIMIT_EXCEEDED" ||
    value === "PLUGIN_BLOB_INVALID_INPUT"
  );
}

function isBlobOperation(value: unknown): value is PluginBlobStoreError["operation"] {
  return (
    value === "open" ||
    value === "register" ||
    value === "lookup" ||
    value === "delete" ||
    value === "entries" ||
    value === "clear" ||
    value === "sweep"
  );
}

function isSkillLibraryCode(value: unknown): value is SkillLibraryErrorCode {
  return (
    value === "IDENTITY_REQUIRED" ||
    value === "FORBIDDEN" ||
    value === "NOT_FOUND" ||
    value === "CONFLICT" ||
    value === "NAME_CONFLICT" ||
    value === "INVALID_BUNDLE" ||
    value === "POLICY_BLOCKED" ||
    value === "AUTHORITY_EXPIRED" ||
    value === "LIMIT"
  );
}

export function parseIdentity(node: Record<string, unknown>): ErrorIdentity | undefined {
  switch (node.type) {
    case "skill-library":
      return isSkillLibraryCode(node.libraryCode) &&
        node.code === node.libraryCode &&
        (node.currentRevision === undefined || typeof node.currentRevision === "string")
        ? {
            type: node.type,
            libraryCode: node.libraryCode,
            ...(typeof node.currentRevision === "string"
              ? { currentRevision: node.currentRevision }
              : {}),
          }
        : undefined;
    case "secret-store-validation":
      return isSecretStoreValidationCode(node.secretCode) && node.code === node.secretCode
        ? { type: node.type, secretCode: node.secretCode }
        : undefined;
    case "worker-session-already-attached":
      return typeof node.sessionId === "string" && typeof node.environmentId === "string"
        ? { type: node.type, sessionId: node.sessionId, environmentId: node.environmentId }
        : undefined;
    case "workspace-alias-repointed":
      return typeof node.aliasPath === "string" &&
        typeof node.storedWorkspacePath === "string" &&
        typeof node.currentWorkspacePath === "string"
        ? {
            type: node.type,
            aliasPath: node.aliasPath,
            storedWorkspacePath: node.storedWorkspacePath,
            currentWorkspacePath: node.currentWorkspacePath,
          }
        : undefined;
    case "error":
    case "aggregate":
    case "ownership":
    case "newer-schema":
    case "coordinator":
    case "range-error":
    case "syntax-error":
    case "type-error":
    case "duplicate-agent":
    case "skill-upload-request":
    case "mcp-oauth-corruption":
    case "session-pending-input-custody":
      return { type: node.type };
    case "session-goal-operation": {
      const goalCode = SESSION_GOAL_OPERATION_ERROR_CODES.find((code) => code === node.goalCode);
      return goalCode && node.code === goalCode ? { type: node.type, goalCode } : undefined;
    }
    case "session-metadata":
      return (node.reason === "schema-missing" || node.reason === "table-missing") &&
        Array.isArray(node.missingTables) &&
        node.missingTables.every((table: unknown) => typeof table === "string")
        ? { type: node.type, reason: node.reason, missingTables: [...node.missingTables] }
        : undefined;
    case "state-owner-contention":
    case "ownership-metadata":
      return typeof node.databasePath === "string"
        ? { type: node.type, databasePath: node.databasePath }
        : undefined;
    case "external-ownership":
      return typeof node.databasePath === "string" && typeof node.managerId === "string"
        ? { type: node.type, databasePath: node.databasePath, managerId: node.managerId }
        : undefined;
    case "plugin-blob":
      return isBlobCode(node.blobCode) &&
        node.code === node.blobCode &&
        isBlobOperation(node.operation) &&
        (node.path === undefined || typeof node.path === "string")
        ? {
            type: node.type,
            blobCode: node.blobCode,
            operation: node.operation,
            ...(typeof node.path === "string" ? { path: node.path } : {}),
          }
        : undefined;
    case "state-lease":
      return isOpenClawStateLeaseErrorCode(node.leaseCode) && node.code === node.leaseCode
        ? { type: node.type, leaseCode: node.leaseCode }
        : undefined;
    case "maintenance":
      return isStartupMaintenanceKind(node.kind) ? { type: node.type, kind: node.kind } : undefined;
    case "state-migration":
      return (node.kind === "audit-events-v2" ||
        node.kind === "legacy-cron-run-logs" ||
        node.kind === "legacy-workshop-review-index") &&
        typeof node.pathname === "string"
        ? { type: node.type, kind: node.kind, pathname: node.pathname }
        : undefined;
    case "agent-media-migration":
      return typeof node.pathname === "string" &&
        typeof node.schemaVersion === "number" &&
        Number.isSafeInteger(node.schemaVersion) &&
        node.schemaVersion >= 0
        ? { type: node.type, pathname: node.pathname, schemaVersion: node.schemaVersion }
        : undefined;
    default:
      return undefined;
  }
}

function unreachableErrorNode(node: never): never {
  throw new Error(`Unexpected shared-state worker error node: ${String(node)}`);
}

export function createError(node: ErrorIdentity & { message: string }): Error {
  switch (node.type) {
    case "skill-library":
      return new SkillLibraryError(node.libraryCode, node.message, node.currentRevision);
    case "secret-store-validation":
      return new SecretStoreValidationError(node.secretCode, node.message);
    case "duplicate-agent":
      return new DuplicateAgentError(node.message);
    case "worker-session-already-attached":
      return new WorkerSessionAlreadyAttachedError(node.sessionId, node.environmentId);
    case "workspace-alias-repointed":
      return new WorkspaceAliasRepointedError(node);
    case "session-goal-operation":
      return new SessionGoalOperationError(node.goalCode, node.message);
    case "session-pending-input-custody":
      return new SessionPendingInputCustodyError(node.message);
    case "session-metadata":
      return new SessionMetadataUnavailableError(node.reason, undefined, node.missingTables);
    case "error":
      return new Error(node.message);
    case "range-error":
      return new RangeError(node.message);
    case "syntax-error":
      return new SyntaxError(node.message);
    case "type-error":
      return new TypeError(node.message);
    case "skill-upload-request":
      return new SkillUploadRequestError(node.message);
    case "mcp-oauth-corruption":
      return new McpOAuthStoreCorruptionError("", "");
    case "aggregate":
      return new AggregateError([], node.message);
    case "coordinator":
      return new SqliteCoordinatorError(node.message);
    case "state-owner-contention":
      return new GatewayStateOwnerContentionError(node.databasePath);
    case "ownership":
      return new OpenClawStateOwnershipError(node.message);
    case "ownership-metadata":
      return new OpenClawStateOwnershipMetadataError(node.databasePath, "");
    case "external-ownership":
      return new OpenClawStateExternalOwnershipError(node.databasePath, node.managerId);
    case "newer-schema":
      return new SqliteSchemaVersionError(node.message);
    case "plugin-blob":
      return new PluginBlobStoreError(node.message, {
        code: node.blobCode,
        operation: node.operation,
        ...(node.path === undefined ? {} : { path: node.path }),
      });
    case "state-lease":
      return new OpenClawStateLeaseError(node.message, { code: node.leaseCode });
    case "maintenance":
      return new StartupMaintenanceRequiredError(node.kind, node.message);
    case "state-migration":
      return new OpenClawStateDatabaseSchemaMigrationRequiredError(node.kind, node.pathname);
    case "agent-media-migration":
      return new OpenClawAgentDatabaseMediaMigrationRequiredError(
        node.pathname,
        node.schemaVersion,
      );
  }
  return unreachableErrorNode(node);
}
