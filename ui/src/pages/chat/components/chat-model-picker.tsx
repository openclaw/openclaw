import type { JSX } from "@solidjs/web";
import { createEffect, createMemo, For } from "solid-js";
import { resolveModelRuntimeRoute } from "../../../../../src/shared/model-runtime-route.js";
import { hasProviderBrandIcon, providerDisplayLabel } from "../../../components/provider-icon.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { ProviderBrandIcon } from "../../../components/solid/provider-icon.tsx";
import "../../../components/tooltip.ts";
import { registerModelControlsEnglish } from "../../../i18n/locales/en-model-controls.ts";
import { canonicalModelAuthProviderId } from "../../../lib/model-auth.ts";
import type { ChatModelCatalogState as ModelCatalogState } from "../../../lib/model-catalog-store.ts";
import type { ModelProviderAuthLabel } from "../../../lib/model-provider-auth-label.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { LitContent } from "./chat-composer-interop.tsx";
import {
  type ChatContextWindowControlParams,
  renderContextWindowControl,
} from "./chat-context-window-control.ts";
import type { ChatModelAccountSection } from "./chat-model-account-control.ts";
import { ChatModelAccountSectionView } from "./chat-model-account-control.tsx";
import { ChatModelCatalogRefresh, ChatModelCatalogState } from "./chat-model-catalog-state.tsx";
import {
  isModelPickerOptionSelected,
  modelPickerOptionKey,
  type ChatModelPickerOption as ModelPickerOption,
  type ChatModelPickerTargetGroup,
} from "./chat-model-picker-options.ts";
import {
  ChatModelPickerOption,
  ChatModelPickerTargetOption,
  ChatModelProviderIcon,
} from "./chat-model-picker-options.tsx";
import {
  handleModelPickerKeydown,
  handleModelSearchKeydown,
  resetModelSearch,
  syncChatModelSearch,
  toggleModelProviderGroup,
  updateModelSearch,
} from "./chat-model-picker-search.ts";
import { handleChatComposerDetailsToggle, syncChatPickerOverlay } from "./chat-picker-overlay.ts";

registerEnglishCatalog(registerModelControlsEnglish);

export type ChatModelPickerParams = {
  providerAuth?: ReadonlyMap<string, ModelProviderAuthLabel>;
  accountSection?: ChatModelAccountSection;
  contextWindow?: ChatContextWindowControlParams;
  disabled: boolean;
  disabledReason?: string;
  modelCatalogState?: ModelCatalogState;
  modelSelectionLocked: boolean;
  selectionScopeDescription?: string;
  modelOptions: ModelPickerOption[];
  open?: boolean;
  targetGroups?: readonly ChatModelPickerTargetGroup[];
  selectedModelValue: string;
  selectedAgentRuntime?: string;
  /** Pin recorded on the session row; only then does an unavailable Default row reset. */
  sessionModelPinned: boolean;
  sessionKey: string;
  triggerModelLabel: string;
  triggerModelValue?: string;
  triggerStatusLabel?: string;
  triggerLoading?: boolean;
  onModelSetup?: () => void;
  onProviderSettings?: (provider: string) => void;
  onOpen?: () => unknown;
  onOpenChange?: (open: boolean) => void;
  onModelSelect: (
    value: string,
    sessionKey: string,
    agentRuntime?: string | null,
  ) => Promise<unknown>;
  onTargetRetry?: (groupId: string) => unknown;
  onTargetSelect?: (groupId: string, value: string) => unknown;
  onRequestUpdate?: () => void;
};

function closeModelPickerAfterSelection(event: MouseEvent) {
  // SAFETY: Model option buttons are the only callers of this click handler.
  const details = (event.currentTarget as HTMLElement).closest<HTMLDetailsElement>("details");
  if (details) {
    details.open = false;
    if (event.detail === 0) {
      details.querySelector<HTMLElement>("summary")?.focus({ preventScroll: true });
    }
  }
}

