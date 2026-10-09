import { html, nothing } from "lit";
import { keyed } from "lit/directives/keyed.js";
import type { AgentIdentityResult, AgentsListResult } from "../../api/types.ts";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import { shellLayoutTraits } from "../../app/shell-layout-traits.ts";
import { handleCopyButton } from "../../components/copy-button.ts";
import { renderHubTabs } from "../../components/hub-tabs.ts";
import {
  renderLearnMoreLink,
  renderSettingsEmpty,
  renderSettingsNavRow,
  renderSettingsSection,
} from "../../components/settings-ui.ts";
import "../../styles/agents.css";
import "../../styles/sidebar-markdown.css";
import "./memory/memory-panel.ts";
import { t } from "../../i18n/index.ts";
import { buildAgentContext } from "../../lib/agents/display.ts";
import type { AgentsPanel } from "../../lib/agents/index.ts";
import {
  currentConfigObject,
  type RuntimeConfigState,
} from "../../lib/config/config-state-model.ts";
import type { AgentConfigActions } from "./config-actions.ts";
import { renderAgentFiles } from "./panels-files.ts";
import { renderAgentOverview } from "./panels-overview.ts";
import { renderAgentSkills } from "./panels-skills.ts";
import { renderAgentChannels, renderAgentCron } from "./panels-status-files.ts";
import { renderAgentTools } from "./panels-tools-skills.ts";

const AGENTS_DOCS_URL = "https://docs.openclaw.ai/concepts/multi-agent";

