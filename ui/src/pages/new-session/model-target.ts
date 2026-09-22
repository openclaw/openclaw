import type {
  FastMode,
  GatewayAgentRow,
  ModelCatalogEntry,
  SessionsListResult,
} from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import {
  buildQualifiedChatModelValue,
  normalizeChatModelProviderId,
  resolvePreferredServerChatModelValue,
} from "../../lib/chat/model-ref.ts";
import {
  isChatFastModeProviderSupported,
  resolveChatModelUnavailableReason,
} from "../../lib/chat/model-select-state.ts";
import {
  normalizeThinkingOptionValue,
  resolveThinkingProfileForSession,
  type ChatThinkingTarget,
} from "../../lib/chat/thinking.ts";
import {
  resolveModelRuntimeEntry,
  type ModelRuntimeEntry,
} from "../../lib/model-runtime-choice.ts";
import { draftCloudProfileSupportsExecutionMode, type DraftCloudProfile } from "./discovery.ts";

registerNewSessionSetupEnglish();

type DraftModelTarget = {
  entry?: ModelRuntimeEntry;
  model: string;
  provider: string | null;
};

export function resolveDraftContextWindowTarget(
  entry: ModelRuntimeEntry | undefined,
  contextWindow: string,
) {
  const selected = contextWindow || entry?.contextWindowDefault;
  return entry?.contextWindows && selected
    ? {
        contextWindow: selected,
        contextWindows: entry.contextWindows,
        ...(entry.contextWindowDefault ? { contextWindowDefault: entry.contextWindowDefault } : {}),
      }
    : undefined;
}

export function resolveDraftThinkingTarget(
  target: DraftModelTarget | null,
  agent?: GatewayAgentRow,
  selection?: { thinkingLevel?: string; agentRuntime?: string },
): ChatThinkingTarget {
  // Keep configured-base metadata in the catalog so it cannot hide Gateway defaults.
  const runtimeEntry = selection?.agentRuntime ? target?.entry : undefined;
  return {
    model: target?.model ?? agent?.model?.primary,
    modelProvider: target?.provider ?? undefined,
    agentRuntime: agent?.agentRuntime ?? target?.entry?.agentRuntime,
    thinkingLevels: agent?.thinkingLevels ?? runtimeEntry?.thinkingLevels,
    thinkingOptions: agent?.thinkingOptions,
    thinkingDefault: agent?.thinkingDefault ?? runtimeEntry?.thinkingDefault,
    thinkingLevel: selection?.thinkingLevel || undefined,
  };
}

export function resolveDraftThinkingDefaults(
  target: DraftModelTarget | null,
  agent: GatewayAgentRow | undefined,
  defaults: SessionsListResult["defaults"] | undefined,
  catalog: ModelCatalogEntry[],
) {
  const profile = resolveThinkingProfileForSession(
    resolveDraftThinkingTarget(target, agent),
    defaults,
    catalog,
  );
  return {
    modelProvider: target?.provider ?? null,
    model: target?.model ?? null,
    contextTokens: defaults?.contextTokens ?? null,
    agentRuntime: profile?.agentRuntime,
    thinkingLevels: profile?.thinkingLevels,
    thinkingDefault: profile?.thinkingDefault,
  };
}

export function resolveDraftModelTarget(
  model: string | null | undefined,
  provider: string | null | undefined,
  catalog: ModelCatalogEntry[],
  agentRuntime?: string,
): DraftModelTarget | null {
  const value = resolvePreferredServerChatModelValue(model, provider, catalog);
  if (!value) {
    return null;
  }
  const normalized = value.toLowerCase();
  const entry = catalog.find(
    (candidate) =>
      buildQualifiedChatModelValue(candidate.id, candidate.provider).toLowerCase() === normalized,
  );
  if (entry) {
    return {
      entry: resolveModelRuntimeEntry(entry, agentRuntime),
      model: entry.id,
      provider: normalizeChatModelProviderId(entry.provider) || null,
    };
  }
  const separator = value.indexOf("/");
  if (separator > 0) {
    return {
      model: value.slice(separator + 1),
      provider: normalizeChatModelProviderId(value.slice(0, separator)) || null,
    };
  }
  return {
    model: value,
    provider: normalizeChatModelProviderId(provider ?? "") || null,
  };
}

export function resolveDraftModelUnavailableReason(params: {
  model: string | undefined;
  agentRuntime?: string;
  catalog: ModelCatalogEntry[];
}): ModelRuntimeEntry["unavailableReason"] {
  return params.agentRuntime
    ? resolveDraftModelTarget(params.model, undefined, params.catalog, params.agentRuntime)?.entry
        ?.unavailableReason
    : resolveChatModelUnavailableReason(params.model, undefined, params.catalog);
}

