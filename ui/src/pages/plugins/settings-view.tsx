import type { JSX } from "@solidjs/web";
import { Errored, Loading, Show, createMemo } from "solid-js";
import { resolveConfigObjectFields } from "../../components/config-form.node.collection.ts";
import { Icon } from "../../components/solid/icon.tsx";
import {
  SettingsEmpty,
  SettingsLoadingSkeleton,
  SettingsPage,
} from "../../components/solid/settings-ui.tsx";
import type { JsonSchema } from "../../lib/config-form-utils.ts";
import { formatUiError, formatUiExternalText } from "../../lib/format-error.ts";
import type { PluginDiscoveryDetailResult, PluginsInspectResult } from "../../lib/plugins/index.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { renderPluginReadme } from "./catalog-detail.tsx";
import { PluginArtTile } from "./consent-dialog.tsx";
import { renderPluginDetailShell as PluginDetailShell } from "./detail-shell.tsx";
import "./custom-elements.ts";
import type { InstalledPluginDetailTab } from "./detail-tabs.ts";
import { PluginInstallAction, type PluginInstallActionProps } from "./install-action.tsx";
import type { PluginInstallProgress } from "./install-progress.ts";
import {
  renderPluginCapabilitySection,
  renderPluginCompatibilityNotices,
  renderPluginContentCapabilities,
  renderPluginMetadata,
  renderPluginPublisher,
  renderPluginAskAction,
} from "./overview.tsx";
import {
  pluginRowKey,
  renderPluginRowMessage,
  type PluginRowMessage,
} from "./plugin-row-message.tsx";
import type { PluginDetailRead } from "./plugins-detail-reads.ts";
import type { PluginMutationAction } from "./plugins-page-model.ts";
import {
  flattenPluginSettingsFields,
  pluginSettingsNodeOptions,
  PluginSettingsEditor,
  type PluginSettingsEditorProps,
  type PluginSettingsField,
} from "./settings-editor.tsx";
import { PluginLifecycle } from "./settings-lifecycle.tsx";
import { pluginEntryValue, type PluginSettingsEditorModel } from "./settings-model.ts";
import { PluginRetryError } from "./settings-retry-error.tsx";
import type { PluginToolPreview } from "./tool-preview.tsx";
export type PluginSettingsTab = "installed" | "advanced";
type SharedProps = Omit<
  PluginSettingsEditorModel,
  "pluginId" | "configSchema" | "backHref" | "onBack"
