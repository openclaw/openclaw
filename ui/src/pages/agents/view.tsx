import {
  action,
  createMemo,
  createOptimistic,
  Errored,
  lazy,
  Loading,
  Match,
  onSettled,
  Show,
  Switch,
} from "solid-js";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import { ConfigError } from "../../components/config-error.tsx";
import { FloatingHeaderActions } from "../../components/solid/floating-header-actions.tsx";
import { HubTabs } from "../../components/solid/hub-tabs.tsx";
import { InlineAlert } from "../../components/solid/inline-alert.tsx";
import { RefreshButton } from "../../components/solid/refresh-button.tsx";
import {
  RetryAction,
  SettingsEmpty,
  SettingsUnavailable,
  SettingsPage,
  SettingsPageHeader,
  SettingsSection,
  SettingsNavRow,
  SettingsLoadingSkeleton,
  LearnMoreLink,
} from "../../components/solid/settings-ui.tsx";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { registerPluginManagementEnglish } from "../../i18n/locales/en-plugin-management.ts";
import { registerRouteSubtitlesEnglish } from "../../i18n/locales/en-route-subtitles.ts";
import "../../styles/agents.css";
import "../../styles/sidebar-markdown.css";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { buildAgentContext } from "../../lib/agents/display.ts";
import { resolveAgentSettingsReadFailure } from "../../lib/agents/settings-access.ts";
import { currentConfigObject } from "../../lib/config/config-state-model.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { createMediaQuery } from "../../lib/reactive/platform.ts";
import { AgentsPageMenu } from "./agents-page-menu.tsx";
import type { AgentsPageView } from "./agents-page-state.ts";
import { AgentFiles } from "./panels-files.tsx";
import { AgentOverview } from "./panels-overview.tsx";
import { AgentReadNotice, createAgentReadPending } from "./read-status.tsx";

registerRouteSubtitlesEnglish();

registerEnglishCatalog(registerSettingsEnglish);
registerEnglishCatalog(registerPluginManagementEnglish);

// Matches the phone rules in agents.css, where New agent and Refresh move into the menu.
const PHONE_WIDTH_QUERY = "(max-width: 640px)";
const AGENTS_DOCS_URL = "https://docs.openclaw.ai/concepts/multi-agent";
const AgentMemoryPanel = lazy(() => import("./memory/memory-panel.tsx"), {
  export: "AgentMemoryPanel",
});
const AgentCron = lazy(() => import("./panel-cron.tsx"), { export: "AgentCron" });
const AgentSkills = lazy(() => import("./panels-skills.tsx"), { export: "AgentSkills" });
const AgentChannels = lazy(() => import("./panels-status-files.tsx"), { export: "AgentChannels" });
const AgentTools = lazy(() => import("./panels-tools-skills.tsx"), { export: "AgentTools" });

export type AgentsProps = Omit<
  AgentsPageView,
  "config" | "overview" | "onOpenMemoryImport" | "onOpenMemorySettings"
> & {
  config: Pick<
    AgentsPageView["config"],
    | "configForm"
    | "configSnapshot"
    | "configLoading"
    | "configSaving"
    | "configFormDirty"
    | "configAutoSaveStatus"
    | "lastError"
  >;
  overview: Omit<AgentsPageView["overview"], "modelSelectionPolicy" | "modelCatalogRetired"> &
    Partial<Pick<AgentsPageView["overview"], "modelSelectionPolicy" | "modelCatalogRetired">>;
  onOpenMemoryImport?: AgentsPageView["onOpenMemoryImport"];
  onOpenMemorySettings?: AgentsPageView["onOpenMemorySettings"];
};

