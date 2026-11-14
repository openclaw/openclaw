import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, Errored, For, Show, useContext } from "solid-js";
import { resolveModelRuntimeRoute } from "../../../../../src/shared/model-runtime-route.js";
import { providerDisplayLabel as defaultProviderLabel } from "../../../components/provider-icon-data.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerSettingsEnglish } from "../../../i18n/locales/en-settings.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import {
  ChatModelAccountOptions,
  ChatModelAccountSectionView,
} from "./chat-model-account-control.tsx";
import { ChatModelAuthState, modelAuthState } from "./chat-model-auth-state.tsx";
import {
  ChatModelCatalogRefresh,
  ChatModelCatalogState,
  isModelCatalogLoading,
} from "./chat-model-catalog-state.tsx";
import {
  createChatModelFavorites,
  createChatModelFavoritesOpening,
  createChatModelFavoritesScope,
} from "./chat-model-favorites.ts";
import {
  isModelPickerOptionSelected,
  modelProviderId,
  prepareChatModelPickerPanel,
  modelPickerOptionKey,
  modelRowKey,
  FAVORITES_GROUP,
  type ChatModelPickerOption as ModelPickerOption,
} from "./chat-model-picker-options.ts";
import {
  ChatModelPickerOption,
  ChatModelPickerTargets,
  ModelList,
  modelOptionSearchRow,
} from "./chat-model-picker-options.tsx";
import {
  createChatModelSearchView,
  handleModelSearchKeydown,
  updateModelSearch,
} from "./chat-model-picker-search-view.ts";
import {
  chatModelSearchState,
  ChatModelSearchContext,
  type ChatModelSearchCatalog,
} from "./chat-model-picker-search.ts";
import { createModelPickerWindow } from "./chat-model-picker-window.tsx";
import type { ChatModelPickerParams } from "./chat-model-picker.tsx";
import { ChatModelProviderHeading } from "./chat-model-provider-heading.tsx";
import { ChatModelProviderRail } from "./chat-model-provider-rail.tsx";
import {
  ChatModelSettings,
  modelRuntimeId,
  providerRuntimeOptions,
} from "./chat-model-settings.tsx";

registerSettingsEnglish();

type ChatModelPickerPanelProps = {
  params: ChatModelPickerParams;
  onSelectionClose: (event: MouseEvent) => void;
  searchRef: (element: HTMLInputElement) => void;
};

