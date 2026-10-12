import { parseModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  getOwner,
  isDisposed,
  onCleanup,
  untrack,
} from "solid-js";
import type {
  WebSearchStatusParams,
  WebSearchStatusResult,
  WebSearchTestResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { ModelCatalogEntry } from "../../api/types.ts";
import { readGatewayOperatorAccess } from "../../app/operator-access.ts";
import { renderModelPicker } from "../../components/model-picker.ts";
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
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { currentConfigObject } from "../../lib/config/config-state-model.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { GatewayConnectionScope } from "../../lib/gateway-connection-lifecycle.ts";
import { loadModelCatalog } from "../../lib/model-catalog-store.ts";
import { projectAgentSelection } from "../../lib/reactive/application.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { projectAgents, projectRuntimeConfig } from "../../lib/reactive/domain-capabilities.ts";
import { useGatewayPage } from "../../lib/reactive/gateway-page.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { LitContent, defineSolidBridge } from "../../lit/solid-bridge.ts";
import { newSessionModelSearch } from "../new-session/model-location.ts";
import { readConfigValue, searchConfigRevision, isSearchConfigSettled } from "./search-config.ts";
import { renderSearchTestResult } from "./search-results.tsx";
import { SearchSetup, AdvancedSearchSettings } from "./search-setup.tsx";

registerEnglishCatalog(registerSettingsEnglish);

function SettingsSelectRow(props: {
  title: string;
  value: string;
  description?: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <SettingsRow
      title={props.title}
      description={props.description}
      control={
        <select
          class="settings-select"
          aria-label={props.title}
          disabled={props.disabled}
          value={props.value}
          onChange={(event) => props.onChange(event.currentTarget.value)}
        >
          <For each={props.options} keyed={(option) => option.value}>
            {(option) => (
              <option value={option().value} selected={option().value === props.value}>
                {option().label}
              </option>
            )}
          </For>
        </select>
      }
    />
  );
}

function SearchPageContent() {
  const context = useApplication();
  const owner = getOwner();
  const active = () => owner !== null && !isDisposed(owner);
  const [result, setResult] = createSignal<WebSearchStatusResult | null>(null);
  const [error, setError] = createSignal("");
  const [loading, setLoading] = createSignal(false);
  const [testing, setTesting] = createSignal(false);
  const [testResult, setTestResult] = createSignal<WebSearchTestResult | null>(null);
  const [testError, setTestError] = createSignal("");
  const [models, setModels] = createSignal<ModelCatalogEntry[]>([]);
  const [model, setModel] = createSignal("");
  const [setupProvider, setSetupProvider] = createSignal("");
  const [query, setQuery] = createSignal(untrack(() => t("searchPage.queryDefault")));
  let selectedAgent = "";
  let configRevision = "";
  let loadingActive = false;
  let testingActive = false;
  let queryInput: HTMLInputElement | undefined;
  let resetModelOnConnect = false;
  const runtimeView = projectRuntimeConfig(context.runtimeConfig);
  const agents = projectAgents(context.agents);
  const selectionProjection = projectAgentSelection(context.settingsAgentSelection);
  // Record the initial config receipt before the Gateway effect starts loading.
  createEffect(
    () => undefined,
    () => untrack(syncRuntime),
  );
  const gateway = useGatewayPage({
    getGateway: () => context.gateway,
    onIdentityChange: () => {
      resetModelOnConnect = true;
      setModel("");
      setSetupProvider("");
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
  const stopRuntime = runtimeView.subscribe(() => untrack(syncRuntime));
  const stopSelection = selectionProjection.subscribe(() => untrack(syncAgent));
  onCleanup(() => {
    stopRuntime();
    stopSelection();
  });

  function invalidateTest() {
    testingActive = false;
    setTestResult(null);
    setTestError("");
  }

  function invalidate() {
    invalidateTest();
    setResult(null);
    setError("");
    setModels([]);
  }

  function syncAgent() {
    const id = context?.settingsAgentSelection.state.selectedId ?? "";
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

  async function load(modelValue = model()) {
    const scope = gateway.capture();
    if (!scope || loadingActive) {
      return;
    }
    invalidateTest();
    loadingActive = true;
    setLoading(true);
    setError("");
    const selected = selection(modelValue);
    const current = () =>
      active() &&
      gateway.isCurrent(scope) &&
      JSON.stringify(selection()) === JSON.stringify(selected);
    if (canEdit()) {
      const runtime = context.runtimeConfig;
      void runtime
        .ensureLoaded()
        .then(() => runtime.ensureSchemaLoaded())
        .catch(() => undefined);
    }
    try {
      const catalog = await loadModelCatalog(scope.client, { agentId: selected.agentId }).catch(
        () => null,
      );
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
          setSetupProvider(
            status.providers.find((provider) => provider.id === preferred)?.id ??
              status.providers.find((provider) => provider.available && provider.configured)?.id ??
              status.providers.toSorted((a, b) => a.label.localeCompare(b.label))[0]?.id ??
              "",
          );
        }
      }
    } catch (cause) {
      if (active()) {
        setError(formatUiError(cause));
      }
    } finally {
      loadingActive = false;
      if (active()) {
        setLoading(false);
        if (!current() && gateway.connected) {
          void load();
        }
      }
    }
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
      testingActive ||
      !isSearchConfigSettled(runtime.state) ||
      loadingActive
    ) {
      return;
    }
    const selected = selection();
    const current = () =>
      active() &&
      gateway.isCurrent(scope) &&
      JSON.stringify(selection()) === JSON.stringify(selected);
    testingActive = true;
    setTesting(true);
    setTestResult(null);
    setTestError("");
    try {
      const response = await scope.client.request<WebSearchTestResult>("webSearch.test", {
        ...selected,
        ...(result()?.testProvider ? { providerId: result()!.testProvider!.id } : {}),
        query: queryText,
      });
      if (current()) {
        setTestResult(response);
      }
    } catch (cause) {
      if (current()) {
        setTestError(formatUiError(cause));
      }
    } finally {
      testingActive = false;
      if (active()) {
        setTesting(false);
      }
    }
  }

  const configState = () => runtimeView.read().state;
  const config = () => currentConfigObject(configState());
  const search = () => asNullableRecord(readConfigValue(config(), ["tools", "web", "search"]));
  const providers = createMemo(() =>
    (result()?.providers ?? []).toSorted((a, b) => a.label.localeCompare(b.label)),
  );
  const providerOptions = createMemo(() =>
    providers().map(({ id, label }) => ({ value: id, label })),
  );
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
  const health = () => {
    const failed = testError() || testResult()?.status === "error";
    return {
      kind: failed ? ("danger" as const) : testResult() ? ("ok" as const) : ("muted" as const),
      label: t(
        `searchPage.${testing() ? "testing" : failed ? "failure" : testResult() ? "success" : "untested"}`,
      ),
    };
  };
  const healthDescription = () => {
    const last = testResult();
    return last
      ? `${last.provider} · ${t("searchPage.duration", { ms: String(last.latencyMs) })}${last.cached ? ` · ${t("searchPage.cached")}` : ""}`
      : undefined;
  };
  const selectedProvider = () => providers().find((provider) => provider.id === setupProvider());
  const agentOptions = () =>
    (agents.read().agentsList?.agents ?? [])
      .filter((agent) => agent.kind !== "system")
      .map((agent) => ({ value: agent.id, label: agent.name || agent.id }));
  const disabled = () => !canEdit() || busy() || !configState().configSnapshot;

  return (
    <>
      <SettingsPageHeader title={t("tabs.search")} subtitle={t("subtitles.search")} />
      <SettingsWorkspace>
        <SettingsPage>
          {!gateway.connected ? <SettingsEmpty message={t("searchPage.offline")} /> : undefined}
          {error() ? (
            <div role="alert" class="callout danger">
              {error()}
              <button class="btn btn--sm" onClick={() => void load()}>
                {t("common.retry")}
              </button>
            </div>
          ) : undefined}
          {configState().lastError ? (
            <div role="alert" class="callout danger">
              {configState().lastError}
              <button class="btn btn--sm" onClick={() => void retryConfig(gateway.capture())}>
                {t("common.retry")}
              </button>
            </div>
          ) : undefined}
          {!result() && loading() ? <SettingsLoadingSkeleton rows={4} /> : undefined}
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
                        setSetupProvider(provider || setupProvider());
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
                        <LitContent
                          render={() =>
                            renderModelPicker({
                              label: t("searchPage.model"),
                              value: model(),
                              options: modelOptions(),
                              disabled: !gateway.connected,
                              onChange: (value) => {
                                setModel(value);
                                void load(value);
                              },
                            })
                          }
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
                    <SettingsRow
                      title={t("searchPage.health")}
                      description={healthDescription()}
                      control={
                        <span role="status">
                          <SettingsStatus {...health()} />
                        </span>
                      }
                    />
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
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
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
                  {renderSearchTestResult(testResult(), testError())}
                  <SettingsSection
                    title={t("searchPage.setup")}
                    description={t("searchPage.setupHint")}
                  >
                    <SettingsSelectRow
                      title={t("searchPage.setupProvider")}
                      description={selectedProvider()?.hint}
                      value={setupProvider()}
                      options={providerOptions()}
                      onChange={setSetupProvider}
                    />
                    <Show when={selectedProvider()?.id} keyed>
                      {(providerId) => (
                        <SearchSetup
                          provider={selectedProvider()!}
                          state={configState}
                          context={context}
                          gateway={gateway}
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
        </SettingsPage>
      </SettingsWorkspace>
    </>
  );
}
export const SearchPage = defineSolidBridge("openclaw-search-page", SearchPageContent, {
  properties: {},
});
