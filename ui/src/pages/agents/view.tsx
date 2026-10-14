import { Show, Switch, Match, createMemo } from "solid-js";
import type { AgentIdentityResult, AgentsListResult } from "../../api/types.ts";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import { ShellLayoutBoundary } from "../../app/shell-layout-traits-solid.tsx";
import { handleCopyButton } from "../../components/copy-button.ts";
import { renderHubTabs } from "../../components/hub-tabs.ts";
import {
  SettingsEmpty,
  SettingsSection,
  SettingsNavRow,
  LearnMoreLink,
} from "../../components/solid/settings-ui.tsx";
import { buildAgentContext } from "../../lib/agents/display.ts";
import "../../styles/agents.css";
import "../../styles/sidebar-markdown.css";
import type { AgentsPanel } from "../../lib/agents/index.ts";
import {
  currentConfigObject,
  type RuntimeConfigState,
} from "../../lib/config/config-state-model.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { LitContent } from "../../lit/solid-bridge.ts";
import type { AgentConfigActions } from "./config-actions.tsx";
import { AgentMemoryPanel } from "./memory/memory-panel.tsx";
import { AgentFiles } from "./panels-files.tsx";
import { AgentOverview } from "./panels-overview.tsx";
import { AgentSkills } from "./panels-skills.tsx";
import { AgentChannels, AgentCron } from "./panels-status-files.tsx";
import { AgentTools } from "./panels-tools-skills.tsx";

const AGENTS_DOCS_URL = "https://docs.openclaw.ai/concepts/multi-agent";

