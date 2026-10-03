import type {
  SkillLibraryEntry,
  SkillLibrarySelection,
  SkillsLibraryActivateParams,
  SkillsLibraryListParams,
  SkillsLibraryListResult,
  SkillsLibraryReadResult,
} from "../../../packages/gateway-protocol/src/schema/skill-library.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { DB as StateDatabase } from "../../state/openclaw-state-db.generated.js";

export type SkillLibraryWorkerAuthority = {
  profileId?: string;
  namespace?: "personal";
  scopes: readonly string[];
  config: OpenClawConfig;
};
export type SkillLibraryReadQueries = {
  profile: { input: undefined; output: string };
  entry: { input: { skillId: string; write?: boolean }; output: SkillLibraryEntry };
  upload: { input: { uploadId: string }; output: StateDatabase["skill_library_uploads"] };
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
