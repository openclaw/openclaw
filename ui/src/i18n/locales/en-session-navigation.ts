import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Session links are shared with New Session and dashboard routes.
const enSessionNavigation = {
  chat: {
    sessionSuggestions: {
      suggest: "Suggest",
      suggestMessage: "Suggest message",
    },
    sessionRoute: {
      chooseTitle: "Choose a session",
      multipleMatches: "More than one session matches {shortId}.",
      additionalMatches: "Search results remain. Use a longer id prefix.",
      notFoundTitle: "Session not found",
      notFoundExplanation: "The session may have been removed, or the link may be incorrect.",
      goToMain: "Go to main session",
      viewSessions: "View sessions",
      catalogShareUnavailable: "This shared session route is unavailable.",
      catalogShareInvalid: "This {catalog} share URL is invalid.",
    },
  },
} satisfies TranslationMap;

export const registerSessionNavigationEnglish = Object.assign(
  () => {
    Object.assign(en.chat.sessionSuggestions, enSessionNavigation.chat.sessionSuggestions);
    Object.assign(en.chat.sessionRoute, enSessionNavigation.chat.sessionRoute);
  },
  { catalog: enSessionNavigation },
);