export type AgentsProps = {
  access: {
    canCreateAgent: boolean;
    canPatchConfig: boolean;
    canUpdateConfig: boolean;
    canUpdateIdentity: boolean;
    canWriteFiles: boolean;
    canRunCron: boolean;
  };
  basePath: string;
  loading: boolean;
  error: string | null;
  agentsList: AgentsListResult | null;
  selectedAgentId: string | null;
  activePanel: AgentsPanel;
  config: Pick<
    RuntimeConfigState,
    | "configForm"
    | "configSnapshot"
    | "configLoading"
    | "configSaving"
    | "configFormDirty"
    | "lastError"
  >;
  channels: Omit<Parameters<typeof AgentChannels>[0], "context" | "configForm" | "onSelectPanel">;
  cron: Omit<
    Parameters<typeof AgentCron>[0],
    "basePath" | "context" | "canRunNow" | "onSelectPanel"
  >;
  agentFiles: Omit<Parameters<typeof AgentFiles>[0], "agentId" | "canWrite">;
  agentIdentityById: Record<string, AgentIdentityResult>;
  overview: Omit<
    Parameters<typeof AgentOverview>[0],
    | keyof AgentConfigActions
    | "agent"
    | "defaultId"
    | "configForm"
    | "agentFilesList"
    | "agentIdentity"
    | "canUpdateIdentity"
    | "onSelectPanel"
  >;
  agentSkills: Omit<
    Parameters<typeof AgentSkills>[0],
    keyof AgentConfigActions | "agentId" | "configForm" | "canPatchConfig"
  >;
  tools: Omit<
    Parameters<typeof AgentTools>[0],
    keyof AgentConfigActions | "agentId" | "configForm"
  >;
  pinnedAgentIds: readonly string[];
  onTogglePinnedAgent: (agentId: string) => void;
  onRefresh: () => void;
  onCreateAgent: () => void;
  onSelectPanel: (panel: AgentsPanel) => void;
  onConfigReload: () => void;
  onConfigSave: () => void;
  onOpenMemoryImport?: () => void;
  onOpenMemorySettings?: () => void;
  onOpenAgentDefaults: () => void;
  onSetDefault: (agentId: string) => void;
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
    props.agentsList?.selectionRequired ? null : (props.agentsList?.defaultId ?? null);
  const selectedAgent = createMemo(
    () => props.agentsList?.agents.find((agent) => agent.id === props.selectedAgentId) ?? null,
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
      props.agentFiles.agentFilesList,
      defaultId(),
      props.agentIdentityById[props.selectedAgentId!] ?? null,
    );
  const tabCounts = (): Record<string, number | null> => ({
    files: props.agentFiles.agentFilesList?.files?.length ?? null,
    skills:
      props.selectedAgentId && props.agentSkills.activeAgentId === props.selectedAgentId
        ? (props.agentSkills.report?.skills.length ?? null)
        : null,
    channels: props.channels.snapshot
      ? Object.keys(props.channels.snapshot.channelAccounts ?? {}).length
      : null,
    cron: props.selectedAgentId ? props.cron.jobsTotal || null : null,
  });
  return (
    <div class="agents-layout">
      <section class="agents-toolbar">
        <div class="agents-toolbar-row">
          <div class="agents-toolbar-actions">
            <Show when={props.access.canCreateAgent}>
              <button
                class="btn btn--sm btn--ghost agents-create-btn"
                disabled={props.loading}
                onClick={() => props.onCreateAgent()}
              >
                {t("custodian.newAgent")}
              </button>
            </Show>
            <Show when={selectedAgent()}>
              {(agent) => (
                <>
                  <Show when={agent().id} keyed>
                    {(id) => (
                      <button
                        type="button"
                        class="btn btn--sm btn--ghost"
                        onClick={(event) => void handleCopyButton(event, id, t("agents.copyId"))}
                      >
                        <span data-copy-label>{t("agents.copyId")}</span>
                      </button>
                    )}
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
              <LitContent
                render={() =>
                  renderHubTabs({
                    id: "agents",
                    active: props.activePanel,
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
                  })
                }
              />
              <div
                id="agent-panel"
                class="settings-stack"
                role="tabpanel"
                aria-labelledby={`agents-tab-${props.activePanel}`}
              >
                <Show when={props.config.lastError}>
                  <div class="callout danger" role="alert">
                    {props.config.lastError}
                  </div>
                </Show>
                <Switch>
                  <Match when={props.activePanel === "overview"}>
                    <Show when={agent().id} keyed>
                      {(agentId) => (
                        <AgentOverview
                          {...props.overview}
                          {...configActions()}
                          agent={agent()}
                          defaultId={defaultId()}
                          agentFilesList={props.agentFiles.agentFilesList}
                          agentIdentity={props.agentIdentityById[agentId] ?? null}
                          canUpdateIdentity={props.access.canUpdateIdentity}
                          onSelectPanel={props.onSelectPanel}
                        />
                      )}
                    </Show>
                  </Match>
                  <Match when={props.activePanel === "files"}>
                    <AgentFiles
                      {...props.agentFiles}
                      agentId={agent().id}
                      canWrite={props.access.canWriteFiles}
                    />
                  </Match>
                  <Match when={props.activePanel === "tools"}>
                    <AgentTools {...props.tools} {...configActions()} agentId={agent().id} />
                  </Match>
                  <Match when={props.activePanel === "skills"}>
                    <AgentSkills
                      {...props.agentSkills}
                      {...configActions()}
                      agentId={agent().id}
                      canPatchConfig={props.access.canPatchConfig}
                    />
                  </Match>
                  <Match when={props.activePanel === "channels"}>
                    <AgentChannels
                      {...props.channels}
                      context={context()}
                      configForm={config()}
                      onSelectPanel={props.onSelectPanel}
                    />
                  </Match>
                  <Match when={props.activePanel === "cron"}>
                    <AgentCron
                      {...props.cron}
                      basePath={props.basePath}
                      context={context()}
                      canRunNow={props.access.canRunCron}
                      onSelectPanel={props.onSelectPanel}
                    />
                  </Match>
                  <Match when={props.activePanel === "memory"}>
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
                    <AgentMemoryPanel agentId={agent().id} />
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
