// Control UI plugins page: installed inventory, discover shelves, and ClawHub search.
import { html, nothing, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import { repeat } from "lit/directives/repeat.js";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { EXTERNAL_LINK_TARGET, buildExternalLinkRel } from "../../lib/external-link.ts";
import {
  CLAWHUB_BROWSE_URL,
  type PluginCatalogItem,
  type PluginInstallRequest,
  type PluginListResult,
  type PluginSearchResult,
} from "../../lib/plugins/index.ts";
import {
  CONNECTOR_SUGGESTIONS,
  PLUGIN_CATEGORY_ORDER,
  pluginArtPath,
  pluginCategoryLabel,
  pluginFallbackGradient,
  pluginMonogram,
  type ConnectorSuggestion,
} from "./presentation.ts";

export type PluginsTab = "installed" | "discover" | "clawhub";

export type InstalledFilter = "all" | "enabled" | "disabled" | "issues";

export type PluginRowMessage = {
  kind: "success" | "error";
  text: string;
  acknowledge?: { packageName: string; version?: string };
};

export type McpServerSummary = {
  name: string;
  enabled: boolean;
  transport: "stdio" | "http" | "invalid";
  target: string;
  auth: string | null;
};

export type McpServerForm = {
  name: string;
  target: string;
};

export type PluginsViewProps = {
  connected: boolean;
  loading: boolean;
  result: PluginListResult | null;
  error: string | null;
  activeTab: PluginsTab;
  query: string;
  installedFilter: InstalledFilter;
  searchResults: PluginSearchResult[] | null;
  searchLoading: boolean;
  searchError: string | null;
  busy: Readonly<Record<string, boolean>>;
  messages: Readonly<Record<string, PluginRowMessage>>;
  pendingRemoval: Readonly<Record<string, boolean>>;
  canMutate: boolean;
  mutationBlockedReason: string | null;
  pageNotice: PluginRowMessage | null;
  mcpSettingsHref: string;
  mcpServers: McpServerSummary[] | null;
  mcpMessage: PluginRowMessage | null;
  mcpBusy: boolean;
  mcpFormOpen: boolean;
  onTabChange: (tab: PluginsTab) => void;
  onQueryChange: (query: string) => void;
  onFilterChange: (filter: InstalledFilter) => void;
  onRefresh: () => void;
  onSetEnabled: (pluginId: string, enabled: boolean, rowKey: string) => void;
  onInstall: (rowKey: string, request: PluginInstallRequest) => void;
  onRequestUninstall: (rowKey: string) => void;
  onCancelUninstall: (rowKey: string) => void;
  onUninstall: (pluginId: string, rowKey: string) => void;
  onAddConnector: (suggestion: ConnectorSuggestion) => void;
  onSearchClawHub: (query: string) => void;
  onMcpToggle: (name: string, enabled: boolean) => void;
  onMcpRemove: (name: string) => void;
  onMcpFormToggle: (open: boolean) => void;
  onMcpAdd: (form: McpServerForm) => void;
};

const PLUGIN_TABS: readonly PluginsTab[] = ["installed", "discover", "clawhub"];

const INSTALLED_FILTERS: readonly InstalledFilter[] = ["all", "enabled", "disabled", "issues"];

function tabLabel(tab: PluginsTab): string {
  switch (tab) {
    case "installed":
      return t("pluginsPage.installedTab");
    case "discover":
      return t("pluginsPage.discoverTab");
    case "clawhub":
      return t("pluginsPage.clawhubTab");
    default:
      return tab satisfies never;
  }
}

function filterLabel(filter: InstalledFilter): string {
  switch (filter) {
    case "all":
      return t("pluginsPage.filterAll");
    case "enabled":
      return t("pluginsPage.enabled");
    case "disabled":
      return t("pluginsPage.disabled");
    case "issues":
      return t("pluginsPage.filterIssues");
    default:
      return filter satisfies never;
  }
}

function handleTabKeydown(
  event: KeyboardEvent,
  tab: PluginsTab,
  onTabChange: PluginsViewProps["onTabChange"],
) {
  const currentIndex = PLUGIN_TABS.indexOf(tab);
  let nextIndex: number;
  switch (event.key) {
    case "ArrowRight":
      nextIndex = (currentIndex + 1) % PLUGIN_TABS.length;
      break;
    case "ArrowLeft":
      nextIndex = (currentIndex - 1 + PLUGIN_TABS.length) % PLUGIN_TABS.length;
      break;
    case "Home":
      nextIndex = 0;
      break;
    case "End":
      nextIndex = PLUGIN_TABS.length - 1;
      break;
    default:
      return;
  }
  event.preventDefault();
  const nextTab = PLUGIN_TABS[nextIndex];
  if (!nextTab) {
    return;
  }
  onTabChange(nextTab);
  const tablist = (event.currentTarget as HTMLElement).closest('[role="tablist"]');
  tablist?.querySelector<HTMLElement>(`#plugins-tab-${nextTab}`)?.focus();
}

export function pluginRowKey(pluginId: string): string {
  return `plugin:${pluginId}`;
}

export function clawHubRowKey(packageName: string): string {
  return `clawhub:${packageName}`;
}

export function connectorRowKey(connectorId: string): string {
  return `connector:${connectorId}`;
}

function normalizedQuery(query: string): string {
  return query.trim().toLocaleLowerCase();
}

function matchesPlugin(plugin: PluginCatalogItem, query: string): boolean {
  const needle = normalizedQuery(query);
  if (!needle) {
    return true;
  }
  return [
    plugin.name,
    plugin.id,
    plugin.description,
    plugin.origin,
    plugin.category,
    ...(plugin.kind ?? []),
  ].some((value) => value?.toLocaleLowerCase().includes(needle));
}

function matchesConnector(connector: ConnectorSuggestion, query: string): boolean {
  const needle = normalizedQuery(query);
  if (!needle) {
    return true;
  }
  return [connector.id, connector.name, connector.description].some((value) =>
    value.toLocaleLowerCase().includes(needle),
  );
}

function sortCatalogPlugins(plugins: readonly PluginCatalogItem[]): PluginCatalogItem[] {
  return plugins.toSorted(
    (left, right) =>
      (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER) ||
      left.name.localeCompare(right.name),
  );
}

export function installedPlugins(
  plugins: readonly PluginCatalogItem[],
  query = "",
  filter: InstalledFilter = "all",
): PluginCatalogItem[] {
  return sortCatalogPlugins(
    plugins.filter((plugin) => {
      if (!plugin.installed || !matchesPlugin(plugin, query)) {
        return false;
      }
      switch (filter) {
        case "enabled":
          return plugin.enabled && plugin.state !== "error";
        case "disabled":
          return !plugin.enabled && plugin.state !== "error";
        case "issues":
          return plugin.state === "error";
        default:
          return true;
      }
    }),
  );
}

export type InstalledCategoryGroup = {
  category: string;
  label: string;
  plugins: PluginCatalogItem[];
};

export function groupInstalledByCategory(
  plugins: readonly PluginCatalogItem[],
): InstalledCategoryGroup[] {
  const groups = new Map<string, PluginCatalogItem[]>();
  for (const plugin of plugins) {
    const category = plugin.category ?? "other";
    const group = groups.get(category) ?? [];
    group.push(plugin);
    groups.set(category, group);
  }
  const rank = (category: string) => {
    const index = PLUGIN_CATEGORY_ORDER.indexOf(category);
    return index === -1 ? PLUGIN_CATEGORY_ORDER.length : index;
  };
  return [...groups.entries()]
    .map(([category, entries]) => ({
      category,
      label: pluginCategoryLabel(category),
      plugins: entries,
    }))
    .toSorted((left, right) => rank(left.category) - rank(right.category));
}

export type DiscoverShelves = {
  featured: PluginCatalogItem[];
  official: PluginCatalogItem[];
  connectors: ConnectorSuggestion[];
};

export function discoverShelves(
  plugins: readonly PluginCatalogItem[],
  query = "",
): DiscoverShelves {
  const featured = sortCatalogPlugins(
    plugins.filter((plugin) => plugin.featured && matchesPlugin(plugin, query)),
  );
  const featuredIds = new Set(featured.map((plugin) => plugin.id));
  const official = sortCatalogPlugins(
    plugins.filter(
      (plugin) =>
        !featuredIds.has(plugin.id) &&
        plugin.origin === "official" &&
        !plugin.installed &&
        matchesPlugin(plugin, query),
    ),
  );
  const connectors = CONNECTOR_SUGGESTIONS.filter((connector) =>
    matchesConnector(connector, query),
  );
  return { featured, official, connectors };
}

const compactNumber = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});

