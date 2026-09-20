import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Discovery copy loads with the palette or transcript search, not the shell.
const enCommandPalette = {
  commandPalette: {
    newSessionSettings: "New session settings",
    rememberSettings: "Remember settings for {shortcut}",
    rememberUnavailable: "Reconnect to remember settings.",
    settingsSaveFailed: "Could not save settings.",
  },
  palette: {
    placeholder: en.palette.placeholder,
    noResults: "No results found",
    noResultsStart: "Press {shortcut} to start a new session.",
    startSession: "New session",
    startSessionBackground: "Start new session in background",
    startingSession: "Starting…",
    promptRequired: "Write a prompt to start a session.",
    searchingSessions: "Searching sessions…",
    searchingCommands: "Searching commands…",
    clearSearch: "Clear search",
    escapeKey: "esc",
    filterLabel: "Filter search results",
    filters: { all: "All", sessions: "Sessions", messages: "Messages" },
    searchFailed: "Chat search failed — check the gateway logs and retry",
    modelSearchFailed: "Model search unavailable. Change your search to retry.",
    searchPartial: "Transcript search unavailable — showing chat titles and metadata",
    searchIndexing: "Indexing older messages — search again shortly.",
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
    transcriptSearchTitle: "Search transcripts",
    transcriptSearchDescription:
      "Find exact words or phrases in user and assistant messages across the default agent's sessions.",
    transcriptSearchInputLabel: "Search session transcripts",
    transcriptSearchPlaceholder: "Search exact words or phrases…",
    transcriptSearchAction: "Search",
    transcriptSearchClear: "Clear",
    transcriptSearchRetry: "Retry",
    transcriptSearchSearching: "Searching transcripts…",
    transcriptSearchUnavailable: "Transcript search requires a newer Gateway.",
    transcriptSearchError: "Transcript search failed",
    transcriptSearchIndexing:
      "The transcript index is still updating. Retry to include recent messages.",
    transcriptSearchArchivedExcluded:
      "{count} archived transcripts excluded; open a session to restore its searchable history.",
    transcriptSearchEmpty: "No transcript messages match that search.",
    transcriptSearchMatches: "Transcript matches: {count}",
    transcriptSearchTruncated: "Showing the first 25 matches.",
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
      paletteStartSession: "Start a background session (in the command palette)",
      keyboardShortcuts: "Show keyboard shortcuts",
      toggleSidebar: "Toggle sidebar",
      debugOverlay: "Toggle debug overlay",
      appearanceSettings: "Open appearance settings",
      startNewSession: "Start new session (from the new-session page)",
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
      terminalPanel: "Toggle terminal panel",
      homePanel: "Talk to your Home agent",
      workspaceFiles: "Toggle workspace files",
      sideChat: "Toggle side chat",
      browserPanel: "Toggle browser panel",
      tasksPanel: "Toggle tasks panel",
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
    welcome: {
      hintBeforeShortcut: "Type a message below ·",
      hintAfterShortcut: "for commands",
      recentSessions: "Recent chats",
      suggestions: {
        whatCanYouDo: en.chat.welcome.suggestions.whatCanYouDo,
        summarizeRecentSessions: "Summarize my recent sessions",
        configureChannel: "Help me configure a channel",
        checkSystemHealth: "Check system health",
      },
    },
    commands: {
      arguments: "Command arguments",
      menu: "Slash commands",
      optionCount: "{count} options",
      clearDescription: "Clear chat history",
      redirectDescription: "Abort and restart with a new message",
      steerDescription: "Inject a message into the active run",
      exportDescription: "Download this conversation as Markdown",
      categories: {
        session: "Session",
        model: "Model",
        agents: "Agents",
        tools: "Tools",
      },
    },
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
