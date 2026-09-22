import type { SkillStatusEntry, SkillStatusReport } from "../../api/types.ts";
import type { SkillsState } from "../../lib/skills/index.ts";
import type { SkillsProps } from "./view-types.ts";

export function normalizeText(node: Element | DocumentFragment): string {
  return node.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

export function createSkill(overrides: Partial<SkillStatusEntry> = {}): SkillStatusEntry {
  return {
    name: "Repo Skill",
    description: "Skill description",
    source: "workspace",
    filePath: "/tmp/skill",
    baseDir: "/tmp",
    skillKey: "repo-skill",
    bundled: false,
    primaryEnv: "OPENAI_API_KEY",
    emoji: undefined,
    homepage: "https://example.com",
    always: false,
    disabled: false,
    blockedByAllowlist: false,
    blockedByAgentFilter: false,
    eligible: true,
    platformIncompatible: false,
    modelVisible: true,
    userInvocable: true,
    commandVisible: true,
    requirements: {
      anyBins: [],
      bins: [],
      env: [],
      config: [],
      os: [],
    },
    missing: {
      anyBins: [],
      bins: [],
      env: [],
      config: [],
      os: [],
    },
    configChecks: [],
    install: [],
    ...overrides,
  };
}

type SkillsTestOverrides = Partial<SkillsProps> & Record<string, unknown>;

export function createProps<T extends SkillsTestOverrides>(overrides: T): SkillsProps & T;
export function createProps(): SkillsProps;
export function createProps(overrides: SkillsTestOverrides = {}): SkillsProps {
  const report: SkillStatusReport = {
    workspaceDir: "/tmp/workspace",
    managedSkillsDir: "/tmp/skills",
    skills: [createSkill()],
  };
  const legacy = {
    canUpdate: true,
    canInstall: true,
    connected: true,
    loading: false,
    report,
    error: null,
    filter: "",
    statusFilter: "all",
    edits: {},
    operation: null,
    messages: {},
    detailKey: null,
    detailTab: "overview",
    clawhubVerdicts: {},
    clawhubVerdictsLoading: false,
    clawhubVerdictsError: null,
    skillCardContents: {},
    skillCardLoadingKey: null,
    skillCardErrors: {},
    clawhubQuery: "",
    clawhubResults: null,
    clawhubSearchLoading: false,
    clawhubSearchError: null,
    clawhubIconUrls: {},
    clawhubDetail: null,
    clawhubDetailRef: null,
    clawhubDetailLoading: false,
    clawhubDetailError: null,
    clawhubInstallMessage: null,
    onFilterChange: () => undefined,
    onStatusFilterChange: () => undefined,
    onRefresh: () => undefined,
    onToggle: () => undefined,
    onEdit: () => undefined,
    onSaveKey: () => undefined,
    onInstall: () => undefined,
    onDetailOpen: () => undefined,
    onDetailClose: () => undefined,
    onDetailTabChange: () => undefined,
    onClawHubQueryChange: () => undefined,
    onClawHubDetailOpen: () => undefined,
    onClawHubDetailClose: () => undefined,
    onClawHubInstall: () => undefined,
    ...overrides,
  };
  const state: SkillsState = {
    client: null,
    connected: legacy.connected,
    runtimeConfig: {} as SkillsState["runtimeConfig"],
    skillsAgentId: null,
    skillsAgentRevision: 0,
    skillsLoading: legacy.loading,
    skillsReport: legacy.report,
    skillsError: legacy.error,
    skillsFilter: legacy.filter,
    skillsStatusFilter: legacy.statusFilter as SkillsState["skillsStatusFilter"],
    skillsDetailKey: legacy.detailKey,
    skillsDetailTab: legacy.detailTab as SkillsState["skillsDetailTab"],
    skillOperation: legacy.operation,
    skillEdits: legacy.edits,
    skillMessages: legacy.messages,
    clawhubSearchQuery: legacy.clawhubQuery,
    clawhubSearchResults: legacy.clawhubResults,
    clawhubSearchLoading: legacy.clawhubSearchLoading,
    clawhubSearchError: legacy.clawhubSearchError,
    clawhubIconUrls: legacy.clawhubIconUrls,
    clawhubDetail: legacy.clawhubDetail,
    clawhubDetailRef: legacy.clawhubDetailRef,
    clawhubDetailLoading: legacy.clawhubDetailLoading,
    clawhubDetailError: legacy.clawhubDetailError,
    clawhubInstallMessage: legacy.clawhubInstallMessage,
    clawhubVerdicts: legacy.clawhubVerdicts,
    clawhubVerdictsLoading: legacy.clawhubVerdictsLoading,
    clawhubVerdictsError: legacy.clawhubVerdictsError,
    skillCardContents: legacy.skillCardContents,
    skillCardContentKeys: {},
    skillCardLoadingKey: legacy.skillCardLoadingKey,
    skillCardErrors: legacy.skillCardErrors,
    ...overrides.state,
  };
  return { ...legacy, state } as SkillsProps;
}

/**
 * Each split test file owns its own cleanup stack, so a patched dialog prototype from one file
 * can never leak into the other when Vitest runs them in a shared environment.
 */
export function createDialogMethodInstaller(restores: Array<() => void>) {
  return function installDialogMethod(
    name: "showModal" | "close",
    value: (this: HTMLDialogElement) => void,
  ) {
    const proto = HTMLDialogElement.prototype as HTMLDialogElement & Record<string, unknown>;
    const original = Object.getOwnPropertyDescriptor(proto, name);
    Object.defineProperty(proto, name, {
      configurable: true,
      writable: true,
      value,
    });
    restores.push(() => {
      if (original) {
        Object.defineProperty(proto, name, original);
        return;
      }
      delete proto[name];
    });
  };
}
