import { html, nothing, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type { ConfigUiHints } from "../../api/types.ts";
import { renderNode } from "../../components/config-form.ts";
import { renderHubTabs } from "../../components/hub-tabs.ts";
import { icons } from "../../components/icons.ts";
import {
  renderSettingsEmpty,
  renderSettingsLoadingSkeleton,
  renderSettingsPage,
  renderSettingsPageHeader,
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsStatus,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import type { JsonSchema } from "../../lib/config-form-utils.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import { shouldHandleNavigationClick } from "../../lib/navigation-click.ts";
import type {
  PluginCatalogItem,
  PluginListResult,
  PluginsInspectResult,
} from "../../lib/plugins/index.ts";
import { renderPluginReadme } from "./catalog-detail.ts";
import {
  renderArtTile,
  renderPluginDeclaredCapabilities,
  renderPluginGrants,
} from "./consent-dialog.ts";
import { renderPluginDetailBreadcrumb, renderPluginDetailShell } from "./detail-shell.ts";
import type { InstalledPluginDetailTab } from "./detail-tabs.ts";
import {
  renderPluginCapabilitySection,
  renderPluginMetadata,
  renderPluginPublisher,
} from "./overview.ts";
import { renderPluginStateStatus } from "./plugin-card.ts";
import { pluginRowKey, type PluginRowMessage } from "./plugin-row-message.ts";
import { matchesPluginQuery } from "./plugin-state-presentation.ts";
import { renderPluginLifecycle } from "./settings-lifecycle.ts";
import { pluginEntryValue } from "./settings-model.ts";
import type { PluginToolPreview } from "./tool-preview.ts";

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
  reloadBlockedReason: string | null;
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
  onReload: (pluginId: string, rowKey: string) => void;
  onConfigPatch: (path: Array<string | number>, value: unknown) => void;
  onConfigRemove: (path: Array<string | number>) => void;
  onConfigReload: () => void;
  onConfigReadRetry: () => void;
  onConfigWriteRetry: () => void;
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
  skillsSection?: TemplateResult;
  tools?: PluginToolPreview[];
  onOpenTool?: (name: string) => void;
  settingsHref?: string;

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
      return html`
        <article
          class="settings-row settings-row--nav plugins-settings-row oc-settings-row"
          data-plugin-id=${plugin.id}
          @click=${(event: Event) => {
            const target = event.target;
            if (!(target instanceof Element) || !target.closest("button, a")) {
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
            ${
              plugin.state === "not-installed"
                ? nothing
                : renderPluginStateStatus(plugin.state, "plugins-settings-row__status")
            }
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
      ? renderRetryError(props.configError, props.onConfigReadRetry)
      : props.configSchemaLoading || !props.configValue
        ? renderSettingsLoadingSkeleton({ rows: 4, carapace: true })
        : renderSettingsEmpty(t("pluginsPage.schemaUnavailable"), { carapace: true });
  }
  return html`
    ${renderNode({
      rawAvailable: false,
      maskSensitive: true,
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
    ${props.configError ? renderRetryError(props.configError, props.onConfigWriteRetry) : nothing}
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
      return renderRetryError(props.configError, props.onConfigReadRetry);
    }
    return renderSettingsLoadingSkeleton({ rows: 3, carapace: true });
  }
  const pluginEntry = pluginEntryValue(props.configValue, plugin.id);
  return html`
    ${renderNode({
      rawAvailable: false,
      maskSensitive: true,
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
    ${props.configError ? renderRetryError(props.configError, props.onConfigWriteRetry) : nothing}
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
          rawAvailable: false,
          maskSensitive: true,
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
  ${renderPluginDeclaredCapabilities(props.inspection.declared)}
  ${renderPluginGrants(props.inspection.grants, props.inspection.plugin.origin)}`;
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
  const catalog = props.inspection?.catalog;
  const components = props.inspection?.components;
  const settings = props.tab === "configuration";
  const notices = html`${props.pageNotice ? renderMessage(props.pageNotice) : nothing}
  ${props.error ? renderRetryError(props.error, props.onRefresh) : nothing}
  ${props.inspectionError ? renderRetryError(props.inspectionError, props.onRetryInspection) : nothing}
  ${plugin.error ? html`<div class="callout danger oc-banner oc-banner-error" role="alert">${formatUiExternalText(plugin.error)}</div>` : nothing}
  ${renderMessage(props.messages[key])}`;
  if (settings) {
    return renderSettingsPage(
      html`
        ${renderPluginDetailBreadcrumb({
          name: t("pluginsPage.detailSettings"),
          backHref: props.backHref,
          backLabel: plugin.name,
          onBack: props.onBack,
        })}
        <h1>${plugin.name} ${t("pluginsPage.detailSettings")}</h1>
        ${notices}
        ${props.configSchema || props.configSchemaLoading || props.configError ? renderConfiguration(props, plugin) : nothing}
        ${renderSettingsSection({ title: t("pluginsPage.detailTabs.access"), carapace: true }, html`${renderAccess(props)}${renderInstalledAdvanced(props)}`)}
      `,
      { wide: true, carapace: true },
    );
  }
  const names = (values: string[] | undefined) => (values ?? []).map((name) => ({ name }));
  const skills = (components?.skills ?? []).map((name) => ({
    name,
    description: catalog?.detail.skills.find((skill) => skill.name === name)?.description,
  }));
  const tools = props.tools ?? names(props.inspection?.declared.tools);
  return renderSettingsPage(
    renderPluginDetailShell({
      id: "plugin-installed-detail",
      name: plugin.name,
      summary: plugin.description || catalog?.plugin.catalog.summary,
      backHref: props.backHref,
      backLabel: props.backLabel,
      onBack: props.onBack,
      icon: html`<span data-plugin-icon-id=${plugin.id}
        >${props.iconUrls[plugin.id] ? html`<img src=${props.iconUrls[plugin.id]} alt="" @error=${() => props.onIconError(plugin.id)} />` : icons.box}</span
      >`,
      identity: renderPluginPublisher(catalog, props.inspection?.overview?.publisherName),
      titleAction: renderPluginLifecycle(
        {
          ...props,
          settingsHref: props.settingsHref ?? "#configuration",
          onSettings: () => props.onTabChange("configuration"),
        },
        plugin,
      ),
      sidebar:
        catalog || plugin.version || props.inspection?.overview
          ? renderPluginMetadata(catalog, plugin.version, props.inspection?.overview)
          : undefined,
      panel: html`${notices}
      ${!props.inspection && !props.inspectionError ? renderSettingsLoadingSkeleton({ rows: 2, carapace: true }) : nothing}
      ${props.skillsSection ?? renderPluginCapabilitySection(t("pluginsPage.detailTabs.skills"), skills, icons.book)}
      ${renderPluginCapabilitySection(t("pluginsPage.detailMcpServers"), names(components?.mcpServers), icons.plug)}
      ${renderPluginCapabilitySection(t("pluginsPage.detailTools"), tools, icons.wrench, props.onOpenTool)}
      ${renderPluginCapabilitySection(t("pluginsPage.detailTabs.commands"), names(components?.commands), icons.terminal)}
      ${renderPluginCapabilitySection(t("pluginsPage.detailTabs.hooks"), names(components?.hooks), icons.plug)}
      ${renderPluginCapabilitySection(t("pluginsPage.detailTabs.lspServers"), names(components?.lspServers), icons.fileText)} `,
      readme:
        props.inspection?.overview?.readme || catalog?.detail.readme
          ? renderPluginReadme(props.inspection?.overview?.readme ?? catalog?.detail.readme)
          : undefined,
    }),
    { wide: true, carapace: true },
  );
}