> & {
  registerRemovalHeading?: (heading: HTMLHeadingElement) => () => void;
  registerInstallAction?: PluginInstallActionProps["registerInstallAction"];
  registerIcon?: (readId: () => string) => () => void;
  loading: boolean;
  error: string | null;
  busy: Readonly<Record<string, PluginMutationAction>>;
  presentedEnabled?: (pluginId: string) => boolean | undefined;
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
export type InventoryProps = SharedProps & {
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
    canMcpLogout?: boolean;
    onMcpLogout?: (serverName: string) => void;
    installProgress?: PluginInstallProgress;
    onAskSetting?: (field: PluginSettingsField) => void;
    skillsSection?: JSX.Element;
    tools?: PluginToolPreview[];
    onOpenTool?: (name: string) => void;
    settingsHref?: string;
    inspection: PluginsInspectResult | null;
    inspectionRead: PluginDetailRead;
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
const CONNECTION_VERBS = { Account: ["connect", "signOut"], Credential: ["configure", "edit"] };
function PluginConnectionAction(props: {
  kind: "Account" | "Credential";
  ready: boolean;
  name: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  const verb = () => CONNECTION_VERBS[props.kind][props.ready ? 1 : 0];
  return (
    <>
      <button
        type="button"
        class="btn btn--sm oc-action oc-action-secondary"
        aria-label={t(`pluginsPage.auth.${verb()}${props.kind}`, { name: props.name })}
        disabled={props.disabled}
        onClick={() => props.onClick()}
      >
        {t(`pluginsPage.auth.${verb()}`)}
      </button>
      {props.ready ? (
        <span class="plugin-connection-status" role="status">
          <Icon name="check" />
          {t(
            props.kind === "Account" ? "pluginsPage.auth.connected" : "pluginsPage.auth.configured",
          )}
        </span>
      ) : null}
    </>
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
function PluginInspectionStatus(props: DetailProps) {
  const source = createMemo(() => props.inspectionRead);
  const receipt = createMemo(() => source().receipt());
  const read = () => source().value();
  const placeholder = () =>
    !props.inspection && !props.catalog ? (
      <SettingsLoadingSkeleton rows={2} carapace={true} />
    ) : null;
  return (
    <Loading on={receipt()} fallback={placeholder()}>
      <Errored
        fallback={(error, reset) => (
          <PluginRetryError
            error={formatUiError(error())}
            onRetry={() => {
              props.onRetryInspection();
              reset();
            }}
          />
        )}
      >
        {read()}
      </Errored>
    </Loading>
  );
}

function PluginNotices(props: DetailProps) {
  const plugin = createMemo(() =>
    props.result?.plugins.find((entry) => entry.id === props.pluginId),
  );
  return (
    <>
      {props.error ? <PluginRetryError error={props.error} onRetry={props.onRefresh} /> : null}
      <PluginInspectionStatus {...props} />
      {plugin()?.error ? (
        <div class="callout danger oc-banner oc-banner-error" role="alert">
          {formatUiExternalText(plugin()!.error!)}
        </div>
      ) : null}
      {renderPluginRowMessage(props.messages[pluginRowKey(props.pluginId)])}
      {renderPluginCompatibilityNotices(plugin()?.compatibilityNotices, true)}
    </>
  );
}
export function renderPluginSettingsDetail(props: DetailProps): JSX.Element {
  const plugin = createMemo(() =>
    props.result?.plugins.find((entry) => entry.id === props.pluginId),
  );
  return (
    <>
      {!props.connected && !props.result ? (
        <SettingsPage carapace={true}>
          <SettingsEmpty message={t("pluginsPage.connectToManage")} carapace={true} />
        </SettingsPage>
      ) : props.error && !props.result ? (
        <SettingsPage carapace={true}>
          <PluginRetryError error={props.error} onRetry={props.onRefresh} />
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
        <PluginOverview {...props} />
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
  const mcpDescription = () => {
    const inspection = props.inspection;
    // Only a single-purpose bundle's description can describe its individual server.
    if (
      !inspection ||
      !plugin().enabled ||
      catalog()?.plugin.catalog.family !== "bundle-plugin" ||
      inspection.components.mcpServers.length !== 1 ||
      inspection.declared.mcpServers.length !== 1 ||
      inspection.components.unavailable.capabilities.length > 0 ||
      inspection.components.mapped.some((kind) => kind !== "mcpServers") ||
      Object.entries(inspection.declared).some(
        ([kind, values]) => kind !== "mcpServers" && values.length > 0,
      ) ||
      tools().length > 0 ||
      skills().length > 0
    ) {
      return undefined;
    }
    return catalog()?.plugin.catalog.summary?.trim() || plugin().description?.trim();
  };
  const catalogIcon = () => {
    const url = catalog()?.plugin.catalog.imageUrl;
    return {
      src: url ? props.catalogIconUrls?.[url] : undefined,
      loading: Boolean(url && props.catalogIconLoading?.(url)),
    };
  };
  const authorIcon = () => {
    const url = catalog()?.detail.author?.imageUrl;
    return {
      src: url ? props.catalogIconUrls?.[url] : undefined,
      loading: Boolean(url && props.catalogIconLoading?.(url)),
    };
  };
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
  const signInServer = createMemo(() =>
    props.canMcpLogin && props.onMcpLogin
      ? props.inspection?.mcpAuth?.find((entry) => entry.state !== "authorized")?.serverName
      : undefined,
  );
  return (
    <SettingsPage wide={true} carapace={true}>
      <PluginDetailShell
        registerRemovalHeading={props.registerRemovalHeading}
        id={"plugin-installed-detail"}
        name={plugin().name}
        summary={plugin().description || catalog()?.plugin.catalog.summary}
        backHref={props.backHref}
        backLabel={props.backLabel}
        onBack={props.onBack}
        icon={
          <PluginArtTile
            registerIcon={props.registerIcon}
            slug={plugin().id}
            name={plugin().name}
            iconUrl={props.iconUrls[plugin().id] ?? catalogIcon().src}
            onIconError={() => props.onIconError(plugin().id)}
            authorIconUrl={authorIcon().src}
            loading={
              props.iconLoading?.(plugin().id) ||
              props.catalogLoading ||
              catalogIcon().loading ||
              authorIcon().loading
            }
          />
        }
        identity={renderPluginPublisher(catalog(), props.inspection?.overview?.publisherName)}
        titleAction={
          <Show
            when={Boolean(props.installProgress)}
            fallback={
              <PluginLifecycle
                {...props}
                signInServer={signInServer()}
                settingsHref={props.settingsHref ?? "#configuration"}
                onSettings={() => props.onTabChange("configuration")}
                plugin={plugin()}
                enabled={props.presentedEnabled?.(plugin().id) ?? plugin().enabled}
              />
            }
          >
            <PluginInstallAction
              registerInstallAction={props.registerInstallAction}
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
            <PluginNotices {...props} />
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
                      props.mcpLoginBusy ||
                      (server.state === "authorized"
                        ? !props.canMcpLogout || !props.onMcpLogout
                        : !props.canMcpLogin || !props.onMcpLogin)
                    }
                    onClick={() =>
                      server.state === "authorized"
                        ? props.onMcpLogout?.(server.serverName)
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
            {renderPluginContentCapabilities({
              contracts: props.inspection?.overview?.capabilities?.contracts,
              uiCapabilities: props.inspection?.overview?.capabilities?.ui,
              skillsSection: props.skillsSection,
              skills: skills(),
              tools: tools().map(({ name, description, parameters }) => ({
                name,
                description,
                onOpen:
                  (description?.trim() || parameters?.length) && props.onOpenTool
                    ? () => props.onOpenTool?.(name)
                    : undefined,
              })),
              mcpServers: components()?.mcpServers ?? catalog()?.detail.mcpServers ?? [],
              mcpServerDetails: catalog()?.detail.mcpServerDetails,
              mcpDescription: mcpDescription(),
            })}
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
