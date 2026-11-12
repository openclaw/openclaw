import type { TranslationMap } from "../lib/types.ts";
import { registerChatCommandsEnglish } from "./en-chat-commands.ts";
import { registerChatWelcomeEnglish } from "./en-chat-welcome.ts";
import { registerSessionOrganizationSharedEnglish } from "./en-session-organization-shared.ts";
import { en } from "./en.ts";

// Discovery copy loads with the palette, not the shell or Sessions page.
const enCommandPalette = {
  commandPalette: {
    newSessionSettings: "New session settings",
    rememberSettings: "Remember settings for {shortcut}",
    rememberSettingsNoShortcut: "Remember these settings",
    rememberUnavailable: "Reconnect to remember settings.",
    settingsSaveFailed: "Couldn’t save settings. Try again.",
  },
  palette: {
    placeholder: en.palette.placeholder,
    noResults: "No results match your search.",
    noResultsStart: "Press {shortcut} to start a new session.",
    startSession: "New session",
    startSessionBackground: "Start new session in background",
    startingSession: "Starting…",
    sessionStarted: "Session started",
    sessionCreated: "Session created",
    sessionCreatedWithError: "Session created, but couldn't start: {error}",
    startFailed: "Couldn’t start the session. Try again. {error}",
    tryAgain: "Try again",
    promptRequired: "Write a prompt to start a session.",
    attachmentPrompt: en.palette.attachmentPrompt,
    searchingSessions: "Searching sessions…",
    searchingCommands: "Searching commands…",
    archivedSessionsExcluded: "Archived sessions are not included in message search.",
    clearSearch: "Clear search",
    escapeKey: "esc",
    filterLabel: "Filter search results",
    filters: { all: "All", sessions: "Sessions", messages: "Messages" },
    searchFailed: "Couldn’t search sessions. Try again.",
    searchOffline: "Reconnect to search sessions.",
    modelSearchFailed: "Couldn’t search models. Change your search to try again.",
    searchPartial: "Couldn’t search messages. Showing session titles and details.",
    searchIndexing: "Results may be incomplete. Search again shortly.",
    categories: {
      search: "Search",
      navigation: en.palette.categories.navigation,
      skills: "Skills",
      messages: "In messages",
    },
    items: {
      apps: "Apps",
      sessions: "Sessions",
      scheduled: "Automations",
      skills: "Skills",
      plugins: "Plugins",
      settings: "Settings",
      agents: "Agents",
      desktop: "Desktop",
    },
    descriptions: {
      verboseMode: "Toggle verbose mode.",
    },
    footer: {
      navigate: "navigate",
      select: "select",
      close: "close",
      newline: "newline",
    },
  },
  sessionsView: {
    transcriptSearchArchivedExcluded:
      registerSessionOrganizationSharedEnglish.catalog.sessionsView
        .transcriptSearchArchivedExcluded,
  },

  chat: {
    welcome: registerChatWelcomeEnglish.catalog.chat.welcome,
    commands: registerChatCommandsEnglish.catalog.chat.commands,
  },
} satisfies TranslationMap;

export const registerCommandPaletteEnglish = Object.assign(
  () => {
    Object.assign(en.chat.welcome, enCommandPalette.chat.welcome);
    Object.assign(en.chat.commands, enCommandPalette.chat.commands);
    Object.assign(en.commandPalette, enCommandPalette.commandPalette);
    Object.assign(en.palette, enCommandPalette.palette);
    Object.assign(en.sessionsView, enCommandPalette.sessionsView);
  },
  { catalog: enCommandPalette },
);
