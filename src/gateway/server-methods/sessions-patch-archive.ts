import { isDeepStrictEqual } from "node:util";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
  type SessionsPatchParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { ModelCatalogSnapshot } from "../../agents/model-catalog.js";
import { SessionWorktreeLifecycleError } from "../../agents/worktrees/errors.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { SessionAccessScope } from "../../config/sessions/session-accessor.js";
import { retainPreparedSessionEntryPredicate } from "../../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import { captureSessionEntryMetadataRead } from "../../config/sessions/session-entry-source-authority.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { resolveMissingAgentHarnessSessionError } from "../../sessions/agent-harness-session-key.js";
import { restoreSessionWorktree } from "../../sessions/session-worktree-lifecycle.js";
import type { UserModelAccountSelection } from "../model-account-authority.js";
import { ModelAccountConnectAuthorityError } from "../model-account-connect-errors.js";
import { resolvePluginSessionOwnershipError } from "../session-plugin-ownership.js";
import { tryResolveSessionCompatibilityOwnerAgentId } from "../session-request-agent.js";
import { SessionMutationAuthorizationChangedError } from "../session-sharing.js";
import { withGatewaySessionEntryReadOnly } from "../session-utils-read-lifetime.js";
import { resolveGatewaySessionStoreTargetInWorker } from "../session-utils-store-worker.js";
import type { GatewaySessionStoreTargetWithStore } from "../session-utils-store.types.js";
import { projectSessionsPatchEntry } from "../sessions-patch.js";
import { WorkerInferenceSessionDrainBusyError } from "../worker-environments/inference-control-internal.js";
import {
  prepareSessionWorkerPlacementArchiveCheckAsync,
  prepareSessionWorkerPlacementMutationCheck,
  SessionWorkerPlacementStopError,
} from "../worker-environments/session-placement-lifecycle.js";
import {
  prepareSessionLifecycleDrain,
  SessionLifecycleWorkspaceRecoveryError,
} from "./sessions-lifecycle-drain.js";
import type {
  SessionPatchArchivePreparation,
  SessionPatchArchiveTarget,
} from "./sessions-patch-archive.types.js";
import {
  sessionChangedError as archiveChangedError,
  unexpectedPatchError,
} from "./sessions-patch-errors.js";
import { resolveSessionPatchTargetError } from "./sessions-patch-expectations.js";
import {
  resolveProtectedSessionVisibilityError,
  resolveSessionWorkerPlacementPatchError,
  prepareSessionWorkerPlacementPatchError,
  sessionLog,
} from "./sessions-shared.js";
import type { GatewayRequestContext } from "./types.js";

export function releaseSessionPatchArchive(preparation?: SessionPatchArchivePreparation): void {
  try {
    preparation?.drain.release();
  } catch (error) {
    sessionLog.warn(
      `sessions.patch: archive drain release failed for ${preparation?.canonicalKey}: ${formatErrorMessage(error)}`,
    );
  }
}

function archiveUnavailableError(key: string, message: "active" | "stopping"): ErrorShape {
  return errorShape(
    ErrorCodes.UNAVAILABLE,
    message === "active"
      ? `Session ${key} is still active; retry the archive.`
      : `Session ${key} did not finish stopping; retry the archive.`,
    { retryable: true },
  );
}

function archiveTargetChanged(params: {
  baselineEntry: SessionEntry | undefined;
  currentEntry: SessionEntry | undefined;
  patch: SessionsPatchParams;
}): boolean {
  const { baselineEntry, currentEntry, patch } = params;
  return (
    (patch.expectedSessionId !== undefined &&
      currentEntry?.sessionId !== patch.expectedSessionId) ||
    (patch.expectedLifecycleRevision !== undefined &&
      currentEntry?.lifecycleRevision !== patch.expectedLifecycleRevision) ||
    (baselineEntry === undefined) !== (currentEntry === undefined) ||
    currentEntry?.sessionId !== baselineEntry?.sessionId ||
    currentEntry?.lifecycleRevision !== baselineEntry?.lifecycleRevision
  );
}

