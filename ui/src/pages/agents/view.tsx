import { Show, Switch, Match, createMemo } from "solid-js";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import { ShellLayoutBoundary } from "../../app/shell-layout-traits-solid.tsx";
import { handleCopyButton } from "../../components/copy-button-state.ts";
import { HubTabs } from "../../components/solid/hub-tabs.tsx";
import {
  SettingsEmpty,
  SettingsSection,
  SettingsNavRow,
  LearnMoreLink,
} from "../../components/solid/settings-ui.tsx";
import { registerPluginManagementEnglish } from "../../i18n/locales/en-plugin-management.ts";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { buildAgentContext } from "../../lib/agents/display.ts";
import "../../styles/agents.css";
import "../../styles/sidebar-markdown.css";
import { currentConfigObject } from "../../lib/config/config-state-model.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { ReasonedDisabledControl } from "../plugins/reasoned-disabled-control.tsx";
import type { AgentsPageView } from "./agents-page-state.ts";
import { AgentMemoryPanel } from "./memory/memory-panel.tsx";
import { AgentFiles } from "./panels-files.tsx";
import { AgentOverview } from "./panels-overview.tsx";
import { AgentSkills } from "./panels-skills.tsx";
import { AgentChannels, AgentCron } from "./panels-status-files.tsx";
import { AgentTools } from "./panels-tools-skills.tsx";

registerEnglishCatalog(registerSettingsEnglish);
registerEnglishCatalog(registerPluginManagementEnglish);

const AGENTS_DOCS_URL = "https://docs.openclaw.ai/concepts/multi-agent";

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
    | "lastError"
  >;
  overview: Omit<AgentsPageView["overview"], "modelSelectionPolicy" | "modelCatalogRetired"> &
    Partial<Pick<AgentsPageView["overview"], "modelSelectionPolicy" | "modelCatalogRetired">>;
  onOpenMemoryImport?: AgentsPageView["onOpenMemoryImport"];
  onOpenMemorySettings?: AgentsPageView["onOpenMemorySettings"];
};

export function AgentsPageHeader() {
  return (
    <ShellLayoutBoundary traits={{ toolbarHeader: true }}>
      <section class="content-header">
        <div>
          <div class="page-title">{titleForRoute("agents")}</div>
          <div class="page-subtitle">
            {subtitleForRoute("agents")} <LearnMoreLink url={AGENTS_DOCS_URL} />
          </div>
        </div>
      </section>
    </ShellLayoutBoundary>
  );
}

