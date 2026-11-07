import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, Errored, For, Loading, Show, useContext } from "solid-js";
import { providerDisplayLabel } from "../../../components/provider-icon-data.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerSettingsEnglish } from "../../../i18n/locales/en-settings.ts";
import { canonicalModelAuthProviderId } from "../../../lib/model-auth.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { ChatModelAccountSectionView } from "./chat-model-account-control.tsx";
import { ChatModelAuthState, modelAuthState } from "./chat-model-auth-state.tsx";
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
  modelOptionSearchRow,
} from "./chat-model-picker-options.tsx";
import {
  createChatModelSearchView,
  handleModelSearchKeydown,
  updateModelSearch,
} from "./chat-model-picker-search-view.ts";
import { ChatModelSearchContext, type ChatModelSearchCatalog } from "./chat-model-picker-search.ts";
import { createModelPickerWindow } from "./chat-model-picker-window.tsx";
import type { ChatModelPickerParams } from "./chat-model-picker.tsx";
import { ChatModelProviderRail } from "./chat-model-provider-rail.tsx";
import {
  ChatModelSettings,
  modelRuntimeId,
  modelProviderId,
  providerRuntimeOptions,
} from "./chat-model-settings.tsx";

registerSettingsEnglish();

function prepareChatModelPickerPanel(
  params: Pick<
    ChatModelPickerParams,
    "modelOptions" | "selectedModelValue" | "selectedAgentRuntime" | "targetGroups"
  >,
) {
  const defaultModelOption = params.modelOptions.find((option) => option.isDefault);
  const activeModelOption = params.modelOptions.find((option) =>
    isModelPickerOptionSelected(option, params.selectedModelValue, params.selectedAgentRuntime),
  );
  const leadingModelOption = activeModelOption ?? defaultModelOption;
  const groupProvider = modelProviderId;
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

  const orderedOptions = orderedProviderGroups.flatMap(([, { lead, more }]) => [...lead, ...more]);
  const optionIndex = new Map(
    orderedOptions.map((option, index) => [modelPickerOptionKey(option), index]),
  );
  const targetGroups = params.targetGroups ?? [];
  const targetOptionCount = targetGroups.reduce((count, group) => count + group.options.length, 0);
  const hasOptions = params.modelOptions.length > 0 || targetGroups.length > 0;
  const hasSelectableModelOptions = params.modelOptions.some((option) => !option.disabled);
  return {
    orderedProviderGroups,
    activeProvider: activeProvider ?? leadingProvider ?? orderedProviderGroups[0]?.[0],
    orderedOptions,
    optionIndex,
    targetGroups,
    targetOptionCount,
    hasOptions,
    hasSelectableModelOptions,
  };
}