function renderArtTile(slug: string, name: string, variant: "tile" | "cover"): TemplateResult {
  const art = pluginArtPath(slug);
  if (art) {
    return html`<span class="plugins-${variant}">
      <img src=${art} alt="" loading="lazy" decoding="async" />
    </span>`;
  }
  const [from, to] = pluginFallbackGradient(slug);
  const monogram = pluginMonogram(name);
  return html`<span
    class="plugins-${variant} plugins-${variant}--fallback"
    style=${`--plugins-art-a:${from};--plugins-art-b:${to}`}
    aria-hidden="true"
  >
    ${monogram ? html`<span>${monogram}</span>` : icons.puzzle}
  </span>`;
}

function stateLabel(plugin: PluginCatalogItem): string {
  switch (plugin.state) {
    case "enabled":
      return t("pluginsPage.enabled");
    case "disabled":
      return t("pluginsPage.disabled");
    case "error":
      return t("pluginsPage.needsAttention");
    case "not-installed":
      return t("pluginsPage.available");
    default:
      return plugin.state satisfies never;
  }
}

function originLabel(origin: string): string {
  switch (origin) {
    case "bundled":
      return t("pluginsPage.included");
    case "global":
      return t("pluginsPage.global");
    case "workspace":
      return t("pluginsPage.workspace");
    case "config":
      return t("pluginsPage.config");
    case "official":
      return t("pluginsPage.official");
    default:
      return origin;
  }
}

