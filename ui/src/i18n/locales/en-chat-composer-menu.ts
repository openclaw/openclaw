import type { TranslationMap } from "../lib/types.ts";
import { registerChatComposerEnglish } from "./en-chat-composer.ts";
import { en } from "./en.ts";

const catalog = {
  chat: {
    composer: {
      menu: {
        back: "Back",
        fromLibraries: "From your libraries",
        agentWorkspace: "Agent & workspace",
        unavailable: "Unavailable",
        addFromLibraries: "Add from libraries",
        searchSkills: "Search skills",
        clearSearch: "Clear search",
        noMatches: "No skills match your search.",
        reset: "Reset",
        sessionChange: "{count} change in this session",
        sessionChanges: "{count} changes in this session",
        libraryOwner: "{owner}’s library",
        readSkill: "Read skill",
        updateSkill: "Update to latest",
        newVersion: "New version",
        removeSkill: "Remove from session",
        tools: "Tools",
        turnAllOn: "Turn all on",
        turnAllOff: "Turn all off",
        serverNoResponse: "The server didn’t respond.",
        noServers: "No MCP servers yet. Add one to give the agent new tools.",
        pluginSettingsRestricted: "Plugin settings aren’t available for this account.",
        pluginSettingsUnavailable: "Plugin settings are unavailable.",
        skills: "Skills",
        connectors: "Plugins",
        webSearch: "Web search",
        webSearchGloballyDisabled:
          "Web search is off in Gateway config (tools.web.search.enabled). It can’t be turned on for a single session.",
        webSearchClearStaleEnable: "Web search is off in Settings. Remove this session’s override.",
        managePlugins: "Manage plugins",
        manageSkills: "Manage skills",
        addMcpServer: "Add MCP server",
        addMcpServerTitle: "Add MCP server",
        addMcpServerDescription: "Configure the server and choose where it’s enabled.",
        scopeLabel: "Availability",
        scopeSession: "This session",
        scopeEverywhere: "Everywhere",
        scopeSessionHint: "Saved for all sessions, but on only in this one.",
        scopeEverywhereHint: "Saved and on in every session.",
        toolAccess: {
          label: "Tool access",
          loading: "Loading tools…",
          loadFailed: registerChatComposerEnglish.catalog.chat.composer.menu.toolAccess.loadFailed,
          noTools: "No tools available for this MCP server.",
          summary: "{enabled} of {total} tools on",
          summaryOne: "{enabled} of {total} tool on",
        },
        enabledCount: "{count} on",
        loadingSkills: "Loading skills…",
        skillsLoadFailed: "Couldn’t load skills. Try again.",
        noSkills: "No skills available.",
        noConnectors: "No MCP servers configured.",
        depsMissing: "Missing dependencies",
        skillBlocked: "Not available for this agent",
        sessionTag: "session",
        offlineBlocked: registerChatComposerEnglish.catalog.chat.composer.menu.offlineBlocked,
        adminBlocked: registerChatComposerEnglish.catalog.chat.composer.menu.adminBlocked,
        savingBlocked: registerChatComposerEnglish.catalog.chat.composer.menu.savingBlocked,
      },
    },
  },
} satisfies TranslationMap;

export const registerChatComposerMenuEnglish = Object.assign(
  () => {
    registerChatComposerEnglish();
    Object.assign(en.chat.composer, catalog.chat.composer);
  },
  { catalog },
);
