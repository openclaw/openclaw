import { html, nothing } from "lit";
import type { ChatAccountSelection } from "../../../../../packages/gateway-protocol/src/index.ts";
import { resolveModelRuntimeRoute } from "../../../../../src/shared/model-runtime-route.js";
import type {
  ModelAuthStatusResult,
  ModelCatalogEntry,
  SessionsListResult,
} from "../../../api/types.ts";
import { t } from "../../../i18n/index.ts";
import { registerModelControlsEnglish } from "../../../i18n/locales/en-model-controls.ts";
import {
  buildQualifiedChatModelValue,
  normalizeChatModelProviderId,
  resolvePreferredServerChatModelValue,
} from "../../../lib/chat/model-ref.ts";
import {
  resolveChatFastModeSelectState,
  resolveChatModelSelectState,
  type ChatFastModeSelectValue,
  type ChatFastModeTarget,
} from "../../../lib/chat/model-select-state.ts";
import {
  resolveChatThinkingSelectState,
  type ChatThinkingTarget,
} from "../../../lib/chat/thinking.ts";
import {
  canonicalModelAuthProviderId,
  listEffectiveModelAuthProviders,
} from "../../../lib/model-auth.ts";
import { describeModelProviderAuth } from "../../../lib/model-provider-auth-label.ts";
import {
  isSessionRuntimePinned,
  resolveModelRuntimeEntry,
} from "../../../lib/model-runtime-choice.ts";
import { isSessionRunActive } from "../../../lib/session-run-state.ts";
import { areUiSessionKeysEquivalent } from "../../../lib/sessions/session-key.ts";
import { renderChatEffortPicker } from "./chat-effort-picker.ts";
import type { ChatModelAccountSection } from "./chat-model-account-control.ts";
import {
  isModelPickerOptionSelected,
  type ChatModelPickerOption,
  type ChatModelPickerTargetGroup,
} from "./chat-model-picker-options.ts";
import {
  renderChatModelPicker,
  type ChatModelCatalogState,
  type ChatModelProviderAuth,
} from "./chat-model-picker.ts";

registerModelControlsEnglish();

export type { ChatModelCatalogState } from "./chat-model-picker.ts";

type ChatContextWindowTarget = Pick<
  SessionsListResult["defaults"],
  "contextWindow" | "contextWindows" | "contextWindowDefault"
>;

type ChatModelControlsProps = {
  modelAuthStatusResult?: ModelAuthStatusResult | null;
  accountSelection?: ChatAccountSelection | null;
  renderAccountSection?: (model: string) => ChatModelAccountSection | undefined;
  activeRunId: string | null;
  activeRunSessionKey?: string;
  modelObservedRunId?: string;
  agentDefaultModel?: string;
  connected: boolean;
  gatewayAvailable: boolean;
  loading: boolean;
  modelCatalog: ModelCatalogEntry[];
  modelCatalogState?: ChatModelCatalogState;
  modelOverrides?: Readonly<Record<string, string | null | undefined>>;
  modelSelectionLocked?: boolean;
  modelSelectionTarget?: SessionsListResult["defaults"]["modelSelectionTarget"];
  modelPickerTargetGroups?: readonly ChatModelPickerTargetGroup[];
  modelPickerOpen?: boolean;
  modelSwitching: boolean;
  modelsLoading?: boolean;
  modelMutationDisabledReason?: string;
  effortMutationDisabledReason?: string;
  contextWindowMutationDisabledReason?: string;
  fastModeTarget?: ChatFastModeTarget;
  sending: boolean;
  sessionKey: string;
  selectedSession: SessionsListResult["sessions"][number] | undefined;
  selectedAgentRuntime?: string;
  sessionsResult: SessionsListResult | null;
  stream: string | null;
  contextWindowTarget?: ChatContextWindowTarget;
  thinkingDefaults?: SessionsListResult["defaults"];
  thinkingSession?: ChatThinkingTarget;
  onFastModeSelect?: (value: ChatFastModeSelectValue, sessionKey: string) => unknown;
  onContextWindowSelect?: (value: string, sessionKey: string) => unknown;
  onModelSetup?: () => void;
  onModelPickerOpen?: () => unknown;
  onModelPickerOpenChange?: (open: boolean) => void;
  onModelSelect?: (value: string, sessionKey: string, agentRuntime?: string | null) => unknown;
  onModelPickerTargetRetry?: (groupId: string) => unknown;
  onModelPickerTargetSelect?: (groupId: string, value: string) => unknown;
  onRequestUpdate?: () => void;
  onThinkingSelect?: (value: string, sessionKey: string) => unknown;
};