function renderRowMessage(
  key: string,
  message: PluginRowMessage | undefined,
  busy: boolean,
  props: PluginsViewProps,
) {
  if (!message) {
    return nothing;
  }
  const role = message.kind === "error" ? "alert" : "status";
  return html`
    <div class="plugins-row-message plugins-row-message--${message.kind}" role=${role}>
      <span>${message.text}</span>
      ${message.acknowledge
        ? html`
            <button
              type="button"
              class="btn btn--sm"
              title=${props.mutationBlockedReason ?? ""}
              ?disabled=${busy || !props.canMutate}
              @click=${() =>
                props.onInstall(key, {
                  source: "clawhub",
                  packageName: message.acknowledge?.packageName ?? "",
                  ...(message.acknowledge?.version ? { version: message.acknowledge.version } : {}),
                  acknowledgeClawHubRisk: true,
                })}
            >
              ${busy ? t("pluginsPage.installing") : t("pluginsPage.acknowledgeRisk")}
            </button>
          `
        : nothing}
    </div>
  `;
}

function renderInstalledSwitch(
  plugin: PluginCatalogItem,
  props: PluginsViewProps,
  busy: boolean,
  rowKey = pluginRowKey(plugin.id),
) {
  const blocked = !props.canMutate || busy;
  return html`
    <label class="plugins-switch" title=${props.mutationBlockedReason ?? ""}>
      <span class="plugins-switch__label">
        ${plugin.enabled ? t("pluginsPage.enabled") : t("pluginsPage.disabled")}
      </span>
      <input
        type="checkbox"
        role="switch"
        aria-label=${t(plugin.enabled ? "pluginsPage.disableNamed" : "pluginsPage.enableNamed", {
          name: plugin.name,
        })}
        .checked=${live(plugin.enabled)}
        ?disabled=${blocked}
        @change=${(event: Event) =>
          props.onSetEnabled(plugin.id, (event.currentTarget as HTMLInputElement).checked, rowKey)}
      />
      <span class="plugins-switch__track" aria-hidden="true"></span>
    </label>
  `;
}

function renderUninstallControls(
  plugin: PluginCatalogItem,
  props: PluginsViewProps,
  busy: boolean,
  rowKey: string,
) {
  if (!plugin.removable) {
    return nothing;
  }
  if (props.pendingRemoval[rowKey]) {
    return html`
      <span
        class="plugins-remove-confirm"
        role="alertdialog"
        aria-label=${t("pluginsPage.removeNamed", { name: plugin.name })}
      >
        <span>${t("pluginsPage.removeConfirm")}</span>
        <button
          type="button"
          class="btn btn--sm danger"
          ?disabled=${busy || !props.canMutate}
          @click=${() => props.onUninstall(plugin.id, rowKey)}
        >
          ${busy ? t("pluginsPage.removing") : t("pluginsPage.remove")}
        </button>
        <button
          type="button"
          class="btn btn--sm"
          ?disabled=${busy}
          @click=${() => props.onCancelUninstall(rowKey)}
        >
          ${t("pluginsPage.cancel")}
        </button>
      </span>
    `;
  }
  return html`
    <button
      type="button"
      class="btn btn--sm btn--icon plugins-remove"
      title=${props.mutationBlockedReason ?? t("pluginsPage.removeNamed", { name: plugin.name })}
      aria-label=${t("pluginsPage.removeNamed", { name: plugin.name })}
      ?disabled=${!props.canMutate || busy}
      @click=${() => props.onRequestUninstall(rowKey)}
    >
      ${icons.trash}
    </button>
  `;
}

function renderInstallButton(
  props: PluginsViewProps,
  busy: boolean,
  key: string,
  name: string,
  request: PluginInstallRequest,
) {
  return html`
    <button
      type="button"
      class="btn btn--sm primary plugins-install"
      title=${props.mutationBlockedReason ?? ""}
      aria-label=${t("pluginsPage.installNamed", { name })}
      ?disabled=${!props.canMutate || busy}
      @click=${() => props.onInstall(key, request)}
    >
      ${busy ? t("pluginsPage.installing") : t("pluginsPage.install")}
    </button>
  `;
}

/* ---------------------------------- installed tab ---------------------------------- */

