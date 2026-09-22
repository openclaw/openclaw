import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// People-picker copy follows its deferred menu renderer, not the application boot path.
const enSessionPeople = {
  sessionsView: {
    searchPeople: "Search people and agents…",
    noPeopleMatch: "No matching people or agents",
    peopleRange: "{start}–{end} of {total}",
  },
} satisfies TranslationMap;

export const registerSessionPeopleEnglish = Object.assign(
  () => {
    Object.assign(en.sessionsView, enSessionPeople.sessionsView);
  },
  { catalog: enSessionPeople },
);