type SessionPatchArchiveParams = {
  commitGuard: () => ErrorShape | undefined;
  cfg: OpenClawConfig;
  context: GatewayRequestContext;
  loadGatewayModelCatalogSnapshot: () => Promise<ModelCatalogSnapshot>;
  personalModelSelection?: UserModelAccountSelection;
  pluginOwnerId?: string;
  target: SessionPatchArchiveTarget;
};

const archivePolicyFields = [
  "sessionId",
  "lifecycleRevision",
  "archivedAt",
  "sandbox",
  "sandboxMode",
  "permissionMode",
  "nativeRuntimeConsent",
  "agentHarnessId",
  "pluginOwnerId",
  "agentRuntimeOverride",
  "authProfileOverride",
  "modelSelectionLocked",
  "toolOverrides",
  "modelOverride",
  "providerOverride",
  "modelOverrideRouteResolution",
  "modelOverrideFallbackOriginProvider",
  "modelOverrideFallbackOriginModel",
] as const;

export async function prepareSessionPatchArchive(
  params: SessionPatchArchiveParams,
): Promise<Result<SessionPatchArchivePreparation, ErrorShape>> {
  const metadata = captureSessionEntryMetadataRead({
    agentId: params.target.requestedAgentId,
    sessionKey: params.target.canonicalKey,
    storePath: params.target.storePath,
  });
  if (metadata) {
    return withGatewaySessionEntryReadOnly(
      { cfg: params.cfg, key: params.target.key, agentId: params.target.requestedAgentId },
      async (selected) =>
        prepareSessionPatchArchiveFromSource(params, {
          selected,
          readCurrent: () => metadata.readCurrent(),
        }),
    );
  }
  let current: SessionEntry | undefined;
  let retained: ReturnType<typeof retainPreparedSessionEntryPredicate> | undefined;
  let transferred = false;
  try {
    const selected = await resolveGatewaySessionStoreTargetInWorker({
      cfg: params.cfg,
      key: params.target.key,
      agentId: params.target.requestedAgentId,
      projection: "full",
      onSelected: (snapshot) => {
        current = snapshot.store[snapshot.canonicalKey];
        const identity = readDatabasePathIdentitySync(
          snapshot.readSource?.path ?? snapshot.storePath,
        );
        retained = retainPreparedSessionEntryPredicate({
          databaseIdentity: identity.key,
          sessionKey: snapshot.canonicalKey,
          entry: current,
          matches: (before, after) => {
            current = after;
            return (
              (before === undefined) === (after === undefined) &&
              archivePolicyFields.every((field) =>
                isDeepStrictEqual(before?.[field], after?.[field]),
              )
            );
          },
        });
      },
    });
    const result = await prepareSessionPatchArchiveFromSource(params, {
      selected,
      readCurrent: () => current,
      isCurrent: () => retained?.isCurrent() === true,
    });
    if (result.ok) {
      const drain = result.value.drain;
      result.value.drain = {
        ...drain,
        release: () => {
          try {
            drain.release();
          } finally {
            retained?.release();
          }
        },
      };
      transferred = true;
    }
    return result;
  } finally {
    if (!transferred) {
      retained?.release();
    }
  }
}