function renderOverview(props: PluginsViewProps) {
  const plugins = props.result?.plugins ?? [];
  const installed = plugins.filter((plugin) => plugin.installed);
  const enabled = installed.filter((plugin) => plugin.enabled && plugin.state !== "error");
  const issues = installed.filter((plugin) => plugin.state === "error");
  const stats: Array<{ label: string; value: number; tone?: string }> = [
    { label: t("pluginsPage.statInstalled"), value: installed.length },
    { label: t("pluginsPage.statEnabled"), value: enabled.length, tone: "ok" },
    {
      label: t("pluginsPage.statIssues"),
      value: issues.length,
      tone: issues.length ? "danger" : undefined,
    },
    { label: t("pluginsPage.statMcpServers"), value: props.mcpServers?.length ?? 0 },
  ];
  return html`
    <div class="plugins-overview">
      ${stats.map(
        (stat) => html`
          <div class="plugins-overview__stat plugins-overview__stat--${stat.tone ?? "default"}">
            <span class="plugins-overview__value">${stat.value}</span>
            <span class="plugins-overview__label">${stat.label}</span>
          </div>
        `,
      )}
    </div>
  `;
}

function renderInstalledRow(plugin: PluginCatalogItem, props: PluginsViewProps): TemplateResult {
  const key = pluginRowKey(plugin.id);
  const busy = props.busy[key];
  return html`
    <article
      class="plugins-row plugins-row--${plugin.state}"
      data-plugin-id=${plugin.id}
      data-plugin-source=${plugin.origin ?? "unknown"}
      data-plugin-status=${plugin.state}
      aria-busy=${busy ? "true" : "false"}
    >
      ${renderArtTile(plugin.id, plugin.name, "tile")}
      <div class="plugins-row__copy">
        <div class="plugins-row__title">
          <h3>${plugin.name}</h3>
          ${plugin.version
            ? html`<span class="plugins-version">v${plugin.version}</span>`
            : nothing}
          ${plugin.state === "error"
            ? html`<span class="plugins-state plugins-state--error">${stateLabel(plugin)}</span>`
            : nothing}
        </div>
        <p>${plugin.description || t("pluginsPage.optionalCapability")}</p>
        <div class="plugins-row__meta">
          ${plugin.origin ? html`<span>${originLabel(plugin.origin)}</span>` : nothing}
          ${plugin.packageName
            ? html`<span class="plugins-row__package">${plugin.packageName}</span>`
            : nothing}
        </div>
      </div>
      <div class="plugins-row__actions">
        ${renderUninstallControls(plugin, props, busy, key)}
        ${renderInstalledSwitch(plugin, props, busy)}
      </div>
      ${plugin.error
        ? html`<div class="plugins-row-message plugins-row-message--error" role="alert">
            ${plugin.error}
          </div>`
        : nothing}
      ${renderRowMessage(key, props.messages[key], busy, props)}
    </article>
  `;
}

function renderMcpSection(props: PluginsViewProps) {
  const needle = normalizedQuery(props.query);
  const servers = props.mcpServers?.filter(
    (server) =>
      !needle ||
      server.name.toLocaleLowerCase().includes(needle) ||
      server.target.toLocaleLowerCase().includes(needle),
  );
  if (needle && servers && servers.length === 0) {
    return nothing;
  }
  return html`
    <section class="plugins-group" aria-labelledby="plugins-group-mcp">
      <div class="plugins-group__heading">
        <h2 id="plugins-group-mcp">${t("pluginsPage.mcpServersGroup")}</h2>
        ${servers ? html`<span>${servers.length}</span>` : nothing}
        <div class="plugins-group__actions">
          <a class="plugins-group__link" href=${props.mcpSettingsHref}
            >${t("pluginsPage.mcpSettingsLink")}</a
          >
          <button
            type="button"
            class="btn btn--sm"
            title=${props.mutationBlockedReason ?? ""}
            ?disabled=${!props.canMutate || props.mcpBusy}
            @click=${() => props.onMcpFormToggle(!props.mcpFormOpen)}
          >
            <span aria-hidden="true">${icons.plus}</span>
            ${t("pluginsPage.mcpAdd")}
          </button>
        </div>
      </div>
      <p class="plugins-group__hint">${t("pluginsPage.mcpHint")}</p>
      ${props.mcpFormOpen ? renderMcpForm(props) : nothing}
      ${props.mcpMessage
        ? html`<div
            class="plugins-row-message plugins-row-message--${props.mcpMessage.kind}"
            role=${props.mcpMessage.kind === "error" ? "alert" : "status"}
          >
            <span>${props.mcpMessage.text}</span>
          </div>`
        : nothing}
      ${!servers
        ? html`<div class="plugins-search-state" role="status">${t("pluginsPage.loading")}</div>`
        : servers.length === 0
          ? html`<div class="plugins-mcp-empty">${t("pluginsPage.mcpEmpty")}</div>`
          : html`<div class="plugins-rows">
              ${repeat(
                servers,
                (server) => server.name,
                (server) => renderMcpRow(server, props),
              )}
            </div>`}
    </section>
  `;
}