export function Agents(props: AgentsProps) {
  const config = createMemo(() => currentConfigObject(props.config), { equals: false });
  const defaultId = () =>
    props.readData().agentsList?.selectionRequired
      ? null
      : (props.readData().agentsList?.defaultId ?? null);
  const selectedAgent = createMemo(
    () =>
      props.readData().agentsList?.agents.find((agent) => agent.id === props.selectedAgentId) ??
      null,
  );
  const configActions = () => ({
    configForm: config(),
    configLoading: props.config.configLoading,
    configSaving: props.config.configSaving,
    configDirty: props.config.configFormDirty,
    canUpdateConfig: props.access.canUpdateConfig,
    onConfigReload: props.onConfigReload,
    onConfigSave: props.onConfigSave,
  });
  const context = () =>
    buildAgentContext(
      selectedAgent()!,
      config(),
      props.readData().agentFilesList,
      defaultId(),
      props.agentIdentityById[props.selectedAgentId!] ?? null,
    );
  const tabCounts = (): Record<string, number | null> => ({
    files: props.readData().agentFilesList?.files?.length ?? null,
    skills:
      props.selectedAgentId && props.readData().agentSkillsAgentId === props.selectedAgentId
        ? (props.readData().agentSkillsReport?.skills.length ?? null)
        : null,
    channels: props.readChannels().channelsSnapshot
      ? Object.keys(props.readChannels().channelsSnapshot?.channelAccounts ?? {}).length
      : null,
    cron: props.selectedAgentId ? props.readData().cron.cronJobsTotal || null : null,
  });
  return (
    <div class="agents-layout">
      <section class="agents-toolbar">
        <div class="agents-toolbar-row">
          <div class="agents-toolbar-actions">
            <ReasonedDisabledControl
              reason={!props.access.canCreateAgent ? t("custodian.accessRequired") : undefined}
            >
              <button
                class="btn btn--sm btn--ghost agents-create-btn"
                disabled={props.loading || !props.access.canCreateAgent}
                title={!props.access.canCreateAgent ? t("custodian.accessRequired") : undefined}
                onClick={() => props.onCreateAgent()}
              >
                {t("custodian.newAgent")}
              </button>
            </ReasonedDisabledControl>
            <Show when={selectedAgent()}>
              {(agent) => (
                <>
                  <Show when={agent().id} keyed>
                    {(id) => {
                      let label!: HTMLSpanElement;
                      return (
                        <button
                          type="button"
                          class="btn btn--sm btn--ghost"
                          onClick={(event) =>
                            void handleCopyButton(event, id, t("agents.copyId"), { label })
                          }
                        >
                          <span ref={(element) => (label = element)} data-copy-label>
                            {t("agents.copyId")}
                          </span>
                        </button>
                      );
                    }}
                  </Show>
                  <button
                    type="button"
                    class="btn btn--sm btn--ghost"
                    disabled={!props.access.canUpdateConfig || agent().id === defaultId()}
                    onClick={() => props.onSetDefault(agent().id)}
                  >
                    {agent().id === defaultId() ? t("agents.default") : t("agents.setDefault")}
                  </button>
                  <button
                    type="button"
                    class="btn btn--sm btn--ghost"
                    onClick={() => props.onTogglePinnedAgent(agent().id)}
                  >
                    {t(
                      props.pinnedAgentIds.includes(agent().id)
                        ? "agents.unpinFromSwitcher"
                        : "agents.pinToSwitcher",
                    )}
                  </button>
                </>
              )}
            </Show>
            <button
              class="btn btn--sm agents-refresh-btn"
              disabled={props.loading}
              onClick={() => props.onRefresh()}
            >
              {t(props.loading ? "common.loading" : "common.refresh")}
            </button>
          </div>
        </div>
        <Show when={props.error}>
          <div class="callout danger" style={{ "margin-top": "8px" }}>
            {props.error}
          </div>
        </Show>
      </section>
      <section class="agents-main">
        <div class="settings-group">
          <SettingsNavRow
            title={t("agents.defaults.title")}
            description={t("agents.defaults.description")}
            onClick={props.onOpenAgentDefaults}
          />
        </div>
        <Show
          when={selectedAgent()}
          fallback={
            <SettingsSection title={t("agents.selectTitle")}>
              <SettingsEmpty message={t("agents.selectSubtitle")} />
            </SettingsSection>
          }
        >
          {(agent) => (
            <>
              <HubTabs
                {...{
                  id: "agents",
                  active: props.readData().agentsPanel,
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
                  ).map(([value, key]) => ({ value, label: t(key), count: tabCounts()[value] })),
                  ariaLabel: t("tabs.agents"),
                  panelId: "agent-panel",
                  onSelect: props.onSelectPanel,
                }}
              />
              <div
                id="agent-panel"
                class="settings-stack"
                role="tabpanel"
                aria-labelledby={`agents-tab-${props.readData().agentsPanel}`}
              >
                <Show when={props.config.lastError}>
                  <div class="callout danger" role="alert">
                    {props.config.lastError}
                  </div>
                </Show>
                <Switch>
                  <Match when={props.readData().agentsPanel === "overview"}>
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
                          onSelectPanel={props.onSelectPanel}
                        />
                      )}
                    </Show>
                  </Match>
                  <Match when={props.readData().agentsPanel === "files"}>
                    <AgentFiles
                      {...props.agentFiles}
                      readData={props.readData}
                      agentId={agent().id}
                      canWrite={props.access.canWriteFiles}
                    />
                  </Match>
                  <Match when={props.readData().agentsPanel === "tools"}>
                    <AgentTools
                      {...props.tools}
                      {...configActions()}
                      readData={props.readData}
                      agentId={agent().id}
                    />
                  </Match>
                  <Match when={props.readData().agentsPanel === "skills"}>
                    <AgentSkills
                      {...props.agentSkills}
                      readData={props.readData}
                      {...configActions()}
                      agentId={agent().id}
                      canPatchConfig={props.access.canPatchConfig}
                    />
                  </Match>
                  <Match when={props.readData().agentsPanel === "channels"}>
                    <AgentChannels
                      {...props.channels}
                      readState={props.readChannels}
                      context={context()}
                      configForm={config()}
                      onSelectPanel={props.onSelectPanel}
                    />
                  </Match>
                  <Match when={props.readData().agentsPanel === "cron"}>
                    <AgentCron
                      {...props.cron}
                      readState={() => props.readData().cron}
                      basePath={props.basePath}
                      context={context()}
                      canRunNow={props.access.canRunCron}
                      onSelectPanel={props.onSelectPanel}
                    />
                  </Match>
                  <Match when={props.readData().agentsPanel === "memory"}>
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
              </div>
            </>
          )}
        </Show>
      </section>
    </div>
  );
}
