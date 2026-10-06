import type { ChatAccountSelection } from "@openclaw/gateway-protocol";
import type {
  FastMode,
  GatewayAgentRow,
  ModelCatalogEntry,
  ModelCatalogResult,
  SessionsListResult,
} from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { registerModelControlsEnglish } from "../../i18n/locales/en-model-controls.ts";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import {
  buildQualifiedChatModelValue,
  normalizeChatModelProviderId,
  resolvePreferredServerChatModelValue,
} from "../../lib/chat/model-ref.ts";
import {
  chatModelUnavailableMessage,
  isChatFastModeProviderSupported,
  resolveChatModelUnavailableReason,
} from "../../lib/chat/model-select-state.ts";
import {
  normalizeThinkingOptionValue,
  resolveThinkingProfileForSession,
  type ChatThinkingTarget,
} from "../../lib/chat/thinking.ts";
import type { ChatModelCatalogState } from "../../lib/model-catalog-store.ts";
import {
  resolveModelRuntimeEntry,
  type ModelRuntimeEntry,
} from "../../lib/model-runtime-choice.ts";
import { draftCloudProfileSupportsExecutionMode, type DraftCloudProfile } from "./discovery.ts";

registerNewSessionSetupEnglish();
registerModelControlsEnglish();

type DraftModelTarget = {
  entry?: ModelRuntimeEntry;
  model: string;
  provider: string | null;
};

export type NewSessionModelMetadata = ChatModelCatalogState & {
  catalog: ModelCatalogEntry[];
  accountSelection?: ChatAccountSelection;
  displayOnly?: boolean;
};

export function createEmptyDraftModelMetadata(): NewSessionModelMetadata {
  return { catalog: [], hasSnapshot: false, status: "idle" };
}

type DraftModelControlSelection = {
  agentRuntime?: string;
  contextWindow: string;
  thinkingLevel: string;
  fastMode?: FastMode;
};

export function resolveDraftModelControls(params: {
  model: string;
  selection: DraftModelControlSelection;
  metadata: NewSessionModelMetadata;
  agent?: GatewayAgentRow;
  defaults?: SessionsListResult["defaults"];
}) {
  const { model, selection, metadata, agent, defaults } = params;
  const policy = metadata.modelSelectionPolicy;
  const agentDefaultModel = policy?.restricted
    ? (policy.defaultModel ?? undefined)
    : agent?.model?.primary;
  const defaultTarget = resolveDraftModelTarget(
    policy?.restricted ? policy.defaultModel : (agentDefaultModel ?? defaults?.model),
    policy?.restricted || agentDefaultModel ? undefined : defaults?.modelProvider,
    metadata.catalog,
  );
  const selectedTarget = resolveDraftModelTarget(
    model,
    undefined,
    metadata.catalog,
    selection.agentRuntime,
  );
  const entry = selectedTarget?.entry ?? defaultTarget?.entry;
  const modelCatalogState: ChatModelCatalogState = {
    // Agent defaults and the catalog hydrate independently; both must identify this draft.
    hasSnapshot: agent !== undefined && metadata.hasSnapshot,
    initialized: !metadata.retired && (metadata.initialized ?? metadata.hasSnapshot),
    refreshFailed: metadata.refreshFailed,
    pendingProviders: metadata.pendingProviders,
    modelSelectionPolicy: policy,
    retired: metadata.retired,
    status: !agent && metadata.status !== "error" ? "loading" : metadata.status,
  };
  return {
    defaultTarget,
    agentDefaultModel,
    modelCatalogState,
    contextWindowTarget: resolveDraftContextWindowTarget(entry, selection.contextWindow),
    fastModeTarget: {
      agentRuntime: entry?.agentRuntime,
      model: selectedTarget?.model ?? defaultTarget?.model,
      modelProvider: selectedTarget?.provider ?? defaultTarget?.provider ?? undefined,
      fastMode: selection.fastMode,
      effectiveFastMode: selection.fastMode ?? entry?.effectiveFastMode,
    },
    thinkingDefaults: resolveDraftThinkingDefaults(
      defaultTarget,
      policy?.restricted ? undefined : agent,
      policy?.restricted ? undefined : defaults,
      metadata.catalog,
    ),
    thinkingSession: resolveDraftThinkingTarget(selectedTarget, undefined, selection),
  };
}