function renderMcpRow(server: McpServerSummary, props: PluginsViewProps): TemplateResult {
  return html`
    <article class="plugins-row plugins-row--mcp" data-mcp-name=${server.name}>
      ${renderArtTile(server.name, server.name, "tile")}
      <div class="plugins-row__copy">
        <div class="plugins-row__title">
          <h3>${server.name}</h3>
          <span class="plugins-badge plugins-badge--mcp">MCP</span>
          ${server.auth === "oauth" ? html`<span class="plugins-badge">OAuth</span>` : nothing}
        </div>
        <p class="plugins-row__target">${server.target}</p>
        <div class="plugins-row__meta"><span>${server.transport}</span></div>
      </div>
      <div class="plugins-row__actions">
        <button
          type="button"
          class="btn btn--sm btn--icon plugins-remove"
          title=${props.mutationBlockedReason ??
          t("pluginsPage.removeNamed", { name: server.name })}
          aria-label=${t("pluginsPage.removeNamed", { name: server.name })}
          ?disabled=${!props.canMutate || props.mcpBusy}
          @click=${() => props.onMcpRemove(server.name)}
        >
          ${icons.trash}
        </button>
        <label class="plugins-switch" title=${props.mutationBlockedReason ?? ""}>
          <span class="plugins-switch__label">
            ${server.enabled ? t("pluginsPage.enabled") : t("pluginsPage.disabled")}
          </span>
          <input
            type="checkbox"
            role="switch"
            aria-label=${t(
              server.enabled ? "pluginsPage.disableNamed" : "pluginsPage.enableNamed",
              {
                name: server.name,
              },
            )}
            .checked=${live(server.enabled)}
            ?disabled=${!props.canMutate || props.mcpBusy}
            @change=${(event: Event) =>
              props.onMcpToggle(server.name, (event.currentTarget as HTMLInputElement).checked)}
          />
          <span class="plugins-switch__track" aria-hidden="true"></span>
        </label>
      </div>
    </article>
  `;
}

function renderMcpForm(props: PluginsViewProps) {
  const submit = (event: Event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    props.onMcpAdd({
      name: String(data.get("mcp-name") ?? "").trim(),
      target: String(data.get("mcp-target") ?? "").trim(),
    });
  };
  return html`
    <form class="plugins-mcp-form" @submit=${submit}>
      <label>
        <span>${t("pluginsPage.mcpNameLabel")}</span>
        <input name="mcp-name" type="text" required placeholder="context7" autocomplete="off" />
      </label>
      <label class="plugins-mcp-form__target">
        <span>${t("pluginsPage.mcpTargetLabel")}</span>
        <input
          name="mcp-target"
          type="text"
          required
          placeholder="https://mcp.example.com/mcp  ·  npx some-mcp-server"
          autocomplete="off"
        />
      </label>
      <div class="plugins-mcp-form__actions">
        <button type="submit" class="btn btn--sm primary" ?disabled=${props.mcpBusy}>
          ${props.mcpBusy ? t("pluginsPage.mcpAdding") : t("pluginsPage.mcpAdd")}
        </button>
        <button type="button" class="btn btn--sm" @click=${() => props.onMcpFormToggle(false)}>
          ${t("pluginsPage.cancel")}
        </button>
      </div>
    </form>
  `;
}

function renderInstalled(props: PluginsViewProps) {
  const plugins = installedPlugins(props.result?.plugins ?? [], props.query, props.installedFilter);
  const groups = groupInstalledByCategory(plugins);
  return html`
    ${renderOverview(props)}
    <div class="plugins-filters" role="group" aria-label=${t("pluginsPage.filterLabel")}>
      ${INSTALLED_FILTERS.map(
        (filter) => html`
          <button
            type="button"
            class=${props.installedFilter === filter ? "active" : ""}
            @click=${() => props.onFilterChange(filter)}
          >
            ${filterLabel(filter)}
          </button>
        `,
      )}
    </div>
    ${groups.length === 0
      ? renderEmpty(
          props.query || props.installedFilter !== "all"
            ? t("pluginsPage.noInstalledMatchTitle")
            : t("pluginsPage.noInstalledTitle"),
          props.query || props.installedFilter !== "all"
            ? t("pluginsPage.noMatchBody")
            : t("pluginsPage.noInstalledBody"),
        )
      : html`
          <div class="plugins-groups">
            ${groups.map(
              (group) => html`
                <section class="plugins-group" aria-labelledby=${`plugins-group-${group.category}`}>
                  <div class="plugins-group__heading">
                    <h2 id=${`plugins-group-${group.category}`}>${group.label}</h2>
                    <span>${group.plugins.length}</span>
                  </div>
                  <div class="plugins-rows">
                    ${repeat(
                      group.plugins,
                      (plugin) => plugin.id,
                      (plugin) => renderInstalledRow(plugin, props),
                    )}
                  </div>
                </section>
              `,
            )}
          </div>
        `}
    ${renderMcpSection(props)}
  `;
}

