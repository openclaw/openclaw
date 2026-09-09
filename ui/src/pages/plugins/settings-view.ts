import { html, nothing, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type { ConfigUiHints } from "../../api/types.ts";
import { renderNode } from "../../components/config-form.ts";
import { renderHubTabs } from "../../components/hub-tabs.ts";
import { icons } from "../../components/icons.ts";
import { renderReasonedDisabledControl } from "../../components/reasoned-disabled-control.ts";
import {
  renderSettingsEmpty,
  renderSettingsLoadingSkeleton,
  renderSettingsPage,
  renderSettingsPageHeader,
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsStatus,
  renderSettingsToggle,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import type { JsonSchema } from "../../lib/config-form-utils.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import { formatDateMs } from "../../lib/format.ts";
import { shouldHandleNavigationClick } from "../../lib/navigation-click.ts";
import type {
  PluginCatalogItem,
  PluginListResult,
  PluginsInspectResult,
} from "../../lib/plugins/index.ts";
import {
  pluginDetailCompatibilityRows,
  renderPluginDetailCompatibility,
  renderPluginDetailReadme,
  renderPluginDetailVersions,
} from "./catalog-detail.ts";
import { clawHubPackageUrl } from "./catalog-links.ts";
import { formatCompactCount } from "./catalog-results.ts";
import {
  renderArtTile,
  renderPluginDeclaredCapabilities,
  renderPluginGrants,
} from "./consent-dialog.ts";
import { renderPluginDetailRows, renderPluginDetailShell } from "./detail-shell.ts";
import { buildInstalledPluginDetailTabs, type InstalledPluginDetailTab } from "./detail-tabs.ts";
import { renderPluginOfficialBadge } from "./plugin-card.ts";
import { pluginRowKey, type PluginRowMessage } from "./plugin-row-message.ts";
import { matchesPluginQuery, pluginStatePresentation } from "./plugin-state-presentation.ts";
import { renderPluginLifecycle } from "./settings-lifecycle.ts";
import { pluginEntryValue } from "./settings-model.ts";

export type PluginSettingsTab = "installed" | "advanced";

type SharedProps = {
  connected: boolean;
  loading: boolean;
  result: PluginListResult | null;
  error: string | null;
  busy: Readonly<Record<string, boolean>>;
  messages: Readonly<Record<string, PluginRowMessage>>;
  pageNotice: PluginRowMessage | null;
  iconUrls: Readonly<Record<string, string>>;
  canMutate: boolean;
  mutationBlockedReason: string | null;
  configBusy: boolean;
  configSchemaLoading: boolean;
  configError: string | null;
  canEditConfig: boolean;
  configValue: Record<string, unknown> | null;
  configHints: ConfigUiHints;
  configUnsupportedPaths: readonly string[];
  onIconError: (pluginId: string) => void;
  onSetEnabled: (pluginId: string, enabled: boolean, rowKey: string) => void;
  onUninstall: (pluginId: string, rowKey: string) => void;
  onConfigPatch: (path: Array<string | number>, value: unknown) => void;
  onConfigRemove: (path: Array<string | number>) => void;
  onConfigReload: () => void;
  onConfigRetry: () => void;
  onRefresh: () => void;
};

type InventoryProps = SharedProps & {
  tab: PluginSettingsTab;
  query: string;
  advancedSchema: JsonSchema | null;
  onTabChange: (tab: PluginSettingsTab) => void;
  onQueryChange: (query: string) => void;
  pluginHref: (pluginId: string) => string;
  onOpenPlugin: (pluginId: string) => void;
};

export type DetailProps = SharedProps & {
  pluginId: string;
  inspection: PluginsInspectResult | null;
  inspectionError: string | null;
  configSchema: JsonSchema | null;
  hostControlsSchema: JsonSchema | null;
  backHref: string;
  backLabel: string;
  tab: InstalledPluginDetailTab;
  onBack: () => void;
  onRetryInspection: () => void;
  onTabChange: (tab: InstalledPluginDetailTab) => void;
};

function renderMessage(message: PluginRowMessage | undefined) {
  if (!message) {
    return nothing;
  }
  return html`<div
    class="plugins-row-message plugins-row-message--${message.kind} oc-banner ${
      message.kind === "error"
        ? "oc-banner-error"
        : message.kind === "warning"
          ? "oc-banner-warning"
          : "oc-banner-success"
    }"
    role=${message.kind === "error" ? "alert" : "status"}
  >
    ${message.text}
  </div>`;
}

function renderRetryError(error: string, onRetry: () => void): TemplateResult {
  return html`<div
    class="callout danger plugins-settings-error oc-banner oc-banner-error"
    role="alert"
  >
    <span>${error}</span>
    <button type="button" class="btn btn--sm oc-action oc-action-secondary" @click=${onRetry}>
      ${t("pluginsPage.tryAgain")}
    </button>
  </div>`;
}

function renderConfigActions(props: SharedProps) {
  return html`<button
    type="button"
    class="btn btn--xs btn--icon oc-action oc-action-icon oc-action-secondary"
    aria-label=${t("common.reload")}
    ?disabled=${props.configBusy || props.configSchemaLoading}
    @click=${props.onConfigReload}
  >
    ${icons.refresh}
  </button>`;
}

function renderSettingsTabs(props: InventoryProps): TemplateResult {
  return renderHubTabs({
    id: "plugin-settings",
    active: props.tab,
    tabs: [
      { value: "installed", label: t("pluginsPage.settingsInstalled") },
      { value: "advanced", label: t("pluginsPage.advanced") },
    ],
    ariaLabel: t("pluginsPage.settingsTabs"),
    panelId: "plugin-settings-panel",
    variant: "sub",
    className: "plugins-settings-tabs",
    carapace: true,
    onSelect: props.onTabChange,
  });
}

function renderInstalledInventory(props: InventoryProps): TemplateResult {
  if (!props.connected) {
    return renderSettingsEmpty(t("pluginsPage.connectToManage"), { carapace: true });
  }
  if (props.loading) {
    return renderSettingsLoadingSkeleton({ rows: 4, carapace: true });
  }
  if (props.error && !props.result) {
    return renderRetryError(props.error, props.onRefresh);
  }
  const refreshError = props.error ? renderRetryError(props.error, props.onRefresh) : nothing;
  const plugins = (props.result?.plugins ?? [])
    .filter((plugin) => plugin.installed && matchesPluginQuery(plugin, props.query))
    .toSorted((left, right) => left.name.localeCompare(right.name));
  if (plugins.length === 0) {
    return html`${refreshError}${renderSettingsEmpty(
      props.query ? t("pluginsPage.noSettingsMatches") : t("pluginsPage.noInstalled"),
      { carapace: true },
    )}`;
  }
  return html`${refreshError}${repeat(
    plugins,
    (plugin) => plugin.id,
    (plugin) => {
      const key = pluginRowKey(plugin.id);
      const busy = Boolean(props.busy[key]);
      const setupBlockedReason =
        plugin.state === "needs-setup" ? t("pluginsPage.setupRequiredNotice") : null;
      const toggle = renderSettingsToggle({
        checked: plugin.enabled,
        disabled:
          Boolean(setupBlockedReason) ||
          (!props.mutationBlockedReason && (!props.canMutate || busy)),
        ariaDisabled: Boolean(setupBlockedReason) || !props.canMutate,
        ariaLabel: t("pluginsPage.toggleNamed", { name: plugin.name }),
        onChange: (enabled) => {
          if (setupBlockedReason || !props.canMutate || busy) {
            return false;
          }
          props.onSetEnabled(plugin.id, enabled, key);
          return true;
        },
      });
      return html`
        <article
          class="settings-row settings-row--nav plugins-settings-row oc-settings-row"
          data-plugin-id=${plugin.id}
          @click=${(event: Event) => {
            const target = event.target;
            if (!(target instanceof Element) || !target.closest("wa-switch, button, a")) {
              props.onOpenPlugin(plugin.id);
            }
          }}
        >
          ${renderArtTile(plugin.id, plugin.name, props.iconUrls[plugin.id], () =>
            props.onIconError(plugin.id),
          )}
          <a
            class="settings-row__text plugins-settings-row__link oc-settings-row-content"
            href=${props.pluginHref(plugin.id)}
            @click=${(event: MouseEvent) => {
              if (!shouldHandleNavigationClick(event)) {
                return;
              }
              event.preventDefault();
              props.onOpenPlugin(plugin.id);
            }}
          >
            <span class="settings-row__title oc-settings-row-title">${plugin.name}</span>
            <span class="settings-row__desc oc-settings-row-description"
              >${plugin.description || t("pluginsPage.optionalCapability")}</span
            >
          </a>
          <div class="settings-row__control oc-settings-row-control">
            ${renderReasonedDisabledControl(setupBlockedReason ?? props.mutationBlockedReason, toggle)}
            <span class="settings-row__chevron" aria-hidden="true">${icons.chevronRight}</span>
          </div>
          ${renderMessage(props.messages[key])}
        </article>
      `;
    },
  )}`;
}

function renderAdvanced(props: InventoryProps): TemplateResult {
  if (!props.connected) {
    return renderSettingsEmpty(t("pluginsPage.connectToManage"), { carapace: true });
  }
  if (!props.advancedSchema || !props.configValue) {
    return props.configError
      ? renderRetryError(props.configError, props.onConfigRetry)
      : props.configSchemaLoading || !props.configValue
        ? renderSettingsLoadingSkeleton({ rows: 4, carapace: true })
        : renderSettingsEmpty(t("pluginsPage.schemaUnavailable"), { carapace: true });
  }
  return html`
    ${renderNode({
      schema: props.advancedSchema,
      value: props.configValue.plugins ?? {},
      path: ["plugins"],
      hints: props.configHints,
      unsupported: new Set(props.configUnsupportedPaths),
      disabled: !props.canEditConfig || props.configBusy,
      showLabel: false,
      onPatch: props.onConfigPatch,
      onRemove: props.onConfigRemove,
    })}
    ${props.configError ? renderRetryError(props.configError, props.onConfigRetry) : nothing}
  `;
}

export function renderPluginSettingsInventory(props: InventoryProps): TemplateResult {
  const body =
    props.tab === "installed"
      ? html`
          <label class="plugins-settings-search">
            <span class="settings-control__sr-label">${t("pluginsPage.searchInstalled")}</span>
            <span aria-hidden="true">${icons.search}</span>
            <input
              class="settings-input oc-input"
              type="search"
              aria-label=${t("pluginsPage.searchInstalled")}
              placeholder=${t("pluginsPage.searchInstalled")}
              .value=${props.query}
              @input=${(event: Event) => {
                // SAFETY: Lit attaches this handler directly to the input declared above.
                props.onQueryChange((event.currentTarget as HTMLInputElement).value);
              }}
            />
          </label>
          ${renderSettingsSection(
            {
              title: t("pluginsPage.settingsInstalled"),
              description: t("pluginsPage.settingsInstalledDescription"),
              count: (props.result?.plugins ?? []).filter((plugin) => plugin.installed).length,
              carapace: true,
            },
            renderInstalledInventory(props),
          )}
        `
      : html`<div id="plugin-settings-advanced">
          ${renderSettingsSection(
            {
              title: t("pluginsPage.advanced"),
              description: t("pluginsPage.advancedDescription"),
              actions: renderConfigActions(props),
              carapace: true,
            },
            renderAdvanced(props),
          )}
        </div>`;
  return renderSettingsPage(
    html`
      ${renderSettingsPageHeader({
        title: html`<h1 class="plugins-settings-title">${t("tabs.plugins")}</h1>`,
        subtitle: t("pluginsPage.settingsDescription"),
      })}
      ${props.pageNotice ? renderMessage(props.pageNotice) : nothing}
      <div class="plugins-settings-content">
        ${renderSettingsTabs(props)}
        <wa-tab-panel
          id="plugin-settings-panel"
          name=${props.tab}
          active
          aria-labelledby=${`plugin-settings-tab-${props.tab}`}
        >
          ${body}
        </wa-tab-panel>
      </div>
    `,
    { carapace: true },
  );
}

function renderConfiguration(props: DetailProps, plugin: PluginCatalogItem): TemplateResult {
  if (!props.configValue || !props.configSchema) {
    if (props.configError) {
      return renderRetryError(props.configError, props.onConfigRetry);
    }
    return renderSettingsLoadingSkeleton({ rows: 3, carapace: true });
  }
  const pluginEntry = pluginEntryValue(props.configValue, plugin.id);
  return html`
    ${renderNode({
      schema: props.configSchema,
      value: pluginEntry.config ?? {},
      path: ["plugins", "entries", plugin.id, "config"],
      hints: props.configHints,
      unsupported: new Set(props.configUnsupportedPaths),
      disabled: !props.canEditConfig || props.configBusy,
      showLabel: false,
      onPatch: props.onConfigPatch,
      onRemove: props.onConfigRemove,
    })}
    ${props.configError ? renderRetryError(props.configError, props.onConfigRetry) : nothing}
  `;
}

function renderAccess(props: DetailProps): TemplateResult {
  if (!props.inspection) {
    return renderSettingsLoadingSkeleton({ rows: 3, carapace: true });
  }
  const grants = props.inspection.grants;
  const modelOverride = Boolean(
    grants.llm?.allowModelOverride ||
    grants.llm?.allowAuthProfileOverride ||
    grants.llm?.allowAgentIdOverride ||
    grants.subagent?.allowModelOverride,
  );
  return html`
    ${renderSettingsRow({
      title: t("pluginsPage.promptContextAccess"),
      description: t("pluginsPage.promptContextAccessDescription"),
      control: renderSettingsStatus({
        kind: grants.hooks.allowPromptInjection.effective ? "warn" : "muted",
        label: grants.hooks.allowPromptInjection.effective
          ? t("pluginsPage.accessAllowed")
          : t("pluginsPage.accessBlocked"),
        carapace: true,
      }),
      carapace: true,
    })}
    ${renderSettingsRow({
      title: t("pluginsPage.conversationAccess"),
      description: t("pluginsPage.conversationAccessDescription"),
      control: renderSettingsStatus({
        kind: grants.hooks.allowConversationAccess.effective ? "warn" : "muted",
        label: grants.hooks.allowConversationAccess.effective
          ? t("pluginsPage.accessAllowed")
          : t("pluginsPage.accessBlocked"),
        carapace: true,
      }),
      carapace: true,
    })}
    ${renderSettingsRow({
      title: t("pluginsPage.modelOverrideAccess"),
      description: t("pluginsPage.modelOverrideAccessDescription"),
      control: renderSettingsStatus({
        kind: modelOverride ? "warn" : "muted",
        label: modelOverride ? t("pluginsPage.accessAllowed") : t("pluginsPage.accessBlocked"),
        carapace: true,
      }),
      carapace: true,
    })}
  `;
}

function renderInstalledAdvanced(props: DetailProps): TemplateResult {
  if (!props.inspection) {
    return renderSettingsLoadingSkeleton({ rows: 3, carapace: true });
  }
  const pluginEntry = pluginEntryValue(props.configValue, props.pluginId);
  return html`${
    props.hostControlsSchema && props.configValue
      ? renderNode({
          schema: props.hostControlsSchema,
          value: pluginEntry,
          path: ["plugins", "entries", props.pluginId],
          hints: props.configHints,
          unsupported: new Set(props.configUnsupportedPaths),
          disabled: !props.canEditConfig || props.configBusy,
          showLabel: false,
          onPatch: props.onConfigPatch,
          onRemove: props.onConfigRemove,
        })
      : nothing
  }
  ${props.configError ? renderRetryError(props.configError, props.onConfigRetry) : nothing}
  ${renderPluginDeclaredCapabilities(props.inspection.declared)}
  ${renderPluginGrants(props.inspection.grants, props.inspection.plugin.origin)}`;
}

function installedTabLabel(tab: InstalledPluginDetailTab, needsSetup: boolean): unknown {
  const label = t(`pluginsPage.detailTabs.${tab}`);
  if (tab !== "configuration" || !needsSetup) {
    return label;
  }
  const warning = t("pluginsPage.additionalConfigurationRequired");
  return html`<span class="plugin-installed-detail__configuration-label">
    ${label}
    <span class="plugin-installed-detail__setup-dot" title=${warning} aria-label=${warning}></span>
  </span>`;
}

function renderInstalledTabPanel(
  props: DetailProps,
  plugin: PluginCatalogItem,
  tab: InstalledPluginDetailTab,
): TemplateResult {
  const catalog = props.inspection?.catalog;
  const components = props.inspection?.components;
  if (tab === "readme" && catalog) {
    return renderPluginDetailReadme(catalog);
  }
  if (tab === "configuration") {
    return html`<div class="plugin-installed-detail__panel-head">
        <p>${t("pluginsPage.configurationDescription")}</p>
        ${renderConfigActions(props)}
      </div>
      ${
        plugin.state === "needs-setup"
          ? html`<div class="callout warning oc-banner oc-banner-warning" role="status">
              ${t("pluginsPage.setupRequiredDescription")}
            </div>`
          : nothing
      }
      ${renderConfiguration(props, plugin)}`;
  }
  if (tab === "skills" && components) {
    return renderPluginDetailRows(components.skills);
  }
  if (tab === "mcpServers" && components) {
    return renderPluginDetailRows(components.mcpServers);
  }
  if (tab === "commands" && components) {
    return renderPluginDetailRows(components.commands);
  }
  if (tab === "hooks" && components) {
    return renderPluginDetailRows(components.hooks);
  }
  if (tab === "lspServers" && components) {
    return renderPluginDetailRows(components.lspServers);
  }
  if (tab === "compatibility" && catalog) {
    return renderPluginDetailCompatibility(catalog);
  }
  if (tab === "versions" && catalog) {
    return renderPluginDetailVersions(catalog);
  }
  if (tab === "access") {
    return renderAccess(props);
  }
  if (tab === "lifecycle") {
    return renderPluginLifecycle(props, plugin);
  }
  return renderInstalledAdvanced(props);
}

export function renderPluginSettingsDetail(props: DetailProps): TemplateResult {
  const plugin = props.result?.plugins.find((entry) => entry.id === props.pluginId);
  if (!props.connected) {
    return renderSettingsPage(
      renderSettingsEmpty(t("pluginsPage.connectToManage"), { carapace: true }),
      { carapace: true },
    );
  }
  if (props.error && !props.result) {
    return renderSettingsPage(renderRetryError(props.error, props.onRefresh), { carapace: true });
  }
  if (!props.result) {
    return renderSettingsPage(renderSettingsLoadingSkeleton({ rows: 5, carapace: true }), {
      carapace: true,
    });
  }
  if (!plugin?.installed) {
    return renderSettingsPage(
      html`
        <a
          class="btn btn--sm oc-action oc-action-secondary"
          href=${props.backHref}
          @click=${(event: Event) => {
            event.preventDefault();
            props.onBack();
          }}
        >
          ${icons.chevronLeft} ${props.backLabel}
        </a>
        ${renderSettingsEmpty(t("pluginsPage.pluginNotFound"), { carapace: true })}
      `,
      { carapace: true },
    );
  }
  const key = pluginRowKey(plugin.id);
  const statePresentation = pluginStatePresentation(plugin);
  const stateStatus =
    plugin.state === "error"
      ? renderSettingsStatus({
          ...statePresentation,
          carapace: true,
        })
      : nothing;
  const setupRequired = plugin.state === "needs-setup";
  const catalog = props.inspection?.catalog;
  const components = props.inspection?.components ?? {
    mapped: [],
    skills: [],
    mcpServers: [],
    commands: [],
    hooks: [],
    lspServers: [],
    unavailable: { capabilities: [], mcpServers: [], lspServers: [] },
  };
  const hasConfiguration = Boolean(
    props.configSchema ||
    props.configSchemaLoading ||
    props.configError ||
    plugin.state === "needs-setup",
  );
  const tabs = buildInstalledPluginDetailTabs({
    hasReadme: Boolean(catalog?.detail.readme),
    hasConfiguration,
    components,
    hasCompatibility: Boolean(catalog && pluginDetailCompatibilityRows(catalog).length > 0),
    hasVersions: Boolean(catalog?.detail.versions.length),
  });
  const activeTab = tabs.includes(props.tab) ? props.tab : (tabs[0] ?? "configuration");
  const authorHandle = catalog?.detail.author?.handle ?? catalog?.plugin.catalog.author;
  const publisherName =
    catalog?.detail.author?.displayName ?? authorHandle ?? plugin.packageName ?? plugin.name;
  const packageUrl = catalog
    ? clawHubPackageUrl(catalog.detail.packageName, authorHandle)
    : undefined;
  const sidebar = catalog
    ? html`<dl>
          ${
            catalog.plugin.catalog.downloads === undefined
              ? nothing
              : html`<div>
                  <dt>${t("pluginsPage.catalogDownloadsColumn")}</dt>
                  <dd>${icons.download} ${formatCompactCount(catalog.plugin.catalog.downloads)}</dd>
                </div>`
          }
          ${
            plugin.version
              ? html`<div>
                  <dt>${t("pluginsPage.version")}</dt>
                  <dd>${plugin.version}</dd>
                </div>`
              : nothing
          }
          ${
            catalog.detail.updatedAt
              ? html`<div>
                  <dt>${t("pluginsPage.detailUpdated")}</dt>
                  <dd>${formatDateMs(catalog.detail.updatedAt, { dateStyle: "medium" })}</dd>
                </div>`
              : nothing
          }
        </dl>
        ${
          catalog.detail.security
            ? html`<a
                class="plugin-catalog-detail__security"
                href=${packageUrl ? `${packageUrl}/security-audit` : nothing}
                target="_blank"
                rel="noopener noreferrer"
              >
                <h2>${t("pluginsPage.detailSecurity")} ${icons.info}</h2>
                <strong>${catalog.detail.security.status}</strong>
              </a>`
            : nothing
        }
        ${
          packageUrl
            ? html`<a
                class="btn plugin-catalog-detail__clawhub"
                href=${packageUrl}
                target="_blank"
                rel="noopener noreferrer"
                >${t("pluginsPage.detailViewOnClawHub")}</a
              >`
            : nothing
        }`
    : undefined;
  return renderSettingsPage(
    html`${renderPluginDetailShell({
      id: "plugin-installed-detail",
      name: plugin.name,
      summary: plugin.description || catalog?.plugin.catalog.summary || plugin.id,
      backHref: props.backHref,
      backLabel: props.backLabel,
      onBack: props.onBack,
      titleAction: html`<div class="plugins-settings-detail-actions">
        ${stateStatus}
        ${renderReasonedDisabledControl(
          props.mutationBlockedReason,
          renderSettingsToggle({
            checked: plugin.enabled,
            disabled:
              setupRequired ||
              (!props.mutationBlockedReason && (!props.canMutate || Boolean(props.busy[key]))),
            ariaDisabled: setupRequired || !props.canMutate,
            ariaLabel: t("pluginsPage.toggleNamed", { name: plugin.name }),
            onChange: (enabled) => {
              if (setupRequired || !props.canMutate || props.busy[key]) {
                return false;
              }
              props.onSetEnabled(plugin.id, enabled, key);
              return true;
            },
          }),
        )}
      </div>`,
      identity: html`<div class="plugin-catalog-detail__publisher">
        <span class="plugin-catalog-detail__publisher-icon" aria-hidden="true">
          ${
            props.iconUrls[plugin.id]
              ? html`<img
                  src=${props.iconUrls[plugin.id]}
                  alt=""
                  @error=${() => props.onIconError(plugin.id)}
                />`
              : icons.box
          }
        </span>
        <div>
          <div class="plugin-catalog-detail__publisher-name">
            <strong>${publisherName}</strong>
            ${catalog?.plugin.catalog.official ? renderPluginOfficialBadge() : nothing}
          </div>
          ${authorHandle ? html`<span>@${authorHandle.replace(/^@/u, "")}</span>` : nothing}
        </div>
      </div>`,
      sidebar,
      tabs: tabs.map((tab) => ({
        value: tab,
        label: installedTabLabel(tab, plugin.state === "needs-setup"),
      })),
      activeTab,
      onTabChange: props.onTabChange,
      panel: html`${props.pageNotice ? renderMessage(props.pageNotice) : nothing}
      ${props.error ? renderRetryError(props.error, props.onRefresh) : nothing}
      ${
        props.inspectionError
          ? renderRetryError(props.inspectionError, props.onRetryInspection)
          : nothing
      }
      ${
        plugin.error
          ? html`<div class="callout danger oc-banner oc-banner-error" role="alert">
              ${formatUiExternalText(plugin.error)}
            </div>`
          : nothing
      }
      ${renderMessage(props.messages[key])} ${renderInstalledTabPanel(props, plugin, activeTab)}`,
    })}`,
    { wide: true, carapace: true },
  );
}
