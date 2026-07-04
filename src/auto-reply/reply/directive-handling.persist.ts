// Persists directive-derived session preferences such as model and auth choices.
import {
  resolveAgentDir,
  resolveDefaultAgentId,
  resolveSessionAgentId,
} from "../../agents/agent-scope.js";
import { resolveCliRuntimeModelBackendBinding } from "../../agents/cli-backends.js";
import { resolveAgentHarnessPolicy } from "../../agents/harness/policy.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import {
  modelKey,
  normalizeProviderId,
  type ModelAliasIndex,
} from "../../agents/model-selection.js";
import { resolveContextConfigProviderForRuntime } from "../../agents/openai-routing.js";
import {
  adoptPersistedSessionSnapshot,
  sessionModelOverrideChangesApplied,
  sessionSnapshotChangesApplied,
} from "../../config/sessions/session-snapshot-merge.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { triggerSessionPatchHook } from "../../gateway/session-patch-hooks.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { applyTraceOverride, applyVerboseOverride } from "../../sessions/level-overrides.js";
import { applyModelOverrideToSessionEntry } from "../../sessions/model-overrides.js";
import { isThinkingLevelSupported, resolveSupportedThinkingLevel } from "../thinking.js";
import { resolveModelSelectionFromDirective } from "./directive-handling.model-selection.js";
import type { InlineDirectives } from "./directive-handling.parse.js";
import {
  canPersistSessionDirectiveDefaults,
  enqueueModeSwitchEvents,
  resolveDirectiveTouchedSessionFields,
} from "./directive-handling.shared.js";
import type { ElevatedLevel, ReasoningLevel, ThinkLevel } from "./directives.js";
import { resolveContextTokens } from "./model-selection.js";
import { persistReplySessionEntry } from "./session-entry-persistence.js";

export type PersistedThinkingLevelRemap = {
  from: ThinkLevel;
  to: ThinkLevel;
  provider: string;
  model: string;
};

const MODEL_RUNTIME_CLEAR_VALUES = new Set(["auto", "default"]);

function resolveModelRuntimeOverride(params: {
  rawRuntime?: string;
  provider: string;
  cfg: OpenClawConfig;
}):
  | { kind: "clear" }
  | { kind: "set"; runtime: string }
  | { kind: "invalid"; runtime: string }
  | undefined {
  const rawRuntime = params.rawRuntime?.trim();
  if (!rawRuntime) {
    return undefined;
  }

  const runtime = normalizeProviderId(rawRuntime);
  if (MODEL_RUNTIME_CLEAR_VALUES.has(runtime)) {
    return { kind: "clear" };
  }
  if (runtime === "openclaw") {
    return { kind: "set", runtime: "openclaw" };
  }
  if (normalizeProviderId(params.provider) === "openai" && runtime === "codex") {
    return { kind: "set", runtime: "codex" };
  }

  const provider = normalizeProviderId(params.provider);
  const backend = resolveCliRuntimeModelBackendBinding({
    config: params.cfg,
    provider,
    runtime,
  });
  if (backend) {
    return { kind: "set", runtime: backend.runtime };
  }

  return { kind: "invalid", runtime: rawRuntime };
}