async function prepareSessionPatchArchiveFromSource(
  params: SessionPatchArchiveParams,
  source: {
    selected: GatewaySessionStoreTargetWithStore;
    readCurrent: () => SessionEntry | undefined;
    isCurrent?: () => boolean;
  },
): Promise<Result<SessionPatchArchivePreparation, ErrorShape>> {
  const { cfg, target } = params;
  const resolveCurrent = (): Result<
    {
      freshResolved: GatewaySessionStoreTargetWithStore;
      fresh: {
        target: GatewaySessionStoreTargetWithStore;
        primaryKey: string;
        entry: SessionEntry | undefined;
      };
      freshCanonicalKey: string;
    },
    ErrorShape
  > => {
    const freshResolved = source.selected;
    if (source.isCurrent?.() === false || freshResolved.storePath !== target.storePath) {
      return err(archiveChangedError(target.key));
    }
    const fresh = {
      target: freshResolved,
      primaryKey: freshResolved.canonicalKey,
      entry: source.readCurrent(),
    };
    const freshCanonicalKey = fresh.target.canonicalKey ?? target.key;
    const ownershipError = resolvePluginSessionOwnershipError({
      action: "patch",
      entry: fresh.entry,
      key: freshCanonicalKey,
      pluginOwnerId: params.pluginOwnerId,
    });
    if (ownershipError) {
      return err(ownershipError);
    }
    if (
      freshCanonicalKey !== target.canonicalKey ||
      archiveTargetChanged({
        currentEntry: fresh.entry,
        baselineEntry: target.initialEntry,
        patch: target.fullPatch,
      }) ||
      archivePolicyFields.some(
        (field) =>
          !isDeepStrictEqual(fresh.entry?.[field], freshResolved.store[freshCanonicalKey]?.[field]),
      )
    ) {
      return err(archiveChangedError(target.key));
    }
    const expectationError = resolveSessionPatchTargetError(fresh.entry, target);
    if (expectationError) {
      return err(expectationError);
    }
    const missingHarnessSessionError = resolveMissingAgentHarnessSessionError(
      freshCanonicalKey,
      fresh.entry,
    );
    if (missingHarnessSessionError) {
      return err(errorShape(ErrorCodes.INVALID_REQUEST, missingHarnessSessionError));
    }
    const protectedError = resolveProtectedSessionVisibilityError(
      cfg,
      freshCanonicalKey,
      "archive",
    );
    if (protectedError) {
      return err(protectedError);
    }
    const placementError = resolveSessionWorkerPlacementPatchError({
      agentId: freshResolved.agentId,
      cfg,
      context: params.context,
      entry: fresh.entry,
      key: target.key,
      patch: target.fullPatch,
      sessionKey: freshCanonicalKey,
      validateModelRuntime: false,
    });
    if (placementError) {
      return err(errorShape(ErrorCodes.INVALID_REQUEST, placementError));
    }
    return ok({ freshResolved, fresh, freshCanonicalKey });
  };
  const resolved = resolveCurrent();
  if (!resolved.ok) {
    return resolved;
  }
  const { freshResolved, fresh, freshCanonicalKey } = resolved.value;
  const planningEntry = freshResolved.store[freshCanonicalKey];
  const assertCurrent = () => {
    params.personalModelSelection?.assertCurrent();
    const authorizationError = params.commitGuard();
    if (authorizationError) {
      throw new SessionMutationAuthorizationChangedError(authorizationError);
    }
    const current = resolveCurrent();
    if (!current.ok) {
      throw new SessionMutationAuthorizationChangedError(current.error);
    }
  };
  const freshCandidateKeys = new Set(fresh.target.storeKeys);
  const preview = await projectSessionsPatchEntry({
    cfg,
    existingEntry: planningEntry,
    isLabelInUse: (label) =>
      Object.entries(freshResolved.store).some(
        ([sessionKey, entry]) => !freshCandidateKeys.has(sessionKey) && entry.label === label,
      ),
    storeKey: fresh.primaryKey,
    agentId: target.requestedAgentId,
    patch: target.fullPatch,
    archivedBy: target.archiveActor,
    loadGatewayModelCatalogSnapshot: params.loadGatewayModelCatalogSnapshot,
    personalModelSelection: params.personalModelSelection,
  });
  if (!preview.ok) {
    return err(preview.error);
  }
  const previewPlacementError = await prepareSessionWorkerPlacementPatchError({
    agentId: freshResolved.agentId,
    cfg,
    context: params.context,
    entry: preview.entry,
    key: target.key,
    patch: target.fullPatch,
    sessionKey: freshCanonicalKey,
    validateModelRuntime: true,
  });
  if (previewPlacementError) {
    return err(errorShape(ErrorCodes.INVALID_REQUEST, previewPlacementError));
  }
  try {
    const drain = await prepareSessionLifecycleDrain({
      action: "archive",
      authorize: assertCurrent,
      context: params.context,
      storePath: target.storePath,
      sessionKeys: Array.from(
        new Set([
          target.key,
          target.canonicalKey,
          ...target.initialStoreKeys,
          freshCanonicalKey,
          ...fresh.target.storeKeys,
        ]),
      ),
      sessionId: fresh.entry?.sessionId,
      session: {
        ok: true,
        value: {
          cfg,
          storePath: target.storePath,
          entry: fresh.entry,
          canonicalKey: freshCanonicalKey,
          agentId: freshResolved.agentId,
        },
      },
      sessionKey: freshCanonicalKey,
      agentId: freshResolved.agentId,
      defaultAgentId: tryResolveSessionCompatibilityOwnerAgentId(cfg, freshCanonicalKey),
      lifecycleIdentities: target.lifecycleIdentities.filter((identity): identity is string =>
        Boolean(identity),
      ),
    });
    return ok({
      canonicalKey: freshCanonicalKey,
      drain,
      ...(planningEntry ? { entry: planningEntry } : {}),
    });
  } catch (error) {
    if (error instanceof SessionLifecycleWorkspaceRecoveryError) {
      return err(error.error);
    }
    if (error instanceof WorkerInferenceSessionDrainBusyError) {
      return err(
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `Session ${target.key} is already being stopped by another archive or delete request. Wait for that request to finish.`,
          { retryable: true },
        ),
      );
    }
    if (error instanceof SessionWorkerPlacementStopError) {
      return err(errorShape(ErrorCodes.UNAVAILABLE, error.message, { retryable: true }));
    }
    if (
      error instanceof SessionMutationAuthorizationChangedError ||
      error instanceof ModelAccountConnectAuthorityError
    ) {
      return err(unexpectedPatchError(target.key, error));
    }
    sessionLog.warn(
      `sessions.patch: archive drain failed for ${target.canonicalKey}: ${formatErrorMessage(error)}`,
    );
    return err(archiveUnavailableError(target.key, "stopping"));
  }
}

