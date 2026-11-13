import { mergeCatalog } from "../lib/merge-catalog.ts";
import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Session links and catalog menus are shared with New Session and dashboard routes.
const enSessionNavigation = {
  chat: {
    catalog: {
      remoteViewOnly: "This session is on a paired device and is view-only.",
      unsupportedViewOnly: "This external session source is view-only.",
      sourceHandoffRequired:
        "This is a read-only snapshot. Its authenticated original publisher must run the handoff command from the original conversation before you can continue here.",
    },
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
      bootDraftRecovery: "Copy any text below before opening another session.",
      homeUnavailableTitle: "Start a session",
      homeUnavailableBody:
        "This Home is unavailable. Start a new session, or open one from Sessions.",
      startConversation: "New session",
      goToMain: "Go to main session",
      viewSessions: "View sessions",
      catalogShareUnavailable: "This shared session route is unavailable.",
      catalogShareInvalid: "This {catalog} share URL is invalid.",
    },
  },
} satisfies TranslationMap;

export const registerSessionNavigationEnglish = Object.assign(
  () => mergeCatalog(en, enSessionNavigation),
  { catalog: enSessionNavigation },
);
