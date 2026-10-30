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
      empty: "No managed skills selected.",
      refresh: "Refresh revision",
      attachNamed: "Attach {name} · {owner}",
      detach: "Detach",
      queued:
        "Skill selections updated for the next turn. An active turn keeps its current revision.",
      readOnly:
        "This is the exact revision selected for this session. Session access allows reading this pin, not editing its library or browsing other revisions.",
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
