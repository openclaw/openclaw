import { html, nothing, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
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
import type { PluginsInspectResult } from "../../lib/plugins/index.ts";
import { renderPluginReadme } from "./catalog-detail.ts";
import {
  renderArtTile,
  renderPluginDeclaredCapabilities,
  renderPluginGrants,
} from "./consent-dialog.ts";
import { renderPluginDetailShell } from "./detail-shell.ts";
import type { InstalledPluginDetailTab } from "./detail-tabs.ts";
import {
  renderPluginCapabilitySection,
  renderPluginMetadata,
  renderPluginPublisher,
  renderPluginAskAction,
} from "./overview.ts";
import { renderPluginStateStatus } from "./plugin-card.ts";
import {
  pluginRowKey,
  renderPluginRowMessage,
  type PluginRowMessage,
} from "./plugin-row-message.ts";
import { matchesPluginQuery } from "./plugin-state-presentation.ts";
import type { PluginSettingsEditor, PluginSettingsField } from "./settings-editor.ts";
import { renderPluginLifecycle } from "./settings-lifecycle.ts";
import { pluginEntryValue, type PluginSettingsEditorModel } from "./settings-model.ts";
import type { PluginToolPreview } from "./tool-preview.ts";
import "./settings-editor.ts";

export type PluginSettingsTab = "installed" | "advanced";

type SharedProps = Omit<
  PluginSettingsEditorModel,
  "pluginId" | "configSchema" | "backHref" | "onBack"
> & {
  loading: boolean;
  error: string | null;
  busy: Readonly<Record<string, boolean>>;
  messages: Readonly<Record<string, PluginRowMessage>>;
  iconUrls: Readonly<Record<string, string>>;
  canMutate: boolean;
  reloadBlockedReason: string | null;
  mutationBlockedReason: string | null;
  onIconError: (pluginId: string) => void;
  onSetEnabled: (pluginId: string, enabled: boolean, rowKey: string) => void;
  onUninstall: (pluginId: string, rowKey: string) => void;
  onReload: (pluginId: string, rowKey: string) => void;
  onConfigReload: () => void;
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

export type DetailProps = SharedProps &
  PluginSettingsEditorModel & {
    renderCredential?: PluginSettingsEditor["renderCredential"];
    onAskPlugin?: () => void;
    onAskSetting?: (field: PluginSettingsField) => void;
    skillsSection?: TemplateResult;
    tools?: PluginToolPreview[];
    onOpenTool?: (name: string) => void;
    settingsHref?: string;

    inspection: PluginsInspectResult | null;
    inspectionError: string | null;
    hostControlsSchema: JsonSchema | null;
    backLabel: string;
    tab: InstalledPluginDetailTab;
    onRetryInspection: () => void;
    onTabChange: (tab: InstalledPluginDetailTab) => void;
  };

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
          ${renderPluginRowMessage(props.messages[key])}
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

function renderPermissions(props: DetailProps, query: string): TemplateResult | typeof nothing {
  if (!props.inspection) {
    return query ? nothing : renderSettingsLoadingSkeleton({ rows: 3, carapace: true });
  }
  const pluginEntry = pluginEntryValue(props.configValue, props.pluginId);
  const controls =
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
          compact: true,
          commitOnBlur: true,
          searchCriteria:
            query && !t("pluginsPage.editor.permissions").toLocaleLowerCase().includes(query)
              ? { text: query, tags: [] }
              : undefined,
          onPatch: props.onConfigPatch,
          onRemove: props.onConfigRemove,
        })
      : nothing;
  if (query && controls === nothing) {
    return nothing;
  }
  return html`${controls}
  ${
    query
      ? nothing
      : html`${renderAccess(props)}
          <div class="plugin-editor__permission-details">
            ${renderPluginDeclaredCapabilities(props.inspection.declared)}
            ${renderPluginGrants(props.inspection.grants, props.inspection.plugin.origin)}
          </div>`
  }`;
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
  const notices = html`${props.error ? renderRetryError(props.error, props.onRefresh) : nothing}
  ${props.inspectionError ? renderRetryError(props.inspectionError, props.onRetryInspection) : nothing}
  ${plugin.error ? html`<div class="callout danger oc-banner oc-banner-error" role="alert">${formatUiExternalText(plugin.error)}</div>` : nothing}
  ${renderPluginRowMessage(props.messages[key])}`;
  if (settings) {
    return renderSettingsPage(
      html`
        ${notices}
        <openclaw-plugin-settings-editor
          .model=${props}
          .renderCredential=${props.renderCredential}
          .onAskSetting=${props.onAskSetting}
          .renderPermissions=${(query: string) => renderPermissions(props, query)}
        ></openclaw-plugin-settings-editor>
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
      titleAction: html`${renderPluginLifecycle(
        {
          ...props,
          settingsHref: props.settingsHref ?? "#configuration",
          onSettings: () => props.onTabChange("configuration"),
        },
        plugin,
      )}${renderPluginAskAction(props.onAskPlugin)}`,
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