function prepareChatModelPicker(params: ChatModelPickerParams) {
  const defaultModelOption = params.modelOptions.find((option) => option.isDefault);
  const activeModelOption = params.modelOptions.find((option) =>
    isModelPickerOptionSelected(option, params.selectedModelValue, params.selectedAgentRuntime),
  );
  const leadingModelOption = activeModelOption ?? defaultModelOption;
  const triggerModelValue = params.triggerModelValue;
  const triggerModelOption =
    triggerModelValue === undefined
      ? activeModelOption
      : triggerModelValue === ""
        ? undefined
        : params.modelOptions.find((option) =>
            isModelPickerOptionSelected(option, triggerModelValue, params.selectedAgentRuntime),
          );
  const modelToolsUnavailable = triggerModelOption?.supportsTools === false;
  const selectedContextWindowOption = params.contextWindow?.options.find(
    (option) => option.id === params.contextWindow?.selected,
  );
  const showContextWindowBadge =
    selectedContextWindowOption !== undefined &&
    params.contextWindow?.selected !== params.contextWindow?.defaultId;
  const triggerTitle = [
    params.triggerStatusLabel ?? params.triggerModelLabel,
    modelToolsUnavailable ? t("chat.modelControls.chatOnly") : "",
  ]
    .filter(Boolean)
    .join(" · ");
  // A model reachable only through Claude CLI (an Anthropic ref pinned to that runtime)
  // belongs to the Claude CLI group, not to an Anthropic API group the user may not have.
  const groupProvider = (option: ModelPickerOption) =>
    resolveModelRuntimeRoute(option.provider, option.agentRuntimeId) === "claudeCli"
      ? "claude-cli"
      : option.provider;
  // Default restores inheritance; it stays ahead of ranked model choices. When a
  // provider recommends models, they follow, and the rest collapse under "All models".
  const recommendingProviders = new Set(
    params.modelOptions.filter((option) => option.recommended).map(groupProvider),
  );
  const providerGroups = new Map<
    string,
    { lead: ModelPickerOption[]; more: ModelPickerOption[] }
  >();
  for (const option of params.modelOptions) {
    const provider = groupProvider(option);
    const group = providerGroups.get(provider) ?? { lead: [], more: [] };
    if (option.isDefault) {
      group.lead.unshift(option);
    } else if (option === leadingModelOption) {
      group.lead.splice(group.lead[0]?.isDefault ? 1 : 0, 0, option);
    } else if (option.recommended || !recommendingProviders.has(provider)) {
      group.lead.push(option);
    } else {
      group.more.push(option);
    }
    providerGroups.set(provider, group);
  }
  const orderedProviderGroups = [...providerGroups];
  const leadingProvider = leadingModelOption && groupProvider(leadingModelOption);
  const activeProvider = activeModelOption && groupProvider(activeModelOption);
  const selectedProviderIndex = orderedProviderGroups.findIndex(
    ([provider]) => provider === leadingProvider,
  );
  if (selectedProviderIndex > 0) {
    orderedProviderGroups.unshift(...orderedProviderGroups.splice(selectedProviderIndex, 1));
  }
  const orderedOptions = orderedProviderGroups.flatMap(([, { lead, more }]) => [...lead, ...more]);
  const optionIndex = new Map(
    orderedOptions.map((option, index) => [modelPickerOptionKey(option), index]),
  );
  const targetGroups = params.targetGroups ?? [];
  const targetOptionCount = targetGroups.reduce((count, group) => count + group.options.length, 0);
  const hasOptions =
    params.modelOptions.length + targetOptionCount > 0 ||
    targetGroups.some((group) => group.status !== "ready");
  const hasSelectableModelOptions = params.modelOptions.some((option) => !option.disabled);
  return {
    triggerModelOption,
    modelToolsUnavailable,
    selectedContextWindowOption,
    showContextWindowBadge,
    triggerTitle,
    orderedProviderGroups,
    activeProvider,
    orderedOptions,
    optionIndex,
    targetGroups,
    targetOptionCount,
    hasOptions,
    hasSelectableModelOptions,
  };
}