export function ChatModelPickerPanel(panel: ChatModelPickerPanelProps) {
  const owner = createChatModelFavoritesScope(() => panel.params.sessionKey);
  const favorites = createChatModelFavorites(owner);
  const search = useContext(ChatModelSearchContext);
  // Restart CSS without remounting the list or disturbing a focused model row.
  const [providerTransition, setProviderTransition] = createSignal(false);
  // Parent controls also publish effort and copy changes; retain unchanged model facts.
  const modelOptions = createMemo(() => panel.params.modelOptions);
  const providerPresentation = (provider: string) =>
    modelOptions().find((option) => option.provider === provider && option.presentation)
      ?.presentation;
  const providerDisplayLabel = (provider: string) =>
    defaultProviderLabel(provider, providerPresentation(provider));
  const modelTargetGroups = createMemo(() => panel.params.targetGroups);
  const selectedModelValue = createMemo(() => panel.params.selectedModelValue);
  const selectedAgentRuntime = createMemo(() => panel.params.selectedAgentRuntime);
  const disabled = createMemo(() => panel.params.disabled);
  const sessionModelPinned = createMemo(() => panel.params.sessionModelPinned);
  const onModelSetup = createMemo(() => panel.params.onModelSetup);
  const modelSelectionLocked = createMemo(() => panel.params.modelSelectionLocked);
  const [runtimeOverrides, setRuntimeOverrides] = createSignal<Record<string, string | null>>({});
  const providerOptions = createMemo(() => Map.groupBy(modelOptions(), modelProviderId));
  const providerRuntime = (provider: string) => {
    const options = providerOptions().get(provider)!;
    const selected = options.find((option) =>
      isModelPickerOptionSelected(option, selectedModelValue(), selectedAgentRuntime()),
    );
    if (selected) {
      return modelRuntimeId(selected);
    }
    const overrides = runtimeOverrides();
    return provider in overrides ? overrides[provider]! : modelRuntimeId(options[0]!);
  };
  const runtimeModelOptions = createMemo(() =>
    [...providerOptions()].flatMap(([provider, options]) =>
      providerRuntimeOptions(options, providerRuntime(provider)),
    ),
  );
  const opening = createChatModelFavoritesOpening(
    favorites,
    owner.scope,
    () => search?.open() ?? true,
    selectedModelValue,
  );
  const state = createMemo(() =>
    prepareChatModelPickerPanel(
      {
        modelOptions: runtimeModelOptions(),
        targetGroups: modelTargetGroups(),
        selectedModelValue: selectedModelValue(),
        selectedAgentRuntime: selectedAgentRuntime(),
      },
      opening(),
    ),
  );
  const showBrowser = createMemo(
    () =>
      state().hasOptions ||
      (panel.params.accountSection && !isModelCatalogLoading(panel.params.modelCatalogState)),
  );
  const accounts = createMemo(() =>
    panel.params.accountSection?.viewProps(
      state().orderedOptions.length + state().targetOptionCount,
    ),
  );
  // Search uses these four labels; other lazy English catalogs do not change its rows.
  const searchCopy = createMemo(
    () =>
      [
        t("chat.modelControls.default"),
        t("chat.modelControls.routes.claudeCli.label"),
        t("chat.modelControls.routes.anthropicApi.label"),
        t("chat.modelControls.routes.anthropicConfigured.label"),
      ] as const,
    { equals: (before, after) => before.every((value, index) => value === after[index]) },
  );
  const catalog = createMemo<ChatModelSearchCatalog>(() => {
    const [defaultLabel] = searchCopy();
    const current = state();
    const unlocked = !modelSelectionLocked();
    const providerGroups = unlocked ? current.orderedProviderGroups : [];
    const targetGroups = unlocked ? current.targetGroups : [];
    const account = accounts();
    const modelSearchProps = {
      disabled: disabled(),
      selectedModelValue: selectedModelValue(),
      selectedAgentRuntime: selectedAgentRuntime(),
      sessionModelPinned: sessionModelPinned(),
    };
    return {
      activeProvider: current.activeProvider,
      providers: [
        ...providerGroups.map(([provider]) => provider),
        ...targetGroups.map((group) => `target:${group.id}`),
      ],
      lists: [
        ...providerGroups.flatMap(([provider, group]) => [
          provider,
          ...(group.more.length ? [`${provider}:more`] : []),
        ]),
        ...targetGroups.map((group) => `target:${group.id}`),
        ...(account ? ["accounts"] : []),
      ],
      rows: [
        ...providerGroups
          .filter(([provider]) => provider !== FAVORITES_GROUP || !search?.query().trim())
          .flatMap(([provider, group]) =>
            group.lead
              .map((entry) =>
                Object.assign(modelOptionSearchRow({ ...modelSearchProps, entry }, defaultLabel), {
                  key: modelRowKey(entry, provider),
                  provider,
                  list: provider,
                }),
              )
              .concat(
                group.more.map((entry) =>
                  Object.assign(
                    modelOptionSearchRow({ ...modelSearchProps, entry }, defaultLabel),
                    {
                      provider,
                      more: true,
                      list: `${provider}:more`,
                    },
                  ),
                ),
              ),
          ),
        ...targetGroups.flatMap((group) =>
          group.options.map((entry) => ({
            key: `target:${group.id}:${entry.value}`,
            list: `target:${group.id}`,
            provider: `target:${group.id}`,
            name: entry.label.toLocaleLowerCase(),
            providerLabel: group.label.toLocaleLowerCase(),
            reference: entry.value,
            selected: false,
            hasShortcut: true,
            disabled: disabled(),
          })),
        ),
        ...(account?.options.map((entry) => ({
          key: `account:${entry.value}`,
          list: "accounts",
          name: entry.label.toLocaleLowerCase(),
          keywords: entry.description?.toLocaleLowerCase(),
          providerLabel: "account",
          reference: `account:${entry.value}`,
          selected: entry.value === account.currentValue,
          hasShortcut: false,
          disabled: account.disabled || Boolean(entry.disabled),
          visible: account.open,
        })) ?? []),
      ],
    };
  });
  const searchView =
    search && createChatModelSearchView(search, catalog, (key) => window.reveal(key));
  const activeAuth = createMemo(() => {
    const group = state().orderedProviderGroups.find(([provider]) =>
      searchView?.providerOpen(provider),
    );
    return group && group[0] !== FAVORITES_GROUP && !searchView?.filtering()
      ? modelAuthState([...group[1].lead, ...group[1].more])
      : undefined;
  });
  const layout = createMemo<string[]>(() => {
    if (searchView?.filtering()) {
      return [
        ...searchView.matches().map(({ row }) => row.key),
        ...state()
          .targetGroups.filter((group) => !group.options.length)
          .map((group) => `state:target:${group.id}`),
        ...(accounts()?.error ? ["error:accounts"] : []),
      ];
    }
    const rows: string[] = [];
    for (const [provider, group] of state().orderedProviderGroups) {
      if (searchView?.providerOpen(provider)) {
        rows.push(`heading:${provider}`);
        rows.push(...group.lead.map((entry) => modelRowKey(entry, provider)));
        rows.push(
          ...(searchView.moreOpen(provider)
            ? group.more.map((entry) => modelRowKey(entry, provider))
            : group.more.length
              ? [`more:${provider}`]
              : []),
        );
      }
    }
    for (const group of state().targetGroups) {
      if (!searchView?.providerOpen(`target:${group.id}`)) {
        continue;
      }
      rows.push(`heading:target:${group.id}`);
      rows.push(...group.options.map((entry) => `target:${group.id}:${entry.value}`));
      if (!group.options.length) {
        rows.push(`state:target:${group.id}`);
      }
    }
    return rows;
  });
  const window = createModelPickerWindow(
    layout,
    () => search?.highlighted(),
    () =>
      searchView
        ?.selectable()
        .slice(0, 9)
        .map(({ row }) => row.key) ?? [],
  );
  const renderRow = window.renderRow;
  const mounted = (entries: readonly ModelPickerOption[], provider: string) => {
    if (!entries.length) {
      return [];
    }
    const keys = window.keys();
    if (entries.length <= keys.length) {
      return entries.filter((entry) => window.has(modelRowKey(entry, provider)));
    }
    const indexes = state().optionIndex;
    // Each lead/more list is a contiguous slice of the prepared catalog order.
    const first = indexes.get(modelRowKey(entries[0]!, provider))!;
    const end = first + entries.length;
    return keys
      .flatMap((key) => {
        const index = indexes.get(key);
        return index !== undefined && index >= first && index < end ? [index] : [];
      })
      .toSorted((left, right) => left - right)
      .map((index) => entries[index - first]!);
  };
  const selectModel = (entry: ModelPickerOption, event: MouseEvent) => {
    event.stopPropagation();
    // Resetting a pin does not require the inherited model to be available.
    const resetsPin = entry.isDefault && sessionModelPinned();
    if (disabled() || modelSelectionLocked() || (entry.disabled && !resetsPin)) {
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
    if (disabled() || modelSelectionLocked()) {
      event.preventDefault();
      return;
    }
    panel.params.onTargetSelect?.(groupId, value);
    panel.onSelectionClose(event);
  };
  // Retain the route boundary across unrelated owner publications.
  const renderDirect = (render: () => JSX.Element) => render();
  const renderCatalogStatus = createMemo(
    () => panel.params.renderModelCatalogStatus ?? renderDirect,
  );
  function CatalogStatus() {
    return (
      <Show when={!activeAuth() || panel.params.modelCatalogState?.status !== "ready"}>
        {renderCatalogStatus()(() => (
          <ChatModelCatalogState
            loadingSkeleton
            state={panel.params.modelCatalogState}
            hasOptions={modelOptions().length > 0}
            hasSelectableOptions={state().hasSelectableModelOptions}
            onModelSetup={onModelSetup()}
          />
        ))}
      </Show>
    );
  }
  function ModelOption(props: {
    entry: ModelPickerOption;
    provider: string;
    hideCooldown?: boolean;
  }) {
    const key = createMemo(() => modelRowKey(props.entry, props.provider));
    return (
      <>
        {renderRow(key(), () => (
          <ChatModelPickerOption
            disabled={disabled()}
            entry={props.entry}
            rowKey={key()}
            favorite={
              !props.entry.isDefault && favorites.available()
                ? {
                    selected: favorites.keys().includes(props.entry.value),
                    disabled: disabled() || favorites.disabled(),
                    onToggle: (event) => {
                      // Saving disables every star; move focus before the browser drops it.
                      if (event.currentTarget === document.activeElement) {
                        chatModelSearchState(event.currentTarget)?.input?.focus({
                          preventScroll: true,
                        });
                      }
                      favorites.toggle(props.entry.value);
                    },
                  }
                : undefined
            }
            hideCooldown={props.hideCooldown}
            index={state().optionIndex.get(key()) ?? 0}
            selectedModelValue={selectedModelValue()}
            selectedAgentRuntime={selectedAgentRuntime()}
            sessionModelPinned={sessionModelPinned()}
            onSelect={selectModel}
            contextWindow={panel.params.contextWindow}
            sessionKey={panel.params.sessionKey}
          />
        ))}
      </>
    );
  }
  function ProviderGroup(props: {
    provider: string;
    lead: ModelPickerOption[];
    more: ModelPickerOption[];
  }) {
    const provider = createMemo(() => props.provider);
    const providerLabel = () =>
      props.provider === FAVORITES_GROUP
        ? t("chat.modelFavorites.label")
        : providerDisplayLabel(props.provider);
    const groupLabel = () => t("chat.modelControls.providerModels", { provider: providerLabel() });
    const options = createMemo(() => [...props.lead, ...props.more]);
    const providerCooldown = createMemo(
      () =>
        !searchView?.filtering() &&
        props.provider !== FAVORITES_GROUP &&
        options().length > 0 &&
        options().every((option) => option.disabled && option.unavailableReason === "cooldown"),
    );
    const auth = createMemo(() => {
      const authProvider =
        resolveModelRuntimeRoute(props.provider, providerRuntime(props.provider) ?? undefined) ===
        "claudeCli"
          ? "claude-cli"
          : props.provider;
      return panel.params.providerAuth?.get(authProvider);
    });
    return (
      <section
        class="chat-controls__provider-model-group"
        data-chat-model-provider-group={props.provider}
        aria-label={groupLabel()}
      >
        {renderRow(`heading:${provider()}`, () => (
          <ChatModelProviderHeading
            provider={props.provider}
            label={providerLabel()}
            favorites={props.provider === FAVORITES_GROUP}
            options={options()}
            cooldown={providerCooldown()}
            auth={auth()}
            accounts={props.provider === state().activeProvider ? accounts() : undefined}
            onSettings={panel.params.onProviderSettings}
          />
        ))}
        <ModelList label={groupLabel()} id={props.provider}>
          <For each={mounted(props.lead, props.provider)} keyed={modelPickerOptionKey}>
            {(entry) => (
              <ModelOption
                entry={entry()}
                provider={props.provider}
                hideCooldown={providerCooldown()}
              />
            )}
          </For>
        </ModelList>
        {props.more.length > 0 ? (
          <>
            {renderRow(`more:${provider()}`, () => (
              <button
                class="chat-controls__inline-select-option chat-controls__model-more-toggle"
                type="button"
                data-chat-model-more-toggle
                aria-expanded={searchView?.moreOpen(props.provider) ? "true" : "false"}
                aria-controls={search?.listId(`${props.provider}:more`)}
                hidden={
                  searchView?.filtering() ||
                  searchView?.moreOpen(props.provider) ||
                  !searchView?.providerOpen(props.provider)
                }
                disabled={disabled()}
                onClick={(event) => searchView?.expandMore(props.provider, event)}
              >
                <span class="chat-controls__model-option-provider" aria-hidden="true" />
                <span>
                  {t("chat.modelControls.allModels", { count: String(props.more.length) })}
                </span>
                <span class="chat-controls__inline-select-chevron" aria-hidden="true">
                  <Icon name="chevronDown" />
                </span>
              </button>
            ))}
            <ModelList label={groupLabel()} id={`${props.provider}:more`} more>
              <For each={mounted(props.more, props.provider)} keyed={modelPickerOptionKey}>
                {(entry) => (
                  <ModelOption
                    entry={entry()}
                    provider={props.provider}
                    hideCooldown={providerCooldown()}
                  />
                )}
              </For>
            </ModelList>
          </>
        ) : undefined}
      </section>
    );
  }
  return (
    <div
      class="chat-controls__inline-select-menu chat-controls__model-menu"
      aria-label={t("chat.selectors.model")}
      data-chat-model-filtering={searchView?.filtering() ? "" : undefined}
      data-chat-model-compact={
        modelSelectionLocked() ||
        (!state().hasOptions &&
          panel.params.modelCatalogState?.status === "ready" &&
          !isModelCatalogLoading(panel.params.modelCatalogState) &&
          panel.params.modelCatalogState.modelSelectionPolicy?.restricted)
          ? ""
          : undefined
      }
    >
      {modelSelectionLocked() ? (
        <div class="chat-controls__locked-model" aria-label={t("chat.selectors.modelLockedLabel")}>
          <span class="chat-controls__locked-model-value">{panel.params.triggerModelLabel}</span>
          <span class="chat-controls__locked-model-badge">{t("chat.selectors.modelLocked")}</span>
        </div>
      ) : (
        <>
          {showBrowser() || isModelCatalogLoading(panel.params.modelCatalogState) ? (
            <div class="chat-controls__model-search-wrap">
              <Icon name="search" />
              <input
                ref={[search?.inputRef(), panel.searchRef]}
                class="chat-controls__model-search"
                data-chat-model-search="true"
                type="search"
                role="combobox"
                aria-autocomplete="list"
                aria-controls={searchView?.controls()}
                aria-expanded={search?.open() ? "true" : "false"}
                aria-activedescendant={
                  search?.highlighted() ? search.optionId(search.highlighted()!) : undefined
                }
                value={search?.query() ?? ""}
                autocomplete="off"
                spellcheck="false"
                placeholder={t("chat.modelControls.searchModels")}
                aria-label={t("chat.modelControls.searchModels")}
                disabled={disabled()}
                onInput={(event: InputEvent) =>
                  // SAFETY: This input handler belongs to the model search input.
                  updateModelSearch(event.currentTarget as HTMLInputElement)
                }
                onKeyDown={handleModelSearchKeydown}
              />
              {modelOptions().length > 0 ? (
                <ChatModelCatalogRefresh
                  state={panel.params.modelCatalogState}
                  providerLabel={providerDisplayLabel}
                />
              ) : undefined}
            </div>
          ) : undefined}
          <Show when={favorites.snapshot().error}>
            <div role="alert">
              {favorites.snapshot().error}
              <button type="button" onClick={() => favorites.retry()}>
                {t("common.retry")}
              </button>
            </div>
          </Show>
          <Show when={!favorites.saving()}>
            <Errored fallback={(error) => <div role="alert">{String(error())}</div>}>
              {favorites.outcome()}
            </Errored>
          </Show>
          {!showBrowser() ? <CatalogStatus /> : undefined}
          {showBrowser() ? (
            <>
              <div
                class="chat-controls__model-browser"
                data-single-provider={catalog().providers.length === 1 ? "" : undefined}
              >
                <Show when={catalog().providers.length !== 1 && !searchView?.filtering()}>
                  <ChatModelProviderRail
                    favorites={state().orderedProviderGroups.some(
                      ([provider]) => provider === FAVORITES_GROUP,
                    )}
                    providers={state()
                      .orderedProviderGroups.filter(([provider]) => provider !== FAVORITES_GROUP)
                      .map(([provider]) => provider)}
                    presentation={providerPresentation}
                    targets={state().targetGroups}
                    active={catalog().providers.find((provider) =>
                      searchView?.providerOpen(provider),
                    )}
                    disabled={disabled()}
                    onSelect={(provider) => {
                      if (!searchView?.providerOpen(provider)) {
                        setProviderTransition((previous) => !previous);
                      }
                      searchView?.toggleProvider(provider);
                    }}
                  />
                </Show>
                <div
                  class="chat-controls__model-pane"
                  data-provider-transition={providerTransition() ? "a" : "b"}
                  data-auth-blocked={activeAuth() ? "" : undefined}
                >
                  <div
                    ref={window.bind}
                    class="chat-controls__model-options"
                    data-chat-model-window
                  >
                    <div
                      class="chat-controls__model-virtual-content"
                      style={{ height: `${window.height()}px` }}
                    >
                      <For each={state().orderedProviderGroups} keyed={(group) => group[0]}>
                        {(group) => (
                          <ProviderGroup
                            provider={group()[0]}
                            lead={group()[1].lead}
                            more={group()[1].more}
                          />
                        )}
                      </For>
                      <Show when={searchView?.filtering() && accounts()}>
                        {(account) => (
                          <ChatModelAccountOptions {...account()} renderRow={renderRow} />
                        )}
                      </Show>
                      <For each={state().targetGroups} keyed={(group) => group.id}>
                        {(group) => {
                          const id = createMemo(() => group().id);
                          return (
                            <section
                              class="chat-controls__provider-model-group"
                              data-chat-model-target-group={group().id}
                              aria-label={group().label}
                            >
                              {renderRow(`heading:target:${id()}`, () => (
                                <div class="chat-controls__provider-heading">
                                  <span>{group().label}</span>
                                </div>
                              ))}
                              <ChatModelPickerTargets
                                group={group()}
                                disabled={disabled()}
                                startIndex={state().orderedOptions.length}
                                window={window}
                                onSelect={selectTarget}
                                onRetry={panel.params.onTargetRetry}
                              />
                            </section>
                          );
                        }}
                      </For>
                    </div>
                  </div>
                  <Show when={activeAuth()}>
                    {(auth) => <ChatModelAuthState state={auth()} onSetup={onModelSetup()} />}
                  </Show>
                  <Show
                    when={!searchView?.filtering() && !searchView?.providerOpen(FAVORITES_GROUP)}
                  >
                    <ChatModelSettings
                      params={panel.params}
                      providers={providerOptions()}
                      provider={catalog().providers.find((provider) =>
                        searchView?.providerOpen(provider),
                      )}
                      runtime={providerRuntime}
                      onRuntimeSelect={(provider, runtime, entry) => {
                        if (entry?.disabled) {
                          onModelSetup()?.();
                          return;
                        }
                        if (
                          entry &&
                          entry.value ===
                            (selectedModelValue() ||
                              modelOptions().find((option) => option.isDefault)?.value)
                        ) {
                          void panel.params.onModelSelect(
                            entry.commitValue,
                            panel.params.sessionKey,
                            entry.runtimeOverride ?? null,
                          );
                        } else {
                          setRuntimeOverrides((previous) => ({ ...previous, [provider]: runtime }));
                        }
                      }}
                    />
                  </Show>
                  <div
                    class="chat-controls__model-search-empty"
                    data-chat-model-search-empty
                    hidden={!searchView?.empty()}
                  >
                    {t("chat.modelControls.noMatchingModels")}
                  </div>
                  <CatalogStatus />
                </div>
              </div>
            </>
          ) : undefined}
        </>
      )}
      {modelSelectionLocked() && panel.params.accountSection ? (
        <div class="chat-controls__model-settings-block">
          <ChatModelAccountSectionView {...accounts()!} startIndex={0} />
        </div>
      ) : undefined}
      {panel.params.modelCatalogState?.modelSelectionPolicy?.restricted &&
      (modelSelectionLocked() || state().hasOptions) ? (
        <div class="chat-controls__model-policy-note" data-chat-model-policy>
          {t("chat.modelControls.restrictedModelsHelp")}
        </div>
      ) : undefined}
    </div>
  );
}
