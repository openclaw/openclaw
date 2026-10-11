import type { JSX } from "@solidjs/web";
import { For, Show, createMemo } from "solid-js";
import { resolveConfigObjectFields } from "../../components/config-form.node.collection.ts";
import { renderNode } from "../../components/config-form.ts";
import { renderHubTabs } from "../../components/hub-tabs.ts";
import { Icon } from "../../components/solid/icon.tsx";
import {
  SettingsEmpty,
  SettingsLoadingSkeleton,
  SettingsPage,
  SettingsPageHeader,
  SettingsSection,
} from "../../components/solid/settings-ui.tsx";
import type { JsonSchema } from "../../lib/config-form-utils.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import { shouldHandleNavigationClick } from "../../lib/navigation-click.ts";
import type { PluginDiscoveryDetailResult, PluginsInspectResult } from "../../lib/plugins/index.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { LitContent } from "../../lit/solid-bridge.ts";
import { renderPluginReadme } from "./catalog-detail.tsx";
import "../../plugins/control-ui-contributions.ts";
import { renderArtTile } from "./consent-dialog.tsx";
import "./custom-elements.ts";
import { renderPluginDetailShell as PluginDetailShell } from "./detail-shell.tsx";
import type { InstalledPluginDetailTab } from "./detail-tabs.ts";
import { PluginInstallAction } from "./install-action.tsx";
import type { PluginInstallProgress } from "./install-progress.ts";
import {
  renderPluginCapabilitySection,
  renderPluginDeclaredCapabilities,
  renderPluginMetadata,
  renderPluginMcpServers,
  renderPluginPublisher,
  renderPluginAskAction,
} from "./overview.tsx";
import { renderPluginStateStatus } from "./plugin-card.tsx";
import {
  pluginRowKey,
  renderPluginRowMessage,
  type PluginRowMessage,
} from "./plugin-row-message.tsx";
import type { PluginMutationAction } from "./plugins-page-model.ts";
import {
  flattenPluginSettingsFields,
  pluginSettingsNodeOptions,
  PluginSettingsEditor,
  type PluginSettingsEditorProps,
  type PluginSettingsField,
} from "./settings-editor.tsx";
import { renderPluginLifecycle } from "./settings-lifecycle.tsx";
import { pluginEntryValue, type PluginSettingsEditorModel } from "./settings-model.ts";
import type { PluginToolPreview } from "./tool-preview.tsx";
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
    resolveCredential?: PluginSettingsEditorProps["resolveCredential"];
    onAskPlugin?: () => void;
    mcpLoginBusy?: boolean;
    canMcpLogin?: boolean;
    onMcpLogin?: (serverName: string) => void;
    onEditMcp?: () => void;
    installProgress?: PluginInstallProgress;
    onAskSetting?: (field: PluginSettingsField) => void;
    skillsSection?: JSX.Element;
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
function renderRetryError(error: string, onRetry: () => void): JSX.Element {
  return (
    <div class="callout danger plugins-settings-error oc-banner oc-banner-error" role="alert">
      <span>{error}</span>
      <button type="button" class="btn btn--sm oc-action oc-action-secondary" onClick={onRetry}>
        {t("pluginsPage.tryAgain")}
      </button>
    </div>
  );
}
function PluginConnectionAction(props: {
  kind: "Account" | "Credential";
  ready: boolean;
  name: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  const verb = () => (props.ready ? "edit" : props.kind === "Account" ? "connect" : "configure");
  return (
    <>
      {props.ready ? (
        <span class="plugin-connection-status" role="status">
          <Icon name="check" />
          {t(
            props.kind === "Account" ? "pluginsPage.auth.connected" : "pluginsPage.auth.configured",
          )}
        </span>
      ) : null}
      <button
        type="button"
        class="btn btn--sm oc-action oc-action-secondary"
        aria-label={t(`pluginsPage.auth.${verb()}${props.kind}`, { name: props.name })}
        disabled={props.disabled}
        onClick={() => props.onClick()}
      >
        {t(`pluginsPage.auth.${verb()}`)}
      </button>
    </>
  );
}
function InstalledInventory(props: InventoryProps): JSX.Element {
  const query = createMemo(() => props.query.trim().toLocaleLowerCase());
  const plugins = createMemo(() =>
    (props.result?.plugins ?? [])
      .filter(
        (plugin) =>
          plugin.installed &&
          (!query() ||
            [plugin.name, plugin.id, plugin.description, plugin.packageName].some((value) =>
              value?.toLocaleLowerCase().includes(query()),
            )),
      )
      .toSorted((left, right) => left.name.localeCompare(right.name)),
  );
  return (
    <>
      {!props.connected ? (
        <SettingsEmpty message={t("pluginsPage.connectToManage")} carapace />
      ) : props.loading ? (
        <SettingsLoadingSkeleton rows={4} carapace />
      ) : props.error && !props.result ? (
        renderRetryError(props.error, props.onRefresh)
      ) : (
        <>
          {props.error ? renderRetryError(props.error, props.onRefresh) : null}
          {!plugins().length ? (
            <SettingsEmpty
              message={
                props.query ? t("pluginsPage.noSettingsMatches") : t("pluginsPage.noInstalled")
              }
              carapace
            />
          ) : (
            <For each={plugins()} keyed={(plugin) => plugin.id}>
              {(plugin) => (
                <article
                  class="settings-row settings-row--nav plugins-settings-row oc-settings-row"
                  data-plugin-id={plugin().id}
                  onClick={(event: Event) => {
                    const target = event.target;
                    if (!(target instanceof Element) || !target.closest("button, a")) {
                      props.onOpenPlugin(plugin().id);
                    }
                  }}
                >
                  {renderArtTile(plugin().id, plugin().name, {
                    iconUrl: props.iconUrls[plugin().id],
                    onIconError: () => props.onIconError(plugin().id),
                    loading: props.iconLoading?.(plugin().id),
                  })}
                  <a
                    class="settings-row__text plugins-settings-row__link oc-settings-row-content"
                    href={props.pluginHref(plugin().id)}
                    onClick={(event: MouseEvent) => {
                      if (!shouldHandleNavigationClick(event)) {
                        return;
                      }
                      event.preventDefault();
                      props.onOpenPlugin(plugin().id);
                    }}
                  >
                    <span class="settings-row__title oc-settings-row-title">{plugin().name}</span>
                    <span class="settings-row__desc oc-settings-row-description">
                      {plugin().description || t("pluginsPage.optionalCapability")}
                    </span>
                  </a>
                  <div class="settings-row__control oc-settings-row-control">
                    {(() => {
                      const state = plugin().state;
                      return state === "not-installed"
                        ? null
                        : renderPluginStateStatus(state, "plugins-settings-row__status");
                    })()}
                    <span class="settings-row__chevron" aria-hidden="true">
                      <Icon name="chevronRight" />
                    </span>
                  </div>
                  {renderPluginRowMessage(props.messages[pluginRowKey(plugin().id)])}
                </article>
              )}
            </For>
          )}
        </>
      )}
    </>
  );
}
function AdvancedSettings(options: InventoryProps): JSX.Element {
  const config = createMemo(() => {
    const schema = options.advancedSchema;
    const value = options.configValue;
    return schema && value ? { schema, value } : null;
  });
  return (
    <Show
      when={options.connected}
      fallback={<SettingsEmpty message={t("pluginsPage.connectToManage")} carapace />}
    >
      <Show
        when={config()}
        fallback={
          options.configError ? (
            renderRetryError(options.configError, options.onConfigReadRetry)
          ) : options.configSchemaLoading || !options.configValue ? (
            <SettingsLoadingSkeleton rows={4} carapace />
          ) : (
            <SettingsEmpty message={t("pluginsPage.schemaUnavailable")} carapace />
          )
        }
      >
        {(current) => (
          <>
            <LitContent
              render={() =>
                renderNode({
                  rawAvailable: false,
                  maskSensitive: true,
                  schema: current().schema,
                  value: current().value.plugins ?? {},
                  path: ["plugins"],
                  hints: options.configHints,
                  unsupported: new Set(options.configUnsupportedPaths),
                  disabled: !options.canEditConfig || options.configBusy,
                  showLabel: false,
                  onPatch: options.onConfigPatch,
                  onRemove: options.onConfigRemove,
                })
              }
            />
            {options.configError
              ? renderRetryError(options.configError, options.onConfigWriteRetry)
              : null}
          </>
        )}
      </Show>
    </Show>
  );
}
export function renderPluginSettingsInventory(props: InventoryProps): JSX.Element {
  const body = (
    <>
      {props.tab === "installed" ? (
        <>
          <label class="plugins-settings-search">
            <span class="settings-control__sr-label">{t("pluginsPage.searchInstalled")}</span>
            <span aria-hidden="true">
              <Icon name="search" />
            </span>
            <input
              class="settings-input oc-input"
              type="search"
              aria-label={t("pluginsPage.searchInstalled")}
              placeholder={t("pluginsPage.searchInstalled")}
              value={props.query}
              onInput={(event) => props.onQueryChange(event.currentTarget.value)}
            />
          </label>
          <div class="settings-group oc-settings-group">
            <InstalledInventory {...props} />
          </div>
        </>
      ) : (
        <>
          <div id="plugin-settings-advanced" class="settings-stack">
            <openclaw-plugin-manager />
            <SettingsSection
              title={t("pluginsPage.advanced")}
              description={t("pluginsPage.advancedDescription")}
              actions={
                <>
                  <button
                    type="button"
                    class="btn btn--xs btn--icon oc-action oc-action-icon oc-action-secondary"
                    aria-label={t("common.reload")}
                    disabled={props.configBusy || props.configSchemaLoading}
                    onClick={props.onConfigReload}
                  >
                    <Icon name="refresh" />
                  </button>
                </>
              }
              carapace={true}
            >
              <AdvancedSettings {...props} />
            </SettingsSection>
          </div>
        </>
      )}
    </>
  );
  return (
    <SettingsPage carapace={true}>
      <SettingsPageHeader
        title={t("tabs.plugins")}
        subtitle={t("pluginsPage.settingsDescription")}
      />
      <div class="plugins-settings-content">
        <LitContent
          render={() =>
            renderHubTabs({
              id: "plugin-settings",
              active: props.tab,
              tabs: [
                {
                  value: "installed",
                  label: t("pluginsPage.settingsInstalled"),
                },
                {
                  value: "advanced",
                  label: t("pluginsPage.advanced"),
                },
              ],
              ariaLabel: t("pluginsPage.settingsTabs"),
              panelId: "plugin-settings-panel",
              variant: "sub",
              className: "plugins-settings-tabs",
              carapace: true,
              onSelect: props.onTabChange,
            })
          }
        />
        <wa-tab-panel
          id="plugin-settings-panel"
          name={props.tab}
          active
          aria-labelledby={`plugin-settings-tab-${props.tab}`}
        >
          {body}
        </wa-tab-panel>
      </div>
    </SettingsPage>
  );
}
function permissionSettings(options: DetailProps): PluginSettingsEditorProps["permissions"] {
  if (!options.inspection) {
    return {
      fields: [],
      loading: true,
    };
  }
  const fields =
    options.hostControlsSchema && options.configValue
      ? resolveConfigObjectFields({
          schema: options.hostControlsSchema,
          value: pluginEntryValue(options.configValue, options.pluginId),
          path: ["plugins", "entries", options.pluginId],
          ...pluginSettingsNodeOptions(options),
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
    field.effectiveValue = options.inspection.grants.hooks[key].effective;
  }
  return {
    fields,
  };
}
function PluginNotices(props: DetailProps) {
  const plugin = createMemo(() =>
    props.result?.plugins.find((entry) => entry.id === props.pluginId),
  );
  return (
    <>
      {props.error ? renderRetryError(props.error, props.onRefresh) : null}
      {props.inspectionError
        ? renderRetryError(props.inspectionError, props.onRetryInspection)
        : null}
      {plugin()?.error ? (
        <div class="callout danger oc-banner oc-banner-error" role="alert">
          {formatUiExternalText(plugin()!.error!)}
        </div>
      ) : null}
      {renderPluginRowMessage(props.messages[pluginRowKey(props.pluginId)])}
    </>
  );
}
export function renderPluginSettingsDetail(props: DetailProps): JSX.Element {
  const plugin = createMemo(() =>
    props.result?.plugins.find((entry) => entry.id === props.pluginId),
  );
  return (
    <>
      {!props.connected ? (
        <SettingsPage carapace={true}>
          <SettingsEmpty message={t("pluginsPage.connectToManage")} carapace={true} />
        </SettingsPage>
      ) : props.error && !props.result ? (
        <SettingsPage carapace={true}>
          {renderRetryError(props.error, props.onRefresh)}
        </SettingsPage>
      ) : !props.result ? (
        <SettingsPage carapace={true}>
          <SettingsLoadingSkeleton rows={5} carapace={true} />
        </SettingsPage>
      ) : !plugin()?.installed ? (
        <SettingsPage carapace={true}>
          <a
            class="btn btn--sm oc-action oc-action-secondary"
            href={props.backHref}
            onClick={(event) => {
              event.preventDefault();
              props.onBack();
            }}
          >
            <Icon name="chevronLeft" /> {props.backLabel}
          </a>
          <SettingsEmpty message={t("pluginsPage.pluginNotFound")} carapace={true} />
        </SettingsPage>
      ) : props.tab === "configuration" ? (
        <SettingsPage wide={true} carapace={true}>
          <PluginNotices {...props} />
          <PluginSettingsEditor
            model={props}
            resolveCredential={props.resolveCredential}
            onAskSetting={props.onAskSetting}
            permissions={permissionSettings(props)}
          />
        </SettingsPage>
      ) : (
        <>
          <PluginNotices {...props} />
          <PluginOverview {...props} />
        </>
      )}
    </>
  );
}
function PluginOverview(props: DetailProps): JSX.Element {
  const plugin = createMemo(() =>
    props.result!.plugins.find((entry) => entry.id === props.pluginId)!,
  );
  const catalog = createMemo(() => props.catalog ?? props.inspection?.catalog);
  const components = createMemo(() => props.inspection?.components);
  const catalogIcon = createMemo(() => {
    const url = catalog()?.plugin.catalog.imageUrl;
    return {
      src: url ? props.catalogIconUrls?.[url] : undefined,
      loading: Boolean(url && props.catalogIconLoading?.(url)),
    };
  });
  const authorIcon = createMemo(() => {
    const url = catalog()?.detail.author?.imageUrl;
    return {
      src: url ? props.catalogIconUrls?.[url] : undefined,
      loading: Boolean(url && props.catalogIconLoading?.(url)),
    };
  });
  const skills = createMemo(() =>
    (components()?.skills ?? []).map((name) => ({
      name,
      description: catalog()?.detail.skills.find((skill) => skill.name === name)?.description,
    })),
  );
  const tools = createMemo<PluginToolPreview[]>(
    () =>
      props.tools ??
      (props.inspection?.declared.tools ?? catalog()?.detail.contracts?.tools ?? []).map(
        (name) => ({ name }),
      ),
  );
  return (
    <SettingsPage wide={true} carapace={true}>
      <PluginDetailShell
        id={"plugin-installed-detail"}
        name={plugin().name}
        summary={plugin().description || catalog()?.plugin.catalog.summary}
        backHref={props.backHref}
        backLabel={props.backLabel}
        onBack={props.onBack}
        icon={renderArtTile(plugin().id, plugin().name, {
          iconUrl: props.iconUrls[plugin().id] ?? catalogIcon().src,
          onIconError: () => props.onIconError(plugin().id),
          authorIconUrl: authorIcon().src,
          loading:
            props.iconLoading?.(plugin().id) ||
            props.catalogLoading ||
            catalogIcon().loading ||
            authorIcon().loading,
        })}
        identity={renderPluginPublisher(catalog(), props.inspection?.overview?.publisherName)}
        titleAction={
          <Show
            when={Boolean(props.installProgress)}
            fallback={renderPluginLifecycle(
              {
                ...props,
                settingsHref: props.settingsHref ?? "#configuration",
                onSettings: () => props.onTabChange("configuration"),
              },
              plugin(),
            )}
          >
            <PluginInstallAction
              buttonClass="btn oc-action plugin-catalog-detail__install"
              primary={true}
              progress={props.installProgress}
            />
            {renderPluginAskAction(props.onAskPlugin, false)}
          </Show>
        }
        sidebar={
          catalog() || plugin().version || props.inspection?.overview || props.catalogLoading
            ? renderPluginMetadata(
                catalog(),
                plugin().version,
                props.inspection?.overview,
                props.catalogLoading,
              )
            : undefined
        }
        panel={
          <>
            {!props.inspection && !catalog() && !props.inspectionError ? (
              <SettingsLoadingSkeleton rows={2} carapace={true} />
            ) : null}
            {renderPluginCapabilitySection(
              t("pluginsPage.auth.accounts"),
              (props.inspection?.mcpAuth ?? []).map((server) => ({
                name: server.serverName,
                trailing: (
                  <PluginConnectionAction
                    kind="Account"
                    name={server.serverName}
                    ready={server.state === "authorized"}
                    disabled={
                      server.state === "authorized"
                        ? !props.onEditMcp
                        : !props.canMcpLogin || props.mcpLoginBusy || !props.onMcpLogin
                    }
                    onClick={() =>
                      server.state === "authorized"
                        ? props.onEditMcp?.()
                        : props.onMcpLogin?.(server.serverName)
                    }
                  />
                ),
              })),
              () => (
                <Icon name="circleUser" />
              ),
            )}
            {renderPluginCapabilitySection(
              t("pluginsPage.auth.credentials"),
              (props.inspection?.credentials ?? []).map((credential) => ({
                name: credential.envVars.join(" / ") || credential.label,
                trailing: (
                  <PluginConnectionAction
                    kind="Credential"
                    name={credential.label}
                    ready={credential.status === "configured"}
                    onClick={() => props.onTabChange("configuration")}
                  />
                ),
              })),
              () => (
                <Icon name="key" />
              ),
            )}
            {renderPluginDeclaredCapabilities(
              props.inspection?.overview?.capabilities?.contracts,
              props.inspection?.overview?.capabilities?.ui,
            )}
            {props.skillsSection ??
              renderPluginCapabilitySection(t("pluginsPage.detailTabs.skills"), skills(), () => (
                <Icon name="bookOpenText" />
              ))}
            {renderPluginCapabilitySection(
              t("pluginsPage.detailTools"),
              tools().map(({ name, description, parameters }) => ({
                name,
                description,
                onOpen:
                  (description?.trim() || parameters?.length) && props.onOpenTool
                    ? () => props.onOpenTool?.(name)
                    : undefined,
              })),
              () => (
                <Icon name="wrench" />
              ),
            )}
            {renderPluginMcpServers(
              components()?.mcpServers ?? catalog()?.detail.mcpServers ?? [],
              catalog()?.detail.mcpServerDetails,
            )}
          </>
        }
        readme={
          props.inspection?.overview?.readme || catalog()?.detail.readme
            ? renderPluginReadme(props.inspection?.overview?.readme ?? catalog()?.detail.readme)
            : undefined
        }
      />
    </SettingsPage>
  );
}
