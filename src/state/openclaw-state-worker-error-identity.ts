import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { DuplicateAgentError } from "../agents/agent-create-error.js";
import { AuthProfileStoreUnreadableError } from "../agents/auth-profiles/store-unreadable-error.js";
import { McpOAuthStoreCorruptionError } from "../agents/mcp-oauth-store-error.js";
import { WorkspaceAliasRepointedError } from "../agents/workspace-state-identity.js";
import {
  SessionWorktreeLifecycleError,
  SessionWorktreeSourceChangedError,
  WorktreeRemovalContentionError,
  WorktreeRemovalLockError,
} from "../agents/worktrees/errors.js";
import {
  SESSION_GOAL_OPERATION_ERROR_CODES,
  SessionGoalOperationError,
  type SessionGoalOperationErrorCode,
} from "../config/sessions/goals-operations.types.js";
import { SessionCanonicalKeyMigrationRequiredError } from "../config/sessions/session-canonical-key-error.js";
import {
  SessionEntryLifecycleUpsertConflictError,
  SqliteSessionMutationConflictError,
} from "../config/sessions/session-mutation-conflict-error.js";
import { SessionPendingInputCustodyError } from "../config/sessions/session-pending-input-custody-error.js";
import { SessionTranscriptWriterClaimReboundError } from "../config/sessions/session-transcript-writer-claim-error.js";
import { ModelAccountConnectAuthorityError } from "../gateway/model-account-connect-errors.js";
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
import { PluginStateStoreError } from "../plugin-state/plugin-state-error.js";
import {
  SecretStoreValidationError,
  isSecretStoreValidationCode,
} from "../secrets/store/secret-store-validation-error.js";
import { ModelSelectionLockedError } from "../sessions/model-selection-error.js";
import { SkillUploadRequestError } from "../skills/lifecycle/upload-store-error.js";
import { SkillLibraryError, type SkillLibraryErrorCode } from "../skills/skill-library-error.js";
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

const MESSAGE_ONLY_ERRORS = {
  "worktree-source-changed": SessionWorktreeSourceChangedError,
  "model-account-authority": ModelAccountConnectAuthorityError,
  "duplicate-agent": DuplicateAgentError,
  "model-selection-locked": ModelSelectionLockedError,
  "session-canonical-key-migration": SessionCanonicalKeyMigrationRequiredError,
  "session-pending-input-custody": SessionPendingInputCustodyError,
  "skill-upload-request": SkillUploadRequestError,
  coordinator: SqliteCoordinatorError,
  ownership: OpenClawStateOwnershipError,
  "newer-schema": SqliteSchemaVersionError,
  "range-error": RangeError,
  "syntax-error": SyntaxError,
  "type-error": TypeError,
};

type MessageOnlyErrorIdentity = { type: keyof typeof MESSAGE_ONLY_ERRORS };

function isMessageOnlyErrorIdentity(node: { type?: unknown }): node is MessageOnlyErrorIdentity {
  return typeof node.type === "string" && Object.hasOwn(MESSAGE_ONLY_ERRORS, node.type);
}

export type ErrorIdentity =
  | { type: "session-worktree-owner-mismatch" }
  | {
      type: "worktree-removal-contention";
      kind: "busy" | "finalized";
      blockedByRun?: { worktreeId: string; pid: number };
    }
  | { type: "worktree-removal-lock"; kind: "busy" | "foreign-lock" }
  | { type: "secret-store-validation"; secretCode: SecretStoreValidationError["code"] }
  | MessageOnlyErrorIdentity
  | { type: "session-goal-operation"; goalCode: SessionGoalOperationErrorCode }
  | { type: "session-mutation-conflict"; operationLabel: string }
  | { type: "session-transcript-writer-claim-rebound" }
  | { type: "session-lifecycle-upsert-conflict"; sessionKey: string }
  | { type: "worker-session-already-attached"; sessionId: string; environmentId: string }
  | {
      type: "workspace-alias-repointed";
      aliasPath: string;
      storedWorkspacePath: string;
      currentWorkspacePath: string;
    }
  | { type: "error" | "aggregate" | "mcp-oauth-corruption" }
  | { type: "auth-profile-store-unreadable"; databasePath: string }
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
  | {
      type: "plugin-state";
      stateCode: PluginStateStoreError["code"];
      operation: PluginStateStoreError["operation"];
      path?: string;
      owner: PluginStateStoreError["owner"];
    }
  | { type: "state-migration"; kind: StateMigrationKind; pathname: string }
  | {
      type: "session-metadata";
      reason: SessionMetadataUnavailableError["reason"];
      missingTables: readonly string[];
    }
  | { type: "agent-media-migration"; pathname: string; schemaVersion: number };