/* ---------------------------------- discover tab ---------------------------------- */

function renderCatalogCard(plugin: PluginCatalogItem, props: PluginsViewProps): TemplateResult {
  const key = pluginRowKey(plugin.id);
  const busy = props.busy[key];
  const install = plugin.install;
  return html`
    <article
      class="plugins-card"
      data-plugin-id=${plugin.id}
      data-plugin-source=${plugin.origin ?? "unknown"}
      data-plugin-status=${plugin.state}
      aria-busy=${busy ? "true" : "false"}
    >
      ${renderArtTile(plugin.id, plugin.name, "cover")}
      <div class="plugins-card__body">
        <div class="plugins-card__title-row">
          <h3>${plugin.name}</h3>
          ${plugin.version
            ? html`<span class="plugins-version">v${plugin.version}</span>`
            : nothing}
        </div>
        <p>${plugin.description || t("pluginsPage.optionalCapability")}</p>
        <div class="plugins-card__meta">
          <span class="plugins-state plugins-state--${plugin.state}">${stateLabel(plugin)}</span>
          ${plugin.origin ? html`<span>${originLabel(plugin.origin)}</span>` : nothing}
        </div>
      </div>
      <div class="plugins-card__footer">
        ${plugin.installed
          ? renderInstalledSwitch(plugin, props, busy)
          : install
            ? renderInstallButton(props, busy, key, plugin.name, install)
            : html`<span class="plugins-action-note">${t("pluginsPage.unavailable")}</span>`}
      </div>
      ${plugin.error
        ? html`<div class="plugins-row-message plugins-row-message--error" role="alert">
            ${plugin.error}
          </div>`
        : nothing}
      ${renderRowMessage(key, props.messages[key], busy, props)}
    </article>
  `;
}

function renderConnectorCard(
  connector: ConnectorSuggestion,
  props: PluginsViewProps,
): TemplateResult {
  const key = connectorRowKey(connector.id);
  const busy = props.busy[key];
  const isMcp = connector.action.kind === "mcp";
  const installed =
    isMcp &&
    Boolean(
      props.mcpServers?.some(
        (server) =>
          connector.action.kind === "mcp" && server.name === connector.action.mcp.serverName,
      ),
    );
  return html`
    <article
      class="plugins-card plugins-card--connector"
      data-connector-id=${connector.id}
      aria-busy=${busy ? "true" : "false"}
    >
      ${renderArtTile(connector.id, connector.name, "cover")}
      <div class="plugins-card__body">
        <div class="plugins-card__title-row">
          <h3>${connector.name}</h3>
        </div>
        <p>${connector.description}</p>
        <div class="plugins-card__meta">
          ${isMcp
            ? html`<span class="plugins-badge plugins-badge--mcp">MCP</span>
                <span>${t("pluginsPage.connectorMcpNote")}</span>`
            : html`<span>${t("pluginsPage.connectorClawHubNote")}</span>`}
        </div>
      </div>
      <div class="plugins-card__footer">
        ${isMcp
          ? installed
            ? html`<span class="plugins-action-note plugins-action-note--ok">
                <span aria-hidden="true">${icons.check}</span> ${t("pluginsPage.connectorAdded")}
              </span>`
            : html`
                <button
                  type="button"
                  class="btn btn--sm primary"
                  title=${props.mutationBlockedReason ?? ""}
                  ?disabled=${!props.canMutate || busy}
                  @click=${() => props.onAddConnector(connector)}
                >
                  ${busy ? t("pluginsPage.mcpAdding") : t("pluginsPage.connectorAdd")}
                </button>
              `
          : html`
              <button
                type="button"
                class="btn btn--sm"
                @click=${() =>
                  connector.action.kind === "clawhub" &&
                  props.onSearchClawHub(connector.action.query)}
              >
                <span aria-hidden="true">${icons.search}</span>
                ${t("pluginsPage.connectorSearch")}
              </button>
            `}
      </div>
      ${renderRowMessage(key, props.messages[key], busy, props)}
    </article>
  `;
}

function renderShelf(
  id: string,
  label: string,
  hint: string | null,
  cards: readonly TemplateResult[],
) {
  if (cards.length === 0) {
    return nothing;
  }
  return html`
    <section class="plugins-group" aria-labelledby=${`plugins-shelf-${id}`}>
      <div class="plugins-group__heading">
        <h2 id=${`plugins-shelf-${id}`}>${label}</h2>
        <span>${cards.length}</span>
      </div>
      ${hint ? html`<p class="plugins-group__hint">${hint}</p>` : nothing}
      <div class="plugins-grid ${id === "featured" ? "plugins-grid--featured" : ""}">${cards}</div>
    </section>
  `;
}

