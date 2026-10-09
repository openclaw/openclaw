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

export function resolveDraftDefaultModelTarget(params: {
  agent?: GatewayAgentRow;
  defaults?: SessionsListResult["defaults"];
  catalog: ModelCatalogEntry[];
  modelSelectionPolicy?: ModelCatalogResult["modelSelectionPolicy"];
}) {
  const { agent, defaults, catalog, modelSelectionPolicy: policy } = params;
  return resolveDraftModelTarget(
    policy?.restricted ? policy.defaultModel : (agent?.model?.primary ?? defaults?.model),
    policy?.restricted || agent?.model?.primary ? undefined : defaults?.modelProvider,
    catalog,
  );
}

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
  const defaultTarget = resolveDraftDefaultModelTarget({
    agent,
    defaults,
    catalog: metadata.catalog,
    modelSelectionPolicy: policy,
  });
  const selectedTarget = resolveDraftModelTarget(
    model,
    undefined,
    metadata.catalog,
    selection.agentRuntime,
  );
  const entry = selectedTarget?.entry ?? defaultTarget?.entry;
  const contextWindow = selection.contextWindow || entry?.contextWindowDefault;
  const thinkingProfile = resolveThinkingProfileForSession(
    resolveDraftThinkingTarget(defaultTarget, policy?.restricted ? undefined : agent),
    policy?.restricted ? undefined : defaults,
    metadata.catalog,
  );
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
    contextWindowTarget:
      entry?.contextWindows && contextWindow
        ? {
            contextWindow,
            contextWindows: entry.contextWindows,
            ...(entry.contextWindowDefault
              ? { contextWindowDefault: entry.contextWindowDefault }
              : {}),
          }
        : undefined,
    fastModeTarget: {
      agentRuntime: entry?.agentRuntime,
      model: selectedTarget?.model ?? defaultTarget?.model,
      modelProvider: selectedTarget?.provider ?? defaultTarget?.provider ?? undefined,
      fastMode: selection.fastMode,
      effectiveFastMode: selection.fastMode ?? entry?.effectiveFastMode,
    },
    thinkingDefaults: {
      modelProvider: defaultTarget?.provider ?? null,
      model: defaultTarget?.model ?? null,
      contextTokens: policy?.restricted ? null : (defaults?.contextTokens ?? null),
      agentRuntime: thinkingProfile?.agentRuntime,
      thinkingLevels: thinkingProfile?.thinkingLevels,
      thinkingDefault: thinkingProfile?.thinkingDefault,
    },
    thinkingSession: resolveDraftThinkingTarget(selectedTarget, undefined, selection),
  };
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
  return {
    model: separator > 0 ? value.slice(separator + 1) : value,
    provider:
      normalizeChatModelProviderId(separator > 0 ? value.slice(0, separator) : (provider ?? "")) ||
      null,
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
  if (
    model &&
    resolveDraftModelTarget(model, undefined, metadata.catalog, agentRuntime)?.entry
      ?.manualSelectionAllowed === false
  ) {
    return t("chat.modelControls.modelsUnavailable");
  }
  if (
    agentRuntime &&
    resolveDraftModelTarget(model, undefined, metadata.catalog, agentRuntime)?.entry?.available ===
      false
  ) {
    return (
      chatModelUnavailableMessage(resolveDraftModelUnavailableReason(params)) ??
      t("chat.modelControls.modelsUnavailable")
    );
  }
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
    // An explicit runtime is execution intent. A disappearing account/runtime must
    // block that draft, not silently replace its host with the default model.
    if (params.agentRuntime && params.agentRuntime !== "openclaw") {
      return {
        model: requestedModel,
        agentRuntime: params.agentRuntime,
        thinkingLevel: params.thinkingLevel,
        fastMode: params.fastMode,
        repaired: false,
      };
    }
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