const CHAT_MODEL_PROVIDER_GROUP_ALIASES: Readonly<Record<string, string>> = {
  "google-gemini-cli": "google",
  "moonshot-ai": "moonshot",
  moonshotai: "moonshot",
  "opencode-go": "opencode",
  "opencode-zen": "opencode",
};

function normalizeChatModelProviderGroupId(provider: string): string {
  const normalized = normalizeChatModelProviderId(provider);
  return CHAT_MODEL_PROVIDER_GROUP_ALIASES[normalized] ?? normalized;
}

function prepareChatModelCatalog(catalog: ModelCatalogEntry[]) {
  const qualified = new Map<string, ModelCatalogEntry[]>();
  const ids = new Map<string, ModelCatalogEntry[]>();
  // Keep source order and duplicate rows: display metadata prefers the first
  // canonical entry, while a raw id is unambiguous only with exactly one row.
  for (const entry of catalog) {
    const id = entry.id.trim().toLowerCase();
    const key = `${normalizeChatModelProviderId(entry.provider)}/${id}`;
    const qualifiedRows = qualified.get(key) ?? [];
    qualifiedRows.push(entry);
    qualified.set(key, qualifiedRows);
    const idRows = ids.get(id) ?? [];
    idRows.push(entry);
    ids.set(id, idRows);
  }
  return {
    provider(value: string, providerHint = ""): string {
      const modelRef = value.trim();
      const normalizedModelRef = modelRef.toLowerCase();
      const qualifiedCatalogEntry = qualified.get(normalizedModelRef)?.[0];
      if (qualifiedCatalogEntry) {
        return normalizeChatModelProviderGroupId(qualifiedCatalogEntry.provider);
      }
      const idMatches = ids.get(normalizedModelRef) ?? [];
      const normalizedHint = normalizeChatModelProviderId(providerHint);
      const hintOwnsRawId = idMatches.some(
        (entry) => normalizeChatModelProviderId(entry.provider) === normalizedHint,
      );
      if (normalizedHint && (idMatches.length === 0 || hintOwnsRawId)) {
        return normalizeChatModelProviderGroupId(normalizedHint);
      }
      if (idMatches.length === 1) {
        return normalizeChatModelProviderGroupId(idMatches[0]?.provider ?? "");
      }
      const separator = modelRef.indexOf("/");
      if (separator > 0) {
        return normalizeChatModelProviderGroupId(modelRef.slice(0, separator));
      }
      return "other";
    },
    entry(value: string): ModelCatalogEntry | undefined {
      const trimmedValue = value.trim().toLowerCase();
      const separator = trimmedValue.indexOf("/");
      const normalizedValue =
        separator > 0
          ? `${normalizeChatModelProviderId(trimmedValue.slice(0, separator))}/${trimmedValue.slice(
              separator + 1,
            )}`
          : trimmedValue;
      if (!normalizedValue) {
        return undefined;
      }
      const matches = qualified.get(normalizedValue) ?? [];
      if (matches.length > 0) {
        return (
          matches.find((candidate) => candidate.provider.trim().toLowerCase() === "openai") ??
          matches[0]
        );
      }
      const idMatches = ids.get(normalizedValue) ?? [];
      return idMatches.length === 1 ? idMatches[0] : undefined;
    },
  };
}

