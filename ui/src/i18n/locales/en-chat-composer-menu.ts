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
        sessionChange: "{count} change for this session",
        sessionChanges: "{count} changes for this session",
        libraryOwner: "{owner}'s library",
        readSkill: "Read skill",
        updateSkill: "Update to latest",
        newVersion: "New version",
        removeSkill: "Remove from session",
        tools: "Tools",
        turnAllOn: "Turn all on",
        turnAllOff: "Turn all off",
        serverNoResponse: "The server didn’t respond.",
        noServers: "No MCP servers yet. Add one to give the agent new tools.",
        skills: "Skills",
        connectors: "Plugins",
        webSearch: "Web search",
        webSearchGloballyDisabled:
          "Web search is disabled in config (tools.web.search.enabled). Session overrides cannot turn it back on.",
        webSearchClearStaleEnable:
          "Web search is disabled in config. Click to clear this session’s enable override.",
        managePlugins: "Manage plugins",
        manageSkills: "Manage skills",
        addMcpServer: "Add MCP server",
        addMcpServerTitle: "Add MCP server",
        addMcpServerDescription: "Configure the server and choose where it is enabled.",
        scopeLabel: "Availability",
        scopeSession: "This session",
        scopeEverywhere: "Everywhere",
        scopeSessionHint:
          "The server is saved globally disabled and enabled only for this session.",
        scopeEverywhereHint: "The server is saved and enabled for every session.",
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
        skillsLoadFailed: "Couldn’t load skills.",
        noSkills: "No skills available.",
        noConnectors: "No MCP servers configured.",
        depsMissing: "deps missing",
        skillBlocked: "not available for this agent",
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