function renderDiscover(props: PluginsViewProps) {
  const shelves = discoverShelves(props.result?.plugins ?? [], props.query);
  const featuredCards = shelves.featured.map((plugin) => renderCatalogCard(plugin, props));
  const officialCards = shelves.official.map((plugin) => renderCatalogCard(plugin, props));
  const connectorCards = shelves.connectors.map((connector) =>
    renderConnectorCard(connector, props),
  );
  if (!featuredCards.length && !officialCards.length && !connectorCards.length) {
    return renderEmpty(t("pluginsPage.noDiscoverMatchTitle"), t("pluginsPage.noMatchBody"));
  }
  return html`
    <div class="plugins-groups">
      ${renderShelf("featured", t("pluginsPage.featuredGroup"), null, featuredCards)}
      ${renderShelf("official", t("pluginsPage.officialGroup"), null, officialCards)}
      ${renderShelf(
        "connectors",
        t("pluginsPage.connectorsGroup"),
        t("pluginsPage.connectorsHint"),
        connectorCards,
      )}
    </div>
  `;
}

/* ---------------------------------- clawhub tab ---------------------------------- */

function findInstalledSearchPlugin(
  item: PluginSearchResult,
  plugins: readonly PluginCatalogItem[],
): PluginCatalogItem | undefined {
  return plugins.find(
    (plugin) =>
      plugin.installed &&
      (plugin.id === item.package.runtimeId ||
        plugin.packageName === item.package.name ||
        (plugin.install?.source === "clawhub" && plugin.install.packageName === item.package.name)),
  );
}

function verificationLabel(tier: string): string {
  return tier === "source-linked" ? t("pluginsPage.verifiedSource") : tier;
}

function renderClawHubResult(item: PluginSearchResult, props: PluginsViewProps): TemplateResult {
  const pkg = item.package;
  const installed = findInstalledSearchPlugin(item, props.result?.plugins ?? []);
  const key = clawHubRowKey(pkg.name);
  const busy = props.busy[key];
  const artSlug = pkg.runtimeId ?? pkg.name;
  return html`
    <article
      class="plugins-row plugins-row--clawhub"
      data-package-name=${pkg.name}
      data-plugin-source="clawhub"
      data-plugin-status=${installed?.state ?? "not-installed"}
      aria-busy=${busy ? "true" : "false"}
    >
      ${renderArtTile(artSlug, pkg.displayName, "tile")}
      <div class="plugins-row__copy">
        <div class="plugins-row__title">
          <h3>${pkg.displayName}</h3>
          ${pkg.latestVersion
            ? html`<span class="plugins-version">v${pkg.latestVersion}</span>`
            : nothing}
        </div>
        <p>${pkg.summary || pkg.name}</p>
        <div class="plugins-row__meta">
          ${pkg.isOfficial
            ? html`<span class="plugins-badge">${t("pluginsPage.official")}</span>`
            : nothing}
          ${pkg.verificationTier
            ? html`<span class="plugins-badge plugins-badge--verified">
                <span aria-hidden="true">${icons.check}</span>
                ${verificationLabel(pkg.verificationTier)}
              </span>`
            : nothing}
          ${typeof pkg.downloads === "number"
            ? html`<span class="plugins-downloads">
                <span aria-hidden="true">${icons.download}</span>
                ${compactNumber.format(pkg.downloads)}
              </span>`
            : nothing}
          <span
            >${pkg.family === "bundle-plugin"
              ? t("pluginsPage.bundlePlugin")
              : t("pluginsPage.codePlugin")}</span
          >
        </div>
      </div>
      <div class="plugins-row__actions">
        ${installed
          ? renderInstalledSwitch(installed, props, busy, key)
          : renderInstallButton(props, busy, key, pkg.displayName, {
              source: "clawhub",
              packageName: pkg.name,
            })}
      </div>
      ${renderRowMessage(key, props.messages[key], busy, props)}
    </article>
  `;
}

function renderEmpty(title: string, body: string) {
  return html`
    <div class="plugins-empty">
      <span class="plugins-empty__icon" aria-hidden="true">${icons.puzzle}</span>
      <h2>${title}</h2>
      <p>${body}</p>
    </div>
  `;
}

function renderClawHub(props: PluginsViewProps) {
  const query = props.query.trim();
  if (query.length < 2) {
    return renderEmpty(t("pluginsPage.searchClawHubTitle"), t("pluginsPage.searchClawHubBody"));
  }
  if (props.searchLoading) {
    return html`<div class="plugins-search-state" role="status">
      ${t("pluginsPage.searching")}
    </div>`;
  }
  if (props.searchError) {
    return html`<div class="plugins-search-state plugins-search-state--error" role="alert">
      ${props.searchError}
    </div>`;
  }
  if (!props.searchResults) {
    return html`<div class="plugins-search-state" role="status">
      ${t("pluginsPage.preparingSearch")}
    </div>`;
  }
  if (props.searchResults.length === 0) {
    return renderEmpty(
      t("pluginsPage.noClawHubResultsTitle"),
      t("pluginsPage.noClawHubResultsBody", { query }),
    );
  }
  return html`
    <div class="plugins-rows">
      ${repeat(
        props.searchResults,
        (item) => item.package.name,
        (item) => renderClawHubResult(item, props),
      )}
    </div>
  `;
}

