import {
  assertOperatorModelAllowed,
  createOperatorModelSelectionAssertion,
  type AdmittedRunOperatorAuthority,
} from "../agents/admitted-run-context.js";
import { resolveAgentDir, type AgentModelPrimaryWriteTarget } from "../agents/agent-scope.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import { modelKey, resolveDefaultModelForAgent } from "../agents/model-selection.js";
import {
  createModelVisibilityPolicy,
  type ModelVisibilityPolicy,
} from "../agents/model-visibility-policy.js";
import { resolveContextConfigProviderForRuntime } from "../agents/openai-routing.js";
import { resolveOperatorModelDefault } from "../agents/operator-model-policy.js";
import {
  persistStickyModelSelectionBestEffort,
  type StickyModelSelectionDispatchOutcome,
} from "../agents/sticky-model-selection.js";
import { resolveEffectiveAgentRuntime } from "../agents/thinking-runtime.js";
import { applyModelRuntimeDirective } from "../auto-reply/reply/directive-handling.model-runtime.js";
import {
  prepareModelSelectionRuntime,
  findSelectedCatalogEntry,
} from "../auto-reply/reply/model-runtime-normalization.js";
import { resolveContextTokens } from "../auto-reply/reply/model-selection-context.js";
import { refreshQueuedFollowupSession } from "../auto-reply/reply/queue.js";
import { hasPendingFollowupQueueWork } from "../auto-reply/reply/queue/state.js";
import { persistReplySessionEntry } from "../auto-reply/reply/session-entry-persistence.js";
import type { ThinkLevel } from "../auto-reply/thinking.shared.js";
import { resolveCollapsedSessionAuthPinSource } from "../config/sessions/auth-profile-override-provenance.js";
import {
  adoptPersistedSessionSnapshot,
  SESSION_MODEL_OVERRIDE_TRANSACTION_FIELDS,
  sessionModelOverrideChangesApplied,
} from "../config/sessions/session-snapshot-merge.js";
import { composeSessionSourceAssertion } from "../config/sessions/session-source-authority.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { triggerSessionPatchHook } from "../gateway/session-patch-hooks.js";
import { resolveSessionWorkerPlacementContext } from "../gateway/session-worker-placement-context.js";
import {
  resolveWorkerPlacementSessionRuntimeCapabilities,
  resolveWorkerPlacementSessionRuntimeCapabilitiesAsync,
} from "../gateway/worker-environments/placement-session-runtime.js";
import { readSessionWorkerPlacementAsync } from "../gateway/worker-environments/session-placement-lifecycle.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resolveSystemEventQueueKey } from "../infra/system-event-ownership.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { applyModelOverrideWithAuthProfileCompatibility } from "../sessions/auth-profile-preservation.js";
import {
  isModelSelectionLocked,
  MODEL_SELECTION_LOCKED_MESSAGE,
} from "../sessions/model-overrides.js";
import { emitSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";

export type SessionModelSelectionRequest = {
  provider: string;
  model: string;
  isDefault: boolean;
  resetToDefault?: true;
  alias?: string;
  profileOverride?: string;
  runtime: { kind: "unchanged" } | { kind: "clear" } | { kind: "set"; runtime: string };
};

export type ApplySessionModelSelectionParams = {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  storePath?: string;
  sessionEntry: SessionEntry;
  sessionStore: Record<string, SessionEntry>;
  allowCreate?: boolean;
  defaultProvider: string;
  defaultModel: string;
  currentProvider: string;
  currentModel: string;
  modelPolicy?: Omit<ModelVisibilityPolicy, "catalog">;
  modelCatalog: readonly ModelCatalogEntry[];
  thinkingCatalog?: readonly ModelCatalogEntry[];
  canPersistStickyModelSelection?: boolean;
  stickyModelSelectionTarget?: AgentModelPrimaryWriteTarget;
  validateAuthProfileSelection?: () => string | undefined;
  request: SessionModelSelectionRequest;
  /** Raw directive text used only by the existing session patch hook. */
  patchModel?: string;
  markLiveSwitchPending: true;
};

export type InternalApplySessionModelSelectionParams = ApplySessionModelSelectionParams & {
  operatorAuthority?: AdmittedRunOperatorAuthority;
  /** Set only by the released SDK adapter for its opaque synchronous validator. */
  nativeCommitValidation?: true;
};

export type ApplySessionModelSelectionResult =
  | {
      status: "applied";
      provider: string;
      model: string;
      effectiveModelRef: string;
      agentRuntime: string;
      changed: boolean;
      contextTokens: number;
      configuredDefaultUpdate?: StickyModelSelectionDispatchOutcome;
      runtimeChange?: { kind: "clear" } | { kind: "set"; runtime: string };
      /** @deprecated No longer emitted; retained for source compatibility until the next SDK major. */
      thinkingRemap?: {
        from: ThinkLevel;
        to: ThinkLevel;
        provider: string;
        model: string;
      };
    }
  | {
      status: "rejected";
      reason: "locked" | "not-allowed" | "invalid-runtime" | "unknown-provider";
      message: string;
    }
  | { status: "conflict"; message: string };

function formatModelSwitchEvent(provider: string, model: string, alias?: string): string {
  const label = `${provider}/${model}`;
  return alias ? `Model switched to ${alias} (${label}).` : `Model switched to ${label}.`;
}

function rejectNotAllowed(provider: string, model: string): ApplySessionModelSelectionResult {
  return {
    status: "rejected",
    reason: "not-allowed",
    message: `Model ${provider}/${model} is not available for this agent.`,
  };
}

/**
 * Rejects a model selection when the candidate runtime is incompatible with an
 * active cloud-worker placement. Mirrors the sessions.patch guard so directive
 * model changes are validated before they persist.
 */
function resolveActivePlacementModelSelectionError(
  params: {
    cfg: OpenClawConfig;
    agentId: string;
    sessionKey: string;
    entry: SessionEntry;
  },
  prepared?: {
    placement: Awaited<ReturnType<typeof readSessionWorkerPlacementAsync>>;
    runtime?: ReturnType<typeof resolveWorkerPlacementSessionRuntimeCapabilities>;
  },
): string | undefined {
  const sessionId = params.entry.sessionId;
  if (!sessionId) {
    return undefined;
  }
  const placementService = resolveSessionWorkerPlacementContext().workerSessionPlacementService;
  const placement = prepared
    ? prepared.placement
    : placementService?.getMany([sessionId]).get(sessionId);
  if (!placement || placement.state === "local") {
    return undefined;
  }
  const { executionMode } =
    prepared?.runtime ??
    resolveWorkerPlacementSessionRuntimeCapabilities({
      cfg: params.cfg,
      entry: params.entry,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
    });
  if (executionMode === placement.executionMode) {
    return undefined;
  }
  return executionMode
    ? `Session cannot change cloud placement execution mode while placement is ${placement.state}.`
    : `Session cannot select a runtime without cloud placement support while cloud worker placement is ${placement.state}.`;
}

/** Applies one validated picker selection to the authoritative live session. */
export async function applySessionModelSelectionInternal(
  params: InternalApplySessionModelSelectionParams,
): Promise<ApplySessionModelSelectionResult> {
  const startingStoreEntry = params.sessionStore[params.sessionKey];
  const startingEntry = params.storePath
    ? params.sessionEntry
    : (startingStoreEntry ?? params.sessionEntry);
  const initialEntry = { ...startingEntry };
  if (isModelSelectionLocked(startingEntry)) {
    return { status: "rejected", reason: "locked", message: MODEL_SELECTION_LOCKED_MESSAGE };
  }
  const operatorScope = params.operatorAuthority
    ? undefined
    : (
        await import("../gateway/operator-invocation-authority.js")
      ).captureOperatorToolGatewayAuthority();
  const operatorAuthority = params.operatorAuthority ?? operatorScope?.authority;

  const resetToDefault = params.request.resetToDefault === true;
  const policy =
    params.modelPolicy ??
    createModelVisibilityPolicy({
      cfg: params.cfg,
      catalog: [...params.modelCatalog],
      defaultProvider: params.defaultProvider,
      defaultModel: { provider: params.defaultProvider, model: params.defaultModel },
      agentId: params.agentId,
    });
  const selectedRef = resetToDefault
    ? resolveOperatorModelDefault({
        cfg: params.cfg,
        agentId: params.agentId,
        policy: operatorAuthority?.modelPolicy,
        model: resolveDefaultModelForAgent({ cfg: params.cfg, agentId: params.agentId }),
        allows: policy.allows,
      })
    : params.request;
  const validateOperatorSelection = () => {
    try {
      operatorScope?.assertCurrent();
      assertOperatorModelAllowed(operatorAuthority, selectedRef);
      return undefined;
    } catch (error) {
      return formatErrorMessage(error);
    }
  };
  const operatorError = validateOperatorSelection();
  if (operatorError || !selectedRef) {
    return {
      status: "rejected",
      reason: "not-allowed",
      message: operatorError ?? "No model is available for this operator role and agent.",
    };
  }
  const normalizedModelKey = modelKey(selectedRef.provider, selectedRef.model);
  const request: SessionModelSelectionRequest = {
    ...params.request,
    provider: selectedRef.provider,
    model: selectedRef.model,
    isDefault:
      resetToDefault ||
      normalizedModelKey === modelKey(params.defaultProvider, params.defaultModel),
  };
  if (!resetToDefault && !policy.allows(request)) {
    return rejectNotAllowed(request.provider, request.model);
  }

  const prepared = await prepareModelSelectionRuntime({
    cfg: params.cfg,
    agentId: params.agentId,
    workspaceDir: startingEntry.spawnedWorkspaceDir,
    sessionEntry: startingEntry,
    profileOverride: request.profileOverride,
    provider: request.provider,
    model: request.model,
    catalog: params.thinkingCatalog ?? params.modelCatalog,
    thinkingPolicyRequired: hasPendingFollowupQueueWork([params.sessionKey]),
    rawRuntime:
      request.runtime.kind === "set"
        ? request.runtime.runtime
        : request.runtime.kind === "clear"
          ? "default"
          : undefined,
  });
  if (prepared.status === "rejected") {
    return prepared;
  }
  const validateSelection = () =>
    validateOperatorSelection() ??
    params.validateAuthProfileSelection?.() ??
    prepared.validateRuntimeSelection?.();
  const authProfileError = validateSelection();
  if (authProfileError) {
    return { status: "rejected", reason: "not-allowed", message: authProfileError };
  }
  const runtime = prepared.runtime;
  const thinkingCatalog = prepared.catalog;
  const selectedCatalogEntry = findSelectedCatalogEntry({ catalog: thinkingCatalog, ...request });
  const nextEntry = { ...startingEntry };
  const modelChange = applyModelOverrideWithAuthProfileCompatibility({
    cfg: params.cfg,
    agentDir: resolveAgentDir(params.cfg, params.agentId),
    entry: nextEntry,
    currentProvider: params.currentProvider,
    selection: request,
    explicitDefaultSelection: request.isDefault,
    profileOverride: request.profileOverride,
    markLiveSwitchPending: params.markLiveSwitchPending,
  });
  const runtimeChange = applyModelRuntimeDirective(nextEntry, runtime);
  const selectionChanged = modelChange.updated || runtimeChange.updated;
  const placement = await readSessionWorkerPlacementAsync({
    context: resolveSessionWorkerPlacementContext(),
    sessionId: nextEntry.sessionId,
  });
  const placementRuntime =
    placement && placement.state !== "local"
      ? await resolveWorkerPlacementSessionRuntimeCapabilitiesAsync({
          cfg: params.cfg,
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          entry: nextEntry,
        })
      : undefined;
  const placementError = resolveActivePlacementModelSelectionError(
    {
      cfg: params.cfg,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      entry: nextEntry,
    },
    {
      placement,
      runtime: placementRuntime,
    },
  );
  if (placementError) {
    return { status: "rejected", reason: "invalid-runtime", message: placementError };
  }
  // An explicit selection retains the existing persistence and conflict semantics even when idempotent.
  nextEntry.updatedAt = Date.now();
  let persistedEntry: SessionEntry;
  // The pre-persistence read above can be overtaken by placement activation before the
  // durable write commits. Revalidate placement inside the synchronous commit boundary so an
  // override that became incompatible during that window is rejected without mutating state.
  const validateCommit = () =>
    params.validateAuthProfileSelection?.() ??
    prepared.validateRuntimeSelection?.() ??
    resolveActivePlacementModelSelectionError({
      cfg: params.cfg,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      entry: nextEntry,
    });
  if (params.storePath) {
    const persistence = await persistReplySessionEntry({
      storePath: params.storePath,
      sessionKey: params.sessionKey,
      initialEntry,
      entry: nextEntry,
      allowCreate: params.allowCreate,
      reassertLiveModelSwitchPending: selectionChanged && nextEntry.liveModelSwitchPending === true,
      requireModelSelectionUnlocked: true,
      touchedFields: SESSION_MODEL_OVERRIDE_TRANSACTION_FIELDS,
      commitGuard: composeSessionSourceAssertion([
        operatorScope?.assertCurrent,
        createOperatorModelSelectionAssertion(operatorAuthority, selectedRef),
      ]),
      validateCommit,
      nativeCommitValidation: params.nativeCommitValidation,
    });
    if (persistence.entry) {
      params.sessionStore[params.sessionKey] = persistence.entry;
      adoptPersistedSessionSnapshot(params.sessionEntry, persistence.entry);
    }
    if (persistence.status === "model-selection-locked") {
      return { status: "rejected", reason: "locked", message: MODEL_SELECTION_LOCKED_MESSAGE };
    }
    if (persistence.status === "commit-rejected") {
      return { status: "rejected", reason: "not-allowed", message: persistence.error };
    }
    if (
      persistence.status !== "current" ||
      !sessionModelOverrideChangesApplied({
        initial: initialEntry,
        next: nextEntry,
        current: persistence.entry,
        reassertLiveModelSwitchPending:
          selectionChanged && nextEntry.liveModelSwitchPending === true,
      })
    ) {
      return {
        status: "conflict",
        message: "Model change was not applied because the session changed. Retry.",
      };
    }
    persistedEntry = persistence.entry;
  } else {
    const commitError = validateOperatorSelection() ?? validateCommit();
    if (commitError) {
      return { status: "rejected", reason: "not-allowed", message: commitError };
    }
    // Both metadata and placement preparation can yield. Fence the in-memory
    // write here, where persisted sessions enforce their lock and identity.
    const currentEntry = params.sessionStore[params.sessionKey] ?? params.sessionEntry;
    if (isModelSelectionLocked(currentEntry)) {
      return { status: "rejected", reason: "locked", message: MODEL_SELECTION_LOCKED_MESSAGE };
    }
    if (
      params.sessionStore[params.sessionKey] !== startingStoreEntry ||
      currentEntry.sessionId !== initialEntry.sessionId
    ) {
      return {
        status: "conflict",
        message: "Model change was not applied because the session changed. Retry.",
      };
    }
    adoptPersistedSessionSnapshot(params.sessionEntry, nextEntry);
    params.sessionStore[params.sessionKey] = params.sessionEntry;
    persistedEntry = params.sessionEntry;
  }

  const agentRuntime = resolveEffectiveAgentRuntime({
    cfg: params.cfg,
    provider: request.provider,
    modelId: request.model,
    modelApi: selectedCatalogEntry?.api,
    modelBaseUrl: selectedCatalogEntry?.baseUrl,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionEntry: persistedEntry,
  });

  const provider = request.provider;
  const model = request.model;
  const effectiveModelRef = `${provider}/${model}`;
  operatorScope?.assertCurrent();
  assertOperatorModelAllowed(operatorAuthority, request);
  const configuredDefaultUpdate =
    params.canPersistStickyModelSelection === true &&
    (!request.isDefault || params.stickyModelSelectionTarget)
      ? persistStickyModelSelectionBestEffort({
          agentId: params.agentId,
          model: effectiveModelRef,
          // The shipped SDK opt-in resolves its effective layer inside the config mutation.
          // Ordinary chat callers supply an authorized target or leave persistence disabled.
          target: params.stickyModelSelectionTarget ?? "effective",
        })
      : undefined;
  if (selectionChanged) {
    emitSessionLifecycleEvent({
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      reason: "patch",
      catalogChanged: true,
    });
    triggerSessionPatchHook({
      cfg: params.cfg,
      sessionEntry: persistedEntry,
      sessionKey: params.sessionKey,
      patch: { key: params.sessionKey, model: params.patchModel ?? effectiveModelRef },
    });
    refreshQueuedFollowupSession({
      key: params.sessionKey,
      nextProvider: provider,
      nextModel: model,
      nextRouteResolution: "resolved",
      nextModelOverrideSource: request.isDefault ? undefined : "user",
      nextAuthProfileId: persistedEntry.authProfileOverride,
      nextAuthProfileIdSource: resolveCollapsedSessionAuthPinSource(persistedEntry),
      nextThinking: {
        level: persistedEntry.thinkingLevel,
        catalog: [...thinkingCatalog],
        agentRuntime,
      },
    });
  }

  if (`${params.currentProvider}/${params.currentModel}` !== effectiveModelRef) {
    enqueueSystemEvent(formatModelSwitchEvent(provider, model, request.alias), {
      sessionKey: resolveSystemEventQueueKey(params.sessionKey, params.agentId),
      contextKey: `model:${effectiveModelRef}`,
    });
  }

  const contextProvider = resolveContextConfigProviderForRuntime({
    provider,
    runtimeId: agentRuntime,
    config: params.cfg,
  });
  return {
    status: "applied",
    provider,
    model,
    effectiveModelRef,
    agentRuntime,
    changed: selectionChanged,
    contextTokens: resolveContextTokens({
      cfg: params.cfg,
      provider: contextProvider,
      model,
      modelContextWindow: selectedCatalogEntry?.contextWindow,
      modelContextTokens: selectedCatalogEntry?.contextTokens,
    }),
    ...(configuredDefaultUpdate ? { configuredDefaultUpdate } : {}),
    ...(runtime.kind === "clear" || runtime.kind === "set" ? { runtimeChange: runtime } : {}),
  };
}