export function Agents(props: AgentsProps) {
  const panel = createMemo(() => props.readData().agentsPanel);
  const panelAccess = () => props.access.settings.panels[panel()];
  const visiblePanel = () => (panelAccess() === "available" ? panel() : null);
  const restricted = () => (
    <div class="agent-panel-restricted">
      <SettingsUnavailable message={t("agents.accessRestricted")} />
    </div>
  );
  const [defaultPending, setSettingDefault] = createOptimistic(false);
  const settingDefault = () => defaultPending() || props.config.configSaving;
  const defaultAction = action(function* (completion: Promise<void>, retired: Promise<void>) {
    if (retired === props.presentationRetired()) {
      setSettingDefault(true);
    }
    yield Promise.race([completion, retired]);
  });
  const setDefault = (agentId: string) => {
    const retired = props.presentationRetired();
    const completion = props.onSetDefault(agentId);
    onSettled(() => {
      void defaultAction(completion, retired);
    });
  };
  const rosterPending = createAgentReadPending(() => props.listRead);
  const config = () => currentConfigObject(props.config);
  const defaultId = () =>
    props.readData().agentsList?.selectionRequired
      ? null
      : (props.readData().agentsList?.defaultId ?? null);
  const selectedAgent = createMemo(
    () =>
      props
        .readData()
        .agentsList?.agents.find(
          (agent) => agent.kind !== "system" && agent.id === props.selectedAgentId,
        ) ?? null,
  );
  const configActions = () => ({
    configForm: config(),
    configLoading: props.config.configLoading,
    configSaving: props.config.configSaving,
    configDirty: props.config.configFormDirty,
    canUpdateConfig: props.access.canUpdateConfig,
  });
  const context = () =>
    buildAgentContext(
      selectedAgent()!,
      config(),
      props.readData().agentFilesList,
      defaultId(),
      props.agentIdentityById[props.selectedAgentId!] ?? null,
    );
  const phone = createMediaQuery(
    PHONE_WIDTH_QUERY,
    globalThis.matchMedia?.(PHONE_WIDTH_QUERY).matches ?? false,
  );
  const pageMenu = () => (
    <AgentsPageMenu
      agentId={selectedAgent()?.id ?? null}
      canCreateAgent={props.access.canCreateAgent}
      canSetDefault={props.access.canUpdateConfig}
      canDeleteAgent={props.access.canDeleteAgent}
      defaultLabel={
        settingDefault()
          ? t("common.saving")
          : selectedAgent()?.id === defaultId()
            ? t("agents.default")
            : t("agents.setDefault")
      }
      defaultDisabled={
        !props.access.canUpdateConfig || settingDefault() || selectedAgent()?.id === defaultId()
      }
      pinLabel={t(
        props.pinnedAgentIds.includes(selectedAgent()?.id ?? "")
          ? "agents.unpinFromSwitcher"
          : "agents.pinToSwitcher",
      )}
      deleteDisabled={!props.access.canDeleteAgent}
      onDelete={props.onDeleteAgent}
      showPhoneActions={phone()}
      createLabel={t("custodian.newAgent")}
      createDisabled={rosterPending() || !props.access.canCreateAgent}
      onCreate={props.onCreateAgent}
      refreshLabel={t(rosterPending() ? "common.loading" : "common.refresh")}
      refreshDisabled={rosterPending()}
      onSetDefault={setDefault}
      onTogglePinned={props.onTogglePinnedAgent}
      onRefresh={props.onRefresh}
    />
  );
  const pageActions = () => (
    <div class="agents-toolbar-actions">
      <RefreshButton
        class="agents-refresh-btn"
        label={t("common.refresh")}
        busy={rosterPending()}
        onClick={() => props.onRefresh()}
      />
      <Show when={!phone() && props.access.canCreateAgent}>
        <button
          class="btn btn--sm agents-create-btn"
          disabled={rosterPending()}
          onClick={() => props.onCreateAgent()}
        >
          {t("custodian.newAgent")}
        </button>
      </Show>
      <Show when={selectedAgent() || phone()}>
        <FloatingHeaderActions fallback={pageMenu()}>{pageMenu()}</FloatingHeaderActions>
      </Show>
    </div>
  );
  // Defaults apply to every agent, so this row stays out of the per-agent tab bar.
  const agentDefaultsRow = () => (
    <Show when={props.access.settings.reads.config}>
      <div class="settings-group">
        <SettingsNavRow
          title={t("agents.defaults.title")}
          description={t("agents.defaults.description")}
          onClick={props.onOpenAgentDefaults}
        />
      </div>
    </Show>
  );
  return (
    <>
      <SettingsPageHeader
        title={titleForRoute("agents")}
        subtitle={
          <>
            {subtitleForRoute("agents")} <LearnMoreLink url={AGENTS_DOCS_URL} />
          </>
        }
        actions={pageActions()}
      />
      <SettingsWorkspace>
        <SettingsPage wide>
          <div class="agents-layout">
            <AgentReadNotice request={props.listRead} />
            <section class="agents-main">
              <Show
                when={selectedAgent()}
                fallback={
                  <>
                    <SettingsSection title={t("agents.selectTitle")}>
                      <SettingsEmpty message={t("agents.selectSubtitle")} />
                    </SettingsSection>
                    {agentDefaultsRow()}
                  </>
                }
              >
                {(agent) => (
                  <>
                    <HubTabs
                      {...{
                        id: "agents",
                        active: panelAccess() === "available" ? panel() : null,
                        tabs: (
                          [
                            ["overview", "agents.tabs.overview"],
                            ["files", "agents.tabs.files"],
                            ["tools", "agents.tabs.tools"],
                            ["skills", "agents.tabs.skills"],
                            ["channels", "agents.tabs.channels"],
                            ["cron", "agents.tabs.cronJobs"],
                            ["memory", "agents.tabs.memory"],
                          ] as const
                        )
                          .filter(([value]) => props.access.settings.panels[value] !== "denied")
                          .map(([value, key]) => ({
                            value,
                            label: t(key),
                            disabled: props.access.settings.panels[value] === "pending",
                          })),
                        ariaLabel: t("tabs.agents"),
                        panelId: "agent-panel",
                        onSelect: props.onSelectPanel,
                      }}
                    />
                    <div
                      id="agent-panel"
                      class="settings-stack"
                      role="tabpanel"
                      aria-labelledby={
                        panelAccess() === "available" ? `agents-tab-${panel()}` : undefined
                      }
                    >
                      {/* A failed write is reported by the save status, without moving this page. */}
                      <Show
                        when={
                          visiblePanel() !== null &&
                          props.access.settings.reads.config &&
                          !props.config.configSaving &&
                          !["error", "rejected", "conflict"].includes(
                            props.config.configAutoSaveStatus,
                          )
                        }
                      >
                        <ConfigError message={props.config.lastError}>
                          {(message) => (
                            <InlineAlert tone="danger" class="agent-config-error" role="alert">
                              {message}
                              <Show when={!props.config.configSnapshot}>
                                <RetryAction
                                  disabled={props.config.configLoading}
                                  onRetry={props.onConfigRetry}
                                />
                              </Show>
                            </InlineAlert>
                          )}
                        </ConfigError>
                      </Show>
                      <Loading on={panel()} fallback={<SettingsLoadingSkeleton />}>
                        <Errored
                          fallback={(error, reset) => (
                            <Show
                              when={resolveAgentSettingsReadFailure(error()).state !== "denied"}
                              fallback={restricted()}
                            >
                              <InlineAlert tone="danger" role="alert">
                                {formatUiError(error())}
                                <Show when={resolveAgentSettingsReadFailure(error()).retryable}>
                                  <button class="btn" onClick={() => reset()}>
                                    {t("common.retry")}
                                  </button>
                                </Show>
                              </InlineAlert>
                            </Show>
                          )}
                        >
                          <Switch
                            fallback={
                              panelAccess() === "pending" ? (
                                <SettingsLoadingSkeleton />
                              ) : (
                                restricted()
                              )
                            }
                          >
                            <Match when={visiblePanel() === "overview"}>
                              <Show when={agent().id} keyed>
                                {(agentId) => (
                                  <AgentOverview
                                    {...props.overview}
                                    readData={props.readData}
                                    {...configActions()}
                                    agent={agent()}
                                    defaultId={defaultId()}
                                    agentFilesList={props.readData().agentFilesList}
                                    agentIdentity={props.agentIdentityById[agentId] ?? null}
                                    canUpdateIdentity={props.access.canUpdateIdentity}
                                    panelAccess={props.access.settings.panels}
                                    onSelectPanel={props.onSelectPanel}
                                  />
                                )}
                              </Show>
                              {agentDefaultsRow()}
                            </Match>
                            <Match when={visiblePanel() === "files"}>
                              <AgentFiles
                                {...props.agentFiles}
                                readData={props.readData}
                                presentationRetired={props.presentationRetired}
                                agentId={agent().id}
                                canWrite={props.access.canWriteFiles}
                              />
                            </Match>
                            <Match when={visiblePanel() === "tools"}>
                              <AgentTools
                                {...props.tools}
                                {...configActions()}
                                canReadConfig={props.access.settings.reads.config}
                                readData={props.readData}
                                agentId={agent().id}
                              />
                            </Match>
                            <Match when={visiblePanel() === "skills"}>
                              <AgentSkills
                                {...props.agentSkills}
                                readData={props.readData}
                                {...configActions()}
                                agentId={agent().id}
                                canPatchConfig={props.access.canPatchConfig}
                              />
                            </Match>
                            <Match when={visiblePanel() === "channels"}>
                              <AgentChannels
                                {...props.channels}
                                readState={props.readChannels}
                                context={context()}
                                configForm={config()}
                                onSelectPanel={props.onSelectPanel}
                              />
                            </Match>
                            <Match when={visiblePanel() === "cron"}>
                              <AgentCron
                                {...props.cron}
                                readState={() => props.readData().cron}
                                basePath={props.basePath}
                                context={context()}
                                canRunNow={props.access.canRunCron}
                                onSelectPanel={props.onSelectPanel}
                              />
                            </Match>
                            <Match when={visiblePanel() === "memory"}>
                              <div class="settings-group agent-memory-import-row">
                                <SettingsNavRow
                                  title={t("tabs.memory")}
                                  description={t("subtitles.memory")}
                                  onClick={() => props.onOpenMemorySettings?.()}
                                />
                                <SettingsNavRow
                                  title={t("tabs.memoryImport")}
                                  description={t("subtitles.memoryImport")}
                                  onClick={() => props.onOpenMemoryImport?.()}
                                />
                              </div>
                              <AgentMemoryPanel initialAgentTarget={props.memoryTarget} />
                            </Match>
                          </Switch>
                        </Errored>
                      </Loading>
                    </div>
                  </>
                )}
              </Show>
            </section>
          </div>
        </SettingsPage>
      </SettingsWorkspace>
    </>
  );
}
