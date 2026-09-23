// Control UI view renders agents screen content.
import { html, nothing } from "lit";
import { keyed } from "lit/directives/keyed.js";
import type { AgentIdentityResult, AgentsListResult, ModelCatalogEntry } from "../../api/types.ts";
import { handleCopyButton } from "../../components/copy-button.ts";
import type { DecisionModelEntry } from "../../components/decision-model-picker.ts";
import { renderHubTabs } from "../../components/hub-tabs.ts";
import type { PanelRefreshStatus } from "../../components/panel-refresh-status.ts";
import {
  renderSettingsEmpty,
  renderSettingsNavRow,
  renderSettingsSection,
} from "../../components/settings-ui.ts";
import type { GitHubIdentityController } from "../../features/github-connections/github-identity-controller.ts";
import { t } from "../../i18n/index.ts";
import "../../styles/agents.css";
import "../../styles/sidebar-markdown.css";
import "./memory/memory-panel.ts";
import { buildAgentContext } from "../../lib/agents/display.ts";
import type { AgentsPanel, AgentsState } from "../../lib/agents/index.ts";
import type { ChannelsState } from "../../lib/channels/index.ts";
import {
  currentConfigObject,
  type RuntimeConfigState,
} from "../../lib/config/config-state-model.ts";
import type { CronState } from "../../lib/cron/types.ts";
import type { AgentFilesViewState } from "./files.ts";
import { renderAgentFiles } from "./panels-files.ts";
import type { AgentIdentityDraft, IdentityAvatarLoader } from "./panels-overview.ts";
import { renderAgentOverview } from "./panels-overview.ts";
import { renderAgentSkills } from "./panels-skills.ts";
import { renderAgentChannels, renderAgentCron } from "./panels-status-files.ts";
import { renderAgentTools } from "./panels-tools-skills.ts";
import type { AgentSkillsState } from "./skills.ts";

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
  channels: Pick<
    ChannelsState,
    "channelsSnapshot" | "channelsLoading" | "channelsError" | "channelsLastSuccess"
  >;
  cron: Pick<
    CronState,
    | "cronStatus"
    | "cronJobs"
    | "cronJobsTotal"
    | "cronJobsHasMore"
    | "cronJobsLoadingMore"
    | "cronScopedTotal"
    | "cronScopedNextWakeAtMs"
    | "cronLoading"
    | "cronError"
  >;
  agentFiles: AgentFilesViewState;
  agentFilesListError: string | null;
  agentIdentityLoading: boolean;
  agentIdentityError: string | null;
  agentIdentityById: Record<string, AgentIdentityResult>;
  identityDraft: AgentIdentityDraft;
  identityAvatarLoader: IdentityAvatarLoader;
  identitySaving: boolean;
  identityError: string | null;
  agentSkills: Pick<
    AgentSkillsState,
    "agentSkillsReport" | "agentSkillsLoading" | "agentSkillsError" | "agentSkillsAgentId"
  > & { skillsFilter: string };
  tools: Pick<
    AgentsState,
    | "toolsCatalogLoading"
    | "toolsCatalogError"
    | "toolsCatalogResult"
    | "toolsEffectiveLoading"
    | "toolsEffectiveError"
    | "toolsEffectiveResult"
  >;
  githubIdentity: GitHubIdentityController;
  onOpenGitHubConnections: () => void;
  runtimeSessionKey: string;
  runtimeSessionMatchesSelectedAgent: boolean;
  modelCatalog: ModelCatalogEntry[];
  decisionModels: DecisionModelEntry[];
  modelCatalogStatus: PanelRefreshStatus;
  pinnedAgentIds: readonly string[];
  onTogglePinnedAgent: (agentId: string) => void;
  onRefresh: () => void;
  onCreateAgent: () => void;
  onSelectPanel: (panel: AgentsPanel) => void;
  onLoadFiles: (agentId: string) => void;
  onSelectFile: (name: string) => void;
  onFileDraftChange: (name: string, content: string) => void;
  onFileReset: (name: string) => void;
  onFileSave: (name: string) => void;
  onFileReload: (name: string) => void;
  onFileOverwrite: (name: string) => void;
  onToolsProfileChange: (agentId: string, profile: string | null, clearAllow: boolean) => void;
  onToolsOverridesChange: (agentId: string, alsoAllow: string[], deny: string[]) => void;
  onConfigReload: () => void;
  onConfigSave: () => void;
  onIdentityFieldChange: (field: "name" | "emoji", value: string) => void;
  onIdentityAvatarSelect: (file: File) => void;
  onIdentitySave: () => void;
  onModelChange: (agentId: string, modelId: string | null) => void;
  onDecisionModelChange: (agentId: string, modelId: string | null) => void;
  onModelFallbacksChange: (agentId: string, fallbacks: string[]) => void;
  onModelCatalogOpen: () => void;
  onChannelsRefresh: () => void;
  onOpenMemoryImport?: () => void;
  onOpenMemorySettings?: () => void;
  onOpenAgentDefaults: () => void;
  onCronRefresh: () => void;
  onCronLoadMore: () => void;
  onCronRunNow: (jobId: string) => void;
  onSkillsFilterChange: (next: string) => void;
  onSkillsRefresh: () => void;
  onAgentSkillToggle: (agentId: string, skillName: string, enabled: boolean) => void;
  onAgentSkillsClear: (agentId: string) => void;
  onAgentSkillsDisableAll: (agentId: string) => void;
  onSetDefault: (agentId: string) => void;
};

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
    selectedId && props.agentSkills.agentSkillsAgentId === selectedId
      ? (props.agentSkills.agentSkillsReport?.skills?.length ?? null)
      : null;

  const channelEntryCount = props.channels.channelsSnapshot
    ? Object.keys(props.channels.channelsSnapshot.channelAccounts ?? {}).length
    : null;
  const cronJobCount = selectedId ? props.cron.cronJobsTotal : null;
  const tabCounts: Record<string, number | null> = {
    files: props.agentFiles.agentFilesList?.files?.length ?? null,
    skills: selectedSkillCount,
    channels: channelEntryCount,
    cron: cronJobCount || null,
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
                ${renderAgentTabs(
                  props.activePanel,
                  (panel) => props.onSelectPanel(panel),
                  tabCounts,
                )}
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
                  ${
                    props.activePanel === "overview"
                      ? keyed(
                          selectedAgent.id,
                          renderAgentOverview({
                            agent: selectedAgent,
                            basePath: props.basePath,
                            defaultId,
                            configForm: config,
                            agentFilesList: props.agentFiles.agentFilesList,
                            agentIdentity: props.agentIdentityById[selectedAgent.id] ?? null,
                            agentIdentityError: props.agentIdentityError,
                            agentIdentityLoading: props.agentIdentityLoading,
                            identityDraft: props.identityDraft,
                            identityAvatarLoader: props.identityAvatarLoader,
                            identitySaving: props.identitySaving,
                            identityError: props.identityError,
                            canUpdateConfig: props.access.canUpdateConfig,
                            canUpdateIdentity: props.access.canUpdateIdentity,
                            configLoading: props.config.configLoading,
                            configSaving: props.config.configSaving,
                            configDirty: props.config.configFormDirty,
                            modelCatalog: props.modelCatalog,
                            decisionModels: props.decisionModels,
                            modelCatalogStatus: props.modelCatalogStatus,
                            onConfigReload: props.onConfigReload,
                            onConfigSave: props.onConfigSave,
                            onIdentityFieldChange: props.onIdentityFieldChange,
                            onIdentityAvatarSelect: props.onIdentityAvatarSelect,
                            onIdentitySave: props.onIdentitySave,
                            onModelChange: props.onModelChange,
                            onDecisionModelChange: props.onDecisionModelChange,
                            onModelFallbacksChange: props.onModelFallbacksChange,
                            onModelCatalogOpen: props.onModelCatalogOpen,
                            onSelectPanel: props.onSelectPanel,
                          }),
                        )
                      : nothing
                  }
                  ${
                    props.activePanel === "files"
                      ? renderAgentFiles({
                          agentId: selectedAgent.id,
                          agentFilesList: props.agentFiles.agentFilesList,
                          agentFilesLoading: props.agentFiles.agentFilesLoading,
                          agentFilesError:
                            props.agentFiles.agentFilesError ?? props.agentFilesListError,
                          agentFileActive: props.agentFiles.agentFileActive,
                          agentFileContents: props.agentFiles.agentFileContents,
                          agentFileDrafts: props.agentFiles.agentFileDrafts,
                          agentFileSaving: props.agentFiles.agentFileSaving,
                          agentFileConflict: props.agentFiles.agentFileConflict,
                          canWrite: props.access.canWriteFiles,
                          onLoadFiles: props.onLoadFiles,
                          onSelectFile: props.onSelectFile,
                          onFileDraftChange: props.onFileDraftChange,
                          onFileReset: props.onFileReset,
                          onFileSave: props.onFileSave,
                          onFileReload: props.onFileReload,
                          onFileOverwrite: props.onFileOverwrite,
                        })
                      : nothing
                  }
                  ${
                    props.activePanel === "tools"
                      ? renderAgentTools({
                          agentId: selectedAgent.id,
                          configForm: config,
                          configLoading: props.config.configLoading,
                          configSaving: props.config.configSaving,
                          configDirty: props.config.configFormDirty,
                          toolsCatalogLoading: props.tools.toolsCatalogLoading,
                          toolsCatalogError: props.tools.toolsCatalogError,
                          toolsCatalogResult: props.tools.toolsCatalogResult,
                          toolsEffectiveLoading: props.tools.toolsEffectiveLoading,
                          toolsEffectiveError: props.tools.toolsEffectiveError,
                          toolsEffectiveResult: props.tools.toolsEffectiveResult,
                          runtimeSessionKey: props.runtimeSessionKey,
                          runtimeSessionMatchesSelectedAgent:
                            props.runtimeSessionMatchesSelectedAgent,
                          canUpdateConfig: props.access.canUpdateConfig,
                          githubIdentity: props.githubIdentity,
                          onOpenGitHubConnections: props.onOpenGitHubConnections,
                          onProfileChange: props.onToolsProfileChange,
                          onOverridesChange: props.onToolsOverridesChange,
                          onConfigReload: props.onConfigReload,
                          onConfigSave: props.onConfigSave,
                        })
                      : nothing
                  }
                  ${
                    props.activePanel === "skills"
                      ? renderAgentSkills({
                          agentId: selectedAgent.id,
                          report: props.agentSkills.agentSkillsReport,
                          loading: props.agentSkills.agentSkillsLoading,
                          error: props.agentSkills.agentSkillsError,
                          activeAgentId: props.agentSkills.agentSkillsAgentId,
                          configForm: config,
                          configLoading: props.config.configLoading,
                          configSaving: props.config.configSaving,
                          configDirty: props.config.configFormDirty,
                          filter: props.agentSkills.skillsFilter,
                          canPatchConfig: props.access.canPatchConfig,
                          canUpdateConfig: props.access.canUpdateConfig,
                          onFilterChange: props.onSkillsFilterChange,
                          onRefresh: props.onSkillsRefresh,
                          onToggle: props.onAgentSkillToggle,
                          onClear: props.onAgentSkillsClear,
                          onDisableAll: props.onAgentSkillsDisableAll,
                          onConfigReload: props.onConfigReload,
                          onConfigSave: props.onConfigSave,
                        })
                      : nothing
                  }
                  ${
                    props.activePanel === "channels"
                      ? renderAgentChannels({
                          context: buildAgentContext(
                            selectedAgent,
                            config,
                            props.agentFiles.agentFilesList,
                            defaultId,
                            props.agentIdentityById[selectedAgent.id] ?? null,
                          ),
                          configForm: config,
                          snapshot: props.channels.channelsSnapshot,
                          loading: props.channels.channelsLoading,
                          error: props.channels.channelsError,
                          lastSuccess: props.channels.channelsLastSuccess,
                          onRefresh: props.onChannelsRefresh,
                          onSelectPanel: props.onSelectPanel,
                        })
                      : nothing
                  }
                  ${
                    props.activePanel === "cron"
                      ? renderAgentCron({
                          basePath: props.basePath,
                          context: buildAgentContext(
                            selectedAgent,
                            config,
                            props.agentFiles.agentFilesList,
                            defaultId,
                            props.agentIdentityById[selectedAgent.id] ?? null,
                          ),
                          agentId: selectedAgent.id,
                          jobs: props.cron.cronJobs,
                          jobsTotal: props.cron.cronJobsTotal,
                          jobsHasMore: props.cron.cronJobsHasMore,
                          jobsLoadingMore: props.cron.cronJobsLoadingMore,
                          status: props.cron.cronStatus,
                          scopedTotal: props.cron.cronScopedTotal,
                          scopedNextWakeAtMs: props.cron.cronScopedNextWakeAtMs,
                          loading: props.cron.cronLoading,
                          error: props.cron.cronError,
                          canRunNow: props.access.canRunCron,
                          onRefresh: props.onCronRefresh,
                          onLoadMore: props.onCronLoadMore,
                          onRunNow: props.onCronRunNow,
                          onSelectPanel: props.onSelectPanel,
                        })
                      : nothing
                  }
                  ${
                    props.activePanel === "memory"
                      ? html`
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
                          <openclaw-agent-memory-panel
                            .agentId=${selectedAgent.id}
                          ></openclaw-agent-memory-panel>
                        `
                      : nothing
                  }
                </div>
              `
        }
      </section>
    </div>
  `;
}

function renderAgentTabs(
  active: AgentsPanel,
  onSelect: (panel: AgentsPanel) => void,
  counts: Record<string, number | null>,
) {
  const tabs: Array<{ id: AgentsPanel; label: string }> = [
    { id: "overview", label: t("agents.tabs.overview") },
    { id: "files", label: t("agents.tabs.files") },
    { id: "tools", label: t("agents.tabs.tools") },
    { id: "skills", label: t("agents.tabs.skills") },
    { id: "channels", label: t("agents.tabs.channels") },
    { id: "cron", label: t("agents.tabs.cronJobs") },
    { id: "memory", label: t("agents.tabs.memory") },
  ];
  return renderHubTabs({
    id: "agents",
    active,
    tabs: tabs.map((tab) => ({
      value: tab.id,
      label: tab.label,
      count: counts[tab.id],
    })),
    ariaLabel: t("tabs.agents"),
    panelId: "agent-panel",
    onSelect,
  });
}
