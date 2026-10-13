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
import {
  captureSessionEntryMetadataRead,
  captureSessionEntrySourceAssertion,
} from "../../config/sessions/session-entry-source-authority.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { resolveMissingAgentHarnessSessionError } from "../../sessions/agent-harness-session-key.js";
import { restoreSessionWorktree } from "../../sessions/session-worktree-lifecycle.js";
import type { UserModelAccountSelection } from "../model-account-authority.js";
import { ModelAccountConnectAuthorityError } from "../model-account-connect-errors.js";
import { resolvePluginSessionOwnershipError } from "../session-plugin-ownership.js";
import { tryResolveSessionCompatibilityOwnerAgentId } from "../session-request-agent.js";
import { SessionMutationAuthorizationChangedError } from "../session-sharing.js";
import { withGatewaySessionEntryReadOnly } from "../session-utils-read-lifetime.js";
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

export async function releaseSessionPatchArchive(
  preparation?: SessionPatchArchivePreparation,
): Promise<void> {
  try {
    try {
      preparation?.drain.release();
    } finally {
      await preparation?.releaseSource?.();
    }
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
  const selected = params.target.initialTarget;
  // Planning is read-only. The source owner joins receipt publication without
  // reserving the database writer; the mutation still rereads inside its FIFO.
  const source = await captureSessionEntrySourceAssertion({
    scope: {
      agentId: selected.agentId,
      sessionKey: selected.canonicalKey,
      storePath: selected.storePath,
    },
    readSource: selected.capturedReadSource,
    expected: params.target.initialEntry,
    fields: [
      ...archivePolicyFields,
      ...(params.target.fullPatch.expectedSidebarRoot !== undefined
        ? ["sidebarRoot" as const]
        : []),
      ...(params.target.fullPatch.expectedCategory !== undefined ? ["category" as const] : []),
    ],
    assertCurrent: () => {
      params.personalModelSelection?.assertCurrent();
      const error = params.commitGuard();
      if (error) {
        throw new SessionMutationAuthorizationChangedError(error);
      }
    },
    refuse: () => {
      throw new SessionMutationAuthorizationChangedError(archiveChangedError(params.target.key));
    },
  }).prepareSessionSource();
  let transferred = false;
  try {
    const result = await prepareSessionPatchArchiveFromSource(params, {
      selected,
      readCurrent: () => params.target.initialEntry,
      isCurrent: () => {
        source.assertCurrent();
        return true;
      },
    });
    if (result.ok) {
      result.value.releaseSource = source.release;
      transferred = true;
    }
    return result;
  } finally {
    if (!transferred) {
      await source.release?.();
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
  const selected = source.selected;
  const canonicalKey = selected.canonicalKey;
  const resolveCurrent = (): Result<SessionEntry | undefined, ErrorShape> => {
    if (source.isCurrent?.() === false || selected.storePath !== target.storePath) {
      return err(archiveChangedError(target.key));
    }
    const entry = source.readCurrent();
    const ownershipError = resolvePluginSessionOwnershipError({
      action: "patch",
      entry,
      key: canonicalKey,
      pluginOwnerId: params.pluginOwnerId,
    });
    if (ownershipError) {
      return err(ownershipError);
    }
    if (
      canonicalKey !== target.canonicalKey ||
      archiveTargetChanged({
        currentEntry: entry,
        baselineEntry: target.initialEntry,
        patch: target.fullPatch,
      }) ||
      archivePolicyFields.some(
        (field) => !isDeepStrictEqual(entry?.[field], selected.store[canonicalKey]?.[field]),
      )
    ) {
      return err(archiveChangedError(target.key));
    }
    const expectationError = resolveSessionPatchTargetError(entry, target);
    if (expectationError) {
      return err(expectationError);
    }
    const missingHarnessSessionError = resolveMissingAgentHarnessSessionError(canonicalKey, entry);
    if (missingHarnessSessionError) {
      return err(errorShape(ErrorCodes.INVALID_REQUEST, missingHarnessSessionError));
    }
    const protectedError = resolveProtectedSessionVisibilityError(cfg, canonicalKey, "archive");
    if (protectedError) {
      return err(protectedError);
    }
    const placementError = resolveSessionWorkerPlacementPatchError({
      agentId: selected.agentId,
      cfg,
      context: params.context,
      entry,
      key: target.key,
      patch: target.fullPatch,
      sessionKey: canonicalKey,
      validateModelRuntime: false,
    });
    if (placementError) {
      return err(errorShape(ErrorCodes.INVALID_REQUEST, placementError));
    }
    return ok(entry);
  };
  const resolved = resolveCurrent();
  if (!resolved.ok) {
    return resolved;
  }
  const entry = resolved.value;
  const planningEntry = selected.store[canonicalKey];
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
  const candidateKeys = new Set(selected.storeKeys);
  const preview = await projectSessionsPatchEntry({
    cfg,
    existingEntry: planningEntry,
    isLabelInUse: (label) =>
      Object.entries(selected.store).some(
        ([sessionKey, candidate]) => !candidateKeys.has(sessionKey) && candidate.label === label,
      ),
    storeKey: canonicalKey,
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
    agentId: selected.agentId,
    cfg,
    context: params.context,
    entry: preview.entry,
    key: target.key,
    patch: target.fullPatch,
    sessionKey: canonicalKey,
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
          ...target.initialTarget.storeKeys,
          canonicalKey,
          ...selected.storeKeys,
        ]),
      ),
      sessionId: entry?.sessionId,
      session: {
        ok: true,
        value: {
          cfg,
          storePath: target.storePath,
          entry,
          canonicalKey,
          agentId: selected.agentId,
        },
      },
      sessionKey: canonicalKey,
      agentId: selected.agentId,
      defaultAgentId: tryResolveSessionCompatibilityOwnerAgentId(cfg, canonicalKey),
      lifecycleIdentities: target.lifecycleIdentities.filter((identity): identity is string =>
        Boolean(identity),
      ),
    });
    return ok({
      canonicalKey,
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
