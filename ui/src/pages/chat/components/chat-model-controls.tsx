import { createMemo, type Accessor } from "solid-js";
import { resolveModelRuntimeRoute } from "../../../../../src/shared/model-runtime-route.js";
import { t as translate } from "../../../i18n/index.ts";
import { registerModelControlsEnglish } from "../../../i18n/locales/en-model-controls.ts";
import { resolveDaybreakAccessProgram } from "../../../lib/chat/daybreak-access-program.ts";
import { resolvePreferredServerChatModelValue } from "../../../lib/chat/model-ref.ts";
import {
  hasNoConnectedChatModel,
  prepareChatModelSelectCatalog,
  resolveChatFastModeSelectState,
  resolveChatModelSelectState,
} from "../../../lib/chat/model-select-state.ts";
import { resolveChatThinkingSelectState } from "../../../lib/chat/thinking.ts";
import type { ChatModelCatalogState } from "../../../lib/model-catalog-store.ts";
import {
  isSessionRuntimePinned,
  resolveModelRuntimeEntry,
} from "../../../lib/model-runtime-choice.ts";
import { i18nRevision, registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { ChatEffortPicker, type ChatEffortPickerParams } from "./chat-effort-picker.tsx";
import {
  prepareChatModelCatalog,
  resolveChatModelPickerLabel,
} from "./chat-model-catalog-presentation.ts";
import type { ChatModelControlsProps } from "./chat-model-controls.types.ts";
import {
  isModelPickerOptionSelected,
  type ChatModelPickerOption,
} from "./chat-model-picker-options.ts";
import { ChatModelPicker, type ChatModelPickerParams } from "./chat-model-picker.tsx";

registerEnglishCatalog(registerModelControlsEnglish);

function formatPickerModelLabel(label: string): string {
  const match = /^Default \((.+)\)$/u.exec(label);
  return match?.[1] ?? label;
}

const MODEL_SELECTION_SCOPE_LABELS = new Map([
  ["session", "chat.modelControls.selectionScopeSession"],
  ["agent", "chat.modelControls.selectionScopeAgent"],
  ["global", "chat.modelControls.selectionScopeGlobal"],
]);

function resolveCatalogTriggerStatus(
  state: ChatModelCatalogState,
  optionCount: number,
): string | undefined {
  if (state.status === "offline") {
    return undefined;
  }
  if (state.status === "error") {
    return optionCount === 0 ? t("chat.modelControls.modelsUnavailable") : undefined;
  }
  if (state.hasSnapshot && optionCount === 0) {
    return t("chat.modelControls.noModelsAvailable");
  }
  return undefined;
}

type ModelControlsViewProps = ChatModelControlsProps & {
  showEffort?: boolean;
  initialDefaultsPending?: boolean;
};

function createChatModelControls(props: ModelControlsViewProps): Accessor<{
  model: ChatModelPickerParams;
  effort: ChatEffortPickerParams;
  showEffort: boolean;
}> {
  const catalogEntries = createMemo(() => props.modelCatalog);
  const catalogIndex = createMemo(() => prepareChatModelCatalog(catalogEntries()));
  const selectCatalog = createMemo(() => prepareChatModelSelectCatalog(catalogEntries()));
  // Spread props change with the whole frame; only model facts rebuild the choices.
  const selectionInputs = createMemo(
    () => {
      const state = props.modelCatalogState;
      const session = props.selectedSession;
      const defaults = props.sessionsResult?.defaults;
      const overrides = props.modelOverrides;
      return [
        state.modelSelectionPolicy,
        state.retired === true,
        state.initialized,
        props.modelSelectionTarget,
        props.agentDefaultModel,
        overrides,
        props.sessionKey,
        props.modelSwitching,
        props.selectedAgentRuntime,
        props.modelSelectionLocked,
        props.sessionRowCurrent,
        session?.model,
        session?.modelProvider,
        session?.modelDisplayName,
        session?.modelOverrideSource,
        session?.runtimeSelectionLocked,
        session?.contextTokens,
        session?.agentRuntime?.id,
        isSessionRuntimePinned(session?.agentRuntime),
        defaults?.model,
        defaults?.modelProvider,
        defaults?.agentRuntime?.id,
        // Retained policy/override objects may change without replacement.
        state.modelSelectionPolicy?.restricted,
        state.modelSelectionPolicy?.defaultModel,
        overrides?.[props.sessionKey],
        overrides !== undefined && Object.hasOwn(overrides, props.sessionKey),
        // Unrelated lazy catalogs must not rebuild every model choice.
        t("chat.modelControls.defaultWithModel"),
        t("chat.selectors.lockedSessionModel"),
      ] as const;
    },
    { equals: (before, after) => before.every((value, index) => value === after[index]) },
  );
  const selection = createMemo(() => {
    // selectionInputs tracks the copy used here.
    const [
      policy,
      retired,
      initialized,
      modelSelectionTarget,
      agentDefaultModel,
      modelOverrides,
      sessionKey,
      modelSwitching,
      selectedRuntimeOverride,
      modelSelectionLocked,
      sessionRowCurrent,
      sessionModel,
      sessionProvider,
      sessionModelDisplayName,
      sessionOverrideSource,
      sessionRuntimeLocked,
      sessionContextTokens,
      sessionRuntimeId,
      sessionRuntimePinned,
      defaultsModel,
      defaultsProvider,
      defaultsRuntimeId,
    ] = selectionInputs();
    const modelCatalog = catalogEntries();
    const catalog = catalogIndex();
    const uninitialized = initialized === false;
    const catalogOwnsChoices = retired || uninitialized || policy?.restricted === true;
    const selectionScopeLabel = MODEL_SELECTION_SCOPE_LABELS.get(modelSelectionTarget ?? "");
    const {
      currentOverride: rawCurrentOverride,
      defaultModel,
      defaultLabel,
      modelOverrideSource,
      options: selectOptions,
    } = resolveChatModelSelectState(
      {
        activeSession: {
          model: sessionModel,
          modelProvider: sessionProvider,
          modelOverrideSource: sessionOverrideSource,
        },
        agentDefaultModel,
        chatModelCatalog: modelCatalog,
        modelOverrides: modelOverrides ?? {},
        sessionKey,
        sessionsResult: { defaults: { model: defaultsModel, modelProvider: defaultsProvider } },
        modelSelectionPolicy: policy,
        catalogRetired: retired,
        catalogInitialized: initialized,
      },
      selectCatalog(),
    );
    const currentOverride =
      !catalogOwnsChoices || (!retired && catalog.entry(rawCurrentOverride))
        ? rawCurrentOverride
        : "";
    const runtimeSelectionLocked = sessionRuntimeLocked === true;
    const currentProviderHint = sessionProvider ?? "";
    // This control owns the saved preference, not the model observed on a run.
    // A running turn can report its old model (or fallback) after a new choice is saved.
    const defaultProviderHint = defaultsProvider ?? "";
    const defaultCatalogEntry = catalog.entry(defaultModel);
    const sessionModelValue = resolvePreferredServerChatModelValue(
      sessionModel,
      sessionProvider,
      modelCatalog,
    );
    const selectedValue = currentOverride || defaultModel;
    const selectedEntry = catalog.entry(selectedValue);
    // Before the first scoped catalog, a live role-projected row can name the saved
    // preference. It cannot admit options or name a different optimistic selection.
    const labelValue =
      uninitialized && !retired && sessionRowCurrent ? rawCurrentOverride : selectedValue;
    const rowLabel =
      !selectedEntry && labelValue && labelValue === sessionModelValue
        ? sessionModelDisplayName?.trim()
        : undefined;
    const canonicalDefaultLabel = resolveChatModelPickerLabel(defaultCatalogEntry, defaultLabel);
    const pickerDefaultLabel =
      defaultModel && canonicalDefaultLabel !== defaultLabel
        ? translate("chat.modelControls.defaultWithModel", { model: canonicalDefaultLabel })
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
        contextTokens: catalogEntry?.contextTokens,
        contextWindow: catalogEntry?.contextWindow,
        supportsTools: catalogEntry?.supportsTools,
        recommended: catalogEntry?.recommended,
        disabled: option.disabled,
        unavailableReason: option.disabled ? option.unavailableReason : undefined,
        unavailableUntil: catalogEntry?.unavailableUntil,
        provider: catalog.provider(
          option.value,
          isDefault
            ? defaultProviderHint
            : option.value === currentOverride
              ? currentProviderHint
              : "",
        ),
      };
      if (catalogEntry?.providerName || catalogEntry?.providerIcon) {
        pickerOption.presentation = catalogEntry;
      }
      if (agentRuntimeId) {
        pickerOption.agentRuntimeId = agentRuntimeId;
      }
      if (isDefault && sessionRuntimePinned && resolveModelRuntimeRoute(pickerOption.provider)) {
        // Default clears the runtime pin; label the configured default route, not the one being left.
        pickerOption.agentRuntimeId = defaultsRuntimeId?.trim() || undefined;
      }
      const options = [pickerOption];
      for (const choice of runtimeSelectionLocked ? [] : (catalogEntry?.runtimeChoices ?? [])) {
        if (choice.manualSelectionAllowed === false) {
          continue;
        }
        options.push({
          value: option.value,
          commitValue: option.value,
          isDefault: false,
          label: resolveChatModelPickerLabel(catalogEntry, option.label, choice.agentRuntime.id),
          provider: pickerOption.provider,
          agentRuntime: choice.agentRuntime.id,
          runtimeOverride: choice.agentRuntime.id,
          agentRuntimeId: choice.agentRuntime.id,
          contextTokens: choice.contextTokens,
          contextWindow: choice.contextWindow,
          supportsTools: choice.supportsTools,
          disabled: choice.available === false,
          unavailableReason: choice.unavailableReason,
          unavailableUntil: choice.unavailableUntil,
          recommended: pickerOption.recommended,
        });
      }
      return options;
    });
    // Only a pin recorded on the session row makes Default a reset target: New Session
    // drafts have no row, and a local optimistic override is not yet a recorded pin.
    const sessionModelPinned =
      sessionOverrideSource === "user" || (!runtimeSelectionLocked && sessionRuntimePinned);
    // That pin must stay clearable even when the configured default is absent from
    // this catalog. Without it the row has no job (an agent-scoped catalog may
    // legitimately omit the Gateway default), so nothing is synthesized.
    if (
      defaultModel &&
      (sessionModelPinned || policy?.restricted) &&
      !retired &&
      !uninitialized &&
      !modelOptions.some((option) => option.isDefault)
    ) {
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
      (!catalogOwnsChoices || currentCatalogEntry) &&
      currentCatalogEntry?.manualSelectionAllowed !== false &&
      modelOptions.length > 0 &&
      !modelOptions.some((option) => option.value === currentOverride)
    ) {
      modelOptions.push({
        commitValue: currentOverride,
        contextTokens: currentCatalogEntry?.contextTokens,
        contextWindow: currentCatalogEntry?.contextWindow,
        supportsTools: currentCatalogEntry?.supportsTools,
        disabled: currentCatalogEntry?.available === false,
        unavailableReason:
          currentCatalogEntry?.available === false
            ? currentCatalogEntry.unavailableReason
            : undefined,
        isDefault: false,
        value: currentOverride,
        label: resolveChatModelPickerLabel(
          currentCatalogEntry,
          currentCatalogEntry?.name.trim() || rowLabel || currentOverride,
        ),
        provider: catalog.provider(currentOverride, currentProviderHint),
      });
    }
    // A persisted pin can match a changed default; equality cannot establish inheritance.
    const selectedAgentRuntime =
      selectedRuntimeOverride ?? sessionRuntimeId ?? selectedEntry?.agentRuntime?.id;
    const defaultRuntime = defaultCatalogEntry?.agentRuntime?.id ?? defaultsRuntimeId;
    // A default model can still have a runtime pin; only the configured model/runtime pair inherits Default.
    const pickerValue =
      modelOverrideSource === null &&
      (!selectedAgentRuntime || selectedAgentRuntime === defaultRuntime)
        ? ""
        : currentOverride || defaultModel;
    const activeModelOption = modelOptions.find((option) =>
      isModelPickerOptionSelected(option, pickerValue, selectedAgentRuntime),
    );
    const activeSessionModel = catalog.entry(sessionModelValue);
    const activeOptionModel = activeModelOption
      ? catalog.entry(activeModelOption.value)
      : undefined;
    const activeSessionRuntime = sessionRuntimeId?.trim().toLowerCase();
    const activeOptionRuntime = (
      resolveModelRuntimeEntry(activeOptionModel, activeModelOption?.agentRuntime)?.agentRuntime
        ?.id ?? (activeModelOption?.isDefault ? defaultsRuntimeId : undefined)
    )
      ?.trim()
      .toLowerCase();
    const activeRuntimeMatches =
      Boolean(activeSessionRuntime) && activeSessionRuntime === activeOptionRuntime;
    // Missing or mismatched current-selection provenance cannot bind the cached
    // session window. Even matching provenance is useful only after the switch settles.
    if (
      !modelSwitching &&
      activeModelOption &&
      sessionContextTokens &&
      activeRuntimeMatches &&
      activeSessionModel !== undefined &&
      activeSessionModel === activeOptionModel
    ) {
      activeModelOption.contextTokens = sessionContextTokens;
    }
    // The preference label uses its selected runtime, not an executing fallback.
    const triggerRuntime = selectedAgentRuntime ?? defaultRuntime;
    // A lock prevents model changes; the concrete selection still owns its label.
    // Without a selection, neither the runtime nor the agent default identifies it.
    const committedModelLabel =
      modelSelectionLocked === true && !currentOverride && !(uninitialized && rowLabel)
        ? translate("chat.selectors.lockedSessionModel")
        : resolveChatModelPickerLabel(
            selectedEntry,
            formatPickerModelLabel(
              selectOptions.find((entry) => entry.value === currentOverride)?.label ??
                (currentCatalogEntry?.name.trim() || rowLabel || currentOverride || defaultLabel),
            ),
            currentOverride || defaultModel ? triggerRuntime : null,
          );
    return {
      catalog,
      policy,
      retired,
      uninitialized,
      selectionScopeLabel,
      currentOverride,
      defaultModel,
      modelOverrideSource,
      modelOptions,
      activeModelOption,
      pickerValue,
      selectedAgentRuntime,
      sessionModelPinned,
      committedModelLabel,
      triggerRuntime,
    };
  });
  // Capture fields so refreshed wrappers and unrelated frames do not rescan the catalog.
  const fastModeInputs = createMemo(
    () => {
      const target = props.fastModeTarget ?? props.selectedSession;
      const defaults = props.sessionsResult?.defaults;
      return [
        catalogEntries(),
        selection().currentOverride,
        target?.model,
        target?.modelProvider,
        target?.agentRuntime?.id,
        target?.fastMode,
        target?.effectiveFastMode,
        defaults?.model,
        defaults?.modelProvider,
        props.connected,
        props.gatewayAvailable,
        props.loading,
      ] as const;
    },
    { equals: (before, after) => before.every((value, index) => value === after[index]) },
  );
  const resolvedFastMode = createMemo(() => {
    i18nRevision();
    const [
      catalog,
      currentModelOverride,
      model,
      modelProvider,
      runtimeId,
      fastMode,
      effectiveFastMode,
      defaultModel,
      defaultProvider,
      connected,
      gatewayAvailable,
      loading,
    ] = fastModeInputs();
    return resolveChatFastModeSelectState({
      catalog,
      connected,
      currentModelOverride,
      fastModeTarget: {
        model,
        modelProvider,
        agentRuntime: runtimeId === undefined ? undefined : { id: runtimeId },
        fastMode,
        effectiveFastMode,
      },
      gatewayAvailable,
      loading,
      sessionsResult: { defaults: { model: defaultModel, modelProvider: defaultProvider } },
    });
  });
  return createMemo(() => {
    const {
      catalog,
      policy,
      retired,
      uninitialized,
      selectionScopeLabel,
      currentOverride,
      defaultModel,
      modelOptions,
      activeModelOption,
      pickerValue,
      selectedAgentRuntime,
      sessionModelPinned,
      committedModelLabel,
      triggerRuntime,
    } = selection();
    const catalogState = props.modelCatalogState;
    const setupRequired =
      catalogState.hasSnapshot &&
      catalogState.status === "ready" &&
      !catalogState.pendingProviders?.length &&
      !policy?.restricted &&
      !(
        props.selectedSession?.placement?.state === "active" &&
        props.selectedSession.placement.inference === "worker"
      ) &&
      hasNoConnectedChatModel(props.modelCatalog, props.modelAuthStatusResult);
    const thinking = resolveChatThinkingSelectState({
      catalog: props.modelCatalog,
      defaults: props.thinkingDefaults,
      session: props.thinkingSession,
      sessionKey: props.sessionKey,
      sessionsResult: props.sessionsResult,
    });
    // Reasoning/fast state still describes the previous model until the refreshed
    // session row lands. Lock both so stale levels cannot be committed mid-switch.
    const currentFastMode = resolvedFastMode();
    const presentedFastMode = props.fastModeDisplay
      ? { ...currentFastMode, ...props.fastModeDisplay }
      : currentFastMode;
    const fastMode = props.modelSwitching
      ? { ...presentedFastMode, disabled: true }
      : presentedFastMode;
    const catalogTriggerStatus =
      catalogState.status === "ready" &&
      catalogState.pendingProviders?.length &&
      modelOptions.length === 0
        ? undefined
        : retired
          ? resolveCatalogTriggerStatus(catalogState, 0)
          : policy?.restricted && !currentOverride && !defaultModel
            ? t(
                modelOptions.length
                  ? "chat.modelControls.selectionRequired"
                  : "chat.modelControls.noPermittedModels",
              )
            : resolveCatalogTriggerStatus(catalogState, modelOptions.length);
    const hasResolvableModel =
      catalogState.hasSnapshot &&
      (catalogState.status === "ready" ||
        catalogState.status === "error" ||
        catalogState.status === "loading" ||
        catalogState.status === "offline") &&
      activeModelOption?.disabled !== true &&
      modelOptions.some((option) => !option.disabled);
    const busy = props.sending || Boolean(props.activeRunId) || props.stream !== null;
    const modelControlsDisabled =
      !props.connected || props.modelSwitching || !props.gatewayAvailable;
    const commonDisabled = modelControlsDisabled || props.loading;
    const effortMutationDisabled = Boolean(props.effortMutationDisabledReason);
    // Loading owns the menu contents, not the trigger. Keeping the trigger
    // interactive lets the first gesture open the picker and observe that state.
    const modelDisabled = modelControlsDisabled || Boolean(props.modelMutationDisabledReason);
    const thinkingDisabled =
      commonDisabled ||
      effortMutationDisabled ||
      !catalogState.hasSnapshot ||
      (thinking.options.length === 0 && thinking.selection.source === "default");
    // One owner supplies the whole tuple: mixing an override session's fields with
    // the defaults row can render the default model's options for a session whose
    // model declares none, then patch an invalid option id.
    const contextWindowOwner =
      props.contextWindowTarget ?? props.selectedSession ?? props.sessionsResult?.defaults;
    const contextWindows = contextWindowOwner?.contextWindows ?? [];
    const selectedContextWindow =
      contextWindowOwner?.contextWindow ?? contextWindowOwner?.contextWindowDefault ?? "";
    const defaultContextWindow = contextWindowOwner?.contextWindowDefault;
    const accessProgramModel = resolveModelRuntimeEntry(
      catalog.entry(currentOverride || defaultModel),
      triggerRuntime,
    );
    const effectiveAccessProgram =
      !retired && !uninitialized && !props.modelSwitching
        ? accessProgramModel?.cyberAccessProgramDefault
        : undefined;
    const accessPrograms =
      props.connected &&
      catalogState.hasSnapshot &&
      catalogState.status === "ready" &&
      !retired &&
      !uninitialized &&
      !props.modelSwitching
        ? accessProgramModel?.availableAccessPrograms?.cyber
        : undefined;
    const daybreak = resolveDaybreakAccessProgram(
      accessPrograms,
      props.requestedAccessProgram ?? effectiveAccessProgram,
    );
    const showAccessProgram = Boolean(props.onAccessProgramSelect) && daybreak.visible;
    const accessProgramDisabled =
      commonDisabled || !hasResolvableModel || Boolean(props.accessProgramMutationDisabledReason);
    const effortDisabled =
      commonDisabled ||
      !hasResolvableModel ||
      ((effortMutationDisabled || (thinking.options.length === 0 && fastMode.disabled)) &&
        (!showAccessProgram || accessProgramDisabled));
    // An empty catalog must not expose fallback speed controls for an unavailable model.
    const confirmedEmptyCatalog =
      catalogState.hasSnapshot &&
      modelOptions.length === 0 &&
      !catalogState.pendingProviders?.length;
    return {
      showEffort: !setupRequired && !confirmedEmptyCatalog,
      model: {
        modelAuthStatusResult: props.modelAuthStatusResult,
        authProfileId:
          props.accountSelection?.kind === "automatic"
            ? undefined
            : props.accountSelection?.authProfileId,
        accountSection: props.renderAccountSection?.(currentOverride || defaultModel),
        contextWindow:
          contextWindows.length > 1
            ? {
                options: contextWindows,
                selected: selectedContextWindow,
                ...(defaultContextWindow ? { defaultId: defaultContextWindow } : {}),
                disabled:
                  commonDisabled || busy || Boolean(props.contextWindowMutationDisabledReason),
                onSelect: async (next, targetSessionKey) => {
                  await props.onContextWindowSelect?.(next, targetSessionKey);
                },
              }
            : undefined,
        disabled: modelDisabled,
        disabledReason: props.modelMutationDisabledReason,
        modelCatalogState: catalogState,
        renderModelCatalogStatus: props.renderModelCatalogStatus,
        open: props.modelPickerOpen,
        modelSelectionLocked: props.modelSelectionLocked === true,
        selectionScopeDescription: policy?.restricted
          ? t("chat.modelControls.restrictedModelsHelp")
          : selectionScopeLabel
            ? t(selectionScopeLabel)
            : undefined,
        // Missing sign-in is not missing configuration. Keep diagnosed catalog rows;
        // only the undiagnosed inherited default is a phantom in an unconfigured chat.
        modelOptions:
          setupRequired && !sessionModelPinned
            ? modelOptions.filter((option) => !option.isDefault || option.unavailableReason)
            : modelOptions,
        targetGroups: props.modelPickerTargetGroups,
        selectedModelValue: pickerValue,
        selectedAgentRuntime,
        sessionModelPinned,
        sessionKey: props.sessionKey,
        triggerModelLabel:
          props.initialDefaultsPending &&
          !currentOverride &&
          !defaultModel &&
          !props.modelSelectionLocked
            ? ""
            : formatPickerModelLabel(committedModelLabel),
        triggerModelValue: currentOverride || undefined,
        triggerStatusLabel: props.modelSelectionLocked
          ? undefined
          : setupRequired
            ? t("modelSetup.required.action")
            : catalogTriggerStatus,
        onModelSetup:
          policy?.restricted || retired || uninitialized ? undefined : props.onModelSetup,
        onProviderSettings:
          policy?.restricted || retired || uninitialized ? undefined : props.onProviderSettings,
        onOpen: props.onModelPickerOpen,
        onOpenChange: props.onModelPickerOpenChange,
        onModelSelect: async (next, targetSessionKey, agentRuntime) =>
          props.onModelSelect?.(next, targetSessionKey, agentRuntime),
        onTargetRetry: props.onModelPickerTargetRetry,
        onTargetSelect: props.onModelPickerTargetSelect,
      },
      effort: {
        accessProgram:
          showAccessProgram && props.onAccessProgramSelect
            ? {
                daybreak,
                disabled: accessProgramDisabled,
                sessionKey: props.sessionKey,
                onSelect: props.onAccessProgramSelect,
              }
            : undefined,
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
        onThinkingSelect: async (next, targetSessionKey) =>
          props.onThinkingSelect?.(next, targetSessionKey),
        reserved: !hasResolvableModel,
      },
    };
  });
}

export function ChatModelControls(props: ModelControlsViewProps) {
  const controls = createChatModelControls(props);
  return (
    <div
      class="chat-controls__session chat-controls__model chat-controls__model-settings"
      data-model-pending={
        !(controls().model.triggerStatusLabel ?? controls().model.triggerModelLabel) || undefined
      }
    >
      <ChatModelPicker {...controls().model} />
      {props.showEffort !== false && controls().showEffort ? (
        <ChatEffortPicker {...controls().effort} />
      ) : undefined}
    </div>
  );
}