export function resolveDraftAgentRuntime(params: {
  model: string;
  agentRuntime?: string;
  agent?: GatewayAgentRow;
  defaults?: SessionsListResult["defaults"];
  catalog: ModelCatalogEntry[];
}): ModelRuntimeEntry["agentRuntime"] {
  let runtime: ModelRuntimeEntry["agentRuntime"];
  if (params.model) {
    // Explicit models without runtime metadata cannot borrow their agent's default runtime.
    runtime = resolveDraftModelTarget(params.model, undefined, params.catalog, params.agentRuntime)
      ?.entry?.agentRuntime;
  } else {
    const agentDefaultModel = params.agent?.model?.primary;
    const target = resolveDraftModelTarget(
      agentDefaultModel ?? params.defaults?.model,
      agentDefaultModel ? undefined : params.defaults?.modelProvider,
      params.catalog,
    );
    runtime =
      target?.entry?.agentRuntime ?? params.agent?.agentRuntime ?? params.defaults?.agentRuntime;
  }
  const runtimeId = runtime?.id.trim();
  // Unresolved policies leave placement eligibility to the Gateway dispatch owner.
  if (!runtime || !runtimeId || runtimeId === "auto" || runtimeId === "default") {
    return undefined;
  }
  return runtimeId === runtime.id ? runtime : { ...runtime, id: runtimeId };
}

export function reconcileDraftModelSelection(params: {
  model: string;
  agentRuntime?: string;
  thinkingLevel: string;
  fastMode?: FastMode;
  agent?: GatewayAgentRow;
  defaults?: SessionsListResult["defaults"];
  catalog: ModelCatalogEntry[];
}): {
  model: string;
  agentRuntime?: string;
  thinkingLevel: string;
  fastMode?: FastMode;
  repaired: boolean;
} {
  const requestedModel = params.model.trim();
  const selectedTarget = requestedModel
    ? resolveDraftModelTarget(requestedModel, undefined, params.catalog, params.agentRuntime)
    : null;
  if (
    requestedModel &&
    (!selectedTarget?.entry ||
      selectedTarget.entry.available === false ||
      selectedTarget.entry.manualSelectionAllowed === false)
  ) {
    return { model: "", thinkingLevel: "", repaired: true };
  }
  const selected = selectedTarget?.entry
    ? buildQualifiedChatModelValue(selectedTarget.entry.id, selectedTarget.entry.provider)
    : "";
  const agentDefaultModel = params.agent?.model?.primary;
  const defaultTarget = selected
    ? null
    : resolveDraftModelTarget(
        agentDefaultModel ?? params.defaults?.model,
        agentDefaultModel ? undefined : params.defaults?.modelProvider,
        params.catalog,
      );
  const provider = (selectedTarget ?? defaultTarget)?.provider;
  const targetEntry = selectedTarget?.entry ?? defaultTarget?.entry;
  const fastMode =
    (targetEntry?.supportsFastMode ?? (!provider || isChatFastModeProviderSupported(provider)))
      ? params.fastMode
      : undefined;
  const selection = {
    model: selected,
    ...(selected && params.agentRuntime ? { agentRuntime: params.agentRuntime } : {}),
    fastMode,
  };
  const repaired = fastMode !== params.fastMode;
  if (!params.thinkingLevel) {
    return { ...selection, thinkingLevel: "", repaired };
  }
  const thinkingProfile = resolveThinkingProfileForSession(
    resolveDraftThinkingTarget(
      selectedTarget ?? defaultTarget,
      selected ? undefined : params.agent,
      { agentRuntime: params.agentRuntime },
    ),
    selected ? undefined : params.defaults,
    params.catalog,
  );
  const authoritativeLevels = thinkingProfile?.thinkingLevels;
  const normalizedThinking = normalizeThinkingOptionValue(params.thinkingLevel);
  const supported = authoritativeLevels?.some(
    (level) => normalizeThinkingOptionValue(level.id) === normalizedThinking,
  );
  if (targetEntry?.reasoning === false || (authoritativeLevels !== undefined && !supported)) {
    return { ...selection, thinkingLevel: "", repaired: true };
  }
  return {
    ...selection,
    thinkingLevel: params.thinkingLevel,
    repaired,
  };
}

export function resolveDraftDevicePlacementUnsupportedReason(
  runtime: ReturnType<typeof resolveDraftAgentRuntime>,
): string | undefined {
  return runtime && !runtime.devicePlacement ? t("newSession.deviceRuntimeUnsupported") : undefined;
}

export function resolveDraftCloudRuntimeUnsupportedReason(
  runtime: ReturnType<typeof resolveDraftAgentRuntime>,
  profile?: DraftCloudProfile,
): string | undefined {
  if (runtime?.cloudPlacementSupported === false) {
    return t("newSession.cloudRuntimeUnsupported", { runtime: runtime.id });
  }
  return runtime &&
    profile &&
    runtime.cloudPlacementExecutionMode &&
    !draftCloudProfileSupportsExecutionMode(profile, runtime.cloudPlacementExecutionMode)
    ? t("newSession.cloudProfileRuntimeUnsupported", { runtime: runtime.id })
    : undefined;
}