export function validateSessionPatchArchiveProjection(params: {
  cfg: OpenClawConfig;
  existingEntry: SessionEntry | undefined;
  fullPatch: SessionsPatchParams;
  key: string;
  pluginOwnerId?: string;
  preparation: SessionPatchArchivePreparation;
  primaryKey: string;
}): ErrorShape | undefined {
  if (params.preparation.drain.hasAuthoritativeWork()) {
    return archiveUnavailableError(params.key, "active");
  }
  if (
    params.primaryKey !== params.preparation.canonicalKey ||
    archiveTargetChanged({
      currentEntry: params.existingEntry,
      baselineEntry: params.preparation.entry,
      patch: params.fullPatch,
    })
  ) {
    return archiveChangedError(params.key);
  }
  return (
    resolveProtectedSessionVisibilityError(params.cfg, params.primaryKey, "archive") ??
    resolvePluginSessionOwnershipError({
      action: "patch",
      entry: params.existingEntry,
      key: params.primaryKey,
      pluginOwnerId: params.pluginOwnerId,
    })
  );
}

/** Restore before opening admission; durable archive metadata delegates removal to GC. */
export async function prepareSessionPatchArchiveTransition(params: {
  archived: boolean;
  entry: SessionEntry;
  context: GatewayRequestContext;
  scope: SessionAccessScope;
  authorize: () => ErrorShape | undefined;
  preparation?: SessionPatchArchivePreparation;
}): Promise<{
  assertCommitAllowed: () => void;
}> {
  const placementTarget = {
    context: params.context,
    sessionId: params.entry.sessionId,
  };
  const placement = await prepareSessionWorkerPlacementArchiveCheckAsync(placementTarget);
  let assertWorktreeMutationAllowed: (() => void) | undefined;
  const commitGuard = () => {
    const authorizationError = params.authorize();
    if (authorizationError) {
      throw new SessionMutationAuthorizationChangedError(authorizationError);
    }
    placement.assertCurrent();
    assertWorktreeMutationAllowed?.();
    if (params.preparation?.drain.hasAuthoritativeWork()) {
      throw new SessionWorktreeLifecycleError(
        "Session worktree is still active; retry the archive after work settles.",
        "busy",
      );
    }
  };
  return {
    assertCommitAllowed: params.archived
      ? commitGuard
      : await restoreSessionWorktree({
          entry: params.entry,
          scope: params.scope,
          commitGuard,
          assertRestoreAllowed: () => {
            assertWorktreeMutationAllowed =
              prepareSessionWorkerPlacementMutationCheck(placementTarget);
          },
        }),
  };
}
