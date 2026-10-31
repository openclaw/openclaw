import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// People menus register this shared catalog when their renderer loads.
const enSessionPeople = {
  sessionsView: {
    searchPeople: "Search people and agents…",
    noPeopleMatch: "No matching people or agents",
  },
} satisfies TranslationMap;

export const registerSessionPeopleEnglish = Object.assign(
  () => {
    Object.assign(en.sessionsView, enSessionPeople.sessionsView);
  },
  { catalog: enSessionPeople },
);
