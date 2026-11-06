import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enSessionSkillLibrary = {
  skillLibrary: {
    inventory: "Agent & workspace",
    file: "File",
    binaryRead: "Binary attachment retained with this revision.",
    technicalDetails: "Skill details",
    skillId: "Skill ID",
    command: "Command",
    ownerRevision: "{owner} · revision {revision}",
    defaultLimit:
      "New sessions select up to {count} default skills. Existing sessions keep their selected revisions.",
    session: {
      selected: "Selected for this session",
      attachable: "Add from your libraries",
      pin: "Selected revision {revision}",
      read: "Read selected revision",
      empty: "No skills selected yet. Add one from your libraries.",
      refresh: "Refresh revision",
      attachNamed: "Attach {name} · {owner}",
      detach: "Detach",
      queued:
        "Skill selections updated for the next reply. A reply in progress keeps its current revision.",
      readOnly:
        "This is the revision selected for this session. You can view it, but session access doesn’t let you edit its library or browse other revisions.",
    },
    revision: "Retained revision",
  },
} satisfies TranslationMap;

export const registerSessionSkillLibraryEnglish = Object.assign(
  () =>
    Object.assign(
      (en.skillLibrary ??= enSessionSkillLibrary.skillLibrary),
      enSessionSkillLibrary.skillLibrary,
    ),
  { catalog: enSessionSkillLibrary },
);
