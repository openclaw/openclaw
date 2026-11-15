import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enMcpApp = {
  mcpApp: {
    title: "MCP app",
    catalogTitle: "Plugin apps",
    catalogDescription: "Open an app directly, without sending a message to your agent.",
    threadApps: "Conversation apps",
    empty: "No plugin apps for this agent yet.",
    loading: "Loading plugin apps…",
    disconnected: "Reconnect to use this app.",
    configure: "Configure MCP servers",
    settings: "App settings",
    onboarding: "Set up app",
    settingsSaved: "App settings saved.",
    settingsDescription:
      "These settings are provided by the app. Changes are sent only when you save.",
    save: "Save settings",
    actionComplete: "App action completed.",
    resources: "App resources",
    resourceSearch: "Search app resources",
    resourceQuery: "Search resources…",
    resourceDescription:
      "Attach a resource reference from an app. This does not mention or notify a person.",
    noResources: "No resources match your search.",
    contextTitle: "App context",
    removeContext: "Remove {title}",
    textContent: "Text",
    imageContent: "Image",
    resourceContent: "Resource",
    openWith: "Open with app",
    invalidLink: "This app link is invalid or the app is unavailable.",
    retry: "Try again",
    relaunch: "Relaunch",
    sessionEnded: "This app’s session ended. Relaunch to use it.",
    reconstructed: "Send a message to interact again.",
    confirmMessage: "Send this message to the agent?",
    sendMessage: "Send",
    cancel: "Cancel",
    confirmFile: "Open this file?",
    openFile: "Open",
    unavailable: "This app couldn’t load. Try again. {error}",
    errors: {
      sessionUnavailable: "Couldn’t open this app’s session. Try again.",
      gatewayUnavailable: "Couldn’t connect this app. Reconnect and try again.",
      mountUnavailable: "Couldn’t load this app. Relaunch it and try again.",
      sandboxTimedOut: "This app took too long to load. Try again.",
      sandboxUnavailable: "Couldn’t load this app. Relaunch it and try again.",
      initializationTimedOut: "This app took too long to load. Try again.",
      requestFailed: "Couldn’t complete this app request. Try again.",
      unsupportedResources: "Couldn’t load this app’s resources. Try again.",
      invalidSandboxUrl: "Couldn’t load this app. Check its URL and try again.",
    },
  },
} satisfies TranslationMap;

export const registerMcpAppEnglish = Object.assign(
  () => Object.assign(en.mcpApp, enMcpApp.mcpApp),
  { catalog: enMcpApp },
);
