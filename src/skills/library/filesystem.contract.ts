import type {
  SkillLibraryFile,
  SkillLibrarySelection,
} from "../../../packages/gateway-protocol/src/schema/skill-library.js";
import type { NativeErrorResponse } from "../../infra/native-error-response-schema.js";
import type { SkillLibraryErrorCode } from "../skill-library-error.js";
import type { SkillEntry } from "../types.js";

export type SkillLibraryFilesystemInput =
  | {
      kind: "selection";
      selections: readonly SkillLibrarySelection[];
      revisions: Array<{ description: string } | undefined>;
      stateDir: string;
    }
  | { kind: "manifest"; directory: string; manifestJson: string; revision: string };
export type SkillLibraryFilesystemOutput =
  | { kind: "selection"; entries: SkillEntry[] }
  | { kind: "manifest"; files: SkillLibraryFile[] }
  | { kind: "error"; error: NativeErrorResponse; libraryCode?: SkillLibraryErrorCode };