function resolveChatModelPickerLabel(
  entry: ModelCatalogEntry | undefined,
  fallbackLabel: string,
): string {
  if (entry && normalizeChatModelProviderId(entry.provider) === "openai") {
    return entry.name.trim() || fallbackLabel;
  }
  return fallbackLabel;
}

function formatPickerModelLabel(label: string): string {
  const match = /^Default \((.+)\)$/u.exec(label);
  return match?.[1] ?? label;
}

function resolveModelSelectionScopeDescription(
  target: SessionsListResult["defaults"]["modelSelectionTarget"],
): string | undefined {
  switch (target) {
    case "session":
      return t("chat.modelControls.selectionScopeSession");
    case "agent":
      return t("chat.modelControls.selectionScopeAgent");
    case "global":
      return t("chat.modelControls.selectionScopeGlobal");
    default:
      return undefined;
  }
}

function resolveCatalogTriggerStatus(
  state: ChatModelCatalogState,
  optionCount: number,
  selectionKnown: boolean,
): string | undefined {
  if (state.status === "offline") {
    return undefined;
  }
  if (state.status === "error") {
    return optionCount === 0 ? t("chat.modelControls.modelsUnavailable") : undefined;
  }
  if (!state.hasSnapshot && ["idle", "loading"].includes(state.status)) {
    return selectionKnown ? undefined : t("chat.modelControls.loadingModels");
  }
  if (state.hasSnapshot && optionCount === 0) {
    return t("chat.modelControls.noModelsAvailable");
  }
  return undefined;
}

