import type {
  SkillWorkshopAction,
  SkillWorkshopActionNotice,
  SkillWorkshopInstalledSkill,
  SkillWorkshopMode,
  SkillWorkshopProposal,
} from "../../lib/skill-workshop/index.ts";

export type SkillWorkshopState = {
  skillWorkshopAgentId: string | null;
  skillWorkshopLoading: boolean;
  skillWorkshopLoaded: boolean;
  skillWorkshopError: string | null;
  skillWorkshopInspectingKey: string | null;
  skillWorkshopProposals: SkillWorkshopProposal[];
  skillWorkshopInstalledSkills: SkillWorkshopInstalledSkill[];
  skillWorkshopInstalledName: string | null;
  skillWorkshopSelectedKey: string | null;
  skillWorkshopActionBusy: { key: string; action: SkillWorkshopAction } | null;
  skillWorkshopActionNotice: SkillWorkshopActionNotice | null;
  skillWorkshopActionNoticeTimer?: ReturnType<typeof globalThis.setTimeout> | number | null;
  skillWorkshopRevisionKey: string | null;
  skillWorkshopRevisionDraft: string;
  skillWorkshopQuery: string;
  skillWorkshopFilePreviewKey: string | null;
  skillWorkshopFilePreviewQuery: string;
  skillWorkshopQueueWidth: number;
  skillWorkshopMode: SkillWorkshopMode;
};

export type SkillWorkshopRouteData = Pick<
  SkillWorkshopState,
  | "skillWorkshopAgentId"
  | "skillWorkshopLoading"
  | "skillWorkshopLoaded"
  | "skillWorkshopError"
  | "skillWorkshopInspectingKey"
  | "skillWorkshopProposals"
  | "skillWorkshopInstalledSkills"
  | "skillWorkshopInstalledName"
  | "skillWorkshopSelectedKey"
  | "skillWorkshopActionBusy"
  | "skillWorkshopActionNotice"
  | "skillWorkshopRevisionKey"
  | "skillWorkshopRevisionDraft"
>;

export function createSkillWorkshopState(data?: SkillWorkshopRouteData): SkillWorkshopState {
  return {
    skillWorkshopAgentId: data?.skillWorkshopAgentId ?? null,
    skillWorkshopLoading: data?.skillWorkshopLoading ?? false,
    skillWorkshopLoaded: data?.skillWorkshopLoaded ?? false,
    skillWorkshopError: data?.skillWorkshopError ?? null,
    skillWorkshopInspectingKey: data?.skillWorkshopInspectingKey ?? null,
    skillWorkshopProposals: data?.skillWorkshopProposals ?? [],
    skillWorkshopInstalledSkills: data?.skillWorkshopInstalledSkills ?? [],
    skillWorkshopInstalledName: data?.skillWorkshopInstalledName ?? null,
    skillWorkshopSelectedKey: data?.skillWorkshopSelectedKey ?? null,
    skillWorkshopActionBusy: data?.skillWorkshopActionBusy ?? null,
    skillWorkshopActionNotice: data?.skillWorkshopActionNotice ?? null,
    skillWorkshopActionNoticeTimer: null,
    skillWorkshopRevisionKey: data?.skillWorkshopRevisionKey ?? null,
    skillWorkshopRevisionDraft: data?.skillWorkshopRevisionDraft ?? "",
    skillWorkshopQuery: "",
    skillWorkshopFilePreviewKey: null,
    skillWorkshopFilePreviewQuery: "",
    skillWorkshopQueueWidth: 360,
    skillWorkshopMode: "skills",
  };
}

export function skillWorkshopRouteData(state: SkillWorkshopState): SkillWorkshopRouteData {
  return {
    skillWorkshopAgentId: state.skillWorkshopAgentId,
    skillWorkshopLoading: state.skillWorkshopLoading,
    skillWorkshopLoaded: state.skillWorkshopLoaded,
    skillWorkshopError: state.skillWorkshopError,
    skillWorkshopInspectingKey: state.skillWorkshopInspectingKey,
    skillWorkshopProposals: state.skillWorkshopProposals,
    skillWorkshopInstalledSkills: state.skillWorkshopInstalledSkills,
    skillWorkshopInstalledName: state.skillWorkshopInstalledName,
    skillWorkshopSelectedKey: state.skillWorkshopSelectedKey,
    skillWorkshopActionBusy: state.skillWorkshopActionBusy,
    skillWorkshopActionNotice: state.skillWorkshopActionNotice,
    skillWorkshopRevisionKey: state.skillWorkshopRevisionKey,
    skillWorkshopRevisionDraft: state.skillWorkshopRevisionDraft,
  };
}
