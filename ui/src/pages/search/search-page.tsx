import { parseModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import {
  Errored,
  Loading,
  Show,
  action,
  createMemo,
  createOptimistic,
  createSignal,
  isPending,
  onSettled,
} from "solid-js";
import type {
  WebSearchStatusParams,
  WebSearchStatusResult,
  WebSearchTestResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { ModelCatalogEntry } from "../../api/types.ts";
import { readGatewayOperatorAccess } from "../../app/operator-access.ts";
import { ModelPicker } from "../../components/solid/model-picker.tsx";
import {
  SettingsEmpty,
  SettingsLoadingSkeleton,
  SettingsNavRow,
  SettingsPage,
  SettingsPageHeader,
  SettingsRow,
  SettingsSection,
  SettingsStatus,
  SettingsToggleRow,
} from "../../components/solid/settings-ui.tsx";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { i18n } from "../../i18n/lib/translate.ts";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { currentConfigObject } from "../../lib/config/config-state-model.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { GatewayConnectionScope } from "../../lib/gateway-connection-lifecycle.ts";
import { isComposingKeyboardEvent, recordCompositionEnd } from "../../lib/ime.ts";
import { loadModelCatalog } from "../../lib/model-catalog-store.ts";
import { projectAgentSelection } from "../../lib/reactive/application.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { projectAgents, projectRuntimeConfig } from "../../lib/reactive/domain-capabilities.ts";
import { useGatewayPage } from "../../lib/reactive/gateway-page.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { SettingsSelectRow } from "../config/settings-select-row.tsx";
import { newSessionModelSearch } from "../new-session/model-location.ts";
import { createCredentialPresentation } from "../plugins/credential-presentation.ts";
import { readConfigValue, searchConfigRevision, isSearchConfigSettled } from "./search-config.ts";
import { renderSearchTestResult } from "./search-results.tsx";
import { SearchSetup, AdvancedSearchSettings } from "./search-setup.tsx";

registerEnglishCatalog(registerSettingsEnglish);

export function SearchPage() {
  const context = useApplication();
  let disposed = false;
  const active = () => !disposed;
  // Accepted data keeps the editable controls mounted through refreshes and failures.
  const [result, setResult] = createSignal<WebSearchStatusResult | null>(null);
  const [loadRequest, setLoadRequest] = createSignal<{ promise: Promise<void> } | null>(null);
  const loadCompletion = createMemo(() => loadRequest()?.promise.then(() => null) ?? null);
  const loading = () => isPending(loadCompletion);
  const [testing, setTesting] = createOptimistic(false);
  const [testRequest, setTestRequest] = createSignal<Promise<WebSearchTestResult | null> | null>(
    null,
  );
  const testResult = createMemo(() => testRequest());
  const [models, setModels] = createSignal<ModelCatalogEntry[]>([]);
  const [model, setModel] = createSignal("");
  const [setupProvider, setSetupProvider] = createSignal("");
  const credentialPresentation = createCredentialPresentation(context.router);
  function selectSetupProvider(provider: string) {
    if (provider !== setupProvider()) {
      credentialPresentation.retire();
    }
    setSetupProvider(provider);
  }
  // The localized default seeds an editable draft; locale changes must not replace user input.
  const initialQuery = i18n.t("searchPage.queryDefault");
  const [query, setQuery] = createSignal(initialQuery);
  let selectedAgent = "";
  // Capture the initial receipt before the Gateway binding admits its first load.
  let configRevision = searchConfigRevision(context.runtimeConfig.state);
  let loadingActive = false;
  let activeTest: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  let queryInput: HTMLInputElement | undefined;
  let resetModelOnConnect = false;
  const runtimeView = projectRuntimeConfig(context.runtimeConfig);
  const agents = projectAgents(context.agents);
  const selectionProjection = projectAgentSelection(context.settingsAgentSelection);
  const gateway = useGatewayPage({
    getGateway: () => context.gateway,
    onIdentityChange: () => {
      resetModelOnConnect = true;
      setModel("");
      selectSetupProvider("");
    },
    invalidateRequests: () => {
      if (active()) {
        invalidate();
      }
    },
    ensureInitialData: () => {
      const agentChanged = syncAgent();
      // Identity resets are synchronous authority; Solid publishes their view next microtask.
      void load(agentChanged || resetModelOnConnect ? "" : model());
      resetModelOnConnect = false;
    },
  });
  function syncRuntime() {
    const state = context.runtimeConfig.state;
    if (!isSearchConfigSettled(state)) {
      invalidateTest();
    }
    const nextRevision = searchConfigRevision(state);
    if (nextRevision !== configRevision) {
      configRevision = nextRevision;
      void load();
    }
  }
  // Invalidate admitted tests and reads before config or selection changes can settle them.
  onSettled(() => {
    const stopRuntime = runtimeView.subscribe(syncRuntime);
    const stopSelection = selectionProjection.subscribe(syncAgent);
    return () => {
      disposed = true;
      stopRuntime();
      stopSelection();
    };
  });

  function invalidateTest() {
    const previous = activeTest;
    activeTest = undefined;
    previous?.resolve();
    setTestRequest(null);
  }

  function invalidate() {
    credentialPresentation.retire();
    invalidateTest();
    setResult(null);
    setModels([]);
  }

  function syncAgent() {
    const id = context.settingsAgentSelection.state.selectedId ?? "";
    if (id === selectedAgent) {
      return false;
    }
    selectedAgent = id;
    setModel("");
    invalidate();
    void load("");
    return true;
  }

  function selection(modelValue = model()): WebSearchStatusParams {
    const parsedModel = parseModelCatalogRef(modelValue);
    return {
      ...(selectedAgent ? { agentId: selectedAgent } : {}),
      ...(parsedModel ? { modelProvider: parsedModel.provider, modelId: parsedModel.modelId } : {}),
    };
  }

  function canEdit() {
    runtimeView.read();
    return (
      gateway.connected &&
      readGatewayOperatorAccess(context.gateway.snapshot).canAdmin &&
      context.runtimeConfig.canPatch !== false
    );
  }

  function busy() {
    runtimeView.read();
    const configState = context.runtimeConfig.state;
    return configState.configLoading || configState.configSaving || configState.configApplying;
  }

  function load(modelValue = model()): Promise<void> {
    const scope = gateway.capture();
    if (!scope || loadingActive) {
      return Promise.resolve();
    }
    invalidateTest();
    loadingActive = true;
    const selected = selection(modelValue);
    let requestedConfigRevision = configRevision;
    const current = () =>
      active() &&
      gateway.isCurrent(scope) &&
      requestedConfigRevision === configRevision &&
      JSON.stringify(selection()) === JSON.stringify(selected);
    if (canEdit()) {
      const runtime = context.runtimeConfig;
      void runtime
        .ensureLoaded()
        .then(() => runtime.ensureSchemaLoaded())
        .catch(() => undefined);
    }
    const request = (async () => {
      try {
        const catalog = await loadModelCatalog(scope.client, { agentId: selected.agentId }).catch(
          () => null,
        );
        // Search config scopes the status request, not the agent's catalog read.
        requestedConfigRevision = configRevision;
        if (!current()) {
          return;
        }
        const status = await scope.client.request<WebSearchStatusResult>(
          "webSearch.status",
          selected,
        );
        if (current()) {
          setModels(catalog?.models ?? []);
          setResult(status);
          if (!status.providers.some((provider) => provider.id === setupProvider())) {
            const preferred = status.provider ?? status.route.provider;
            selectSetupProvider(
              status.providers.find((provider) => provider.id === preferred)?.id ??
                status.providers.find((provider) => provider.available && provider.configured)
                  ?.id ??
                status.providers.toSorted((a, b) => a.label.localeCompare(b.label))[0]?.id ??
                "",
            );
          }
        }
      } catch (cause) {
        if (current()) {
          throw cause;
        }
      } finally {
        loadingActive = false;
        if (active()) {
          if (!current() && gateway.connected) {
            void load();
          }
        }
      }
    })();
    setLoadRequest({ promise: request });
    // The native read owns error presentation; imperative callers only await settlement.
    return request.catch(() => undefined);
  }

  async function patch(
    scope: GatewayConnectionScope | null,
    path: Array<string | number>,
    value: unknown,
  ): Promise<boolean> {
    if (!scope || !gateway.isCurrent(scope) || !canEdit() || busy()) {
      return false;
    }
    const runtime = context.runtimeConfig;
    invalidateTest();
    if (value === undefined) {
      runtime.removeFormValue(path);
    } else {
      runtime.patchForm(path, value);
    }
    const saved = await runtime.flushFormChanges();
    if (gateway.isCurrent(scope) && saved) {
      await load();
    }
    return saved;
  }

  async function retryConfig(scope: GatewayConnectionScope | null) {
    if (!scope || !gateway.isCurrent(scope)) {
      return;
    }
    const runtime = context.runtimeConfig;
    if (runtime.state.configFormDirty) {
      await runtime.retry();
      return;
    }
    await runtime.refresh();
    if (gateway.isCurrent(scope)) {
      await runtime.refreshSchema();
    }
  }

  const presentTest = action(function* (completed: Promise<void>) {
    setTesting(true);
    yield completed;
  });

  async function test(scope: GatewayConnectionScope | null) {
    const queryText = (queryInput?.value ?? query()).trim();
    const runtime = context.runtimeConfig;
    if (
      !scope ||
      !gateway.isCurrent(scope) ||
      !canEdit() ||
      !queryText ||
      queryText.length > 500 ||
      !(result()?.testProvider || result()?.route.testable) ||
      activeTest ||
      !isSearchConfigSettled(runtime.state) ||
      loadingActive
    ) {
      return;
    }
    const selected = selection();
    const presentation = Promise.withResolvers<void>();
    const current = (): boolean =>
      activeTest === presentation &&
      active() &&
      gateway.isCurrent(scope) &&
      JSON.stringify(selection()) === JSON.stringify(selected);
    // Duplicate admission stays synchronous, before opening a presentation transaction.
    activeTest = presentation;
    const completed = (async () => {
      try {
        const response = await scope.client.request<WebSearchTestResult>("webSearch.test", {
          ...selected,
          ...(result()?.testProvider ? { providerId: result()!.testProvider!.id } : {}),
          query: queryText,
        });
        if (current()) {
          return response;
        }
      } catch (cause) {
        if (current()) {
          throw cause;
        }
      } finally {
        if (activeTest === presentation) {
          activeTest = undefined;
        }
        presentation.resolve();
      }
      return null;
    })();
    void setTestRequest(completed);
    // A retired or disposed view may no longer consume this result.
    void completed.catch(() => undefined);
    // Flush the query draft before the action can hold its opening tick.
    await Promise.resolve();
    return current() ? presentTest(presentation.promise) : completed.catch(() => undefined);
  }

  const configState = () => runtimeView.read().state;
  const config = () => currentConfigObject(configState());
  const search = () => asNullableRecord(readConfigValue(config(), ["tools", "web", "search"]));
  const providers = createMemo(() =>
    (result()?.providers ?? []).toSorted((a, b) => a.label.localeCompare(b.label)),
  );
  const providerOptions = () => providers().map(({ id, label }) => ({ value: id, label }));
  const configuredProvider = () => {
    const value = search()?.provider;
    return config() ? (typeof value === "string" ? value : "") : (result()?.provider ?? "");
  };
  const enabled = () => {
    const value = search()?.enabled;
    return typeof value === "boolean" ? value : result()!.enabled;
  };
  const configuredOptions = () => [
    { value: "", label: t("searchPage.automatic") },
    ...providerOptions(),
    ...(configuredProvider() &&
    !providers().some((provider) => provider.id === configuredProvider())
      ? [{ value: configuredProvider(), label: configuredProvider() }]
      : []),
  ];
  const modelOptions = () => [
    {
      value: "",
      label: `${t("searchPage.agentDefault")} · ${result()!.model.provider}/${result()!.model.id}`,
    },
    ...models().map((entry) => ({
      value: `${entry.provider}/${entry.id}`,
      label: entry.name || entry.id,
      provider: entry.provider,
    })),
  ];
  const routeStatus = () => {
    const kind = result()!.route.kind;
    return kind === "unavailable"
      ? "warn"
      : kind === "disabled" || kind === "external"
        ? "muted"
        : "ok";
  };
  function TestHealth(props: { pending?: boolean; failed?: boolean }) {
    const pending = () => props.pending || testing();
    const last = () => (pending() || props.failed ? null : testResult());
    const failed = () => !pending() && (props.failed || last()?.status === "error");
    const description = () => {
      const response = last();
      return response
        ? `${response.provider} · ${t("searchPage.duration", { ms: String(response.latencyMs) })}${response.cached ? ` · ${t("searchPage.cached")}` : ""}`
        : undefined;
    };
    return (
      <SettingsRow
        title={t("searchPage.health")}
        description={description()}
        control={
          <span role="status">
            <SettingsStatus
              kind={failed() ? "danger" : last() ? "ok" : "muted"}
              label={t(
                `searchPage.${pending() ? "testing" : failed() ? "failure" : last() ? "success" : "untested"}`,
              )}
            />
          </span>
        }
      />
    );
  }
  const selectedProvider = () => providers().find((provider) => provider.id === setupProvider());
  const agentOptions = () =>
    (agents.read().agentsList?.agents ?? [])
      .filter((agent) => agent.kind !== "system")
      .map((agent) => ({ value: agent.id, label: agent.name || agent.id }));
  const disabled = () => !canEdit() || busy() || !configState().configSnapshot;

  return (
    <openclaw-search-page>
      <SettingsPageHeader title={t("tabs.search")} subtitle={t("subtitles.search")} />
      <SettingsWorkspace>
        <SettingsPage>
          {!gateway.connected ? <SettingsEmpty message={t("searchPage.offline")} /> : undefined}
          <Show when={loadRequest()} keyed>
            {(request) => (
              <Errored
                fallback={(error) =>
                  gateway.connected ? (
                    <div role="alert" class="callout danger">
                      {formatUiError(error())}
                      <button class="btn btn--sm" onClick={() => void load()}>
                        {t("common.retry")}
                      </button>
                    </div>
                  ) : undefined
                }
              >
                <Loading
                  on={request}
                  fallback={!result() ? <SettingsLoadingSkeleton rows={4} /> : undefined}
                >
                  {loadCompletion()}
                </Loading>
              </Errored>
            )}
          </Show>
          {configState().lastError ? (
            <div role="alert" class="callout danger">
              {configState().lastError}
              <button class="btn btn--sm" onClick={() => void retryConfig(gateway.capture())}>
                {t("common.retry")}
              </button>
            </div>
          ) : undefined}
          <Loading>
            <Show when={result()}>
              {(current) => {
                // Retired controls keep this connection; same-connection refreshes keep their DOM.
                const renderScope = gateway.capture();
                return (
                  <>
                    <SettingsSection
                      description={t("searchPage.scopeHint")}
                      notice={
                        !canEdit() ? <p class="callout">{t("searchPage.readOnly")}</p> : undefined
                      }
                    >
                      <SettingsToggleRow
                        title={t("searchPage.enabled")}
                        description={t("searchPage.enabledHint")}
                        checked={enabled()}
                        disabled={disabled()}
                        onChange={(value) => {
                          void patch(renderScope, ["tools", "web", "search", "enabled"], value);
                        }}
                      />
                      <SettingsSelectRow
                        title={t("searchPage.provider")}
                        description={t("searchPage.automaticHint")}
                        value={configuredProvider()}
                        options={configuredOptions()}
                        disabled={disabled()}
                        onChange={(provider) => {
                          selectSetupProvider(provider || setupProvider());
                          void patch(
                            renderScope,
                            ["tools", "web", "search", "provider"],
                            provider || undefined,
                          );
                        }}
                      />
                    </SettingsSection>
                    <SettingsSection title={t("searchPage.route")}>
                      <SettingsSelectRow
                        title={t("searchPage.agent")}
                        value={selectionProjection.read().state.selectedId ?? ""}
                        options={agentOptions()}
                        onChange={(agent) => context.settingsAgentSelection.set(agent)}
                        disabled={!gateway.connected}
                      />
                      <SettingsRow
                        title={t("searchPage.model")}
                        description={current().model.runtimeLabel}
                        control={
                          <ModelPicker
                            label={t("searchPage.model")}
                            value={model()}
                            options={modelOptions()}
                            disabled={!gateway.connected}
                            onChange={(value) => {
                              setModel(value);
                              void load(value);
                            }}
                          />
                        }
                      />
                      <SettingsRow
                        title={current().route.label}
                        description={current().route.reason}
                        control={
                          <SettingsStatus
                            kind={routeStatus()}
                            label={
                              loading()
                                ? t("searchPage.loading")
                                : t(`searchPage.routeKinds.${current().route.kind}`)
                            }
                          />
                        }
                      />
                    </SettingsSection>
                    <SettingsSection
                      title={t("searchPage.health")}
                      description={t("searchPage.untestedHint")}
                      actions={
                        <button
                          class="btn btn--sm"
                          disabled={loading() || testing() || !gateway.connected}
                          onClick={() => void load()}
                        >
                          {t("searchPage.refresh")}
                        </button>
                      }
                    >
                      <Loading on={testRequest()} fallback={<TestHealth pending />}>
                        <Errored fallback={() => <TestHealth failed />}>
                          <TestHealth />
                        </Errored>
                      </Loading>
                      <Show when={current().testProvider || current().route.testable}>
                        <SettingsRow
                          title={t("searchPage.query")}
                          control={
                            <input
                              ref={(element) => {
                                queryInput = element;
                              }}
                              class="settings-input"
                              aria-label={t("searchPage.query")}
                              maxlength="500"
                              disabled={testing()}
                              value={query()}
                              placeholder={t("searchPage.queryPlaceholder")}
                              onInput={(event) => {
                                if (!testing()) {
                                  setQuery(event.currentTarget.value);
                                  invalidateTest();
                                }
                              }}
                              onCompositionEnd={recordCompositionEnd}
                              onKeyDown={(event) => {
                                if (event.key === "Enter" && !isComposingKeyboardEvent(event)) {
                                  void test(renderScope);
                                }
                              }}
                            />
                          }
                        />
                        <SettingsRow
                          title={t("searchPage.test")}
                          control={
                            <button
                              class="btn"
                              disabled={
                                !canEdit() ||
                                !query().trim() ||
                                query().trim().length > 500 ||
                                testing() ||
                                loading() ||
                                !isSearchConfigSettled(configState()) ||
                                !gateway.connected
                              }
                              onClick={() => void test(renderScope)}
                            >
                              {testing()
                                ? t("searchPage.testing")
                                : current().testProvider
                                  ? t("searchPage.testProvider", {
                                      provider: current().testProvider!.label,
                                    })
                                  : t("searchPage.test")}
                            </button>
                          }
                        />
                      </Show>
                      <Show
                        when={
                          current().route.kind === "native" || current().route.kind === "external"
                        }
                      >
                        <SettingsNavRow
                          title={t("searchPage.testInChat")}
                          description={t("searchPage.testInChatHint")}
                          onClick={() => {
                            if (renderScope && gateway.isCurrent(renderScope) && !loading()) {
                              context.navigate("new-session", {
                                search: newSessionModelSearch(
                                  current().agentId,
                                  `${current().model.provider}/${current().model.id}`,
                                ),
                              });
                            }
                          }}
                        />
                      </Show>
                    </SettingsSection>
                    <Loading on={testRequest()} fallback={undefined}>
                      <Errored
                        fallback={(error) => renderSearchTestResult(null, formatUiError(error()))}
                      >
                        {renderSearchTestResult(testResult(), "")}
                      </Errored>
                    </Loading>
                    <SettingsSection
                      title={t("searchPage.setup")}
                      description={t("searchPage.setupHint")}
                    >
                      <SettingsSelectRow
                        title={t("searchPage.setupProvider")}
                        description={selectedProvider()?.hint}
                        value={setupProvider()}
                        options={providerOptions()}
                        onChange={selectSetupProvider}
                      />
                      <Show when={selectedProvider()?.id} keyed>
                        {(providerId) => (
                          <SearchSetup
                            provider={selectedProvider()!}
                            state={configState}
                            context={context}
                            gateway={gateway}
                            getPresentationLifetime={() => credentialPresentation.lifetime}
                            canEdit={canEdit}
                            busy={busy}
                            commit={(path, value) =>
                              providerId === setupProvider()
                                ? patch(renderScope, path, value)
                                : Promise.resolve(false)
                            }
                          />
                        )}
                      </Show>
                      <SettingsNavRow
                        title={t("searchPage.moreProviders")}
                        description={t("searchPage.moreProvidersHint")}
                        onClick={() => context.navigate("plugins")}
                      />
                    </SettingsSection>
                    <AdvancedSearchSettings
                      state={configState}
                      canEdit={canEdit}
                      busy={busy}
                      commit={(path, value) => patch(renderScope, path, value)}
                    />
                  </>
                );
              }}
            </Show>
          </Loading>
        </SettingsPage>
      </SettingsWorkspace>
    </openclaw-search-page>
  );
}

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-search-page": HTMLAttributes<HTMLElement>;
    }
  }
}
