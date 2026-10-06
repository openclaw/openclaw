import type {
  SkillWorkshopActionBusy,
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
  skillWorkshopActionBusy: SkillWorkshopActionBusy | null;
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

export function createSkillWorkshopState(): SkillWorkshopState {
  return {
    skillWorkshopAgentId: null,
    skillWorkshopLoading: false,
    skillWorkshopLoaded: false,
    skillWorkshopError: null,
    skillWorkshopInspectingKey: null,
    skillWorkshopProposals: [],
    skillWorkshopInstalledSkills: [],
    skillWorkshopInstalledName: null,
    skillWorkshopSelectedKey: null,
    skillWorkshopActionBusy: null,
    skillWorkshopActionNotice: null,
    skillWorkshopActionNoticeTimer: null,
    skillWorkshopRevisionKey: null,
    skillWorkshopRevisionDraft: "",
    skillWorkshopQuery: "",
    skillWorkshopFilePreviewKey: null,
    skillWorkshopFilePreviewQuery: "",
    skillWorkshopQueueWidth: 360,
    skillWorkshopMode: "skills",
  };
}