function ModelList(props: { label: string; more?: boolean; children: JSX.Element }) {
  return (
    <div
      class="chat-controls__provider-model-list"
      data-chat-model-list="true"
      data-chat-model-more={props.more ? "" : undefined}
      role="listbox"
      aria-label={props.label}
    >
      {props.children}
    </div>
  );
}

export function ChatModelPicker(params: ChatModelPickerParams) {
  const state = createMemo(() => prepareChatModelPicker(params));
  const contextWindowContent = createMemo(() => {
    const control = params.contextWindow;
    return control ? renderContextWindowControl(control, params.sessionKey) : undefined;
  });
  let details: HTMLDetailsElement | undefined;
  createEffect(
    () => [
      params.modelCatalogState,
      params.modelOptions,
      params.targetGroups,
      params.accountSection,
      params.selectedModelValue,
      params.selectedAgentRuntime,
    ],
    () => {
      if (details) {
        syncChatModelSearch(details);
      }
    },
  );
  const selectModel = (entry: ModelPickerOption, event: MouseEvent) => {
    event.stopPropagation();
    // Resetting a pin does not require the inherited model to be available.
    const resetsPin = entry.isDefault && params.sessionModelPinned;
    if (params.disabled || params.modelSelectionLocked || (entry.disabled && !resetsPin)) {
      event.preventDefault();
      return;
    }
    void params
      .onModelSelect(
        entry.commitValue,
        params.sessionKey,
        entry.runtimeOverride ??
          (entry.isDefault || entry.agentRuntime !== undefined ? null : undefined),
      )
      .finally(() => params.onRequestUpdate?.());
    params.onRequestUpdate?.();
    closeModelPickerAfterSelection(event);
  };
  const selectTarget = (groupId: string, value: string, event: MouseEvent) => {
    event.stopPropagation();
    if (params.disabled || params.modelSelectionLocked) {
      event.preventDefault();
      return;
    }
    params.onTargetSelect?.(groupId, value);
    closeModelPickerAfterSelection(event);
  };
  function ModelOption(props: { entry: ModelPickerOption }) {
    return (
      <ChatModelPickerOption
        disabled={params.disabled}
        entry={props.entry}
        index={state().optionIndex.get(modelPickerOptionKey(props.entry)) ?? 0}
        selectedModelValue={params.selectedModelValue}
        selectedAgentRuntime={params.selectedAgentRuntime}
        sessionModelPinned={params.sessionModelPinned}
        onSelect={selectModel}
        onModelSetup={params.onModelSetup}
      />
    );
  }
  function ProviderGroup(props: {
    provider: string;
    lead: ModelPickerOption[];
    more: ModelPickerOption[];
  }) {
    const providerLabel = () => providerDisplayLabel(props.provider);
    const groupLabel = () => t("chat.modelControls.providerModels", { provider: providerLabel() });
    const options = () => [...props.lead, ...props.more];
    const auth = () => params.providerAuth?.get(canonicalModelAuthProviderId(props.provider));
    const showAuth = () =>
      auth() &&
      !(
        auth()?.kind === "missing" &&
        options().some(
          (option) =>
            option.disabled &&
            (option.unavailableReason === "missing-auth" ||
              option.unavailableReason === "auth-failed"),
        )
      );
    const authLabel = () =>
      showAuth() ? [auth()?.label, auth()?.detail].filter(Boolean).join(" · ") : undefined;
    const routeDetail = () => {
      const route = resolveModelRuntimeRoute(props.provider);
      return route ? t(`chat.modelControls.routes.${route}.detail`) : undefined;
    };
    return (
      <section
        class="chat-controls__provider-model-group"
        data-chat-model-provider-group={props.provider}
        aria-label={groupLabel()}
      >
        <div
          class="chat-controls__provider-heading"
          data-chat-model-provider={props.provider}
          title={[routeDetail(), authLabel()].filter(Boolean).join(" · ") || undefined}
        >
          <button
            class="chat-controls__provider-toggle"
            type="button"
            data-chat-model-group-toggle
            data-chat-model-provider-toggle
            aria-expanded={props.provider === state().activeProvider ? "true" : "false"}
            aria-label={`${groupLabel()} (${options().length})`}
            aria-description={routeDetail()}
            disabled={params.disabled}
            onClick={toggleModelProviderGroup}
          >
            <ChatModelProviderIcon provider={props.provider} />
            <span class="chat-controls__provider-label">{providerLabel()}</span>
            <span>{options().length}</span>
            <span class="chat-controls__inline-select-chevron" aria-hidden="true">
              <Icon name="chevronDown" />
            </span>
          </button>
          {showAuth() ? (
            <span class="chat-controls__auth-meta" data-auth-kind={auth()?.kind}>
              <span aria-hidden="true">
                <Icon
                  name={
                    auth()?.kind === "subscription"
                      ? "circleUser"
                      : auth()?.kind === "api"
                        ? "key"
                        : "alertTriangle"
                  }
                />
              </span>
              <span class="chat-controls__auth-meta-label">{authLabel()}</span>
            </span>
          ) : undefined}
          {params.onProviderSettings ? (
            <button
              class="chat-controls__provider-settings"
              data-chat-model-provider-settings
              type="button"
              aria-label={t("chat.modelControls.configureModels")}
              onClick={(event: MouseEvent) => {
                event.stopPropagation();
                params.onProviderSettings?.(props.provider);
              }}
            >
              <Icon name="settings" />
            </button>
          ) : undefined}
        </div>
        <ModelList label={groupLabel()}>
          <For each={props.lead} keyed={modelPickerOptionKey}>
            {(entry) => <ModelOption entry={entry()} />}
          </For>
        </ModelList>
        {props.more.length > 0 ? (
          <>
            <button
              class="chat-controls__inline-select-option chat-controls__model-more-toggle"
              type="button"
              data-chat-model-more-toggle
              aria-expanded="false"
              hidden
              disabled={params.disabled}
              onClick={toggleModelProviderGroup}
            >
              <span class="chat-controls__model-option-provider" aria-hidden="true" />
              <span>{t("chat.modelControls.allModels", { count: String(props.more.length) })}</span>
              <span class="chat-controls__inline-select-chevron" aria-hidden="true">
                <Icon name="chevronDown" />
              </span>
            </button>
            <ModelList label={groupLabel()} more>
              <For each={props.more} keyed={modelPickerOptionKey}>
                {(entry) => <ModelOption entry={entry()} />}
              </For>
            </ModelList>
          </>
        ) : undefined}
      </section>
    );
  }
  return (
    <details
      ref={(element) => {
        details = element;
      }}
      class="chat-controls__inline-select chat-controls__model-picker"
      data-chat-autotype-shortcuts
      prop:open={params.open === true}
      onKeyDown={handleModelPickerKeydown}
      onToggle={(event: Event) => {
        // SAFETY: This toggle handler belongs to the surrounding native details.
        const target = event.currentTarget as HTMLDetailsElement;
        params.onOpenChange?.(target.open);
        handleChatComposerDetailsToggle(event);
        syncChatPickerOverlay(target);
        if (!target.open) {
          params.accountSection?.onClose();
          resetModelSearch(target);
          return;
        }
        void params.onOpen?.();
        syncChatModelSearch(target);
        const active = target.ownerDocument.activeElement;
        requestAnimationFrame(() => {
          if (target.isConnected && target.open && target.ownerDocument.activeElement === active) {
            target
              .querySelector<HTMLInputElement>("[data-chat-model-search]")
              ?.focus({ preventScroll: true });
          }
        });
      }}
    >
      <summary
        class={[
          "chat-controls__inline-select-trigger chat-controls__model-trigger",
          {
            "chat-controls__model-trigger--loading": params.triggerLoading,
            "chat-controls__inline-select-trigger--disabled": params.disabled,
          },
        ]}
        data-chat-model-select="true"
        data-chat-model-locked={params.modelSelectionLocked ? "true" : "false"}
        data-chat-select-value={params.selectedModelValue}
        data-chat-model-tools={state().modelToolsUnavailable ? "unavailable" : "available"}
        aria-label={`${t("chat.selectors.model")}: ${state().triggerTitle}${params.selectionScopeDescription ? `. ${params.selectionScopeDescription}` : ""}`}
        aria-busy={params.triggerLoading ? "true" : "false"}
        aria-disabled={params.disabled ? "true" : "false"}
        title={params.disabledReason?.trim() || undefined}
        onClick={(event: MouseEvent) => {
          if (params.disabled) {
            event.preventDefault();
            return;
          }
          // SAFETY: This click handler belongs to the surrounding native summary.
          (event.currentTarget as HTMLElement).focus({ preventScroll: true });
        }}
      >
        {state().modelToolsUnavailable ? (
          <openclaw-tooltip prop:content={t("chat.modelControls.chatOnlyHelp")}>
            <span class="chat-controls__model-capability-badge" aria-hidden="true">
              <Icon name="alertTriangle" />
              <span>{t("chat.modelControls.chatOnly")}</span>
            </span>
          </openclaw-tooltip>
        ) : undefined}
        {!params.triggerLoading &&
        !params.triggerStatusLabel &&
        state().triggerModelOption &&
        hasProviderBrandIcon(state().triggerModelOption!.provider) ? (
          <ProviderBrandIcon
            provider={state().triggerModelOption!.provider}
            class="chat-controls__trigger-provider-icon"
          />
        ) : undefined}
        <span class="chat-controls__inline-select-label">
          {params.triggerLoading ? (
            <span class="skeleton chat-controls__model-trigger-skeleton" aria-hidden="true" />
          ) : (
            (params.triggerStatusLabel ?? params.triggerModelLabel)
          )}
        </span>
        {state().showContextWindowBadge ? (
          <span
            class="chat-controls__locked-model-badge chat-controls__model-context-badge"
            data-chat-model-context-badge
          >
            {state().selectedContextWindowOption?.label}
          </span>
        ) : undefined}
        <span class="chat-controls__inline-select-chevron" aria-hidden="true">
          <Icon name="chevronUp" />
        </span>
      </summary>
      <wa-popup data-anchored-overlay>
        <div
          class="chat-controls__inline-select-menu chat-controls__model-menu"
          aria-label={t("chat.selectors.model")}
        >
          {params.modelSelectionLocked ? (
            <div
              class="chat-controls__locked-model"
              aria-label={t("chat.selectors.modelLockedLabel")}
            >
              <span class="chat-controls__inline-select-section-label">
                {t("chat.selectors.modelSection")}
              </span>
              <span class="chat-controls__locked-model-value">{params.triggerModelLabel}</span>
              <span class="chat-controls__locked-model-badge">
                {t("chat.selectors.modelLocked")}
              </span>
            </div>
          ) : (
            <>
              {state().hasOptions || params.accountSection ? (
                <div class="chat-controls__model-search-wrap">
                  <Icon name="search" />
                  <input
                    class="chat-controls__model-search"
                    data-chat-model-search="true"
                    type="search"
                    role="combobox"
                    aria-autocomplete="list"
                    autocomplete="off"
                    spellcheck="false"
                    placeholder={t("chat.modelControls.searchModels")}
                    aria-label={t("chat.modelControls.searchModels")}
                    disabled={params.disabled}
                    onInput={(event: InputEvent) =>
                      // SAFETY: This input handler belongs to the model search input.
                      updateModelSearch(event.currentTarget as HTMLInputElement)
                    }
                    onKeyDown={handleModelSearchKeydown}
                  />
                  {params.modelOptions.length > 0 ? (
                    <ChatModelCatalogRefresh state={params.modelCatalogState} />
                  ) : undefined}
                </div>
              ) : undefined}
              <ChatModelCatalogState
                state={params.modelCatalogState}
                hasOptions={params.modelOptions.length > 0}
                hasSelectableOptions={state().hasSelectableModelOptions}
                onModelSetup={params.onModelSetup}
                emptyLabel={
                  params.modelOptions.some(
                    (option) =>
                      option.unavailableReason === "missing-auth" &&
                      resolveModelRuntimeRoute(option.provider, option.agentRuntimeId) ===
                        "claudeCli",
                  )
                    ? t("chat.modelControls.claudeCliNotReady")
                    : undefined
                }
              />
              {state().hasOptions || params.accountSection ? (
                <>
                  <div class="chat-controls__model-options">
                    <For each={state().orderedProviderGroups} keyed={(group) => group[0]}>
                      {(group) => (
                        <ProviderGroup
                          provider={group()[0]}
                          lead={group()[1].lead}
                          more={group()[1].more}
                        />
                      )}
                    </For>
                    <For each={state().targetGroups} keyed={(group) => group.id}>
                      {(group) => (
                        <section
                          class="chat-controls__provider-model-group"
                          data-chat-model-target-group={group().id}
                          aria-label={group().label}
                        >
                          <div class="chat-controls__provider-heading">
                            <span
                              class="chat-controls__provider-icon chat-controls__target-icon"
                              aria-hidden="true"
                            >
                              <Icon name="terminal" />
                            </span>
                            <span>{group().label}</span>
                          </div>
                          {group().status !== "ready" ? (
                            <ChatModelCatalogState
                              state={{ hasSnapshot: false, status: group().status }}
                              hasOptions={false}
                              hasSelectableOptions={false}
                              errorLabel={group().errorLabel}
                              retryTarget={
                                params.onTargetRetry
                                  ? {
                                      disabled: params.disabled,
                                      groupId: group().id,
                                      onRetry: params.onTargetRetry!,
                                    }
                                  : undefined
                              }
                            />
                          ) : undefined}
                          <ModelList label={group().label}>
                            <For each={group().options} keyed={(entry) => entry.value}>
                              {(entry, index) => (
                                <ChatModelPickerTargetOption
                                  disabled={params.disabled}
                                  entry={entry()}
                                  groupId={group().id}
                                  groupLabel={group().label}
                                  index={state().orderedOptions.length + index()}
                                  onSelect={selectTarget}
                                />
                              )}
                            </For>
                          </ModelList>
                        </section>
                      )}
                    </For>
                    {params.accountSection ? (
                      <ChatModelAccountSectionView
                        {...params.accountSection.viewProps(
                          state().orderedOptions.length + state().targetOptionCount,
                        )}
                      />
                    ) : undefined}
                  </div>
                  <div
                    class="chat-controls__model-search-empty"
                    data-chat-model-search-empty
                    hidden
                  >
                    {t("chat.modelControls.noMatchingModels")}
                  </div>
                  <LitContent value={contextWindowContent()} />
                </>
              ) : undefined}
            </>
          )}
          {params.modelSelectionLocked && params.accountSection ? (
            <div class="chat-controls__model-options">
              <ChatModelAccountSectionView {...params.accountSection.viewProps(0)} />
            </div>
          ) : undefined}
          {params.modelCatalogState?.modelSelectionPolicy?.restricted ? (
            <div class="chat-controls__model-catalog-state" data-chat-model-policy>
              {t("chat.modelControls.restrictedModelsHelp")}
            </div>
          ) : undefined}
        </div>
      </wa-popup>
    </details>
  );
}