export async function persistInlineDirectives(params: {
  directives: InlineDirectives;
  effectiveModelDirective?: string;
  cfg: OpenClawConfig;
  agentDir?: string;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  elevatedEnabled: boolean;
  elevatedAllowed: boolean;
  defaultProvider: string;
  defaultModel: string;
  aliasIndex: ModelAliasIndex;
  allowedModelKeys: Set<string>;
  provider: string;
  model: string;
  initialModelLabel: string;
  formatModelSwitchEvent: (label: string, alias?: string) => string;
  agentCfg: NonNullable<OpenClawConfig["agents"]>["defaults"] | undefined;
  messageProvider?: string;
  surface?: string;
  gatewayClientScopes?: string[];
  commandAuthorized?: boolean;
  senderIsOwner?: boolean;
  markLiveSwitchPending?: boolean;
  modelCatalog?: ModelCatalogEntry[];
  thinkingCatalog?: ModelCatalogEntry[];
}): Promise<{
  provider: string;
  model: string;
  contextTokens: number;
  sessionChangesApplied: boolean;
  thinkingRemap?: PersistedThinkingLevelRemap;
}> {
  const {
    directives,
    cfg,
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    elevatedEnabled,
    elevatedAllowed,
    defaultProvider,
    defaultModel,
    aliasIndex,
    allowedModelKeys,
    initialModelLabel,
    formatModelSwitchEvent,
    agentCfg,
  } = params;
  let { provider, model } = params;
  let thinkingRemap: PersistedThinkingLevelRemap | undefined;
  let sessionChangesApplied = true;
  const allowInternalExecPersistence = canPersistSessionDirectiveDefaults({
    messageProvider: params.messageProvider,
    surface: params.surface,
    gatewayClientScopes: params.gatewayClientScopes,
    commandAuthorized: params.commandAuthorized,
    senderIsOwner: params.senderIsOwner,
  });
  const allowInternalVerbosePersistence = canPersistSessionDirectiveDefaults({
    messageProvider: params.messageProvider,
    surface: params.surface,
    gatewayClientScopes: params.gatewayClientScopes,
    commandAuthorized: params.commandAuthorized,
    senderIsOwner: params.senderIsOwner,
  });
  const touchedSessionFields = resolveDirectiveTouchedSessionFields({
    directives,
    allowInternalExecPersistence,
    allowInternalVerbosePersistence,
  });
  const thinkingCatalog =
    params.thinkingCatalog && params.thinkingCatalog.length > 0
      ? params.thinkingCatalog
      : undefined;
  const delegatedTraceAllowed = (params.gatewayClientScopes ?? []).includes("operator.admin");
  const activeAgentId = sessionKey
    ? resolveSessionAgentId({ sessionKey, config: cfg })
    : resolveDefaultAgentId(cfg);
  const agentDir = resolveAgentDir(cfg, activeAgentId) ?? params.agentDir;

  if (sessionEntry && sessionStore && sessionKey) {
    const initialSessionEntry = { ...sessionEntry };
    let appliedSessionEntry = sessionEntry;
    const prevElevatedLevel =
      (sessionEntry.elevatedLevel as ElevatedLevel | undefined) ??
      (agentCfg?.elevatedDefault as ElevatedLevel | undefined) ??
      (elevatedAllowed ? ("on" as ElevatedLevel) : ("off" as ElevatedLevel));
    const prevReasoningLevel = (sessionEntry.reasoningLevel as ReasoningLevel | undefined) ?? "off";
    let elevatedChanged =
      directives.hasElevatedDirective &&
      directives.elevatedLevel !== undefined &&
      elevatedEnabled &&
      elevatedAllowed;
    let reasoningChanged =
      directives.hasReasoningDirective && directives.reasoningLevel !== undefined;
    let updated = false;

    if (directives.clearThinkLevel) {
      if (sessionEntry.thinkingLevel) {
        delete sessionEntry.thinkingLevel;
        updated = true;
      }
    } else if (directives.hasThinkDirective && directives.thinkLevel) {
      sessionEntry.thinkingLevel = directives.thinkLevel;
      updated = true;
    }
    if (directives.clearFastMode) {
      if (sessionEntry.fastMode !== undefined) {
        delete sessionEntry.fastMode;
        updated = true;
      }
    }
    if (
      directives.hasVerboseDirective &&
      directives.verboseLevel &&
      allowInternalVerbosePersistence
    ) {
      applyVerboseOverride(sessionEntry, directives.verboseLevel);
      updated = true;
    }
    if (
      directives.hasTraceDirective &&
      directives.traceLevel &&
      (params.senderIsOwner || delegatedTraceAllowed)
    ) {
      applyTraceOverride(sessionEntry, directives.traceLevel);
      updated = true;
    }
    if (directives.hasReasoningDirective && directives.reasoningLevel) {
      if (directives.reasoningLevel === "off") {
        // Persist explicit off so it overrides model-capability defaults.
        sessionEntry.reasoningLevel = "off";
      } else {
        sessionEntry.reasoningLevel = directives.reasoningLevel;
      }
      reasoningChanged =
        reasoningChanged ||
        (directives.reasoningLevel !== prevReasoningLevel &&
          directives.reasoningLevel !== undefined);
      updated = true;
    }
    if (
      directives.hasElevatedDirective &&
      directives.elevatedLevel &&
      elevatedEnabled &&
      elevatedAllowed
    ) {
      // Persist "off" explicitly so inline `/elevated off` overrides defaults.
      sessionEntry.elevatedLevel = directives.elevatedLevel;
      elevatedChanged =
        elevatedChanged ||
        (directives.elevatedLevel !== prevElevatedLevel && directives.elevatedLevel !== undefined);
      updated = true;
    }
    if (directives.hasExecDirective && directives.hasExecOptions && allowInternalExecPersistence) {
      if (directives.execHost) {
        sessionEntry.execHost = directives.execHost;
        updated = true;
      }
      if (directives.execSecurity) {
        sessionEntry.execSecurity = directives.execSecurity;
        updated = true;
      }
      if (directives.execAsk) {
        sessionEntry.execAsk = directives.execAsk;
        updated = true;
      }
      if (directives.execNode) {
        sessionEntry.execNode = directives.execNode;
        updated = true;
      }
    }

    const modelDirective =
      directives.hasModelDirective && params.effectiveModelDirective
        ? params.effectiveModelDirective
        : undefined;
    let modelUpdated = false;
    let modelApplied = true;
    let modelRuntimeEvent: { contextKey: string; text: string } | undefined;
    let modelSwitchEvent: { alias?: string; label: string } | undefined;
    if (modelDirective) {
      const modelResolution = resolveModelSelectionFromDirective({
        directives: {
          ...directives,
          hasModelDirective: true,
          rawModelDirective: modelDirective,
        },
        cfg,
        agentDir,
        defaultProvider,
        defaultModel,
        aliasIndex,
        allowedModelKeys,
        allowedModelCatalog: params.modelCatalog ?? [],
        provider,
      });
      if (modelResolution.modelSelection) {
        const appliedModelOverride = applyModelOverrideToSessionEntry({
          entry: sessionEntry,
          selection: modelResolution.modelSelection,
          profileOverride: modelResolution.profileOverride,
          markLiveSwitchPending: params.markLiveSwitchPending,
        });
        const runtimeOverride = resolveModelRuntimeOverride({
          rawRuntime: directives.rawModelRuntime,
          provider: modelResolution.modelSelection.provider,
          cfg,
        });
        if (runtimeOverride?.kind === "clear") {
          if (sessionEntry.agentRuntimeOverride) {
            delete sessionEntry.agentRuntimeOverride;
            updated = true;
          }
        } else if (runtimeOverride?.kind === "set") {
          if (sessionEntry.agentRuntimeOverride) {
            delete sessionEntry.agentRuntimeOverride;
            updated = true;
          }
          modelRuntimeEvent = {
            text: `Ignored session runtime ${runtimeOverride.runtime}; configure provider or model runtime policy instead.`,
            contextKey: `model-runtime:${modelResolution.modelSelection.provider}:${runtimeOverride.runtime}:ignored-session-runtime`,
          };
        } else if (runtimeOverride?.kind === "invalid") {
          if (sessionEntry.agentRuntimeOverride) {
            delete sessionEntry.agentRuntimeOverride;
            updated = true;
          }
          modelRuntimeEvent = {
            text: `Ignored unsupported runtime ${runtimeOverride.runtime} for ${modelResolution.modelSelection.provider}.`,
            contextKey: `model-runtime:${modelResolution.modelSelection.provider}:${runtimeOverride.runtime}`,
          };
        }
        modelUpdated = appliedModelOverride.updated;
        provider = modelResolution.modelSelection.provider;
        model = modelResolution.modelSelection.model;
        const currentThinkingLevel = sessionEntry.thinkingLevel as ThinkLevel | undefined;
        if (
          currentThinkingLevel &&
          !directives.hasThinkDirective &&
          !isThinkingLevelSupported({
            provider,
            model,
            level: currentThinkingLevel,
            catalog: thinkingCatalog,
          })
        ) {
          const remappedThinkingLevel = resolveSupportedThinkingLevel({
            provider,
            model,
            level: currentThinkingLevel,
            catalog: thinkingCatalog,
          });
          if (remappedThinkingLevel !== currentThinkingLevel) {
            sessionEntry.thinkingLevel = remappedThinkingLevel;
            thinkingRemap = {
              from: currentThinkingLevel,
              to: remappedThinkingLevel,
              provider,
              model,
            };
            updated = true;
          }
        }
        const nextLabel = `${provider}/${model}`;
        if (nextLabel !== initialModelLabel) {
          modelSwitchEvent = {
            label: nextLabel,
            ...(modelResolution.modelSelection.alias
              ? { alias: modelResolution.modelSelection.alias }
              : {}),
          };
        }
        // Explicit model selections must still perform the atomic persisted
        // winner check when their value matches the local snapshot.
        updated = true;
      }
    }
    if (directives.hasQueueDirective && directives.queueReset) {
      delete sessionEntry.queueMode;
      delete sessionEntry.queueDebounceMs;
      delete sessionEntry.queueCap;
      delete sessionEntry.queueDrop;
      updated = true;
    }

    if (updated) {
      sessionEntry.updatedAt = Date.now();
      sessionStore[sessionKey] = sessionEntry;
      if (storePath) {
        const persistence = await persistReplySessionEntry({
          storePath,
          sessionKey,
          initialEntry: initialSessionEntry,
          entry: sessionEntry,
          reassertLiveModelSwitchPending:
            modelUpdated &&
            params.markLiveSwitchPending === true &&
            sessionEntry.liveModelSwitchPending === true,
          touchedFields: touchedSessionFields,
        });
        if (persistence.status === "current") {
          const persistedEntry = persistence.entry;
          sessionStore[sessionKey] = persistedEntry;
          appliedSessionEntry = persistedEntry;
          sessionChangesApplied = sessionSnapshotChangesApplied({
            initial: initialSessionEntry,
            next: sessionEntry,
            current: persistedEntry,
            touchedFields: touchedSessionFields,
          });
          if (modelDirective) {
            modelApplied =
              sessionChangesApplied &&
              sessionModelOverrideChangesApplied({
                initial: initialSessionEntry,
                next: sessionEntry,
                current: persistedEntry,
                reassertLiveModelSwitchPending:
                  modelUpdated &&
                  params.markLiveSwitchPending === true &&
                  sessionEntry.liveModelSwitchPending === true,
              });
          }
          adoptPersistedSessionSnapshot(sessionEntry, persistedEntry);
          appliedSessionEntry = sessionEntry;
        } else {
          if (persistence.entry) {
            sessionStore[sessionKey] = persistence.entry;
          }
          sessionChangesApplied = false;
          if (modelDirective) {
            modelApplied = false;
          }
        }
      }
      if (modelDirective && !modelApplied) {
        sessionChangesApplied = false;
        const persistedEntry = sessionStore[sessionKey];
        provider = persistedEntry?.providerOverride?.trim() || defaultProvider;
        model = persistedEntry?.modelOverride?.trim() || defaultModel;
        thinkingRemap = undefined;
      }
      if (modelDirective && modelUpdated && modelApplied) {
        triggerSessionPatchHook({
          cfg,
          sessionEntry: appliedSessionEntry,
          sessionKey,
          patch: { key: sessionKey, model: modelDirective },
        });
      }
      if (sessionChangesApplied) {
        enqueueModeSwitchEvents({
          enqueueSystemEvent,
          sessionEntry: appliedSessionEntry,
          sessionKey,
          elevatedChanged,
          reasoningChanged,
        });
      }
    }
    if (modelRuntimeEvent && modelApplied) {
      enqueueSystemEvent(modelRuntimeEvent.text, {
        sessionKey,
        contextKey: modelRuntimeEvent.contextKey,
      });
    }
    if (modelSwitchEvent && modelApplied) {
      enqueueSystemEvent(formatModelSwitchEvent(modelSwitchEvent.label, modelSwitchEvent.alias), {
        sessionKey,
        contextKey: `model:${modelSwitchEvent.label}`,
      });
    }
  }

  const selectedCatalogEntry = params.modelCatalog?.find(
    (entry) => modelKey(entry.provider, entry.id) === modelKey(provider, model),
  );
  return {
    provider,
    model,
    thinkingRemap,
    sessionChangesApplied,
    contextTokens: resolveContextTokens({
      cfg,
      agentCfg,
      provider: resolveContextConfigProviderForRuntime({
        provider,
        runtimeId: resolveAgentHarnessPolicy({
          provider,
          modelId: model,
          config: cfg,
          agentId: activeAgentId,
          sessionKey,
        }).runtime,
        config: cfg,
      }),
      model,
      modelContextWindow: selectedCatalogEntry?.contextWindow,
      modelContextTokens: selectedCatalogEntry?.contextTokens,
    }),
  };
}
