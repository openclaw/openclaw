import { html, nothing, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { resolveConfigObjectFields } from "../../components/config-form.node.collection.ts";
import { renderNode } from "../../components/config-form.ts";
import { renderHubTabs } from "../../components/hub-tabs.ts";
import { icons } from "../../components/icons.ts";
import {
  renderSettingsEmpty,
  renderSettingsLoadingSkeleton,
  renderSettingsPage,
  renderSettingsPageHeader,
  renderSettingsSection,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import type { JsonSchema } from "../../lib/config-form-utils.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import { shouldHandleNavigationClick } from "../../lib/navigation-click.ts";
import type { PluginDiscoveryDetailResult, PluginsInspectResult } from "../../lib/plugins/index.ts";
import "../../plugins/control-ui-contributions.ts";
import { renderPluginReadme } from "./catalog-detail.ts";
import { renderArtTile } from "./consent-dialog.ts";
import { renderPluginDetailShell } from "./detail-shell.ts";
import type { InstalledPluginDetailTab } from "./detail-tabs.ts";
import type { PluginInstallProgress } from "./install-progress.ts";
import {
  renderPluginCapabilitySection,
  renderPluginDeclaredCapabilities,
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
import type { PluginMutationAction } from "./plugins-page-model.ts";
import {
  flattenPluginSettingsFields,
  type PluginSettingsEditor,
  type PluginSettingsField,
} from "./settings-editor.ts";
import { renderPluginLifecycle } from "./settings-lifecycle.ts";
import { pluginEntryValue, type PluginSettingsEditorModel } from "./settings-model.ts";
import type { PluginToolPreview } from "./tool-preview.ts";

export type PluginSettingsTab = "installed" | "advanced";

type SharedProps = Omit<
  PluginSettingsEditorModel,
  "pluginId" | "configSchema" | "backHref" | "onBack"
> & {
  loading: boolean;
  error: string | null;
  busy: Readonly<Record<string, PluginMutationAction>>;
  messages: Readonly<Record<string, PluginRowMessage>>;
  iconUrls: Readonly<Record<string, string>>;
  iconLoading?: (pluginId: string) => boolean;
  canMutate: boolean;
  mutationBlockedReason: string | null;
  onIconError: (pluginId: string) => void;
  onSetEnabled: (pluginId: string, enabled: boolean, rowKey: string) => void;
  onUninstall: (pluginId: string, rowKey: string) => void;
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
    installProgress?: PluginInstallProgress;
    onAskSetting?: (field: PluginSettingsField) => void;
    skillsSection?: TemplateResult;
    tools?: PluginToolPreview[];
    onOpenTool?: (name: string) => void;
    settingsHref?: string;

    inspection: PluginsInspectResult | null;
    inspectionError: string | null;
    catalog?: PluginDiscoveryDetailResult;
    catalogLoading?: boolean;
    catalogIconUrls?: Readonly<Record<string, string>>;
    catalogIconLoading?: (url: string) => boolean;
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
          ${renderArtTile(plugin.id, plugin.name, {
            iconUrl: props.iconUrls[plugin.id],
            onIconError: () => props.onIconError(plugin.id),
            loading: props.iconLoading?.(plugin.id),
          })}
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
          <div class="settings-group oc-settings-group">${renderInstalledInventory(props)}</div>
        `
      : html`<div id="plugin-settings-advanced" class="settings-stack">
          <openclaw-plugin-manager></openclaw-plugin-manager>
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
        title: t("tabs.plugins"),
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

function permissionSettings(props: DetailProps): PluginSettingsEditor["permissions"] {
  if (!props.inspection) {
    return { fields: [], loading: true };
  }
  const fields =
    props.hostControlsSchema && props.configValue
      ? resolveConfigObjectFields({
          rawAvailable: false,
          maskSensitive: true,
          schema: props.hostControlsSchema,
          value: pluginEntryValue(props.configValue, props.pluginId),
          path: ["plugins", "entries", props.pluginId],
          hints: props.configHints,
          unsupported: new Set(props.configUnsupportedPaths),
          disabled: !props.connected || !props.canEditConfig || props.configBusy,
          showLabel: false,
          compact: true,
          commitOnBlur: true,
          onPatch: props.onConfigPatch,
          onRemove: props.onConfigRemove,
        }).fields.flatMap((field) => flattenPluginSettingsFields(field, String(field.path.at(-1))))
      : [];
  for (const field of fields) {
    const key = field.path[4];
    if (
      field.path[3] !== "hooks" ||
      field.path.length !== 5 ||
      (key !== "allowPromptInjection" && key !== "allowConversationAccess")
    ) {
      continue;
    }
    const labelKey = key === "allowPromptInjection" ? "promptContextAccess" : "conversationAccess";
    field.label = t(`pluginsPage.${labelKey}`);
    field.help = t(`pluginsPage.${labelKey}Description`);
    field.effectiveValue = props.inspection.grants.hooks[key].effective;
  }
  return { fields };
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
  const catalog = props.catalog ?? props.inspection?.catalog;
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
          .permissions=${permissionSettings(props)}
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
  const tools: Array<{ name: string; description?: string }> =
    props.tools ?? names(props.inspection?.declared.tools ?? catalog?.detail.contracts?.tools);
  return renderSettingsPage(
    renderPluginDetailShell({
      id: "plugin-installed-detail",
      name: plugin.name,
      summary: plugin.description || catalog?.plugin.catalog.summary,
      backHref: props.backHref,
      backLabel: props.backLabel,
      onBack: props.onBack,
      icon: renderArtTile(plugin.id, plugin.name, {
        iconUrl:
          props.iconUrls[plugin.id] ??
          (catalog?.plugin.catalog.imageUrl
            ? props.catalogIconUrls?.[catalog.plugin.catalog.imageUrl]
            : undefined),
        onIconError: () => props.onIconError(plugin.id),
        authorIconUrl: catalog?.detail.author?.imageUrl
          ? props.catalogIconUrls?.[catalog.detail.author.imageUrl]
          : undefined,
        loading: Boolean(
          props.iconLoading?.(plugin.id) ||
          props.catalogLoading ||
          (catalog?.plugin.catalog.imageUrl &&
            props.catalogIconLoading?.(catalog.plugin.catalog.imageUrl)) ||
          (catalog?.detail.author?.imageUrl &&
            props.catalogIconLoading?.(catalog.detail.author.imageUrl)),
        ),
      }),
      identity: renderPluginPublisher(catalog, props.inspection?.overview?.publisherName),
      titleAction: props.installProgress
        ? html`<openclaw-plugin-install-action
              .buttonClass=${"btn oc-action plugin-catalog-detail__install"}
              .primary=${true}
              .progress=${props.installProgress}
            ></openclaw-plugin-install-action
            >${renderPluginAskAction(props.onAskPlugin, false)}`
        : renderPluginLifecycle(
            {
              ...props,
              settingsHref: props.settingsHref ?? "#configuration",
              onSettings: () => props.onTabChange("configuration"),
            },
            plugin,
          ),
      sidebar:
        catalog || plugin.version || props.inspection?.overview || props.catalogLoading
          ? renderPluginMetadata(
              catalog,
              plugin.version,
              props.inspection?.overview,
              props.catalogLoading,
            )
          : undefined,
      panel: html`${notices}
      ${!props.inspection && !catalog && !props.inspectionError ? renderSettingsLoadingSkeleton({ rows: 2, carapace: true }) : nothing}
      ${renderPluginDeclaredCapabilities(props.inspection?.overview?.capabilities?.contracts, props.inspection?.overview?.capabilities?.ui)}
      ${props.skillsSection ?? renderPluginCapabilitySection(t("pluginsPage.detailTabs.skills"), skills, icons.bookOpenText)}
      ${renderPluginCapabilitySection(
        t("pluginsPage.detailTools"),
        tools.map(({ name, description }) => ({
          name,
          description,
          onOpen:
            description?.trim() && props.onOpenTool ? () => props.onOpenTool?.(name) : undefined,
        })),
        icons.wrench,
      )}
      ${renderPluginCapabilitySection(t("pluginsPage.detailMcpServers"), names(components?.mcpServers ?? catalog?.detail.mcpServers), icons.plug)}`,
      readme:
        props.inspection?.overview?.readme || catalog?.detail.readme
          ? renderPluginReadme(props.inspection?.overview?.readme ?? catalog?.detail.readme)
          : undefined,
    }),
    { wide: true, carapace: true },
  );
}