export function renderChatModelControls(props: ChatModelControlsProps) {
  const catalog = prepareChatModelCatalog(props.modelCatalog);
  const providerAuth = new Map<string, ChatModelProviderAuth>();
  const headingKey = (id: string) =>
    normalizeChatModelProviderGroupId(
      canonicalModelAuthProviderId(normalizeChatModelProviderId(id)),
    );
  // Alias records (e.g. google and google-gemini-cli) share one heading, so merge
  // them under that key first; iterating raw records let the later one overwrite it.
  for (const provider of listEffectiveModelAuthProviders(
    (props.modelAuthStatusResult?.providers ?? []).map((record) =>
      Object.assign({}, record, { provider: headingKey(record.provider) }),
    ),
  )) {
    const selectedId =
      props.accountSelection?.kind === "automatic"
        ? undefined
        : props.accountSelection?.authProfileId;
    const auth = describeModelProviderAuth(provider, { authProfileId: selectedId });
    if (auth) {
      providerAuth.set(headingKey(provider.provider), auth);
    }
  }
  const {
    currentOverride,
    defaultModel,
    defaultLabel,
    modelOverrideSource,
    options: selectOptions,
  } = resolveChatModelSelectState({
    activeSession: props.selectedSession,
    agentDefaultModel: props.agentDefaultModel,
    chatModelCatalog: props.modelCatalog,
    modelOverrides: props.modelOverrides ?? {},
    sessionKey: props.sessionKey,
    sessionsResult: props.sessionsResult,
  });
  const thinking = resolveChatThinkingSelectState({
    catalog: props.modelCatalog,
    defaults: props.thinkingDefaults,
    session: props.thinkingSession,
    sessionKey: props.sessionKey,
    sessionsResult: props.sessionsResult,
  });
  const activeSession = props.selectedSession;
  const localRunMatchesSession = Boolean(
    props.activeRunId &&
    props.activeRunSessionKey &&
    areUiSessionKeysEquivalent(props.activeRunSessionKey, props.sessionKey),
  );
  const activeRunId = localRunMatchesSession ? props.activeRunId : null;
  const stream = localRunMatchesSession ? props.stream : null;
  const resolvedFastMode = resolveChatFastModeSelectState({
    activeRunId,
    catalog: props.modelCatalog,
    connected: props.connected,
    currentModelOverride: currentOverride,
    fastModeTarget: props.fastModeTarget ?? props.selectedSession,
    gatewayAvailable: props.gatewayAvailable,
    loading: props.loading,
    sending: props.sending,
    sessionsResult: props.sessionsResult,
    stream,
  });
  // Reasoning/fast state still describes the previous model until the refreshed
  // session row lands. Lock both so stale levels cannot be committed mid-switch.
  const fastMode = props.modelSwitching
    ? { ...resolvedFastMode, disabled: true }
    : resolvedFastMode;
  const runtimeSelectionLocked = activeSession?.runtimeSelectionLocked === true;
  const currentProviderHint = activeSession?.modelProvider ?? "";
  const hasPendingModelSelection = Object.hasOwn(props.modelOverrides ?? {}, props.sessionKey);
  const sessionRunning = isSessionRunActive(activeSession ?? {});
  const executionPending =
    props.sending || Boolean(activeRunId) || stream !== null || sessionRunning;
  const currentRunMatches =
    sessionRunning &&
    !props.sending &&
    (!activeRunId ||
      (activeSession?.activeRunIds
        ? activeSession.activeRunIds.includes(activeRunId)
        : props.modelObservedRunId === activeRunId));
  // The row can still describe the previous turn while a send is being admitted.
  // Only the current run's complete provider/model pair identifies its execution.
  const activeModelValue = hasPendingModelSelection
    ? ""
    : executionPending
      ? currentRunMatches &&
        activeSession?.activeModel?.trim() &&
        activeSession.activeModelProvider?.trim()
        ? buildQualifiedChatModelValue(activeSession.activeModel, activeSession.activeModelProvider)
        : ""
      : resolvePreferredServerChatModelValue(
          activeSession?.activeModel,
          activeSession?.activeModelProvider,
          props.modelCatalog,
        );
  const modelPending = executionPending && !activeModelValue;
  // A pending execution does not erase the saved choice or reuse the previous
  // turn's fallback. Keep the choice visible until this run identifies its model.
  const triggerModelValue = activeModelValue || currentOverride;
  const modelStarting =
    modelPending && Boolean(triggerModelValue || (!props.modelSelectionLocked && defaultModel));
  const defaultProviderHint = props.sessionsResult?.defaults?.modelProvider ?? "";
  const defaultCatalogEntry = catalog.entry(defaultModel);
  const canonicalDefaultLabel = resolveChatModelPickerLabel(defaultCatalogEntry, defaultLabel);
  const pickerDefaultLabel =
    defaultModel && canonicalDefaultLabel !== defaultLabel
      ? t("chat.modelControls.defaultWithModel", { model: canonicalDefaultLabel })
      : defaultLabel;
  const normalizedDefaultModel = defaultModel.trim().toLowerCase();
  const modelOptions: ChatModelPickerOption[] = selectOptions.flatMap((option) => {
    const catalogEntry = catalog.entry(option.value);
    const isDefault =
      option.value.trim().toLowerCase() === normalizedDefaultModel ||
      (catalogEntry !== undefined && catalogEntry === defaultCatalogEntry);
    // Anthropic route labels need the resolved runtime even when it was not explicitly pinned.
    const agentRuntime = catalogEntry?.agentRuntime;
    const agentRuntimeId =
      agentRuntime &&
      (agentRuntime.source === "model" ||
        agentRuntime.source === "provider" ||
        resolveModelRuntimeRoute(catalogEntry?.provider ?? "", agentRuntime.id))
        ? agentRuntime.id.trim()
        : undefined;
    const pickerOption: ChatModelPickerOption = {
      ...(catalogEntry?.runtimeChoices?.length && !runtimeSelectionLocked
        ? { agentRuntime: agentRuntime?.id ?? null, agentRuntimeId: agentRuntime?.id }
        : {}),
      commitValue: isDefault ? "" : option.value,
      isDefault,
      value: option.value,
      label: resolveChatModelPickerLabel(catalogEntry, option.label),
      provider: catalog.provider(
        option.value,
        isDefault
          ? defaultProviderHint
          : option.value === currentOverride
            ? currentProviderHint
            : "",
      ),
    };
    if (agentRuntimeId) {
      pickerOption.agentRuntimeId = agentRuntimeId;
    }
    if (
      isDefault &&
      isSessionRuntimePinned(props.selectedSession?.agentRuntime) &&
      resolveModelRuntimeRoute(pickerOption.provider)
    ) {
      // Default clears the runtime pin; session-scoped metadata describes the route being left.
      pickerOption.agentRuntimeId = undefined;
    }
    if (catalogEntry?.contextWindow) {
      pickerOption.contextWindow = catalogEntry.contextWindow;
    }
    if (catalogEntry?.contextTokens) {
      pickerOption.contextTokens = catalogEntry.contextTokens;
    }
    if (typeof catalogEntry?.supportsTools === "boolean") {
      pickerOption.supportsTools = catalogEntry.supportsTools;
    }
    if (option.disabled) {
      pickerOption.disabled = true;
      pickerOption.unavailableReason = option.unavailableReason;
    }
    const options = [pickerOption];
    for (const choice of runtimeSelectionLocked ? [] : (catalogEntry?.runtimeChoices ?? [])) {
      options.push({
        value: option.value,
        commitValue: option.value,
        isDefault: false,
        label: pickerOption.label,
        provider: pickerOption.provider,
        agentRuntime: choice.agentRuntime.id,
        runtimeOverride: choice.agentRuntime.id,
        agentRuntimeId: choice.agentRuntime.id,
        contextWindow: choice.contextWindow,
        supportsTools: choice.supportsTools,
        disabled: choice.available === false,
        unavailableReason: choice.unavailableReason,
      });
    }
    return options;
  });
  // Only a pin recorded on the session row makes Default a reset target: New Session
  // drafts have no row, and a local optimistic override is not yet a recorded pin.
  const sessionModelPinned =
    props.selectedSession?.modelOverrideSource === "user" ||
    (!runtimeSelectionLocked && isSessionRuntimePinned(props.selectedSession?.agentRuntime));
  // That pin must stay clearable even when the configured default is absent from
  // this catalog. Without it the row has no job (an agent-scoped catalog may
  // legitimately omit the Gateway default), so nothing is synthesized.
  if (defaultModel && sessionModelPinned && !modelOptions.some((option) => option.isDefault)) {
    modelOptions.unshift({
      commitValue: "",
      isDefault: true,
      value: defaultModel,
      label: formatPickerModelLabel(pickerDefaultLabel),
      provider: catalog.provider(defaultModel, defaultProviderHint),
    });
  }
  const currentCatalogEntry = catalog.entry(currentOverride);
  if (
    currentOverride &&
    currentCatalogEntry?.manualSelectionAllowed !== false &&
    modelOptions.length > 0 &&
    !modelOptions.some((option) => option.value === currentOverride)
  ) {
    modelOptions.push({
      commitValue: currentOverride,
      ...(currentCatalogEntry?.contextWindow
        ? { contextWindow: currentCatalogEntry.contextWindow }
        : {}),
      ...(currentCatalogEntry?.contextTokens
        ? { contextTokens: currentCatalogEntry.contextTokens }
        : {}),
      ...(typeof currentCatalogEntry?.supportsTools === "boolean"
        ? { supportsTools: currentCatalogEntry.supportsTools }
        : {}),
      ...(currentCatalogEntry?.available === false
        ? { disabled: true, unavailableReason: currentCatalogEntry.unavailableReason }
        : {}),
      isDefault: false,
      value: currentOverride,
      label: currentCatalogEntry?.name.trim() || currentOverride,
      provider: catalog.provider(currentOverride, currentProviderHint),
    });
  }
  // A persisted pin can match a changed default; equality cannot establish inheritance.
  const selectedAgentRuntime =
    props.selectedAgentRuntime ??
    props.selectedSession?.agentRuntime?.id ??
    catalog.entry(currentOverride || defaultModel)?.agentRuntime?.id;
  const defaultRuntime =
    defaultCatalogEntry?.agentRuntime?.id ?? props.sessionsResult?.defaults?.agentRuntime?.id;
  // A default model can still have a runtime pin; only the configured model/runtime pair inherits Default.
  const pickerValue =
    modelOverrideSource === null &&
    (!selectedAgentRuntime || selectedAgentRuntime === defaultRuntime)
      ? ""
      : currentOverride || defaultModel;
  const activeModelOption = modelOptions.find((option) =>
    isModelPickerOptionSelected(option, pickerValue, selectedAgentRuntime),
  );
  const activeSessionModel = activeSession?.model
    ? catalog.entry(
        resolvePreferredServerChatModelValue(
          activeSession.model,
          activeSession.modelProvider,
          props.modelCatalog,
        ),
      )
    : undefined;
  const activeOptionModel = activeModelOption ? catalog.entry(activeModelOption.value) : undefined;
  const activeSessionRuntime = activeSession?.agentRuntime?.id.trim().toLowerCase();
  const activeOptionRuntime = (
    resolveModelRuntimeEntry(activeOptionModel, activeModelOption?.agentRuntime)?.agentRuntime
      ?.id ??
    (activeModelOption?.isDefault ? props.sessionsResult?.defaults?.agentRuntime?.id : undefined)
  )
    ?.trim()
    .toLowerCase();
  const activeRuntimeMatches =
    Boolean(activeSessionRuntime) && activeSessionRuntime === activeOptionRuntime;
  // Missing or mismatched current-selection provenance cannot bind the cached
  // session window. Even matching provenance is useful only after the switch settles.
  if (
    !props.modelSwitching &&
    activeModelOption &&
    activeSession?.contextTokens &&
    activeRuntimeMatches &&
    activeSessionModel !== undefined &&
    activeSessionModel === activeOptionModel
  ) {
    activeModelOption.contextTokens = activeSession.contextTokens;
  }
  // A lock prevents model changes; the concrete selection still owns its label.
  // Without a selection, neither the runtime nor the agent default identifies it.
  const committedModelLabel =
    props.modelSelectionLocked === true && !triggerModelValue
      ? t("chat.selectors.lockedSessionModel")
      : (modelOptions.find((entry) => entry.value === triggerModelValue)?.label ??
        resolveChatModelPickerLabel(
          catalog.entry(triggerModelValue),
          triggerModelValue || pickerDefaultLabel,
        ));
  const managedCatalog = props.modelCatalogState ?? {
    hasSnapshot: !props.modelsLoading,
    status: props.modelsLoading ? ("loading" as const) : ("ready" as const),
  };
  const catalogLoadingWithoutSnapshot =
    !managedCatalog.hasSnapshot && ["idle", "loading"].includes(managedCatalog.status);
  // The session owns the selected model; its account-scoped catalog only owns
  // picker availability. Refreshing that catalog must not hide a known selection.
  const selectionKnown = Boolean(currentOverride || (modelOverrideSource === null && defaultModel));
  const catalogTriggerStatus = resolveCatalogTriggerStatus(
    managedCatalog,
    modelOptions.length,
    selectionKnown,
  );
  const hasResolvableModel =
    managedCatalog.status === "ready" &&
    activeModelOption?.disabled !== true &&
    modelOptions.some((option) => !option.disabled);
  const busy =
    props.loading || props.sending || Boolean(props.activeRunId) || props.stream !== null;
  const commonDisabled =
    !props.connected || busy || props.modelSwitching || !props.gatewayAvailable;
  const effortMutationDisabled = Boolean(props.effortMutationDisabledReason);
  // Loading owns the menu contents, not the trigger. Keeping the trigger
  // interactive lets the first gesture open the picker and observe that state.
  const modelDisabled = commonDisabled || Boolean(props.modelMutationDisabledReason);
  const thinkingDisabled =
    commonDisabled ||
    effortMutationDisabled ||
    !managedCatalog.hasSnapshot ||
    (thinking.options.length === 0 && thinking.selection.source === "default");
  // One owner supplies the whole tuple: mixing an override session's fields with
  // the defaults row can render the default model's options for a session whose
  // model declares none, then patch an invalid option id.
  const contextWindowOwner =
    props.contextWindowTarget ?? activeSession ?? props.sessionsResult?.defaults;
  const contextWindows = contextWindowOwner?.contextWindows ?? [];
  const selectedContextWindow =
    contextWindowOwner?.contextWindow ?? contextWindowOwner?.contextWindowDefault ?? "";
  const defaultContextWindow = contextWindowOwner?.contextWindowDefault;
  const effortDisabled =
    commonDisabled ||
    effortMutationDisabled ||
    (thinking.options.length === 0 && fastMode.disabled);
  // Floating UI deliberately tracks a live anchor. Keep the eventual effort
  // control in layout while catalog state is transient (and until an open model
  // menu closes), so a sibling appearing cannot move that anchor mid-interaction.
  const reserveEffortPicker =
    !hasResolvableModel && (catalogLoadingWithoutSnapshot || props.modelPickerOpen === true);
  const showEffortPicker = hasResolvableModel || reserveEffortPicker;
  return html`
    <div class="chat-controls__session chat-controls__model chat-controls__model-settings">
      ${renderChatModelPicker({
        providerAuth: props.modelAuthStatusResult ? providerAuth : undefined,
        accountSection: props.renderAccountSection?.(currentOverride || defaultModel),
        contextWindow:
          contextWindows.length > 1
            ? {
                options: contextWindows,
                selected: selectedContextWindow,
                ...(defaultContextWindow ? { defaultId: defaultContextWindow } : {}),
                disabled: commonDisabled || Boolean(props.contextWindowMutationDisabledReason),
                onSelect: async (next, targetSessionKey) => {
                  await props.onContextWindowSelect?.(next, targetSessionKey);
                },
              }
            : undefined,
        disabled: modelDisabled,
        disabledReason: props.modelMutationDisabledReason,
        modelCatalogState: managedCatalog,
        open: props.modelPickerOpen,
        modelSelectionLocked: props.modelSelectionLocked === true,
        selectionScopeDescription: resolveModelSelectionScopeDescription(
          props.modelSelectionTarget,
        ),
        modelOptions,
        targetGroups: props.modelPickerTargetGroups,
        selectedModelValue: pickerValue,
        selectedAgentRuntime,
        sessionModelPinned,
        sessionKey: props.sessionKey,
        triggerModelLabel: formatPickerModelLabel(committedModelLabel),
        triggerModelValue: modelPending && !modelStarting ? "" : triggerModelValue || undefined,
        triggerStarting: modelStarting,
        triggerStatusLabel: modelStarting
          ? undefined
          : modelPending
            ? t("chat.modelControls.modelPending")
            : props.modelSelectionLocked
              ? undefined
              : catalogTriggerStatus,
        triggerLoading:
          !modelPending &&
          !props.modelSelectionLocked &&
          catalogLoadingWithoutSnapshot &&
          !selectionKnown,
        onModelSetup: props.onModelSetup,
        onOpen: props.onModelPickerOpen,
        onOpenChange: props.onModelPickerOpenChange,
        onModelSelect: async (next, targetSessionKey, agentRuntime) =>
          props.onModelSelect?.(next, targetSessionKey, agentRuntime),
        onTargetRetry: props.onModelPickerTargetRetry,
        onTargetSelect: props.onModelPickerTargetSelect,
        onRequestUpdate: props.onRequestUpdate,
      })}
      ${
        !showEffortPicker
          ? nothing
          : renderChatEffortPicker({
              disabled: effortDisabled,
              disabledReason: props.effortMutationDisabledReason,
              fastMode: {
                ...fastMode,
                disabled: fastMode.disabled || commonDisabled || effortMutationDisabled,
              },
              sessionKey: props.sessionKey,
              thinkingDisabled,
              thinking,
              onFastModeSelect: async (next, targetSessionKey) =>
                props.onFastModeSelect?.(next, targetSessionKey),
              onRequestUpdate: props.onRequestUpdate,
              onThinkingSelect: async (next, targetSessionKey) =>
                props.onThinkingSelect?.(next, targetSessionKey),
              reserved: reserveEffortPicker,
            })
      }
    </div>
  `;
}
