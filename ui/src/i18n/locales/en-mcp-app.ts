import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enMcpApp = {
  mcpApp: {
    title: "MCP App",
    catalogTitle: "Plugin apps",
    catalogDescription: "Open an app directly, without sending a message to your agent.",
    open: "Open app",
    threadApps: "Conversation apps",
    empty: "No plugin apps are available for this agent.",
    loading: "Loading plugin apps…",
    disconnected: "Connect to the Gateway to use plugin apps.",
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
    noResources: "No matching resources.",
    attach: "Attach resource",
    contextTitle: "App context",
    contextDescription:
      "Included with your next message. Apps can replace their own context; you can remove it here.",
    removeContext: "Remove {title}",
    textContent: "Text",
    imageContent: "Image",
    resourceContent: "Resource",
    openWith: "Open with app",
    fileViewer: "App file viewer",
    invalidLink: "This app link is invalid or the app is unavailable.",
    close: "Close app",
    retry: "Try again",
    relaunch: "Relaunch",
    sessionEnded: "This app session ended. Relaunch to interact",
    reconstructed: "Send a message to interact again",
    newConversation: "Start a new conversation",
    confirmMessage: "Send this app message?",
    sendMessage: "Send message",
    unavailable: "MCP App unavailable: {error}",
    errors: {
      sessionUnavailable: "The App conversation could not be opened",
      gatewayUnavailable: "MCP App gateway unavailable",
      mountUnavailable: "MCP App mount unavailable",
      sandboxTimedOut: "MCP App sandbox timed out",
      sandboxUnavailable: "MCP App sandbox unavailable",
      initializationTimedOut: "MCP App initialization timed out",
      requestFailed: "Request failed",
      unsupportedResources: "This app returned an unsupported resource list",
      invalidSandboxUrl: "MCP App sandbox URL is invalid",
    },
  },
} satisfies TranslationMap;

export const registerMcpAppEnglish = Object.assign(
  () => Object.assign(en.mcpApp, enMcpApp.mcpApp),
  { catalog: enMcpApp },
);