function ModelList(props: { label: string; id: string; more?: boolean; children: JSX.Element }) {
  const search = useContext(ChatModelSearchContext);
  return (
    <div
      id={search?.listId(props.id)}
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
  // Parent controls also publish effort and copy changes; retain unchanged model facts.
  const modelOptions = createMemo(() => panel.params.modelOptions);
  const modelTargetGroups = createMemo(() => panel.params.targetGroups);
  const selectedModelValue = createMemo(() => panel.params.selectedModelValue);
  const selectedAgentRuntime = createMemo(() => panel.params.selectedAgentRuntime);
  const disabled = createMemo(() => panel.params.disabled);
  const sessionModelPinned = createMemo(() => panel.params.sessionModelPinned);
  const onModelSetup = createMemo(() => panel.params.onModelSetup);
  const modelSelectionLocked = createMemo(() => panel.params.modelSelectionLocked);
  const [runtimeOverrides, setRuntimeOverrides] = createSignal<Record<string, string>>({});
  const providerOptions = createMemo(() => Map.groupBy(modelOptions(), modelProviderId));
  const providerRuntime = (provider: string) =>
    runtimeOverrides()[provider] ??
    modelRuntimeId(
      providerOptions()
        .get(provider)
        ?.find((option) =>
          isModelPickerOptionSelected(option, selectedModelValue(), selectedAgentRuntime()),
        ) ?? providerOptions().get(provider)![0]!,
    );
  const runtimeModelOptions = createMemo(() =>
    [...providerOptions()].flatMap(([provider, options]) =>
      providerRuntimeOptions(options, providerRuntime(provider)),
    ),
  );
  const state = createMemo(() =>
    prepareChatModelPickerPanel({
      modelOptions: runtimeModelOptions(),
      targetGroups: modelTargetGroups(),
      selectedModelValue: selectedModelValue(),
      selectedAgentRuntime: selectedAgentRuntime(),
    }),
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
        ...providerGroups.flatMap(([provider, group]) =>
          group.lead
            .map((entry) =>
              Object.assign(modelOptionSearchRow({ ...modelSearchProps, entry }, defaultLabel), {
                provider,
                list: provider,
              }),
            )
            .concat(
              group.more.map((entry) =>
                Object.assign(modelOptionSearchRow({ ...modelSearchProps, entry }, defaultLabel), {
                  provider,
                  more: true,
                  list: `${provider}:more`,
                }),
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
    return group && !searchView?.filtering()
      ? modelAuthState([...group[1].lead, ...group[1].more])
      : undefined;
  });
  const layout = createMemo<string[]>(() => {
    if (searchView?.filtering()) {
      return [
        ...searchView
          .matches()
          .filter(({ row }) => row.list !== "accounts")
          .map(({ row }) => row.key),
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
        rows.push(...group.lead.map(modelPickerOptionKey));
        rows.push(
          ...(searchView.moreOpen(provider)
            ? group.more.map(modelPickerOptionKey)
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
  const mounted = (entries: readonly ModelPickerOption[]) => {
    if (!entries.length) {
      return [];
    }
    const keys = window.keys();
    if (entries.length <= keys.length) {
      return entries.filter((entry) => window.has(modelPickerOptionKey(entry)));
    }
    const indexes = state().optionIndex;
    // Each lead/more list is a contiguous slice of the prepared catalog order.
    const first = indexes.get(modelPickerOptionKey(entries[0]!))!;
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
      <>
        {renderCatalogStatus()(() => (
          <ChatModelCatalogState
            state={panel.params.modelCatalogState}
            hasOptions={modelOptions().length > 0}
            hasSelectableOptions={state().hasSelectableModelOptions}
            onModelSetup={onModelSetup()}
          />
        ))}
      </>
    );
  }
  function TargetOptions(props: { group: ChatModelPickerTargetGroup }) {
    const options = createMemo(() => props.group.completion.promise);
    return (
      <ModelList label={props.group.label} id={`target:${props.group.id}`}>
        <For
          each={options().filter((entry) => window.has(`target:${props.group.id}:${entry.value}`))}
          keyed={(entry) => entry.value}
        >
          {(entry) => {
            const key = createMemo(() => `target:${props.group.id}:${entry().value}`);
            return (
              <>
                {renderRow(key(), () => (
                  <ChatModelPickerTargetOption
                    disabled={disabled()}
                    entry={entry()}
                    groupId={props.group.id}
                    groupLabel={props.group.label}
                    index={
                      state().orderedOptions.length +
                      props.group.options.findIndex((option) => option.value === entry().value)
                    }
                    onSelect={selectTarget}
                  />
                ))}
              </>
            );
          }}
        </For>
      </ModelList>
    );
  }
  function TargetState(props: { group: ChatModelPickerTargetGroup; error?: boolean }) {
    return (
      <>
        {renderRow(`state:target:${props.group.id}`, () => (
          <ChatModelCatalogState
            state={{ hasSnapshot: false, status: props.error ? "error" : "loading" }}
            hasOptions={false}
            hasSelectableOptions={false}
            errorLabel={props.group.errorLabel}
            retryTarget={
              panel.params.onTargetRetry
                ? {
                    disabled: disabled(),
                    groupId: props.group.id,
                    onRetry: panel.params.onTargetRetry!,
                  }
                : undefined
            }
          />
        ))}
        <ModelList label={props.group.label} id={`target:${props.group.id}`}>
          {null}
        </ModelList>
      </>
    );
  }
  function ModelOption(props: { entry: ModelPickerOption }) {
    const key = createMemo(() => modelPickerOptionKey(props.entry));
    return (
      <>
        {renderRow(key(), () => (
          <ChatModelPickerOption
            disabled={disabled()}
            entry={props.entry}
            index={state().optionIndex.get(modelPickerOptionKey(props.entry)) ?? 0}
            selectedModelValue={selectedModelValue()}
            selectedAgentRuntime={selectedAgentRuntime()}
            sessionModelPinned={sessionModelPinned()}
            onSelect={selectModel}
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
    const providerLabel = () => providerDisplayLabel(props.provider);
    const groupLabel = () => t("chat.modelControls.providerModels", { provider: providerLabel() });
    const auth = () => panel.params.providerAuth?.get(canonicalModelAuthProviderId(props.provider));
    const authKind = () => auth()?.kind;
    const showAuth = () => Boolean(auth());
    const authLabel = () => (showAuth() ? auth()?.label : undefined);
    const authHelp = () => {
      const expiryLabel = props.lead[0]?.expiryLabel;
      return [
        auth()?.detail,
        expiryLabel ? t("modelProviders.expiresIn", { time: expiryLabel }) : undefined,
      ]
        .filter(Boolean)
        .join("\n");
    };
    return (
      <section
        class="chat-controls__provider-model-group"
        data-chat-model-provider-group={props.provider}
        aria-label={groupLabel()}
      >
        {renderRow(`heading:${provider()}`, () => (
          <div class="chat-controls__provider-heading" data-chat-model-provider={props.provider}>
            <span class="chat-controls__provider-label">{providerLabel()}</span>
            {showAuth() ? (
              <span class="chat-controls__auth-meta" data-auth-kind={authKind()}>
                <openclaw-tooltip prop:content={authHelp()}>
                  <span
                    class="chat-controls__auth-meta-label"
                    tabindex={authHelp() ? 0 : undefined}
                  >
                    {authKind() === "api" ? t("modelProviders.status.apiKey") : authLabel()}
                  </span>
                </openclaw-tooltip>
              </span>
            ) : undefined}
            {panel.params.onProviderSettings ? (
              <button
                class="chat-controls__provider-settings"
                data-chat-model-provider-settings
                type="button"
                aria-label={t("chat.modelControls.configureModels")}
                onClick={(event) => {
                  event.stopPropagation();
                  panel.params.onProviderSettings?.(props.provider);
                }}
              >
                <Icon name="settings" />
              </button>
            ) : undefined}
          </div>
        ))}
        <ModelList label={groupLabel()} id={props.provider}>
          <For each={mounted(props.lead)} keyed={modelPickerOptionKey}>
            {(entry) => <ModelOption entry={entry()} />}
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
              <For each={mounted(props.more)} keyed={modelPickerOptionKey}>
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
      class="chat-controls__inline-select-menu chat-controls__model-menu"
      aria-label={t("chat.selectors.model")}
      data-chat-model-filtering={searchView?.filtering() ? "" : undefined}
      data-chat-model-compact={modelSelectionLocked() || !state().hasOptions ? "" : undefined}
    >
      {modelSelectionLocked() ? (
        <div class="chat-controls__locked-model" aria-label={t("chat.selectors.modelLockedLabel")}>
          <span class="chat-controls__locked-model-value">{panel.params.triggerModelLabel}</span>
          <span class="chat-controls__locked-model-badge">{t("chat.selectors.modelLocked")}</span>
        </div>
      ) : (
        <>
          {state().hasOptions ? (
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
                <ChatModelCatalogRefresh state={panel.params.modelCatalogState} />
              ) : undefined}
            </div>
          ) : undefined}
          {!state().hasOptions ? <CatalogStatus /> : undefined}
          {state().hasOptions ? (
            <>
              <div class="chat-controls__model-browser">
                <ChatModelProviderRail
                  providers={state().orderedProviderGroups.map(([provider]) => provider)}
                  targets={state().targetGroups}
                  active={catalog().providers.find((provider) =>
                    searchView?.providerOpen(provider),
                  )}
                  disabled={disabled()}
                  onSelect={(provider) => searchView?.toggleProvider(provider)}
                />
                <div
                  class="chat-controls__model-pane"
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
                              <Show when={group().completion} keyed>
                                <Errored fallback={() => <TargetState group={group()} error />}>
                                  <Loading fallback={<TargetState group={group()} />}>
                                    <TargetOptions group={group()} />
                                  </Loading>
                                </Errored>
                              </Show>
                            </section>
                          );
                        }}
                      </For>
                    </div>
                  </div>
                  <div
                    class="chat-controls__model-search-empty"
                    data-chat-model-search-empty
                    hidden={!searchView?.empty()}
                  >
                    {t("chat.modelControls.noMatchingModels")}
                  </div>
                  <Show when={activeAuth()}>
                    {(auth) => <ChatModelAuthState state={auth()} onSetup={onModelSetup()} />}
                  </Show>
                  <CatalogStatus />
                </div>
              </div>
              <ChatModelSettings
                params={panel.params}
                account={accounts()}
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
                  setRuntimeOverrides((previous) => ({ ...previous, [provider]: runtime }));
                  if (
                    entry &&
                    (entry.value === selectedModelValue() ||
                      (entry.isDefault && !selectedModelValue()))
                  ) {
                    void panel.params.onModelSelect(
                      entry.commitValue,
                      panel.params.sessionKey,
                      entry.runtimeOverride ?? null,
                    );
                  }
                }}
              />
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
