import { consume } from "@lit/context";
import { parseModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { html, nothing } from "lit";
import { state } from "lit/decorators.js";
import { keyed } from "lit/directives/keyed.js";
import type {
  WebSearchStatusParams,
  WebSearchStatusResult,
  WebSearchTestResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { ModelCatalogEntry } from "../../api/types.ts";
import { pathForRoute } from "../../app-route-paths.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { readGatewayOperatorAccess } from "../../app/operator-access.ts";
import { resolveConfigFieldMeta } from "../../components/config-form.search.ts";
import { analyzeConfigSchema, renderNode } from "../../components/config-form.ts";
import { renderModelPicker } from "../../components/model-picker.ts";
import {
  renderLearnMoreLink,
  renderSettingsEmpty,
  renderSettingsGroup,
  renderSettingsLoadingSkeleton,
  renderSettingsNavRow,
  renderSettingsPage,
  renderSettingsPageHeader,
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsStatus,
  renderSettingsToggleRow,
} from "../../components/settings-ui.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { t } from "../../i18n/index.ts";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import type { JsonSchema } from "../../lib/config-form-utils.ts";
import { currentConfigObject } from "../../lib/config/config-state-model.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { GatewayConnectionScope } from "../../lib/gateway-connection-lifecycle.ts";
import { loadModelCatalog } from "../../lib/model-catalog-store.ts";
import { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { renderSettingsSelectRow } from "../config/settings-select-row.ts";
import { newSessionModelSearch } from "../new-session/model-location.ts";
import { renderPluginCredential } from "../plugins/credential-editor.ts";
import { pluginConfigSchema } from "../plugins/settings-model.ts";
import { readConfigValue, searchConfigRevision, isSearchConfigSettled } from "./search-config.ts";
import { renderSearchTestResult } from "./search-results.ts";

registerSettingsEnglish();

type SearchProvider = WebSearchStatusResult["providers"][number];

class SearchPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @state() private result: WebSearchStatusResult | null = null;
  @state() private error = "";
  @state() private loading = false;
  @state() private testing = false;
  @state() private testResult: WebSearchTestResult | null = null;
  @state() private testError = "";
  @state() private models: ModelCatalogEntry[] = [];
  @state() private model = "";
  @state() private setupProvider = "";
  @state() private query = t("searchPage.queryDefault");
  private generation = 0;
  private testGeneration = 0;
  private selectedAgent = "";
  private configRevision = "";

  private readonly gateway = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
    onIdentityChange: () => {
      this.model = "";
      this.setupProvider = "";
    },
    invalidateRequests: () => this.invalidate(),
    ensureInitialData: () => {
      this.syncAgent();
      void this.load();
    },
  });

  private readonly subscriptions = new SubscriptionsController(this)
    .watch(
      () => this.context?.runtimeConfig,
      (runtime, notify) => runtime.subscribe(notify),
      (runtime) => {
        if (!isSearchConfigSettled(runtime.state)) {
          this.invalidateTest();
        }
        const revision = searchConfigRevision(runtime.state);
        if (revision !== this.configRevision) {
          this.configRevision = revision;
          void this.load();
        }
      },
    )
    .watch(
      () => this.context?.settingsAgentSelection,
      (selection, notify) => selection.subscribe(notify),
      () => this.syncAgent(),
    )
    .watch(
      () => this.context?.agents,
      (agents, notify) => agents.subscribe(notify),
    );

  override disconnectedCallback() {
    this.invalidate();
    this.subscriptions.clear();
    super.disconnectedCallback();
  }

  private invalidateTest() {
    this.testGeneration++;
    this.testResult = null;
    this.testError = "";
    this.testing = false;
  }

  private invalidate() {
    this.generation++;
    this.invalidateTest();
    this.result = null;
    this.error = "";
    this.loading = false;
    this.models = [];
  }

  private syncAgent() {
    const id = this.context?.settingsAgentSelection.state.selectedId ?? "";
    if (id === this.selectedAgent) {
      return;
    }
    this.selectedAgent = id;
    this.model = "";
    this.invalidate();
    void this.load();
  }

  private get selection(): WebSearchStatusParams {
    const model = parseModelCatalogRef(this.model);
    return {
      ...(this.selectedAgent ? { agentId: this.selectedAgent } : {}),
      ...(model ? { modelProvider: model.provider, modelId: model.modelId } : {}),
    };
  }

  private get canEdit() {
    return (
      this.gateway.connected &&
      readGatewayOperatorAccess(this.context.gateway.snapshot).canAdmin &&
      this.context.runtimeConfig.canPatch !== false
    );
  }

  private get busy() {
    const configState = this.context.runtimeConfig.state;
    return configState.configLoading || configState.configSaving || configState.configApplying;
  }

  private async load() {
    const scope = this.gateway.capture();
    if (!scope) {
      return;
    }
    const generation = ++this.generation;
    this.invalidateTest();
    this.loading = true;
    this.error = "";
    const current = () =>
      this.isConnected && generation === this.generation && this.gateway.isCurrent(scope);
    const selection = this.selection;
    if (this.canEdit) {
      const runtime = this.context.runtimeConfig;
      void runtime
        .ensureLoaded()
        .then(() => runtime.ensureSchemaLoaded())
        .catch(() => undefined);
    }
    try {
      const catalog = await loadModelCatalog(scope.client, { agentId: selection.agentId }).catch(
        () => null,
      );
      if (!current()) {
        return;
      }
      this.models = catalog?.models ?? [];
      const result = await scope.client.request<WebSearchStatusResult>(
        "webSearch.status",
        selection,
      );
      if (current()) {
        this.result = result;
        if (!result.providers.some((provider) => provider.id === this.setupProvider)) {
          const preferred = result.provider ?? result.route.provider;
          this.setupProvider =
            result.providers.find((provider) => provider.id === preferred)?.id ??
            result.providers.find((provider) => provider.available && provider.configured)?.id ??
            result.providers.toSorted((a, b) => a.label.localeCompare(b.label))[0]?.id ??
            "";
        }
      }
    } catch (error) {
      if (current()) {
        this.error = formatUiError(error);
      }
    } finally {
      if (current()) {
        this.loading = false;
      }
    }
  }

  private async patch(
    scope: GatewayConnectionScope | null,
    path: Array<string | number>,
    value: unknown,
  ): Promise<boolean> {
    if (!scope || !this.gateway.isCurrent(scope) || !this.canEdit || this.busy) {
      return false;
    }
    const runtime = this.context.runtimeConfig;
    this.invalidateTest();
    if (value === undefined) {
      runtime.removeFormValue(path);
    } else {
      runtime.patchForm(path, value);
    }
    const saved = await runtime.flushFormChanges();
    if (this.gateway.isCurrent(scope) && saved) {
      await this.load();
    }
    return saved;
  }

  private async retryConfig(scope: GatewayConnectionScope | null) {
    if (!scope || !this.gateway.isCurrent(scope)) {
      return;
    }
    const runtime = this.context.runtimeConfig;
    if (runtime.state.configFormDirty) {
      await runtime.retry();
      return;
    }
    await runtime.refresh();
    if (this.gateway.isCurrent(scope)) {
      await runtime.refreshSchema();
    }
  }

  private async test(scope: GatewayConnectionScope | null, statusGeneration: number) {
    const query = this.query.trim();
    const runtime = this.context.runtimeConfig;
    const revision = searchConfigRevision(runtime.state);
    if (
      !scope ||
      !this.gateway.isCurrent(scope) ||
      statusGeneration !== this.generation ||
      !this.canEdit ||
      !query ||
      query.length > 500 ||
      !(this.result?.testProvider || this.result?.route.testable) ||
      this.testing ||
      !isSearchConfigSettled(runtime.state) ||
      this.loading
    ) {
      return;
    }
    const generation = ++this.testGeneration;
    const current = () =>
      this.isConnected &&
      generation === this.testGeneration &&
      this.gateway.isCurrent(scope) &&
      this.context.runtimeConfig === runtime &&
      isSearchConfigSettled(runtime.state) &&
      searchConfigRevision(runtime.state) === revision;
    this.testing = true;
    this.testResult = null;
    this.testError = "";
    try {
      const result = await scope.client.request<WebSearchTestResult>("webSearch.test", {
        ...this.selection,
        ...(this.result?.testProvider ? { providerId: this.result.testProvider.id } : {}),
        query,
      });
      if (current()) {
        this.testResult = result;
      }
    } catch (error) {
      if (current()) {
        this.testError = formatUiError(error);
      }
    } finally {
      if (current()) {
        this.testing = false;
      }
    }
  }

  private renderConfigField(
    schema: JsonSchema,
    path: Array<string | number>,
    value: unknown,
    unsupported: Set<string>,
    patch: (path: Array<string | number>, value: unknown) => Promise<boolean>,
  ) {
    const hints = this.context.runtimeConfig.state.configUiHints;
    const meta = resolveConfigFieldMeta(path, schema, hints);
    return renderSettingsRow({
      title: meta.label,
      description: meta.help,
      stackedOnNarrow: true,
      control: renderNode({
        schema,
        value,
        path,
        hints,
        unsupported,
        disabled: !this.canEdit || this.busy,
        compact: true,
        commitOnBlur: true,
        showLabel: false,
        rawAvailable: false,
        maskSensitive: true,
        onPatch: (changedPath, nextValue) => void patch(changedPath, nextValue),
        onRemove: (changedPath) => void patch(changedPath, undefined),
      }),
    });
  }

  private renderSetup(provider: SearchProvider) {
    const scope = this.gateway.capture();
    const runtime = this.context.runtimeConfig;
    const patch = (path: Array<string | number>, value: unknown) =>
      this.setupProvider === provider.id ? this.patch(scope, path, value) : Promise.resolve(false);
    const config = currentConfigObject(runtime.state);
    const analysis = analyzeConfigSchema(runtime.state.configSchema);
    const unsupported = new Set(analysis.unsupportedPaths);
    const schema = provider.configPath.length
      ? provider.configPath
          .slice(4)
          .reduce<JsonSchema | null>(
            (node, key) => node?.properties?.[key] ?? null,
            pluginConfigSchema(analysis.schema, provider.pluginId),
          )
      : null;
    const values = asNullableRecord(readConfigValue(config, provider.configPath));
    const credential = provider.credential;
    return html`
      ${renderSettingsRow({
        title: t("searchPage.configuration"),
        description: t(`searchPage.credentialSources.${provider.credentialSource}`),
        control: renderSettingsStatus({
          kind: provider.available && provider.configured ? "ok" : "warn",
          label: t(
            !provider.installed
              ? "searchPage.pluginMissing"
              : !provider.available
                ? "searchPage.pluginUnavailable"
                : provider.configured
                  ? "searchPage.configured"
                  : "searchPage.needsSetup",
          ),
        }),
      })}
      ${
        credential
          ? renderSettingsRow({
              title: credential.label,
              stackedOnNarrow: true,
              control: renderPluginCredential(
                {
                  path: credential.path,
                  value: readConfigValue(config, credential.path),
                  disabled: !this.canEdit || this.busy,
                  onPatch: (path, value) => {
                    void patch(path, value);
                  },
                },
                credential,
                {
                  pluginId: provider.pluginId,
                  baseHash: runtime.state.configSnapshot?.hash ?? null,
                  gateway: this.gateway,
                  canInspect: this.canEdit,
                  saveError: runtime.state.lastError,
                  onCommit: patch,
                  onDiscard: () => runtime.discardFormValue(credential.path),
                },
              ),
            })
          : nothing
      }
      ${
        schema?.properties
          ? Object.entries(schema.properties)
              .filter(
                ([key]) =>
                  !credential ||
                  credential.path.length !== provider.configPath.length + 1 ||
                  !provider.configPath.every(
                    (segment, index) => segment === credential.path[index],
                  ) ||
                  credential.path.at(-1) !== key,
              )
              .map(([key, field]) =>
                this.renderConfigField(
                  field,
                  [...provider.configPath, key],
                  values?.[key],
                  unsupported,
                  patch,
                ),
              )
          : nothing
      }
      ${renderSettingsRow({
        title: t("searchPage.pluginSettings"),
        description: t("searchPage.pluginSettingsHint"),
        control: html`<a
          class="btn btn--sm"
          href=${`${pathForRoute("plugin-settings", this.context.basePath)}/${encodeURIComponent(provider.pluginId)}?view=settings`}
          >${t("pluginsPage.detailSettings")}</a
        >`,
      })}
      ${provider.docsUrl ? renderSettingsRow({ title: t("searchPage.docs"), control: renderLearnMoreLink(provider.docsUrl) }) : nothing}
    `;
  }

  private renderAdvanced() {
    const runtime = this.context.runtimeConfig;
    const scope = this.gateway.capture();
    const analysis = analyzeConfigSchema(runtime.state.configSchema);
    const unsupported = new Set(analysis.unsupportedPaths);
    const schema = analysis.schema?.properties?.tools?.properties?.web?.properties?.search;
    const config = currentConfigObject(runtime.state);
    const value = asNullableRecord(asNullableRecord(asNullableRecord(config?.tools)?.web)?.search);
    const fields = Object.entries(schema?.properties ?? {}).filter(
      ([key]) => key !== "enabled" && key !== "provider",
    );
    if (!fields.length) {
      return nothing;
    }
    return html`<details class="settings-section config-advanced-disclosure">
      <summary class="settings-section__heading config-advanced-disclosure__summary">
        ${t("searchPage.advanced")}
      </summary>
      ${renderSettingsGroup(
        fields.map(([key, field]) =>
          this.renderConfigField(
            field,
            ["tools", "web", "search", key],
            value?.[key],
            unsupported,
            (path, nextValue) => this.patch(scope, path, nextValue),
          ),
        ),
      )}
    </details>`;
  }

  override render() {
    if (!this.context) {
      return nothing;
    }
    const result = this.result;
    const scope = this.gateway.capture();
    const statusGeneration = this.generation;
    const configState = this.context.runtimeConfig.state;
    const config = currentConfigObject(configState);
    const search = asNullableRecord(asNullableRecord(asNullableRecord(config?.tools)?.web)?.search);
    const providers = (result?.providers ?? []).toSorted((a, b) => a.label.localeCompare(b.label));
    const configuredProvider = config
      ? typeof search?.provider === "string"
        ? search.provider
        : ""
      : (result?.provider ?? "");
    const selectedProvider = providers.find((provider) => provider.id === this.setupProvider);
    const agents = (this.context.agents.state.agentsList?.agents ?? []).filter(
      (agent) => agent.kind !== "system",
    );
    const disabled = !this.canEdit || this.busy || !configState.configSnapshot;
    const body = renderSettingsWorkspace(
      renderSettingsPage(html`
        ${!this.gateway.connected ? renderSettingsEmpty(t("searchPage.offline")) : nothing}
        ${this.error ? html`<div role="alert" class="callout danger">${this.error}<button class="btn btn--sm" @click=${() => this.load()}>${t("common.retry")}</button></div>` : nothing}
        ${configState.lastError ? html`<div role="alert" class="callout danger">${configState.lastError}<button class="btn btn--sm" @click=${() => this.retryConfig(scope)}>${t("common.retry")}</button></div>` : nothing}
        ${!result && this.loading ? renderSettingsLoadingSkeleton({ rows: 4 }) : nothing}
        ${
          result
            ? html`
                ${renderSettingsSection(
                  {
                    description: t("searchPage.scopeHint"),
                    notice: !this.canEdit
                      ? html`<p class="callout">${t("searchPage.readOnly")}</p>`
                      : nothing,
                  },
                  html`
                    ${renderSettingsToggleRow({
                      title: t("searchPage.enabled"),
                      description: t("searchPage.enabledHint"),
                      checked:
                        typeof search?.enabled === "boolean" ? search.enabled : result.enabled,
                      disabled,
                      onChange: (enabled) => {
                        void this.patch(scope, ["tools", "web", "search", "enabled"], enabled);
                      },
                    })}
                    ${renderSettingsSelectRow({
                      title: t("searchPage.provider"),
                      description: t("searchPage.automaticHint"),
                      value: configuredProvider,
                      options: [
                        { value: "", label: t("searchPage.automatic") },
                        ...providers.map((provider) => ({
                          value: provider.id,
                          label: provider.label,
                        })),
                        ...(configuredProvider &&
                        !providers.some((provider) => provider.id === configuredProvider)
                          ? [{ value: configuredProvider, label: configuredProvider }]
                          : []),
                      ],
                      disabled,
                      onChange: (provider) => {
                        this.setupProvider = provider || this.setupProvider;
                        void this.patch(
                          scope,
                          ["tools", "web", "search", "provider"],
                          provider || undefined,
                        );
                      },
                    })}
                  `,
                )}
                ${renderSettingsSection(
                  { title: t("searchPage.route") },
                  html`
                    ${renderSettingsSelectRow({ title: t("searchPage.agent"), value: this.selectedAgent, options: agents.map((agent) => ({ value: agent.id, label: agent.name || agent.id })), onChange: (agent) => this.context.settingsAgentSelection.set(agent), disabled: !this.gateway.connected })}
                    ${renderSettingsRow({
                      title: t("searchPage.model"),
                      description: result.model.runtimeLabel,
                      control: renderModelPicker({
                        label: t("searchPage.model"),
                        value: this.model,
                        options: [
                          {
                            value: "",
                            label: result.model
                              ? `${t("searchPage.agentDefault")} · ${result.model.provider}/${result.model.id}`
                              : t("searchPage.agentDefault"),
                          },
                          ...this.models.map((model) => ({
                            value: `${model.provider}/${model.id}`,
                            label: model.name || model.id,
                            provider: model.provider,
                          })),
                        ],
                        disabled: !this.gateway.connected,
                        onChange: (model) => {
                          this.model = model;
                          void this.load();
                        },
                      }),
                    })}
                    ${renderSettingsRow({ title: result.route.label, description: result.route.reason, control: renderSettingsStatus({ kind: result.route.kind === "unavailable" ? "warn" : result.route.kind === "disabled" || result.route.kind === "external" ? "muted" : "ok", label: this.loading ? t("searchPage.loading") : t(`searchPage.routeKinds.${result.route.kind}`) }) })}
                  `,
                )}
                ${renderSettingsSection(
                  {
                    title: t("searchPage.health"),
                    description: t("searchPage.untestedHint"),
                    actions: html`<button
                      class="btn btn--sm"
                      ?disabled=${this.loading || this.testing || !this.gateway.connected}
                      @click=${() => this.load()}
                    >
                      ${t("searchPage.refresh")}
                    </button>`,
                  },
                  html`
                    ${renderSettingsRow({ title: t("searchPage.health"), description: this.testResult ? `${this.testResult.provider} · ${t("searchPage.duration", { ms: String(this.testResult.latencyMs) })}${this.testResult.cached ? ` · ${t("searchPage.cached")}` : ""}` : undefined, control: html`<span role="status">${renderSettingsStatus({ kind: this.testError || this.testResult?.status === "error" ? "danger" : this.testResult ? "ok" : "muted", label: this.testing ? t("searchPage.testing") : this.testError || this.testResult?.status === "error" ? t("searchPage.failure") : this.testResult ? t("searchPage.success") : t("searchPage.untested") })}</span>` })}
                    ${
                      result.testProvider || result.route.testable
                        ? html`
                            ${renderSettingsRow({
                              title: t("searchPage.query"),
                              control: html`<input
                                class="settings-input"
                                aria-label=${t("searchPage.query")}
                                maxlength="500"
                                ?disabled=${this.testing}
                                .value=${this.query}
                                placeholder=${t("searchPage.queryPlaceholder")}
                                @input=${(event: Event) => {
                                  if (
                                    event.currentTarget instanceof HTMLInputElement &&
                                    !this.testing
                                  ) {
                                    this.query = event.currentTarget.value;
                                    this.invalidateTest();
                                  }
                                }}
                                @keydown=${(event: KeyboardEvent) => {
                                  if (event.key === "Enter") {
                                    void this.test(scope, statusGeneration);
                                  }
                                }}
                              />`,
                            })}
                            ${renderSettingsRow({ title: t("searchPage.test"), description: !result.testProvider && !result.route.testable ? result.route.reason : undefined, control: html`<button class="btn" ?disabled=${!this.canEdit || !(result.testProvider || result.route.testable) || !this.query.trim() || this.query.trim().length > 500 || this.testing || this.loading || !isSearchConfigSettled(configState) || !this.gateway.connected} @click=${() => this.test(scope, statusGeneration)}>${this.testing ? t("searchPage.testing") : result.testProvider ? t("searchPage.testProvider", { provider: result.testProvider.label }) : t("searchPage.test")}</button>` })}
                          `
                        : nothing
                    }
                    ${
                      result.route.kind === "native" || result.route.kind === "external"
                        ? renderSettingsNavRow({
                            title: t("searchPage.testInChat"),
                            description: t("searchPage.testInChatHint"),
                            onClick: () => {
                              if (
                                scope &&
                                this.gateway.isCurrent(scope) &&
                                statusGeneration === this.generation &&
                                !this.loading
                              ) {
                                this.context.navigate("new-session", {
                                  search: newSessionModelSearch(
                                    result.agentId,
                                    `${result.model.provider}/${result.model.id}`,
                                  ),
                                });
                              }
                            },
                          })
                        : nothing
                    }
                  `,
                )}
                ${renderSearchTestResult(this.testResult, this.testError)}
                ${renderSettingsSection(
                  { title: t("searchPage.setup"), description: t("searchPage.setupHint") },
                  html`
                    ${renderSettingsSelectRow({
                      title: t("searchPage.setupProvider"),
                      description: selectedProvider?.hint,
                      value: this.setupProvider,
                      options: providers.map((provider) => ({
                        value: provider.id,
                        label: provider.label,
                      })),
                      onChange: (provider) => {
                        this.setupProvider = provider;
                      },
                    })}
                    ${selectedProvider ? keyed(selectedProvider.id, this.renderSetup(selectedProvider)) : nothing}
                    ${renderSettingsNavRow({ title: t("searchPage.moreProviders"), description: t("searchPage.moreProvidersHint"), onClick: () => this.context.navigate("plugins") })}
                  `,
                )}
                ${this.renderAdvanced()}
              `
            : nothing
        }
      `),
    );
    return html`${renderSettingsPageHeader({ title: t("tabs.search"), subtitle: t("subtitles.search") })}${body}`;
  }
}
customElements.define("openclaw-search-page", SearchPage);
