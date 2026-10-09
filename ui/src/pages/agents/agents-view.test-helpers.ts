import { GitHubIdentityController } from "../../features/github-connections/github-identity-controller.ts";
import type { renderAgentFiles } from "./panels-files.ts";
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
      snapshot: null,
      loading: false,
      error: null,
      lastSuccess: null,
      onRefresh: () => undefined,
    },
    cron: {
      status: null,
      jobs: [],
      jobsTotal: 0,
      jobsHasMore: false,
      jobsLoadingMore: false,
      scopedTotal: null,
      scopedNextWakeAtMs: null,
      loading: false,
      error: null,
      onRefresh: () => undefined,
      onLoadMore: () => undefined,
      onRunNow: () => undefined,
    },
    agentFiles: {
      agentFilesList: null,
      agentFilesLoading: false,
      agentFilesError: null,
      agentFileActive: null,
      agentFileEditors: {},
      agentFileSaving: false,
      ...inertAgentFileControls,
    },
    agentIdentityById: {},
    overview: {
      identityDraft: { name: null, emoji: null, avatar: null },
      identityAvatarLoader: {
        resolve: (url) => url,
        imageErrorHandler: () => () => undefined,
      },
      identitySaving: false,
      identityError: null,
      modelCatalog: [],
      decisionModels: [],
      modelCatalogRetired: false,
      modelCatalogStatus: { error: null, hasLoaded: false, stale: false, awaitingGateway: false },
      onModelChange: () => undefined,
      onDecisionModelChange: () => undefined,
      onModelFallbacksChange: () => undefined,
      onModelCatalogOpen: () => undefined,
      onIdentityFieldChange: () => undefined,
      onIdentityAvatarSelect: () => undefined,
      onIdentitySave: () => undefined,
    },
    agentSkills: {
      report: null,
      loading: false,
      error: null,
      activeAgentId: null,
      filter: "",
      onFilterChange: () => undefined,
      onRefresh: () => undefined,
      onToggle: () => undefined,
      onClear: () => undefined,
      onDisableAll: () => undefined,
    },
    tools: {
      toolsCatalogLoading: false,
      toolsCatalogError: null,
      toolsCatalogResult: null,
      toolsEffectiveLoading: false,
      toolsEffectiveError: null,
      toolsEffectiveResult: null,
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
      onProfileChange: () => undefined,
      onOverridesChange: () => undefined,
    },
    pinnedAgentIds: [],
    onRefresh: () => undefined,
    onCreateAgent: () => undefined,
    onSelectPanel: () => undefined,
    onConfigReload: () => undefined,
    onConfigSave: () => undefined,
    onSetDefault: () => undefined,
    onTogglePinnedAgent: () => undefined,
    onOpenAgentDefaults: () => undefined,
    ...overrides,
  };
}
