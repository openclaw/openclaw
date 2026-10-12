import type {
  SkillsLibraryMutateParams,
  SkillsLibrarySaveParams,
  SkillsLibraryUploadParams,
  SkillsLibraryReceipt,
  SkillsLibraryUploadResult,
} from "../../../packages/gateway-protocol/src/schema/skill-library.js";
import type { SkillLibraryWorkerAuthority } from "./read.contract.js";

export type SkillLibraryPublishInput = {
  authority: SkillLibraryWorkerAuthority;
  params: Pick<SkillsLibrarySaveParams, "skillId" | "slug" | "expectedRevision">;
  skillId: string;
  bundle: { revision: string; description: string; filesJson: string };
  uploadId?: string;
};
export type SkillLibraryMutateInput = {
  authority: SkillLibraryWorkerAuthority;
  params: SkillsLibraryMutateParams;
};
export type SkillLibraryUploadInput = {
  authority: SkillLibraryWorkerAuthority;
  params: Exclude<SkillsLibraryUploadParams, { action: "commit" }>;
};
export type SkillLibraryWorkerOperations = {
  "skillLibrary.publish": { input: SkillLibraryPublishInput; output: SkillsLibraryReceipt };
  "skillLibrary.mutate": { input: SkillLibraryMutateInput; output: SkillsLibraryReceipt };
  "skillLibrary.upload": {
    input: SkillLibraryUploadInput;
    output: Exclude<SkillsLibraryUploadResult, SkillsLibraryReceipt>;
  };
};
