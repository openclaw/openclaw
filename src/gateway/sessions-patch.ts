// Session patch applier for gateway session metadata and model/runtime overrides.
import { randomUUID } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  type ErrorShape,
  errorShape,
  type SessionsPatchParams,
} from "../../packages/gateway-protocol/src/index.js";
import { readAcpSessionMetaForEntry } from "../acp/runtime/session-meta-readonly.js";
import type { AdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import {
  requiresAgentHarnessPluginSelection,
  resolveAgentHarnessOwnerPluginIds,
} from "../agents/harness/runtime-plugin-load-plan.js";
import { selectModelCatalogRuntimeEntry } from "../agents/model-catalog-view.js";
import {
  findModelCatalogEntry,
  type ModelCatalogEntry,
  type ModelCatalogSnapshot,
} from "../agents/model-catalog.js";
import { splitTrailingAuthProfile } from "../agents/model-ref-profile.js";
import {
  type ModelRef,
  resolveDefaultModelForAgent,
  resolveSubagentConfiguredModelSelection,
} from "../agents/model-selection.js";
import { resolveEffectiveAgentRuntime } from "../agents/thinking-runtime.js";
import { normalizeGroupActivation } from "../auto-reply/group-activation.js";
import {
  applyModelRuntimeDirective,
  resolveModelRuntimeDirective,
} from "../auto-reply/reply/directive-handling.model-runtime.js";
import {
  normalizeElevatedLevel,
  normalizeFastMode,
  normalizeReasoningLevel,
  normalizeThinkLevel,
  normalizeUsageDisplay,
  resolveSupportedThinkingLevelFromProfile,
  resolveThinkingProfile,
} from "../auto-reply/thinking.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions.js";
import {
  buildSessionCreationStamp,
  type SessionCreatedVia,
} from "../config/sessions/session-entry-provenance.js";
import { isPinnableSessionEntry } from "../config/sessions/session-pin-policy.js";
import { projectCanonicalSessionEntryShape } from "../config/sessions/store-entry-shape.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import {
  isSubagentSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import { applyModelOverrideWithAuthProfileCompatibility } from "../sessions/auth-profile-preservation.js";
import {
  applyTraceOverride,
  applyVerboseOverride,
  parseTraceOverride,
  parseVerboseOverride,
} from "../sessions/level-overrides.js";
import { normalizeSendPolicy } from "../sessions/send-policy.js";
import {
  isSessionAgentAttentionIconId,
  resolveActiveSessionAgentStatus,
  sanitizeSessionAgentStatusNote,
  sessionAgentStatusExpiresAt,
  SESSION_AGENT_STATUS_MAX_TTL_MINUTES,
} from "../sessions/session-agent-status.js";
import { isUserModelAuthProfileId } from "../state/user-model-account-id.js";
import type { UserModelAccountSelection } from "./model-account-authority.js";
import {
  prepareSessionPatchModelSelection,
  resolveSessionPatchModelSelection,
} from "./server-methods/sessions-patch-model-selection.js";
import { applySessionExecutionSettings } from "./session-execution-settings.js";
import {
  isAgentSessionModelPatchOrigin,
  isSessionStatusModelPatchOrigin,
  snapshotAgentModelFallback,
} from "./session-model-patch-origin.js";
import { invalidSessionRequest as invalid } from "./session-request-error.js";
import { normalizeSessionToolOverrides } from "./session-tool-overrides.js";
import { validateSessionPatchAdmission } from "./sessions-patch-admission.js";
import { applySessionContextWindowPatch } from "./sessions-patch-context-window.js";
import { applySessionsPatchDisplayMetadata } from "./sessions-patch-display-metadata.js";
import { applySessionsPatchSubagentPolicy } from "./sessions-patch-subagent-policy.js";

type SessionPatchProjectionParams = {
  cfg: OpenClawConfig;
  creation?: { via: SessionCreatedVia; actor?: SessionEntry["createdActor"] };
  existingEntry?: SessionEntry;
  isLabelInUse: (label: string) => boolean;
  storeKey: string;
  agentId?: string;
  patch: SessionsPatchParams;
  /** Canonical root prepared by the trusted create path; never accepted from public patches. */
  preparedSessionRoot?: string;
  /** Trusted catalog runtime must own selection checks before the new row is persisted. */
  preparedAgentRuntime?: string;
  archivedBy?: SessionEntry["archivedBy"];
  providerAuthMetadataSnapshot?: Pick<PluginMetadataSnapshot, "plugins">;
  /** Exact harness owner authorized to project its new reserved session row. */
  authorizedAgentHarnessId?: string;
  personalModelSelection?: UserModelAccountSelection;
  operatorAuthority?: AdmittedRunOperatorAuthority;
  /** Resolved spawn identity supplied only by the trusted creation owner. */
  preparedModelSelection?: ModelRef;
};

type SessionPatchProjectionResult =
  | { ok: true; entry: SessionEntry; validateModelSelection?: () => ErrorShape | undefined }
  | { ok: false; error: ErrorShape };

type SessionPatchPreparation =
  | { kind: "complete"; result: SessionPatchProjectionResult }
  | {
      kind: "model-catalog";
      finish: (catalog: ModelCatalogSnapshot | undefined) => SessionPatchProjectionResult;
    };

/** Stop at the first actual catalog use without committing or acquiring runtime effects. */
export function prepareSessionsPatchEntry(
  params: SessionPatchProjectionParams,
): SessionPatchPreparation {
  const projection = projectSessionPatchSteps(params);
  const first = projection.next();
  if (first.done) {
    return { kind: "complete", result: first.value };
  }
  return {
    kind: "model-catalog",
    finish: (catalog) => {
      const completed = projection.next(catalog);
      if (!completed.done) {
        throw new Error("Session patch preparation requested the catalog more than once");
      }
      return completed.value;
    },
  };
}

/** Project a validated gateway session patch for one session entry. */
export async function projectSessionsPatchEntry(
  params: SessionPatchProjectionParams & {
    loadGatewayModelCatalogSnapshot?: () => Promise<ModelCatalogSnapshot>;
  },
): Promise<SessionPatchProjectionResult> {
  const preparation = prepareSessionsPatchEntry(params);
  if (preparation.kind === "complete") {
    return preparation.result;
  }
  if (!params.loadGatewayModelCatalogSnapshot) {
    return preparation.finish(undefined);
  }
  const catalog = await params.loadGatewayModelCatalogSnapshot();
  return preparation.finish(catalog);
}

function* projectSessionPatchSteps(
  params: SessionPatchProjectionParams,
): Generator<void, SessionPatchProjectionResult, ModelCatalogSnapshot | undefined> {
  const { cfg, storeKey, patch, creation } = params;
  const invalidPatch = validateSessionPatchAdmission(params);
  if (invalidPatch) {
    return invalidPatch;
  }
  const now = Date.now();
  const parsedAgent = parseAgentSessionKey(storeKey);
  const sessionAgentId = normalizeAgentId(
    params.agentId ?? parsedAgent?.agentId ?? resolveDefaultAgentId(cfg),
  );
  let resolvedDefault = resolveDefaultModelForAgent({ cfg, agentId: sessionAgentId });
  const subagentModelHint = isSubagentSessionKey(storeKey)
    ? resolveSubagentConfiguredModelSelection({ cfg, agentId: sessionAgentId })
    : undefined;
  const resolveThinkingRuntime = (
    provider: string,
    model: string,
    entry?: SessionEntry,
  ): string => {
    // ACP metadata can own canonical agent keys (for example agent:main:main),
    // so key shape alone cannot identify the runtime that validates thinking.
    const acpMeta = readAcpSessionMetaForEntry({
      sessionKey: storeKey,
      agentId: sessionAgentId,
      entry,
    });
    return (
      params.preparedAgentRuntime ??
      acpMeta?.backend ??
      resolveEffectiveAgentRuntime({
        cfg,
        provider,
        modelId: model,
        agentId: sessionAgentId,
        sessionKey: storeKey,
        sessionEntry: entry,
      })
    );
  };
  let loadedModelCatalog: ModelCatalogSnapshot | undefined;
  let validateModelSelection: (() => ErrorShape | undefined) | undefined;
  let catalogPrepared = false;
  function* loadPreparedModelCatalogForPatch(): Generator<
    void,
    ModelCatalogEntry[] | undefined,
    ModelCatalogSnapshot | undefined
  > {
    if (!catalogPrepared) {
      loadedModelCatalog = yield;
      catalogPrepared = true;
    }
    return loadedModelCatalog?.entries;
  }
  function* loadThinkingProfileForPatch(
    provider: string,
    model: string,
    entry?: SessionEntry,
  ): Generator<void, ReturnType<typeof resolveThinkingProfile>, ModelCatalogSnapshot | undefined> {
    const catalog = yield* loadPreparedModelCatalogForPatch();
    const agentRuntime = resolveThinkingRuntime(provider, model, entry);
    const logical = catalog
      ? findModelCatalogEntry(catalog, { provider, modelId: model })
      : undefined;
    const selected =
      logical && loadedModelCatalog
        ? selectModelCatalogRuntimeEntry({
            entry: logical,
            routeVariants: loadedModelCatalog.routeVariants,
            runtimeId: agentRuntime,
          }).entry
        : undefined;
    return resolveThinkingProfile({
      provider,
      model,
      catalog: selected ? [selected] : catalog,
      agentRuntime,
    });
  }

  const existing =
    params.existingEntry && projectCanonicalSessionEntryShape({ ...params.existingEntry });
  // Existing entries without session ids are placeholder aliases; assigning an id makes them real.
  const next: SessionEntry = {
    ...existing,
    sessionId: existing?.sessionId || randomUUID(),
    // Reset retains sessionId, so rollback also needs the original lifecycle revision.
    ...(existing?.sessionId ? {} : { lifecycleRevision: randomUUID() }),
    updatedAt: Math.max(existing?.updatedAt ?? 0, now),
    ...(params.preparedSessionRoot ? { sessionRoot: params.preparedSessionRoot } : {}),
    // Stamp only genuinely new rows; existing placeholder aliases must not be restamped.
    ...(creation && params.existingEntry === undefined ? buildSessionCreationStamp(creation) : {}),
  };
  if (existing && !existing.sessionId) {
    delete next.label;
    delete next.autoLabel;
    delete next.category;
    delete next.displayName;
  }

  const subagentPolicyError = applySessionsPatchSubagentPolicy({
    existing,
    next,
    patch,
    storeKey,
  });
  if (subagentPolicyError) {
    return invalid(subagentPolicyError);
  }

  const displayMetadataError = applySessionsPatchDisplayMetadata({
    patch,
    next,
    isLabelInUse: params.isLabelInUse,
  });
  if (displayMetadataError) {
    return invalid(displayMetadataError);
  }

  if ("statusNote" in patch || "attention" in patch || "ttlMinutes" in patch) {
    const rawNote = patch.statusNote;
    const rawAttention = patch.attention;
    const ttlMinutes = patch.ttlMinutes;
    if (
      ttlMinutes !== undefined &&
      (!Number.isInteger(ttlMinutes) ||
        ttlMinutes < 1 ||
        ttlMinutes > SESSION_AGENT_STATUS_MAX_TTL_MINUTES)
    ) {
      return invalid(`invalid ttlMinutes (use 1-${SESSION_AGENT_STATUS_MAX_TTL_MINUTES})`);
    }
    if (rawNote === null || rawAttention === null) {
      if (
        (rawNote !== undefined && rawNote !== null) ||
        (rawAttention !== undefined && rawAttention !== null)
      ) {
        return invalid("cannot clear and set agent status in the same patch");
      }
      delete next.agentStatus;
    } else {
      const current = resolveActiveSessionAgentStatus(next.agentStatus, now);
      const note = rawNote === undefined ? current?.note : sanitizeSessionAgentStatusNote(rawNote);
      if (!note) {
        return invalid("statusNote required before setting attention or ttlMinutes");
      }
      if (rawAttention !== undefined && !isSessionAgentAttentionIconId(rawAttention)) {
        return invalid("invalid attention icon");
      }
      const attention = rawAttention ?? current?.attention;
      next.agentStatus = {
        note,
        expiresAt: sessionAgentStatusExpiresAt(now, ttlMinutes),
        ...(attention ? { attention } : {}),
      };
    }
  }

  if ("archived" in patch) {
    if (patch.archived === true) {
      // Archived sessions leave the active quick-access set in the same write.
      if (next.archivedAt === undefined) {
        next.archivedAt = now;
        next.archiveReason = "manual";
        if (params.archivedBy) {
          next.archivedBy = params.archivedBy;
        } else {
          delete next.archivedBy;
        }
      }
      delete next.pinnedAt;
    } else {
      delete next.archivedAt;
      delete next.archivedBy;
      delete next.archiveReason;
    }
  }

  const pinnable = isPinnableSessionEntry(storeKey, next);
  if (!pinnable) {
    delete next.pinnedAt;
  }
  if ("pinned" in patch) {
    if (patch.pinned === true) {
      if (next.archivedAt !== undefined) {
        return invalid("cannot pin an archived session; restore it first");
      }
      if (!pinnable) {
        return invalid("cannot pin a child session; pin its parent session instead");
      }
      next.pinnedAt ??= now;
    } else {
      delete next.pinnedAt;
    }
  }

  if ("unread" in patch) {
    if (patch.unread === true) {
      // This timestamp is also the conditional-ack revision. Repeated writes in
      // one clock tick must still represent distinct manual unread intent.
      next.markedUnreadAt = Math.max(now, (params.existingEntry?.markedUnreadAt ?? 0) + 1);
    } else {
      next.lastReadAt = now;
      delete next.markedUnreadAt;
      delete next.agentStatus;
    }
  }

  const rawThinking = patch.thinkingLevel;
  if (rawThinking === null) {
    delete next.thinkingLevel;
  } else if (rawThinking !== undefined) {
    const normalized = normalizeThinkLevel(rawThinking);
    if (!normalized) {
      const hintProvider =
        normalizeOptionalString(existing?.providerOverride) || resolvedDefault.provider;
      const hintModel = normalizeOptionalString(existing?.modelOverride) || resolvedDefault.model;
      const profile = yield* loadThinkingProfileForPatch(hintProvider, hintModel, existing);
      return invalid(
        `invalid thinkingLevel (use ${profile.levels.map(({ label }) => label).join("|")})`,
      );
    }
    next.thinkingLevel = normalized;
  }

  const rawFastMode = patch.fastMode;
  if (rawFastMode === null) {
    delete next.fastMode;
  } else if (rawFastMode !== undefined) {
    const normalized = normalizeFastMode(rawFastMode);
    if (normalized === undefined) {
      return invalid('invalid fastMode (use true, false, or "auto")');
    }
    next.fastMode = normalized;
  }

  if ("toolOverrides" in patch) {
    const raw = patch.toolOverrides;
    if (raw === null) {
      delete next.toolOverrides;
    } else if (raw !== undefined) {
      // Session patches replace this sparse overlay atomically; they never deep-merge old policy.
      const normalized = normalizeSessionToolOverrides(raw);
      if (normalized) {
        next.toolOverrides = normalized;
      } else {
        delete next.toolOverrides;
      }
    }
  }

  if ("verboseLevel" in patch) {
    const parsed = parseVerboseOverride(patch.verboseLevel);
    if (!parsed.ok) {
      return invalid(parsed.error);
    }
    applyVerboseOverride(next, parsed.value);
  }

  if ("traceLevel" in patch) {
    const parsed = parseTraceOverride(patch.traceLevel);
    if (!parsed.ok) {
      return invalid(parsed.error);
    }
    applyTraceOverride(next, parsed.value);
  }

  if ("reasoningLevel" in patch) {
    const raw = patch.reasoningLevel;
    if (raw === null) {
      delete next.reasoningLevel;
    } else if (raw !== undefined) {
      const normalized = normalizeReasoningLevel(raw);
      if (!normalized) {
        return invalid('invalid reasoningLevel (use "on"|"off"|"stream")');
      }
      // Persist "off" explicitly so that resolveDefaultReasoningLevel()
      // does not re-enable reasoning for capable models (#24406).
      next.reasoningLevel = normalized;
    }
  }

  const rawResponseUsage = patch.responseUsage;
  if (rawResponseUsage === null) {
    delete next.responseUsage;
  } else if (rawResponseUsage !== undefined) {
    const normalized = normalizeUsageDisplay(rawResponseUsage);
    if (!normalized) {
      return invalid('invalid responseUsage (use "off"|"tokens"|"full")');
    }
    next.responseUsage = normalized;
  }

  if ("elevatedLevel" in patch) {
    const raw = patch.elevatedLevel;
    if (raw === null) {
      delete next.elevatedLevel;
    } else if (raw !== undefined) {
      const normalized = normalizeElevatedLevel(raw);
      if (!normalized) {
        return invalid('invalid elevatedLevel (use "on"|"off"|"ask"|"full")');
      }
      // Persist "off" explicitly so patches can override defaults.
      next.elevatedLevel = normalized;
    }
  }

  const executionError = applySessionExecutionSettings(next, patch);
  if (executionError) {
    return invalid(executionError);
  }
  if (
    "agentRuntime" in patch &&
    readAcpSessionMetaForEntry({ sessionKey: storeKey, agentId: sessionAgentId, entry: existing })
  ) {
    return invalid("Runtime selection is owned by this ACP session.");
  }
  if (patch.agentRuntime === null) {
    applyModelRuntimeDirective(next, { kind: "clear" });
  }
  if (typeof patch.nativeRuntimeConsent === "string" && typeof patch.model !== "string") {
    yield* loadPreparedModelCatalogForPatch();
  }
  if ("model" in patch) {
    const statusModelPatch = isSessionStatusModelPatchOrigin();
    const agentModelFallback = isAgentSessionModelPatchOrigin()
      ? next.modelFallback?.source === "agent-patch"
        ? { ...next.modelFallback, ts: Math.max(now, next.modelFallback.ts + 1) }
        : snapshotAgentModelFallback(cfg, next, sessionAgentId, now)
      : undefined;
    if (!statusModelPatch) {
      delete next.modelFallback;
    }
    const raw = patch.model;
    let selection: (ModelRef & { profile?: string; isDefault: boolean }) | undefined;
    if (raw === null) {
      selection = { ...resolvedDefault, isDefault: true };
    } else if (raw !== undefined) {
      const trimmed = normalizeOptionalString(raw) ?? "";
      if (!trimmed) {
        return invalid("invalid model: empty");
      }
      const catalog = yield* loadPreparedModelCatalogForPatch();
      if (!catalog) {
        return {
          ok: false,
          error: errorShape(
            ErrorCodes.UNAVAILABLE,
            "model catalog is still loading; retry in a few seconds",
          ),
        };
      }
      const resolved = resolveSessionPatchModelSelection({
        cfg,
        agentId: sessionAgentId,
        catalog,
        raw: trimmed,
        defaultProvider:
          (statusModelPatch && next.providerOverride?.trim()) || resolvedDefault.provider,
        defaultModel: resolvedDefault.model,
        subagentModelHint,
        preparedModelSelection: params.preparedModelSelection,
      });
      if (!resolved.ok) {
        return invalid(resolved.error);
      }
      selection = resolved;
    }
    if (selection) {
      const prepared = prepareSessionPatchModelSelection({
        cfg,
        agentId: sessionAgentId,
        selection,
        resetToDefault: raw === null,
        operatorAuthority: params.operatorAuthority,
      });
      if (!prepared.ok) {
        return prepared;
      }
      selection = prepared.selection;
      validateModelSelection = params.operatorAuthority ? prepared.validate : undefined;
      if (raw === null) {
        resolvedDefault = selection;
      }
      if (
        typeof patch.agentRuntime === "string" &&
        splitTrailingAuthProfile(raw ?? "").model !== `${selection.provider}/${selection.model}`
      ) {
        return invalid("agentRuntime requires an explicit canonical provider/model selection");
      }
      const runtime = resolveModelRuntimeDirective({
        cfg,
        provider: selection.provider,
        rawRuntime: patch.agentRuntime ?? undefined,
        sessionEntry: next,
      });
      if (runtime.kind === "invalid") {
        return invalid(runtime.errorText);
      }
      if (
        typeof patch.agentRuntime === "string" &&
        (runtime.kind !== "set" || runtime.runtime !== patch.agentRuntime)
      ) {
        return invalid("Use a canonical agentRuntime id, or null to follow configured routing");
      }
      applyModelRuntimeDirective(next, runtime);
      if (selection.profile && isUserModelAuthProfileId(selection.profile)) {
        if (params.personalModelSelection?.authProfileId !== selection.profile) {
          return {
            ok: false,
            error: errorShape(
              ErrorCodes.FORBIDDEN,
              "Choose your personal account from an identified Gateway connection.",
            ),
          };
        }
        params.personalModelSelection.assertCurrent();
      }
      // Catalog membership does not guarantee an activatable harness. Reject before
      // committing the session so sticky defaults cannot retain an unusable selection.
      const harnessSelection = {
        provider: selection.provider,
        modelId: selection.model,
        runtime: resolveThinkingRuntime(selection.provider, selection.model, next),
        agentId: sessionAgentId,
      };
      if (
        !readAcpSessionMetaForEntry({
          sessionKey: storeKey,
          agentId: sessionAgentId,
          entry: next,
        }) &&
        requiresAgentHarnessPluginSelection(harnessSelection, cfg) &&
        resolveAgentHarnessOwnerPluginIds({
          ...harnessSelection,
          config: cfg,
          workspaceDir: resolveAgentWorkspaceDir(cfg, sessionAgentId),
        }).length === 0
      ) {
        return invalid(
          `Model ${selection.provider}/${selection.model} requires agent harness "${harnessSelection.runtime}", but no enabled plugin provides it. Install and enable its plugin, restart the Gateway, then select the model again.`,
        );
      }
      applyModelOverrideWithAuthProfileCompatibility({
        cfg,
        agentDir: resolveAgentDir(cfg, sessionAgentId),
        entry: next,
        currentProvider: next.providerOverride ?? next.modelProvider ?? resolvedDefault.provider,
        selection,
        explicitDefaultSelection: raw === null || (statusModelPatch && selection.isDefault),
        profileOverride: selection.profile,
        ...(params.providerAuthMetadataSnapshot
          ? { metadataSnapshot: params.providerAuthMetadataSnapshot }
          : {}),
        markLiveSwitchPending: statusModelPatch || raw !== null,
      });
      if (raw === null && !statusModelPatch) {
        delete next.liveModelSwitchPending;
      }
    }
    if (agentModelFallback) {
      next.modelFallback = agentModelFallback;
    }
  }

  if ("thinkingLevel" in patch || "model" in patch || "agentRuntime" in patch) {
    const effectiveProvider = next.providerOverride ?? resolvedDefault.provider;
    const effectiveModel = next.modelOverride ?? resolvedDefault.model;
    const thinkingLevel = normalizeThinkLevel(next.thinkingLevel);
    if (!thinkingLevel) {
      delete next.thinkingLevel;
    } else {
      const profile = yield* loadThinkingProfileForPatch(effectiveProvider, effectiveModel, next);
      if ("thinkingLevel" in patch && !profile.levels.some(({ id }) => id === thinkingLevel)) {
        return invalid(
          `thinkingLevel "${thinkingLevel}" is not supported for ${effectiveProvider}/${effectiveModel} (use ${profile.levels.map(({ label }) => label).join("|")})`,
        );
      }
      next.thinkingLevel = resolveSupportedThinkingLevelFromProfile(profile, thinkingLevel);
    }
  }

  const contextWindowPatch = yield* applySessionContextWindowPatch({
    defaultModel: resolvedDefault.model,
    defaultProvider: resolvedDefault.provider,
    loadModelCatalog: loadPreparedModelCatalogForPatch,
    runtimeId: resolveThinkingRuntime,
    routeVariants: () => loadedModelCatalog?.routeVariants,
    next,
    patch,
  });
  if (!contextWindowPatch.ok) {
    return invalid(contextWindowPatch.error);
  }

  // Independent preference changes must survive a later model rollback. Copy
  // the marker so previews and prepared patches keep their input snapshot intact.
  if (
    next.modelFallback?.source === "agent-patch" &&
    !("model" in patch) &&
    ("thinkingLevel" in patch || "contextWindow" in patch)
  ) {
    next.modelFallback = {
      ...next.modelFallback,
      ...("thinkingLevel" in patch ? { prevThinkingLevel: next.thinkingLevel } : {}),
      ...("contextWindow" in patch ? { prevContextWindow: next.contextWindow } : {}),
    };
  }

  if ("sendPolicy" in patch) {
    const raw = patch.sendPolicy;
    if (raw === null) {
      delete next.sendPolicy;
    } else if (raw !== undefined) {
      const normalized = normalizeSendPolicy(raw);
      if (!normalized) {
        return invalid('invalid sendPolicy (use "allow"|"deny")');
      }
      next.sendPolicy = normalized;
    }
  }

  if ("groupActivation" in patch) {
    const raw = patch.groupActivation;
    if (raw === null) {
      delete next.groupActivation;
    } else if (raw !== undefined) {
      const normalized = normalizeGroupActivation(raw);
      if (!normalized) {
        return invalid('invalid groupActivation (use "mention"|"always")');
      }
      next.groupActivation = normalized;
    }
  }

  if ("agentRuntime" in patch && existing?.agentRuntimeOverride !== next.agentRuntimeOverride) {
    delete next.contextTokens;
    delete next.contextTokensSource;
    delete next.contextBudgetStatus;
    next.liveModelSwitchPending = true;
  }

  // Fresh rows and placeholder aliases have no running model to replace. Model
  // and context-window initialization must not queue a switch on their first turn.
  if (!existing?.sessionId) {
    delete next.liveModelSwitchPending;
  }

  return { ok: true, entry: next, ...(validateModelSelection ? { validateModelSelection } : {}) };
}
