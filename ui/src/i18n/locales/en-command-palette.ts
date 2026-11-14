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
    searchPlaceholder: en.palette.searchPlaceholder,
    composePlaceholder: en.palette.composePlaceholder,
    modeLabel: en.palette.modeLabel,
    modes: en.palette.modes,
    modeSwitch: en.palette.modeSwitch,
    noResults: "No results match your search.",
    noResultsStart: "Press {shortcut} to compose a new session.",
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
      send: "send",
      close: "close",
      newline: "newline",
    },
  },
  sessionsView: {
    transcriptSearchArchivedExcluded:
      registerSessionOrganizationSharedEnglish.catalog.sessionsView
        .transcriptSearchArchivedExcluded,
  },

  shortcutsOverlay: {
    title: en.shortcutsOverlay.title,
    sections: {
      general: "General",
      chat: "Chat",
      panels: "Panels",
      sidebar: "Sidebar",
      imageViewer: "Image viewer",
      approvals: "Approvals",
    },
    labels: {
      commandPalette: "Open command palette",
      newSession: "Open New Session",
      archiveSession: "Archive current session",
      paletteStartSession: "Start a background session (in the command palette)",
      keyboardShortcuts: "Show keyboard shortcuts",
      toggleSidebar: "Toggle sidebar",
      debugOverlay: "Toggle debug overlay",
      appearanceSettings: "Open appearance settings",
      startNewSession: "Start new session (from the new-session page)",
      startNewSessionBackground: "Start new session in background (from the new-session page)",
      closeDialog: "Close dialog or exit settings",
      sendMessage: "Send message",
      newline: "Insert new line",
      steerImmediately: "Steer active response",
      historyRecall: "Browse sent message history",
      transcriptSearch: "Search conversation",
      clearReply: "Clear reply",
      stopResponse: "Stop active response",
      cancelDictation: "Cancel dictation",
      saveQueuedMessage: "Save queued message",
      toggleSessionSelect: "Select multiple sessions",
      extendSessionSelect: "Extend session selection",
      zoomIn: "Zoom in",
      zoomOut: "Zoom out",
      zoomReset: "Reset zoom",
      panImageHorizontal: "Pan image horizontally",
      panImageVertical: "Pan image vertically",
      terminalPanel: "Toggle terminal panel",
      homePanel: "Talk to your Home agent",
      workspaceFiles: "Toggle workspace files",
      sideChat: "Toggle side chat",
      browserPanel: "Toggle browser panel",
      desktopPanel: "Toggle desktop panel",
      discussionPanel: "Toggle discussion panel",
      dashboardPanel: "Toggle dashboard panel",
      reviewPanel: "Toggle review panel",
      approveOnce: "Approve once",
      approveAlways: "Always allow",
      denyApproval: "Deny approval",
    },
  },
  chat: {
    welcome: registerChatWelcomeEnglish.catalog.chat.welcome,
    commands: registerChatCommandsEnglish.catalog.chat.commands,
  },
} satisfies TranslationMap;

export const registerCommandPaletteEnglish = Object.assign(
  () => {
    Object.assign(en.shortcutsOverlay, enCommandPalette.shortcutsOverlay);
    Object.assign(en.chat.welcome, enCommandPalette.chat.welcome);
    Object.assign(en.chat.commands, enCommandPalette.chat.commands);
    Object.assign(en.commandPalette, enCommandPalette.commandPalette);
    Object.assign(en.palette, enCommandPalette.palette);
    Object.assign(en.sessionsView, enCommandPalette.sessionsView);
  },
  { catalog: enCommandPalette },
);
