import { githubIdentityViewFixture } from "../../features/github-connections/github-identity.test-support.ts";
import { createInitialCronState } from "../../lib/cron/index.ts";
import type { AgentFiles } from "./panels-files.tsx";
import type { Agents } from "./view.tsx";

type AgentsViewProps = Parameters<typeof Agents>[0];
type AgentFilesProps = Parameters<typeof AgentFiles>[0];

export function primaryModelPicker(container: ParentNode) {
  return container.querySelector<HTMLElement>(
    'openclaw-select-picker:has([role="listbox"][aria-label^="Primary model"])',
  );
}

export const inertAgentFileControls = {
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
  const retired = Promise.withResolvers<void>().promise;
  const data: ReturnType<AgentsViewProps["readData"]> = {
    agentsList: {
      defaultId: "alpha",
      mainKey: "main",
      scope: "per-sender",
      agents: [
        { id: "alpha", name: "Alpha" },
        { id: "beta", name: "Beta" },
      ],
    },
    agentsSelectedId: "beta",
    agentsPanel: "overview",
    requestGeneration: 0,
    chatModelCatalogRead: null,
    agentFilesLoading: false,
    agentFileRead: null,
    agentFileOutcome: null,
    agentFilesList: null,
    agentFileActive: null,
    agentFileEditors: {},
    agentFileSaving: false,
    agentFileConflict: null,
    identityDraft: { name: null, emoji: null, avatar: null },
    identitySaving: false,
    identityOutcome: null,
    agentSkillsRead: null,
    agentSkillsReport: null,
    agentSkillsAgentId: null,
    cron: createInitialCronState(),
  };
  return {
    readData: () => data,
    presentationRetired: () => retired,
    readChannels: () => ({
      channelsSnapshot: null,
      channelsRead: null,
      channelsError: null,
      channelsLastSuccess: null,
    }),
    access: {
      canCreateAgent: true,
      canPatchConfig: true,
      canUpdateConfig: true,
      canUpdateIdentity: true,
      canWriteFiles: true,
      canRunCron: true,
    },
    basePath: "",
    listRead: null,
    selectedAgentId: "beta",
    memoryTarget: {
      read: () => (overrides.selectedAgentId === undefined ? "beta" : overrides.selectedAgentId),
      subscribe: () => () => {},
    },
    config: {
      configForm: null,
      configSnapshot: null,
      configLoading: false,
      configSaving: false,
      configFormDirty: false,
      lastError: null,
    },
    channels: {
      onRefresh: () => undefined,
    },
    cron: {
      read: () => ({ summary: null, jobs: null, refresh: null, command: null }),
      onRefresh: () => undefined,
      onLoadMore: () => undefined,
      onRunNow: () => undefined,
    },
    agentFiles: {
      listRead: null,
      ...inertAgentFileControls,
    },
    agentIdentityById: {},
    overview: {
      modelCatalog: [],
      decisionModels: [],
      modelCatalogRetired: false,
      modelCatalogHasSnapshot: false,
      modelCatalogGateway: {
        client: null,
        phase: "connected",
        offlineStable: false,
        hello: null,
        canvasPluginSurfaceUrl: null,
        assistantAgentId: null,
        sessionKey: "main",
        lastError: null,
        lastErrorCode: null,
      },
      modelSelectionPolicy: undefined,
      onModelChange: () => false,
      onDecisionModelChange: () => false,
      onModelFallbacksChange: () => false,
      onModelCatalogOpen: () => undefined,
      onIdentityFieldChange: () => undefined,
      onIdentityAvatarSelect: () => undefined,
      onIdentityAvatarSet: () => undefined,
      onIdentityAvatarGenerate: async () => ({ name: "", description: "", svg: "" }),
      onIdentitySave: () => undefined,
    },
    agentSkills: {
      filter: "",
      onFilterChange: () => undefined,
      onRefresh: () => undefined,
      onToggle: () => false,
      onClear: () => undefined,
      onDisableAll: () => false,
    },
    tools: {
      readCatalog: () => null,
      readEffective: () => null,
      effectivePreview: null,
      effectiveRequest: null,
      catalogRequest: null,
      onRetryCatalog: () => undefined,
      onOpenGitHubConnections: () => undefined,
      githubIdentity: githubIdentityViewFixture(),
      runtimeSessionKey: "main",
      runtimeSessionMatchesSelectedAgent: false,
      onProfileChange: () => undefined,
      onOverridesChange: () => undefined,
    },
    pinnedAgentIds: [],
    onRefresh: () => undefined,
    onCreateAgent: () => undefined,
    onSelectPanel: () => undefined,
    onConfigReload: async () => undefined,
    onConfigSave: async () => undefined,
    onSetDefault: async () => undefined,
    onTogglePinnedAgent: () => undefined,
    onOpenMemoryImport: () => undefined,
    onOpenMemorySettings: () => undefined,
    onOpenAgentDefaults: () => undefined,
    ...overrides,
  };
}
