import { GitHubIdentityController } from "../../features/github-connections/github-identity-controller.ts";
import type { renderAgentFiles } from "./panels-status-files.ts";
import type { renderAgents } from "./view.ts";

type AgentsViewProps = Parameters<typeof renderAgents>[0];
type AgentFilesProps = Parameters<typeof renderAgentFiles>[0];

export function primaryModelPicker(container: ParentNode) {
  return container.querySelector(
    'openclaw-select-picker:has([role="listbox"][aria-label^="Primary model"])',
  );
}

export const inertAgentFileControls = {
  agentFileConflict: null,
  onLoadFiles: () => undefined,
  onSelectFile: () => undefined,
  onFileDraftChange: () => undefined,
  onFileReset: () => undefined,
  onFileSave: () => undefined,
  onFileReload: () => undefined,
  onFileOverwrite: () => undefined,
} satisfies Partial<AgentFilesProps>;

export function createAgentViewTestProps(
  overrides: Partial<AgentsViewProps> = {},
): AgentsViewProps {
  return {
    access: {
      canCreateAgent: true,
      canPatchConfig: true,
      canUpdateConfig: true,
      canUpdateIdentity: true,
      canWriteFiles: true,
      canRunCron: true,
    },
    basePath: "",
    loading: false,
    error: null,
    agentsList: {
      defaultId: "alpha",
      mainKey: "main",
      scope: "per-sender",
      agents: [{ id: "alpha", name: "Alpha" } as never, { id: "beta", name: "Beta" } as never],
    },
    selectedAgentId: "beta",
    activePanel: "overview",
    config: {
      configForm: null,
      configSnapshot: null,
      configLoading: false,
      configSaving: false,
      configFormDirty: false,
      lastError: null,
    },
    channels: {
      channelsSnapshot: null,
      channelsLoading: false,
      channelsError: null,
      channelsLastSuccess: null,
    },
    cron: {
      cronStatus: null,
      cronJobs: [],
      cronJobsTotal: 0,
      cronJobsHasMore: false,
      cronJobsLoadingMore: false,
      cronScopedTotal: null,
      cronScopedNextWakeAtMs: null,
      cronLoading: false,
      cronError: null,
    },
    agentFiles: {
      agentFilesList: null,
      agentFilesLoading: false,
      agentFilesError: null,
      agentFileActive: null,
      agentFileContents: {},
      agentFileDrafts: {},
      agentFileSaving: false,
      agentFileConflict: null,
    },
    agentFilesListError: null,
    agentIdentityLoading: false,
    agentIdentityError: null,
    agentIdentityById: {},
    identityDraft: { name: null, emoji: null, avatar: null },
    identityAvatarLoader: {
      resolve: (url) => url,
      imageErrorHandler: () => () => undefined,
    },
    identitySaving: false,
    identityError: null,
    agentSkills: {
      agentSkillsReport: null,
      agentSkillsLoading: false,
      agentSkillsError: null,
      agentSkillsAgentId: null,
      skillsFilter: "",
    },
    tools: {
      toolsCatalogLoading: false,
      toolsCatalogError: null,
      toolsCatalogResult: null,
      toolsEffectiveLoading: false,
      toolsEffectiveError: null,
      toolsEffectiveResult: null,
    },
    onOpenGitHubConnections: () => undefined,
    githubIdentity: new GitHubIdentityController({
      requestUpdate: () => undefined,
      runExternalMutation: async () => ({
        ok: false,
        reason: "unavailable",
        error: "Mutation unavailable in rendering test.",
      }),
    }),
    runtimeSessionKey: "main",
    runtimeSessionMatchesSelectedAgent: false,
    modelCatalog: [],
    decisionModels: [],
    modelCatalogStatus: { error: null, hasLoaded: false, stale: false, awaitingGateway: false },
    pinnedAgentIds: [],
    onRefresh: () => undefined,
    onCreateAgent: () => undefined,
    onSelectPanel: () => undefined,
    onLoadFiles: () => undefined,
    onSelectFile: () => undefined,
    onFileDraftChange: () => undefined,
    onFileReset: () => undefined,
    onFileSave: () => undefined,
    onFileReload: () => undefined,
    onFileOverwrite: () => undefined,
    onToolsProfileChange: () => undefined,
    onToolsOverridesChange: () => undefined,
    onConfigReload: () => undefined,
    onConfigSave: () => undefined,
    onModelChange: () => undefined,
    onDecisionModelChange: () => undefined,
    onModelFallbacksChange: () => undefined,
    onModelCatalogOpen: () => undefined,
    onChannelsRefresh: () => undefined,
    onCronRefresh: () => undefined,
    onCronLoadMore: () => undefined,
    onCronRunNow: () => undefined,
    onSkillsFilterChange: () => undefined,
    onSkillsRefresh: () => undefined,
    onAgentSkillToggle: () => undefined,
    onAgentSkillsClear: () => undefined,
    onAgentSkillsDisableAll: () => undefined,
    onSetDefault: () => undefined,
    onIdentityFieldChange: () => undefined,
    onIdentityAvatarSelect: () => undefined,
    onIdentitySave: () => undefined,
    onTogglePinnedAgent: () => undefined,
    onOpenAgentDefaults: () => undefined,
    ...overrides,
  };
}
