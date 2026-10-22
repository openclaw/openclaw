import type { SkillStatusEntry, SkillStatusReport } from "../../api/types.ts";
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
    requirements: { anyBins: [], bins: [], env: [], config: [], os: [] },
    missing: { anyBins: [], bins: [], env: [], config: [], os: [] },
    configChecks: [],
    install: [],
    ...overrides,
  };
}

type SkillsTestOverrides = Partial<Omit<SkillsProps, "state">> & Record<string, unknown>;

export function createReport(skills = [createSkill()]): SkillStatusReport {
  return { workspaceDir: "/tmp/workspace", managedSkillsDir: "/tmp/skills", skills };
}

export function createProps(overrides: SkillsTestOverrides = {}): SkillsProps {
  const value = <T>(key: string, fallback: T): T =>
    key in overrides ? (overrides[key] as T) : fallback;
  const state: SkillsProps["state"] = {
    client: null,
    connected: value("connected", true),
    runtimeConfig: {} as SkillsProps["state"]["runtimeConfig"],
    skillsAgentId: null,
    skillsAgentRevision: 0,
    skillsLoading: value("loading", false),
    skillsReport: value("report", createReport()),
    skillsError: value("error", null),
    skillsFilter: value("filter", ""),
    skillsStatusFilter: value("statusFilter", "all"),
    skillsDetailKey: value("detailKey", null),
    skillsDetailTab: value("detailTab", "overview"),
    skillOperation: value("operation", null),
    skillEdits: value("edits", {}),
    skillMessages: value("messages", {}),
    clawhubSearchQuery: value("clawhubQuery", ""),
    clawhubSearchResults: value("clawhubResults", null),
    clawhubSearchLoading: value("clawhubSearchLoading", false),
    clawhubSearchError: value("clawhubSearchError", null),
    clawhubIconUrls: value("clawhubIconUrls", {}),
    clawhubDetail: value("clawhubDetail", null),
    clawhubDetailRef: value("clawhubDetailRef", null),
    clawhubDetailError: value("clawhubDetailError", null),
    clawhubInstallMessage: value("clawhubInstallMessage", null),
    clawhubVerdicts: value("clawhubVerdicts", {}),
    clawhubVerdictsLoading: value("clawhubVerdictsLoading", false),
    clawhubVerdictsError: value("clawhubVerdictsError", null),
    skillCardContents: value("skillCardContents", {}),
    skillCardContentKeys: {},
    skillCardLoadingKey: value("skillCardLoadingKey", null),
    skillCardErrors: value("skillCardErrors", {}),
  };
  return {
    readClawHubDetail: () => {
      if (state.clawhubDetailError) {
        throw new Error(state.clawhubDetailError);
      }
      return state.clawhubDetail;
    },
    canUpdate: true,
    canInstall: true,
    loading: state.skillsLoading,
    error: state.skillsError,
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
    state,
  } as SkillsProps;
}

// Keep prototype restoration scoped to each split file's cleanup stack.
export function createDialogMethodInstaller(restores: Array<() => void>) {
  return function installDialogMethod(
    name: "showModal" | "close",
    value: (this: HTMLDialogElement) => void,
  ) {
    const proto = HTMLDialogElement.prototype;
    const original = Object.getOwnPropertyDescriptor(proto, name);
    Object.defineProperty(proto, name, { configurable: true, writable: true, value });
    restores.push(() => {
      if (original) {
        Object.defineProperty(proto, name, original);
      } else {
        Reflect.deleteProperty(proto, name);
      }
    });
  };
}
