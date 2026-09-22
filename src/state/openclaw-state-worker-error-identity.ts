import { McpOAuthStoreCorruptionError } from "../agents/mcp-oauth-store-error.js";
import { WorkspaceAliasRepointedError } from "../agents/workspace-state-identity.js";
import { WorkerSessionAlreadyAttachedError } from "../gateway/worker-environments/session-attachment.js";
import { SqliteCoordinatorError } from "../infra/sqlite-coordinator.js";
import { SqliteSchemaVersionError } from "../infra/sqlite-user-version.js";
import { StartupMaintenanceRequiredError } from "../infra/startup-maintenance-required.js";
import { StateDatabaseCoordinatorContentionError } from "../infra/state-database-coordinator.js";
import { PluginBlobStoreError } from "../plugin-state/plugin-blob-store.types.js";
import { SkillUploadRequestError } from "../skills/lifecycle/upload-store-error.js";
import { OpenClawAgentDatabaseMediaMigrationRequiredError } from "./openclaw-agent-db-migration-required.js";
import { OpenClawStateDatabaseSchemaMigrationRequiredError } from "./openclaw-state-db-schema-migration-required.js";
import {
  isOpenClawStateLeaseErrorCode,
  OpenClawStateLeaseError,
  type OpenClawStateLeaseErrorCode,
} from "./openclaw-state-lease-error.js";
import {
  OpenClawStateExternalOwnershipError,
  OpenClawStateOwnershipError,
  OpenClawStateOwnershipMetadataError,
} from "./openclaw-state-ownership.js";

type MaintenanceKind = ConstructorParameters<typeof StartupMaintenanceRequiredError>[0];
type StateMigrationKind = ConstructorParameters<
  typeof OpenClawStateDatabaseSchemaMigrationRequiredError
>[0];
type CoordinatorFamily = ConstructorParameters<typeof StateDatabaseCoordinatorContentionError>[0];

export type ErrorIdentity =
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
        | "skill-upload-request"
        | "mcp-oauth-corruption";
    }
  | { type: "coordinator-contention"; family: CoordinatorFamily }
  | { type: "ownership-metadata"; databasePath: string }
  | { type: "external-ownership"; databasePath: string; managerId: string }
  | { type: "state-lease"; leaseCode: OpenClawStateLeaseErrorCode }
  | {
      type: "plugin-blob";
      blobCode: PluginBlobStoreError["code"];
      operation: PluginBlobStoreError["operation"];
      path?: string;
    }
  | { type: "maintenance"; kind: MaintenanceKind }
  | { type: "state-migration"; kind: StateMigrationKind; pathname: string }
  | { type: "agent-media-migration"; pathname: string; schemaVersion: number };

export function identifyError(error: Error): ErrorIdentity {
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
  if (error instanceof SkillUploadRequestError) {
    return { type: "skill-upload-request" };
  }
  if (error instanceof StateDatabaseCoordinatorContentionError) {
    return { type: "coordinator-contention", family: error.family };
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

function isMaintenanceKind(kind: unknown): kind is MaintenanceKind {
  return (
    kind === "newer-schema" ||
    kind === "agent-media" ||
    kind === "agent-databases-composite-primary-key" ||
    kind === "audit-events-v2" ||
    kind === "legacy-cron-run-logs" ||
    kind === "legacy-workshop-review-index" ||
    kind === "legacy-workspace" ||
    kind === "legacy-session-store"
  );
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

export function parseIdentity(node: Record<string, unknown>): ErrorIdentity | undefined {
  switch (node.type) {
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
    case "skill-upload-request":
    case "mcp-oauth-corruption":
      return { type: node.type };
    case "coordinator-contention":
      return node.family === "gateway-lifecycle" ||
        node.family === "state-lifecycle" ||
        node.family === "state-handles"
        ? { type: node.type, family: node.family }
        : undefined;
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
      return isMaintenanceKind(node.kind) ? { type: node.type, kind: node.kind } : undefined;
    case "state-migration":
      return (node.kind === "agent-databases-composite-primary-key" ||
        node.kind === "audit-events-v2" ||
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
    case "worker-session-already-attached":
      return new WorkerSessionAlreadyAttachedError(node.sessionId, node.environmentId);
    case "workspace-alias-repointed":
      return new WorkspaceAliasRepointedError(node);
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
    case "coordinator-contention":
      return new StateDatabaseCoordinatorContentionError(node.family);
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
