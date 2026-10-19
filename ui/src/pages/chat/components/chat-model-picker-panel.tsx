import type { JSX } from "@solidjs/web";
import { createMemo, For, useContext } from "solid-js";
import { resolveModelRuntimeRoute } from "../../../../../src/shared/model-runtime-route.js";
import { providerDisplayLabel } from "../../../components/provider-icon.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { canonicalModelAuthProviderId } from "../../../lib/model-auth.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { ChatContextWindowControl } from "./chat-context-window-control.tsx";
import { ChatModelAccountSectionView } from "./chat-model-account-control.tsx";
import { ChatModelCatalogRefresh, ChatModelCatalogState } from "./chat-model-catalog-state.tsx";
import {
  isModelPickerOptionSelected,
  modelPickerOptionKey,
  type ChatModelPickerOption as ModelPickerOption,
} from "./chat-model-picker-options.ts";
import {
  ChatModelPickerOption,
  ChatModelPickerTargetOption,
  ChatModelProviderIcon,
} from "./chat-model-picker-options.tsx";
import {
  ChatModelSearchContext,
  handleModelSearchKeydown,
  toggleModelProviderGroup,
  updateModelSearch,
} from "./chat-model-picker-search.ts";
import type { ChatModelPickerParams } from "./chat-model-picker.tsx";

