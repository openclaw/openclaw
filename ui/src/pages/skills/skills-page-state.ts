import type { SkillsState } from "../../lib/skills/index.ts";

export function createSkillsData(): Omit<SkillsState, "client" | "connected" | "runtimeConfig"> {
  return {
    skillsAgentId: null,
    skillsAgentRevision: 0,
    skillsLoading: false,
    skillsReport: null,
    skillsError: null,
    skillOperation: null,
    skillEdits: {},
    skillMessages: {},
    clawhubSearchResults: null,
    clawhubDetail: null,
    clawhubDetailRef: null,
    clawhubDetailError: null,
    clawhubInstallMessage: null,
    clawhubVerdicts: {},
    clawhubVerdictsError: null,
    skillCardContents: {},
    skillCardContentKeys: {},
    skillCardReads: {},
    skillsRead: null,
    clawhubVerdictsRead: null,
    skillCardErrors: {},
    clawhubIconUrls: {},
  };
}
