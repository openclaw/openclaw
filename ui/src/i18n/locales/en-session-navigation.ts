import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Session links and catalog menus are shared with New Session and dashboard routes.
const enSessionNavigation = {
  chat: {
    catalog: {
      remoteViewOnly: "This session is on a paired device and is view-only.",
      unsupportedViewOnly: "This external session source is view-only.",
      sessionMenu: "External session actions",
      openInOpenClaw: "Open in OpenClaw",
      importToOpenClaw: "Import to OpenClaw",
      importComplete: "Imported {count} transcript items.",
      importUnchanged: "The imported transcript is up to date.",
      importIncomplete:
        "Imported {count} transcript items. Older history exceeded the import limit.",
      openImportedSession: "Open imported session",
      openInTerminal: "Open in terminal",
      deleteSession: "Delete",
      deleteSessionConfirm:
        "Delete this external session from OpenClaw? Make sure no other runner is using it. Beamed sessions are deleted permanently. Sessions kept by another tool, such as Codex, are archived there and may be restorable.",
      terminalUnavailable: "Terminal opening is unavailable for this session.",
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
      homeUnavailableTitle: "Start a conversation",
      homeUnavailableBody:
        "This Home is unavailable. Start a new conversation, or open one from Sessions.",
      startConversation: "New conversation",
      goToMain: "Go to main session",
      viewSessions: "View sessions",
      catalogShareUnavailable: "This shared session route is unavailable.",
      catalogShareInvalid: "This {catalog} share URL is invalid.",
    },
  },
} satisfies TranslationMap;

export const registerSessionNavigationEnglish = Object.assign(
  () => {
    Object.assign(en.chat.catalog, enSessionNavigation.chat.catalog);
    Object.assign(en.chat.sessionSuggestions, enSessionNavigation.chat.sessionSuggestions);
    Object.assign(en.chat.sessionRoute, enSessionNavigation.chat.sessionRoute);
  },
  { catalog: enSessionNavigation },
);