export function identifyError(error: Error): ErrorIdentity {
  if (error instanceof AuthProfileStoreUnreadableError) {
    return { type: "auth-profile-store-unreadable", databasePath: error.databasePath };
  }
  if (error instanceof SessionWorktreeLifecycleError && error.reason === "owner-mismatch") {
    return { type: "session-worktree-owner-mismatch" };
  }
  if (error instanceof WorktreeRemovalContentionError) {
    return {
      type: "worktree-removal-contention",
      kind: error.kind,
      ...(error.blockedByRun ? { blockedByRun: error.blockedByRun } : {}),
    };
  }
  if (error instanceof WorktreeRemovalLockError) {
    return { type: "worktree-removal-lock", kind: error.kind };
  }
  if (error instanceof PluginStateStoreError) {
    return {
      type: "plugin-state",
      stateCode: error.code,
      operation: error.operation,
      path: error.path,
      owner: error.owner,
    };
  }
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
  if (error instanceof SessionEntryLifecycleUpsertConflictError) {
    return { type: "session-lifecycle-upsert-conflict", sessionKey: error.sessionKey };
  }
  if (error instanceof SessionTranscriptWriterClaimReboundError) {
    return { type: "session-transcript-writer-claim-rebound" };
  }
  if (error instanceof SqliteSessionMutationConflictError) {
    return { type: "session-mutation-conflict", operationLabel: error.operationLabel };
  }
  if (error instanceof SessionMetadataUnavailableError) {
    return {
      type: "session-metadata",
      reason: error.reason,
      missingTables: [...error.missingTables],
    };
  }
  if (error instanceof GatewayStateOwnerContentionError) {
    return { type: "state-owner-contention", databasePath: error.databasePath };
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
  // Parameter-bearing ownership subclasses precede their generic parent;
  // the newer-schema subtype must precede generic startup maintenance.
  // SAFETY: Entries retain the literal keys and constructors of this private table.
  for (const [type, ErrorType] of Object.entries(MESSAGE_ONLY_ERRORS) as [
    MessageOnlyErrorIdentity["type"],
    new (message: string) => Error,
  ][]) {
    if (error instanceof ErrorType) {
      return { type };
    }
  }
  if (error instanceof StartupMaintenanceRequiredError) {
    return { type: "maintenance", kind: error.kind };
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
  if (isMessageOnlyErrorIdentity(node)) {
    return { type: node.type };
  }
  switch (node.type) {
    case "session-worktree-owner-mismatch":
      return { type: node.type };
    case "worktree-removal-contention": {
      if (node.kind !== "busy" && node.kind !== "finalized") {
        return undefined;
      }
      if (node.blockedByRun === undefined) {
        return { type: node.type, kind: node.kind };
      }
      const blocked = node.blockedByRun;
      if (
        !isRecord(blocked) ||
        typeof blocked.worktreeId !== "string" ||
        typeof blocked.pid !== "number" ||
        !Number.isSafeInteger(blocked.pid) ||
        blocked.pid <= 0
      ) {
        return undefined;
      }
      return {
        type: node.type,
        kind: node.kind,
        blockedByRun: { worktreeId: blocked.worktreeId, pid: blocked.pid },
      };
    }
    case "worktree-removal-lock":
      return node.kind === "busy" || node.kind === "foreign-lock"
        ? { type: node.type, kind: node.kind }
        : undefined;
    case "plugin-state": {
      const codes: readonly PluginStateStoreError["code"][] = [
        "PLUGIN_STATE_SQLITE_UNAVAILABLE",
        "PLUGIN_STATE_OPEN_FAILED",
        "PLUGIN_STATE_WRITE_FAILED",
        "PLUGIN_STATE_READ_FAILED",
        "PLUGIN_STATE_CORRUPT",
        "PLUGIN_STATE_LIMIT_EXCEEDED",
        "PLUGIN_STATE_INVALID_INPUT",
      ];
      const operations: readonly PluginStateStoreError["operation"][] = [
        "load-sqlite",
        "open",
        "ensure-schema",
        "register",
        "lookup",
        "consume",
        "delete",
        "entries",
        "count",
        "clear",
        "sweep",
        "probe",
        "close",
      ];
      const stateCode = codes.find((code) => code === node.stateCode && code === node.code);
      const operation = operations.find((candidate) => candidate === node.operation);
      const owner = node.owner;
      return stateCode &&
        operation &&
        isRecord(owner) &&
        typeof owner.pid === "number" &&
        typeof owner.threadId === "number" &&
        typeof owner.version === "string" &&
        (node.path === undefined || typeof node.path === "string")
        ? {
            type: node.type,
            stateCode,
            operation,
            owner: { pid: owner.pid, threadId: owner.threadId, version: owner.version },
            ...(typeof node.path === "string" ? { path: node.path } : {}),
          }
        : undefined;
    }
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
    case "mcp-oauth-corruption":
    case "session-transcript-writer-claim-rebound":
      return { type: node.type };
    case "session-goal-operation": {
      const goalCode = SESSION_GOAL_OPERATION_ERROR_CODES.find((code) => code === node.goalCode);
      return goalCode && node.code === goalCode ? { type: node.type, goalCode } : undefined;
    }
    case "session-lifecycle-upsert-conflict":
      return typeof node.sessionKey === "string"
        ? { type: node.type, sessionKey: node.sessionKey }
        : undefined;
    case "session-mutation-conflict":
      return typeof node.operationLabel === "string"
        ? { type: node.type, operationLabel: node.operationLabel }
        : undefined;
    case "session-metadata":
      return (node.reason === "schema-missing" || node.reason === "table-missing") &&
        Array.isArray(node.missingTables) &&
        node.missingTables.every((table: unknown) => typeof table === "string")
        ? { type: node.type, reason: node.reason, missingTables: [...node.missingTables] }
        : undefined;
    case "auth-profile-store-unreadable":
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
  if (isMessageOnlyErrorIdentity(node)) {
    const ErrorType = MESSAGE_ONLY_ERRORS[node.type];
    return new ErrorType(node.message);
  }
  switch (node.type) {
    case "session-worktree-owner-mismatch":
      return new SessionWorktreeLifecycleError(node.message, "owner-mismatch");
    case "worktree-removal-contention":
      return new WorktreeRemovalContentionError(node.kind, node.message, node.blockedByRun);
    case "worktree-removal-lock":
      return new WorktreeRemovalLockError(node.kind, node.message);
    case "plugin-state":
      return new PluginStateStoreError(node.message, {
        code: node.stateCode,
        operation: node.operation,
        path: node.path,
        owner: node.owner,
      });
    case "skill-library":
      return new SkillLibraryError(node.libraryCode, node.message, node.currentRevision);
    case "secret-store-validation":
      return new SecretStoreValidationError(node.secretCode, node.message);
    case "worker-session-already-attached":
      return new WorkerSessionAlreadyAttachedError(node.sessionId, node.environmentId);
    case "workspace-alias-repointed":
      return new WorkspaceAliasRepointedError(node);
    case "session-goal-operation":
      return new SessionGoalOperationError(node.goalCode, node.message);
    case "session-lifecycle-upsert-conflict":
      return new SessionEntryLifecycleUpsertConflictError(node.sessionKey);
    case "session-mutation-conflict":
      return new SqliteSessionMutationConflictError(node.operationLabel);
    case "session-transcript-writer-claim-rebound":
      return new SessionTranscriptWriterClaimReboundError();
    case "session-metadata":
      return new SessionMetadataUnavailableError(node.reason, undefined, node.missingTables);
    case "error":
      return new Error(node.message);
    case "mcp-oauth-corruption":
      return new McpOAuthStoreCorruptionError("", "");
    case "aggregate":
      return new AggregateError([], node.message);
    case "auth-profile-store-unreadable":
      return new AuthProfileStoreUnreadableError(node.databasePath);
    case "state-owner-contention":
      return new GatewayStateOwnerContentionError(node.databasePath);
    case "ownership-metadata":
      return new OpenClawStateOwnershipMetadataError(node.databasePath, "");
    case "external-ownership":
      return new OpenClawStateExternalOwnershipError(node.databasePath, node.managerId);
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
