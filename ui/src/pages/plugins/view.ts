// Control UI page renders the plugin catalog and ClawHub discovery surface.
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

export type PluginsTab = "recommended" | "installed" | "clawhub";

export type PluginRowMessage = {
  kind: "success" | "error";
  text: string;
  acknowledge?: { packageName: string; version?: string };
};

export type PluginsViewProps = {
  connected: boolean;
  loading: boolean;
  result: PluginListResult | null;
  error: string | null;
  activeTab: PluginsTab;
  query: string;
  searchResults: PluginSearchResult[] | null;
  searchLoading: boolean;
  searchError: string | null;
  busy: Readonly<Record<string, boolean>>;
  messages: Readonly<Record<string, PluginRowMessage>>;
  canMutate: boolean;
  mutationBlockedReason: string | null;
  onTabChange: (tab: PluginsTab) => void;
  onQueryChange: (query: string) => void;
  onRefresh: () => void;
  onSetEnabled: (pluginId: string, enabled: boolean, rowKey: string) => void;
  onInstall: (rowKey: string, request: PluginInstallRequest) => void;
};

export type PluginCatalogGroup = {
  id: string;
  label: string;
  plugins: PluginCatalogItem[];
};

const PLUGIN_TABS: readonly PluginsTab[] = ["recommended", "installed", "clawhub"];

