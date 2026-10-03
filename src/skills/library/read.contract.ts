import type {
  SkillLibrarySelection,
  SkillsLibraryActivateParams,
  SkillsLibraryListParams,
  SkillsLibraryListResult,
  SkillsLibraryReadResult,
} from "../../../packages/gateway-protocol/src/schema/skill-library.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

export type SkillLibraryWorkerAuthority = {
  profileId?: string;
  namespace?: "personal";
  scopes: readonly string[];
  config: OpenClawConfig;
};
export type SkillLibraryReadQueries = {
  presentation: {
    input: undefined;
    output: Pick<
      SkillsLibraryListResult,
      "profileId" | "multipleProfiles" | "defaultTarget" | "canManageWorkspace"
    >;
  };
  list: { input: SkillsLibraryListParams; output: SkillsLibraryListResult };
  read: {
    input: { skillId: string; revision?: string; selectedRevision?: string };
    output: Pick<SkillsLibraryReadResult, "entry" | "revisions"> & { manifestJson: string };
  };
  seed: { input: undefined; output: SkillLibrarySelection[] };
  change: {
    input: { current: readonly SkillLibrarySelection[]; params: SkillsLibraryActivateParams };
    output: SkillLibrarySelection[];
  };
  pins: {
    input: readonly SkillLibrarySelection[];
    output: NonNullable<SkillsLibraryListResult["session"]>["selections"];
  };
};
export type SkillLibraryReadInput = {
  [K in keyof SkillLibraryReadQueries]: {
    kind: K;
    params: SkillLibraryReadQueries[K]["input"];
    authority: SkillLibraryWorkerAuthority;
  };
}[keyof SkillLibraryReadQueries];
export type SkillLibraryReadOutput = {
  [K in keyof SkillLibraryReadQueries]: {
    type: "skillLibrary.read";
    kind: K;
    value: SkillLibraryReadQueries[K]["output"];
    profileIds: string[];
  };
}[keyof SkillLibraryReadQueries];
export type SkillLibraryReadOperations = {
  "skillLibrary.read": { input: SkillLibraryReadInput; output: SkillLibraryReadOutput };
};