function resolveDraftContextWindowTarget(
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

function resolveDraftThinkingTarget(
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

function resolveDraftThinkingDefaults(
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
  model: string;
  agentRuntime?: string;
  metadata: NewSessionModelMetadata;
  agent?: GatewayAgentRow;
}): ModelRuntimeEntry["unavailableReason"] {
  const { metadata, agent } = params;
  if (!metadata.hasSnapshot || metadata.status === "offline") {
    return undefined;
  }
  const policy = metadata.modelSelectionPolicy;
  const model =
    params.model ||
    (policy?.restricted ? (policy.defaultModel ?? undefined) : agent?.model?.primary);
  return params.agentRuntime
    ? resolveDraftModelTarget(model, undefined, metadata.catalog, params.agentRuntime)?.entry
        ?.unavailableReason
    : resolveChatModelUnavailableReason(model, undefined, metadata.catalog);
}

export function isDraftAccountModelAvailable(
  account: { model: string; provider: string },
  catalog: ModelCatalogEntry[],
  agentRuntime?: string,
): boolean {
  const target = resolveDraftModelTarget(account.model, undefined, catalog, agentRuntime);
  return (
    target?.entry?.available === true &&
    target.entry.manualSelectionAllowed !== false &&
    target.provider === account.provider
  );
}

export function resolveDraftModelSelectionBlockedReason(params: {
  model: string;
  agentRuntime?: string;
  metadata: NewSessionModelMetadata;
  agent?: GatewayAgentRow;
  initialModelPending: boolean;
  accountSelected: boolean;
  accountReady: boolean;
  metadataPending: boolean;
  inference?: "worker";
}): string | undefined {
  const { metadata, model, agentRuntime } = params;
  if (
    metadata.retired ||
    params.initialModelPending ||
    (!metadata.hasSnapshot && Boolean(model || agentRuntime))
  ) {
    return t(
      metadata.status === "error"
        ? "chat.modelControls.modelsUnavailable"
        : "chat.modelControls.loadingModels",
    );
  }
  if (
    metadata.modelSelectionPolicy?.restricted &&
    !model &&
    !metadata.modelSelectionPolicy.defaultModel
  ) {
    return t(
      metadata.catalog.length
        ? "chat.modelControls.selectionRequired"
        : "chat.modelControls.noPermittedModels",
    );
  }
  if (
    agentRuntime &&
    metadata.hasSnapshot &&
    !resolveDraftModelTarget(model, undefined, metadata.catalog, agentRuntime)?.entry
  ) {
    return t("chat.modelControls.modelsUnavailable");
  }
  // Explicit model/runtime and personal-account choices retain Gateway availability checks.
  const unavailable = chatModelUnavailableMessage(
    resolveDraftModelUnavailableReason(params),
    !model && !agentRuntime && !params.accountSelected ? params.inference : undefined,
  );
  if (params.accountSelected) {
    if (metadata.status === "error") {
      return t("chat.modelControls.modelsUnavailable");
    }
    if (params.metadataPending || !metadata.hasSnapshot) {
      return t("chat.modelControls.loadingModels");
    }
    if (!params.accountReady) {
      return unavailable ?? t("chat.modelControls.modelsUnavailable");
    }
  }
  return unavailable;
}

export function resolveDraftAgentRuntime(params: {
  model: string;
  agentRuntime?: string;
  agent?: GatewayAgentRow;
  defaults?: SessionsListResult["defaults"];
  catalog: ModelCatalogEntry[];
  modelSelectionPolicy?: ModelCatalogResult["modelSelectionPolicy"];
  retired?: boolean;
}): ModelRuntimeEntry["agentRuntime"] {
  if (params.retired) {
    return undefined;
  }
  const policy = params.modelSelectionPolicy;
  const model = params.model || (policy?.restricted ? (policy.defaultModel ?? "") : "");
  let runtime: ModelRuntimeEntry["agentRuntime"];
  if (model) {
    // Explicit models without runtime metadata cannot borrow their agent's default runtime.
    runtime = resolveDraftModelTarget(model, undefined, params.catalog, params.agentRuntime)?.entry
      ?.agentRuntime;
  } else if (!policy?.restricted) {
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
  modelSelectionPolicy?: ModelCatalogResult["modelSelectionPolicy"];
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
  const policy = params.modelSelectionPolicy;
  const agent = policy?.restricted ? undefined : params.agent;
  const defaults = policy?.restricted ? undefined : params.defaults;
  const agentDefaultModel = policy?.restricted ? policy.defaultModel : agent?.model?.primary;
  const defaultTarget = selected
    ? null
    : resolveDraftModelTarget(
        agentDefaultModel ?? defaults?.model,
        agentDefaultModel ? undefined : defaults?.modelProvider,
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
    resolveDraftThinkingTarget(selectedTarget ?? defaultTarget, selected ? undefined : agent, {
      agentRuntime: params.agentRuntime,
    }),
    selected ? undefined : defaults,
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