function tabLabel(tab: PluginsTab): string {
  switch (tab) {
    case "recommended":
      return t("pluginsPage.recommendedTab");
    case "installed":
      return t("pluginsPage.installedTab");
    case "clawhub":
      return t("pluginsPage.clawhubTab");
    default:
      return tab satisfies never;
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

function normalizedQuery(query: string): string {
  return query.trim().toLocaleLowerCase();
}

function matchesPlugin(plugin: PluginCatalogItem, query: string): boolean {
  const needle = normalizedQuery(query);
  if (!needle) {
    return true;
  }
  return [plugin.name, plugin.id, plugin.description, plugin.origin, ...(plugin.kind ?? [])].some(
    (value) => value?.toLocaleLowerCase().includes(needle),
  );
}

function sortCatalogPlugins(plugins: readonly PluginCatalogItem[]): PluginCatalogItem[] {
  return plugins.toSorted(
    (left, right) =>
      (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER) ||
      left.name.localeCompare(right.name),
  );
}

function humanizeKind(kind: string | undefined): string {
  if (!kind || kind === "featured") {
    return t("pluginsPage.featuredGroup");
  }
  return kind
    .split(/[-_]/u)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toLocaleUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export function groupRecommendedPlugins(
  plugins: readonly PluginCatalogItem[],
  query = "",
): PluginCatalogGroup[] {
  const groups = new Map<string, PluginCatalogItem[]>();
  for (const plugin of plugins) {
    if (!plugin.featured || !matchesPlugin(plugin, query)) {
      continue;
    }
    const shelf =
      plugin.origin === "bundled"
        ? "included"
        : plugin.origin === "official"
          ? "official"
          : "featured";
    const group = groups.get(shelf) ?? [];
    group.push(plugin);
    groups.set(shelf, group);
  }
  return [...groups.entries()]
    .map(([id, entries]) => ({
      id,
      label:
        id === "included"
          ? t("pluginsPage.includedGroup")
          : id === "official"
            ? t("pluginsPage.officialGroup")
            : t("pluginsPage.featuredGroup"),
      plugins: sortCatalogPlugins(entries),
    }))
    .toSorted(
      (left, right) =>
        ["included", "official", "featured"].indexOf(left.id) -
        ["included", "official", "featured"].indexOf(right.id),
    );
}

export function installedPlugins(
  plugins: readonly PluginCatalogItem[],
  query = "",
): PluginCatalogItem[] {
  return sortCatalogPlugins(
    plugins.filter((plugin) => plugin.installed && matchesPlugin(plugin, query)),
  );
}

function pluginMonogram(name: string): string {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  if (words.length === 0) {
    return "";
  }
  const initials = words.length === 1 ? words[0].slice(0, 2) : `${words[0][0]}${words[1][0]}`;
  return initials.toLocaleUpperCase();
}

function renderPluginTile(name: string) {
  const monogram = pluginMonogram(name);
  return html`
    <span class="plugins-tile" aria-hidden="true">
      ${monogram ? html`<span>${monogram}</span>` : icons.puzzle}
    </span>
  `;
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
      return humanizeKind(origin);
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

function renderCatalogAction(plugin: PluginCatalogItem, props: PluginsViewProps, busy: boolean) {
  if (plugin.installed) {
    return renderInstalledSwitch(plugin, props, busy);
  }
  const install = plugin.install;
  if (!install) {
    return html`<span class="plugins-action-note">${t("pluginsPage.unavailable")}</span>`;
  }
  return html`
    <button
      type="button"
      class="btn btn--sm plugins-install"
      title=${props.mutationBlockedReason ?? ""}
      aria-label=${t("pluginsPage.installNamed", { name: plugin.name })}
      ?disabled=${!props.canMutate || busy}
      @click=${() => props.onInstall(pluginRowKey(plugin.id), install)}
    >
      ${busy ? t("pluginsPage.installing") : t("pluginsPage.install")}
    </button>
  `;
}

type PluginHeadingLevel = 2 | 3;

function renderPluginHeading(name: string, level: PluginHeadingLevel) {
  return level === 2 ? html`<h2>${name}</h2>` : html`<h3>${name}</h3>`;
}

function renderCatalogPlugin(
  plugin: PluginCatalogItem,
  props: PluginsViewProps,
  headingLevel: PluginHeadingLevel,
): TemplateResult {
  const key = pluginRowKey(plugin.id);
  const busy = props.busy[key];
  return html`
    <article
      class="plugins-card plugins-card--${plugin.state}"
      data-plugin-id=${plugin.id}
      data-plugin-source=${plugin.origin ?? "unknown"}
      data-plugin-status=${plugin.state}
      aria-busy=${busy ? "true" : "false"}
    >
      <div class="plugins-card__main">
        ${renderPluginTile(plugin.name)}
        <div class="plugins-card__copy">
          <div class="plugins-card__title-row">
            ${renderPluginHeading(plugin.name, headingLevel)}
            ${plugin.version
              ? html`<span class="plugins-version">v${plugin.version}</span>`
              : nothing}
          </div>
          <p>${plugin.description || t("pluginsPage.optionalCapability")}</p>
          <div class="plugins-card__meta">
            <span class="plugins-state plugins-state--${plugin.state}">${stateLabel(plugin)}</span>
            ${plugin.origin ? html`<span>${originLabel(plugin.origin)}</span>` : nothing}
            ${plugin.kind?.[0] ? html`<span>${humanizeKind(plugin.kind[0])}</span>` : nothing}
          </div>
        </div>
      </div>
      <div class="plugins-card__action">${renderCatalogAction(plugin, props, busy)}</div>
      ${plugin.error
        ? html`<div class="plugins-row-message plugins-row-message--error" role="alert">
            ${plugin.error}
          </div>`
        : nothing}
      ${renderRowMessage(key, props.messages[key], busy, props)}
    </article>
  `;
}

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

function renderClawHubResult(item: PluginSearchResult, props: PluginsViewProps): TemplateResult {
  const pkg = item.package;
  const installed = findInstalledSearchPlugin(item, props.result?.plugins ?? []);
  const key = clawHubRowKey(pkg.name);
  const busy = props.busy[key];
  return html`
    <article
      class="plugins-card plugins-card--clawhub"
      data-package-name=${pkg.name}
      data-plugin-source="clawhub"
      data-plugin-status=${installed?.state ?? "not-installed"}
      aria-busy=${busy ? "true" : "false"}
    >
      <div class="plugins-card__main">
        ${renderPluginTile(pkg.displayName)}
        <div class="plugins-card__copy">
          <div class="plugins-card__title-row">
            ${renderPluginHeading(pkg.displayName, 2)}
            ${pkg.latestVersion
              ? html`<span class="plugins-version">v${pkg.latestVersion}</span>`
              : nothing}
          </div>
          <p>${pkg.summary || pkg.name}</p>
          <div class="plugins-card__meta">
            ${pkg.isOfficial
              ? html`<span class="plugins-badge">${t("pluginsPage.official")}</span>`
              : nothing}
            <span
              >${pkg.family === "bundle-plugin"
                ? t("pluginsPage.bundlePlugin")
                : t("pluginsPage.codePlugin")}</span
            >
            ${pkg.channel ? html`<span>${pkg.channel}</span>` : nothing}
          </div>
        </div>
      </div>
      <div class="plugins-card__action">
        ${installed
          ? renderInstalledSwitch(installed, props, busy, key)
          : html`
              <button
                type="button"
                class="btn btn--sm plugins-install"
                title=${props.mutationBlockedReason ?? ""}
                aria-label=${t("pluginsPage.installNamed", { name: pkg.displayName })}
                ?disabled=${!props.canMutate || busy}
                @click=${() => props.onInstall(key, { source: "clawhub", packageName: pkg.name })}
              >
                ${busy ? t("pluginsPage.installing") : t("pluginsPage.install")}
              </button>
            `}
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

function renderRecommended(props: PluginsViewProps) {
  const groups = groupRecommendedPlugins(props.result?.plugins ?? [], props.query);
  if (groups.length === 0) {
    return renderEmpty(
      props.query ? t("pluginsPage.noRecommendedMatchTitle") : t("pluginsPage.noRecommendedTitle"),
      props.query ? t("pluginsPage.noMatchBody") : t("pluginsPage.noRecommendedBody"),
    );
  }
  return html`
    <div class="plugins-groups">
      ${groups.map(
        (group) => html`
          <section class="plugins-group" aria-labelledby=${`plugins-group-${group.id}`}>
            <div class="plugins-group__heading">
              <h2 id=${`plugins-group-${group.id}`}>${group.label}</h2>
              <span>${group.plugins.length}</span>
            </div>
            <div class="plugins-grid">
              ${repeat(
                group.plugins,
                (plugin) => plugin.id,
                (plugin) => renderCatalogPlugin(plugin, props, 3),
              )}
            </div>
          </section>
        `,
      )}
    </div>
  `;
}

function renderInstalled(props: PluginsViewProps) {
  const plugins = installedPlugins(props.result?.plugins ?? [], props.query);
  if (plugins.length === 0) {
    return renderEmpty(
      props.query ? t("pluginsPage.noInstalledMatchTitle") : t("pluginsPage.noInstalledTitle"),
      props.query ? t("pluginsPage.noMatchBody") : t("pluginsPage.noInstalledBody"),
    );
  }
  return html`
    <div class="plugins-grid">
      ${repeat(
        plugins,
        (plugin) => plugin.id,
        (plugin) => renderCatalogPlugin(plugin, props, 2),
      )}
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
    <div class="plugins-grid">
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
    case "recommended":
      return renderRecommended(props);
    case "installed":
      return renderInstalled(props);
    case "clawhub":
      return renderClawHub(props);
    default:
      return props.activeTab satisfies never;
  }
}

export function renderPlugins(props: PluginsViewProps) {
  const installedCount = props.result?.plugins.filter((plugin) => plugin.installed).length ?? 0;
  const recommendedCount = props.result?.plugins.filter((plugin) => plugin.featured).length ?? 0;
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
            .value=${props.query}
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
          const count =
            tab === "recommended" ? recommendedCount : tab === "installed" ? installedCount : null;
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