type AgentsProps = {
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
  channels: Omit<
    Parameters<typeof renderAgentChannels>[0],
    "context" | "configForm" | "onSelectPanel"
  >;
  cron: Omit<
    Parameters<typeof renderAgentCron>[0],
    "basePath" | "context" | "canRunNow" | "onSelectPanel"
  >;
  agentFiles: Omit<Parameters<typeof renderAgentFiles>[0], "agentId" | "canWrite">;
  agentIdentityById: Record<string, AgentIdentityResult>;
  overview: Omit<
    Parameters<typeof renderAgentOverview>[0],
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
    Parameters<typeof renderAgentSkills>[0],
    keyof AgentConfigActions | "agentId" | "configForm" | "canPatchConfig"
  >;
  tools: Omit<
    Parameters<typeof renderAgentTools>[0],
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

export function renderAgentsPageHeader() {
  return html`
    <section class="content-header" ${shellLayoutTraits({ toolbarHeader: true })}>
      <div>
        <div class="page-title">${titleForRoute("agents")}</div>
        <div class="page-subtitle">
          ${subtitleForRoute("agents")} ${renderLearnMoreLink(AGENTS_DOCS_URL)}
        </div>
      </div>
    </section>
  `;
}

export function renderAgents(props: AgentsProps) {
  const config = currentConfigObject(props.config);
  const agents = props.agentsList?.agents ?? [];
  const defaultId = props.agentsList?.selectionRequired
    ? null
    : (props.agentsList?.defaultId ?? null);
  const selectedId = props.selectedAgentId;
  const selectedAgent = selectedId
    ? (agents.find((agent) => agent.id === selectedId) ?? null)
    : null;
  const selectedSkillCount =
    selectedId && props.agentSkills.activeAgentId === selectedId
      ? (props.agentSkills.report?.skills?.length ?? null)
      : null;

  const channelEntryCount = props.channels.snapshot
    ? Object.keys(props.channels.snapshot.channelAccounts ?? {}).length
    : null;
  const cronJobCount = selectedId ? props.cron.jobsTotal : null;
  const tabCounts: Record<string, number | null> = {
    files: props.agentFiles.agentFilesList?.files?.length ?? null,
    skills: selectedSkillCount,
    channels: channelEntryCount,
    cron: cronJobCount || null,
  };

  const renderSelectedPanel = (agent: AgentsListResult["agents"][number]) => {
    const configActions = {
      configForm: config,
      configLoading: props.config.configLoading,
      configSaving: props.config.configSaving,
      configDirty: props.config.configFormDirty,
      canUpdateConfig: props.access.canUpdateConfig,
      onConfigReload: props.onConfigReload,
      onConfigSave: props.onConfigSave,
    };
    switch (props.activePanel) {
      case "overview":
        return keyed(
          agent.id,
          renderAgentOverview({
            ...props.overview,
            ...configActions,
            agent,
            defaultId,
            agentFilesList: props.agentFiles.agentFilesList,
            agentIdentity: props.agentIdentityById[agent.id] ?? null,
            canUpdateIdentity: props.access.canUpdateIdentity,
            onSelectPanel: props.onSelectPanel,
          }),
        );
      case "files":
        return renderAgentFiles({
          ...props.agentFiles,
          agentId: agent.id,
          canWrite: props.access.canWriteFiles,
        });
      case "tools":
        return renderAgentTools({
          ...props.tools,
          ...configActions,
          agentId: agent.id,
        });
      case "skills":
        return renderAgentSkills({
          ...props.agentSkills,
          ...configActions,
          agentId: agent.id,
          canPatchConfig: props.access.canPatchConfig,
        });
      case "channels":
        return renderAgentChannels({
          ...props.channels,
          context: buildAgentContext(
            agent,
            config,
            props.agentFiles.agentFilesList,
            defaultId,
            props.agentIdentityById[agent.id] ?? null,
          ),
          configForm: config,
          onSelectPanel: props.onSelectPanel,
        });
      case "cron":
        return renderAgentCron({
          ...props.cron,
          basePath: props.basePath,
          context: buildAgentContext(
            agent,
            config,
            props.agentFiles.agentFilesList,
            defaultId,
            props.agentIdentityById[agent.id] ?? null,
          ),
          canRunNow: props.access.canRunCron,
          onSelectPanel: props.onSelectPanel,
        });
      case "memory":
        return html`
          <div class="settings-group agent-memory-import-row">
            ${renderSettingsNavRow({
              title: t("tabs.memory"),
              description: t("subtitles.memory"),
              onClick: () => props.onOpenMemorySettings?.(),
            })}
            ${renderSettingsNavRow({
              title: t("tabs.memoryImport"),
              description: t("subtitles.memoryImport"),
              onClick: () => props.onOpenMemoryImport?.(),
            })}
          </div>
          <openclaw-agent-memory-panel .agentId=${agent.id}></openclaw-agent-memory-panel>
        `;
    }
    return nothing;
  };

  return html`
    <div class="agents-layout">
      <section class="agents-toolbar">
        <div class="agents-toolbar-row">
          <div class="agents-toolbar-actions">
            ${
              props.access.canCreateAgent
                ? html`
                    <button
                      class="btn btn--sm btn--ghost agents-create-btn"
                      ?disabled=${props.loading}
                      @click=${props.onCreateAgent}
                    >
                      ${t("custodian.newAgent")}
                    </button>
                  `
                : nothing
            }
            ${
              selectedAgent
                ? html`
                    ${keyed(
                      selectedAgent.id,
                      html`
                        <button
                          type="button"
                          class="btn btn--sm btn--ghost"
                          @click=${(event: Event) =>
                            void handleCopyButton(event, selectedAgent.id, t("agents.copyId"))}
                        >
                          <span data-copy-label>${t("agents.copyId")}</span>
                        </button>
                      `,
                    )}
                    <button
                      type="button"
                      class="btn btn--sm btn--ghost"
                      ?disabled=${
                        !props.access.canUpdateConfig ||
                        Boolean(defaultId && selectedAgent.id === defaultId)
                      }
                      @click=${() => props.onSetDefault(selectedAgent.id)}
                    >
                      ${
                        defaultId && selectedAgent.id === defaultId
                          ? t("agents.default")
                          : t("agents.setDefault")
                      }
                    </button>
                    <button
                      type="button"
                      class="btn btn--sm btn--ghost"
                      @click=${() => props.onTogglePinnedAgent(selectedAgent.id)}
                    >
                      ${
                        props.pinnedAgentIds.includes(selectedAgent.id)
                          ? t("agents.unpinFromSwitcher")
                          : t("agents.pinToSwitcher")
                      }
                    </button>
                  `
                : nothing
            }
            <button
              class="btn btn--sm agents-refresh-btn"
              ?disabled=${props.loading}
              @click=${props.onRefresh}
            >
              ${props.loading ? t("common.loading") : t("common.refresh")}
            </button>
          </div>
        </div>
        ${
          props.error
            ? html`<div class="callout danger" style="margin-top: 8px;">${props.error}</div>`
            : nothing
        }
      </section>
      <section class="agents-main">
        <div class="settings-group">
          ${renderSettingsNavRow({
            title: t("agents.defaults.title"),
            description: t("agents.defaults.description"),
            onClick: props.onOpenAgentDefaults,
          })}
        </div>
        ${
          !selectedAgent
            ? renderSettingsSection(
                { title: t("agents.selectTitle") },
                renderSettingsEmpty(t("agents.selectSubtitle")),
              )
            : html`
                ${renderHubTabs({
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
                  ).map(([value, key]) => ({ value, label: t(key), count: tabCounts[value] })),
                  ariaLabel: t("tabs.agents"),
                  panelId: "agent-panel",
                  onSelect: props.onSelectPanel,
                })}
                <div
                  id="agent-panel"
                  class="settings-stack"
                  role="tabpanel"
                  aria-labelledby=${`agents-tab-${props.activePanel}`}
                >
                  ${
                    props.config.lastError
                      ? html`<div class="callout danger" role="alert">
                          ${props.config.lastError}
                        </div>`
                      : nothing
                  }
                  ${renderSelectedPanel(selectedAgent)}
                </div>
              `
        }
      </section>
    </div>
  `;
}