function renderActivePanel(props: PluginsViewProps) {
  switch (props.activeTab) {
    case "installed":
      return renderInstalled(props);
    case "discover":
      return renderDiscover(props);
    case "clawhub":
      return renderClawHub(props);
    default:
      return props.activeTab satisfies never;
  }
}

export function renderPlugins(props: PluginsViewProps) {
  const installedCount = props.result?.plugins.filter((plugin) => plugin.installed).length ?? 0;
  const canShowCatalog = Boolean(props.result);
  return html`
    <section class="plugins-workspace" aria-label=${t("tabs.plugins")}>
      <div class="plugins-toolbar">
        <label class="plugins-search" for="plugins-global-search">
          <span class="plugins-search__label">${t("pluginsPage.searchLabel")}</span>
          <span class="plugins-search__icon" aria-hidden="true">${icons.search}</span>
          <input
            id="plugins-global-search"
            name="plugins-search"
            type="search"
            autocomplete="off"
            .value=${live(props.query)}
            placeholder=${props.activeTab === "clawhub"
              ? t("pluginsPage.clawhubSearchPlaceholder")
              : t("pluginsPage.searchPlaceholder")}
            @input=${(event: Event) =>
              props.onQueryChange((event.currentTarget as HTMLInputElement).value)}
          />
        </label>
        <div class="plugins-toolbar__actions">
          <a
            class="btn btn--sm plugins-clawhub-link"
            href=${CLAWHUB_BROWSE_URL}
            target=${EXTERNAL_LINK_TARGET}
            rel=${buildExternalLinkRel()}
          >
            ${t("pluginsPage.browseClawHub")}
            <span aria-hidden="true">${icons.externalLink}</span>
          </a>
          <button
            type="button"
            class="btn btn--sm plugins-refresh"
            ?disabled=${props.loading || !props.connected}
            @click=${props.onRefresh}
          >
            <span aria-hidden="true">${icons.refresh}</span>
            ${t("pluginsPage.refresh")}
          </button>
        </div>
      </div>

      ${props.mutationBlockedReason
        ? html`<div class="plugins-readonly" role="note">
            <span aria-hidden="true">${icons.alertTriangle}</span>
            <span>${props.mutationBlockedReason}</span>
          </div>`
        : nothing}

      <div class="plugins-tabs" role="tablist" aria-label=${t("pluginsPage.tablistLabel")}>
        ${PLUGIN_TABS.map((tab) => {
          const selected = props.activeTab === tab;
          const count = tab === "installed" ? installedCount : null;
          return html`
            <button
              id=${`plugins-tab-${tab}`}
              type="button"
              role="tab"
              aria-selected=${selected ? "true" : "false"}
              aria-controls="plugins-tabpanel"
              .tabIndex=${selected ? 0 : -1}
              class=${selected ? "active" : ""}
              @click=${() => props.onTabChange(tab)}
              @keydown=${(event: KeyboardEvent) => handleTabKeydown(event, tab, props.onTabChange)}
            >
              ${tabLabel(tab)} ${count === null ? nothing : html`<span>${count}</span>`}
            </button>
          `;
        })}
      </div>

      ${props.error
        ? html`<div class="plugins-page-error" role="alert">
            <span>${props.error}</span>
            <button type="button" class="btn btn--sm" @click=${props.onRefresh}>
              ${t("pluginsPage.tryAgain")}
            </button>
          </div>`
        : nothing}
      ${props.pageNotice
        ? html`<div
            class="plugins-row-message plugins-row-message--${props.pageNotice
              .kind} plugins-page-notice"
            role=${props.pageNotice.kind === "error" ? "alert" : "status"}
          >
            <span>${props.pageNotice.text}</span>
          </div>`
        : nothing}

      <div
        id="plugins-tabpanel"
        class="plugins-panel"
        role="tabpanel"
        aria-labelledby=${`plugins-tab-${props.activeTab}`}
      >
        ${props.loading && !canShowCatalog
          ? html`<div class="plugins-search-state" role="status">${t("pluginsPage.loading")}</div>`
          : props.error && !canShowCatalog
            ? nothing
            : !props.connected && !canShowCatalog
              ? renderEmpty(t("pluginsPage.offlineTitle"), t("pluginsPage.offlineBody"))
              : renderActivePanel(props)}
      </div>
    </section>
  `;
}