function prepareChatModelPickerPanel(params: ChatModelPickerParams) {
  const defaultModelOption = params.modelOptions.find((option) => option.isDefault);
  const activeModelOption = params.modelOptions.find((option) =>
    isModelPickerOptionSelected(option, params.selectedModelValue, params.selectedAgentRuntime),
  );
  const leadingModelOption = activeModelOption ?? defaultModelOption;
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
  // Unranked catalogs can contain hundreds of models; browse the rest through All models.
  for (const [provider, group] of providerGroups) {
    if (!recommendingProviders.has(provider)) {
      group.more = group.lead.splice(9);
    }
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
  const search = useContext(ChatModelSearchContext);
  return (
    <div
      ref={search?.ref(search.lists)}
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

export function ChatModelPickerPanel(panel: {
  params: ChatModelPickerParams;
  onSelectionClose: (event: MouseEvent) => void;
  searchRef: (element: HTMLInputElement) => void;
}) {
  const search = useContext(ChatModelSearchContext);
  const state = createMemo(() => prepareChatModelPickerPanel(panel.params));
  const selectModel = (entry: ModelPickerOption, event: MouseEvent) => {
    event.stopPropagation();
    // Resetting a pin does not require the inherited model to be available.
    const resetsPin = entry.isDefault && panel.params.sessionModelPinned;
    if (
      panel.params.disabled ||
      panel.params.modelSelectionLocked ||
      (entry.disabled && !resetsPin)
    ) {
      event.preventDefault();
      return;
    }
    void panel.params.onModelSelect(
      entry.commitValue,
      panel.params.sessionKey,
      entry.runtimeOverride ??
        (entry.isDefault || entry.agentRuntime !== undefined ? null : undefined),
    );
    panel.onSelectionClose(event);
  };
  const selectTarget = (groupId: string, value: string, event: MouseEvent) => {
    event.stopPropagation();
    if (panel.params.disabled || panel.params.modelSelectionLocked) {
      event.preventDefault();
      return;
    }
    panel.params.onTargetSelect?.(groupId, value);
    panel.onSelectionClose(event);
  };
  function ModelOption(props: { entry: ModelPickerOption }) {
    return (
      <ChatModelPickerOption
        disabled={panel.params.disabled}
        entry={props.entry}
        index={state().optionIndex.get(modelPickerOptionKey(props.entry)) ?? 0}
        selectedModelValue={panel.params.selectedModelValue}
        selectedAgentRuntime={panel.params.selectedAgentRuntime}
        sessionModelPinned={panel.params.sessionModelPinned}
        onSelect={selectModel}
        onModelSetup={panel.params.onModelSetup}
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
    const auth = () => panel.params.providerAuth?.get(canonicalModelAuthProviderId(props.provider));
    const authKind = createMemo(() => auth()?.kind);
    const showAuth = createMemo(
      () =>
        Boolean(auth()) &&
        !(
          auth()?.kind === "missing" &&
          options().some(
            (option) =>
              option.disabled &&
              (option.unavailableReason === "missing-auth" ||
                option.unavailableReason === "auth-failed"),
          )
        ),
    );
    const authLabel = createMemo(() =>
      showAuth() ? [auth()?.label, auth()?.detail].filter(Boolean).join(" · ") : undefined,
    );
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
            ref={search?.ref(search.groups)}
            class="chat-controls__provider-toggle"
            type="button"
            data-chat-model-group-toggle
            data-chat-model-provider-toggle
            aria-expanded={props.provider === state().activeProvider ? "true" : "false"}
            aria-label={`${groupLabel()} (${options().length})`}
            aria-description={routeDetail()}
            disabled={panel.params.disabled}
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
            <span class="chat-controls__auth-meta" data-auth-kind={authKind()}>
              <span aria-hidden="true">
                <Icon
                  name={
                    authKind() === "subscription"
                      ? "circleUser"
                      : authKind() === "api"
                        ? "key"
                        : "alertTriangle"
                  }
                />
              </span>
              <span class="chat-controls__auth-meta-label">{authLabel()}</span>
            </span>
          ) : undefined}
          {panel.params.onProviderSettings ? (
            <button
              class="chat-controls__provider-settings"
              data-chat-model-provider-settings
              type="button"
              aria-label={t("chat.modelControls.configureModels")}
              onClick={(event: MouseEvent) => {
                event.stopPropagation();
                panel.params.onProviderSettings?.(props.provider);
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
              ref={search?.ref(search.more)}
              class="chat-controls__inline-select-option chat-controls__model-more-toggle"
              type="button"
              data-chat-model-more-toggle
              aria-expanded="false"
              hidden
              disabled={panel.params.disabled}
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
    <div
      ref={search?.ref(search.menus)}
      class="chat-controls__inline-select-menu chat-controls__model-menu"
      aria-label={t("chat.selectors.model")}
    >
      {panel.params.modelSelectionLocked ? (
        <div class="chat-controls__locked-model" aria-label={t("chat.selectors.modelLockedLabel")}>
          <span class="chat-controls__inline-select-section-label">
            {t("chat.selectors.modelSection")}
          </span>
          <span class="chat-controls__locked-model-value">{panel.params.triggerModelLabel}</span>
          <span class="chat-controls__locked-model-badge">{t("chat.selectors.modelLocked")}</span>
        </div>
      ) : (
        <>
          {state().hasOptions || panel.params.accountSection ? (
            <div class="chat-controls__model-search-wrap">
              <Icon name="search" />
              <input
                ref={[search?.ref(search.inputs), panel.searchRef]}
                class="chat-controls__model-search"
                data-chat-model-search="true"
                type="search"
                role="combobox"
                aria-autocomplete="list"
                autocomplete="off"
                spellcheck="false"
                placeholder={t("chat.modelControls.searchModels")}
                aria-label={t("chat.modelControls.searchModels")}
                disabled={panel.params.disabled}
                onInput={(event: InputEvent) =>
                  // SAFETY: This input handler belongs to the model search input.
                  updateModelSearch(event.currentTarget as HTMLInputElement)
                }
                onKeyDown={handleModelSearchKeydown}
              />
              {panel.params.modelOptions.length > 0 ? (
                <ChatModelCatalogRefresh state={panel.params.modelCatalogState} />
              ) : undefined}
            </div>
          ) : undefined}
          <ChatModelCatalogState
            state={panel.params.modelCatalogState}
            hasOptions={panel.params.modelOptions.length > 0}
            hasSelectableOptions={state().hasSelectableModelOptions}
            onModelSetup={panel.params.onModelSetup}
            emptyLabel={
              panel.params.modelOptions.some(
                (option) =>
                  option.unavailableReason === "missing-auth" &&
                  resolveModelRuntimeRoute(option.provider, option.agentRuntimeId) === "claudeCli",
              )
                ? t("chat.modelControls.claudeCliNotReady")
                : undefined
            }
          />
          {state().hasOptions || panel.params.accountSection ? (
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
                            panel.params.onTargetRetry
                              ? {
                                  disabled: panel.params.disabled,
                                  groupId: group().id,
                                  onRetry: panel.params.onTargetRetry!,
                                }
                              : undefined
                          }
                        />
                      ) : undefined}
                      <ModelList label={group().label}>
                        <For each={group().options} keyed={(entry) => entry.value}>
                          {(entry, index) => (
                            <ChatModelPickerTargetOption
                              disabled={panel.params.disabled}
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
                {panel.params.accountSection ? (
                  <ChatModelAccountSectionView
                    {...panel.params.accountSection.viewProps(
                      state().orderedOptions.length + state().targetOptionCount,
                    )}
                  />
                ) : undefined}
              </div>
              <div
                ref={search?.ref(search.empty)}
                class="chat-controls__model-search-empty"
                data-chat-model-search-empty
                hidden
              >
                {t("chat.modelControls.noMatchingModels")}
              </div>
              {panel.params.contextWindow ? (
                <ChatContextWindowControl
                  contextWindow={panel.params.contextWindow}
                  sessionKey={panel.params.sessionKey}
                />
              ) : undefined}
            </>
          ) : undefined}
        </>
      )}
      {panel.params.modelSelectionLocked && panel.params.accountSection ? (
        <div class="chat-controls__model-options">
          <ChatModelAccountSectionView {...panel.params.accountSection.viewProps(0)} />
        </div>
      ) : undefined}
      {panel.params.modelCatalogState?.modelSelectionPolicy?.restricted ? (
        <div class="chat-controls__model-catalog-state" data-chat-model-policy>
          {t("chat.modelControls.restrictedModelsHelp")}
        </div>
      ) : undefined}
    </div>
  );
}
