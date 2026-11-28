import { isRecord } from "@openclaw/normalization-core/record-coerce";

/** Prompt facts for `skill_library`. They are not execution authority. */
export type SkillLibraryPromptListing = {
  multipleProfiles: boolean;
  defaultTarget: "personal" | "workspace";
};

/** Admit a stored listing. Anything else is absent, so a bad row cannot change the prompt. */
export function readSkillLibraryPromptListing(
  value: unknown,
): SkillLibraryPromptListing | undefined {
  if (!isRecord(value) || typeof value.multipleProfiles !== "boolean") {
    return undefined;
  }
  if (value.defaultTarget !== "personal" && value.defaultTarget !== "workspace") {
    return undefined;
  }
  return { multipleProfiles: value.multipleProfiles, defaultTarget: value.defaultTarget };
}
