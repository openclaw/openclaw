import { mergeCatalog } from "../lib/merge-catalog.ts";
import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const catalog = {
  chat: {
    welcome: {
      recentSessions: "Recent chats",
      suggestions: {
        whatCanYouDo: en.chat.welcome.suggestions.whatCanYouDo,
        summarizeRecentSessions: "Summarize my recent sessions",
        configureChannel: "Help me configure a channel",
        checkSystemHealth: "Check system health",
        exploreOpenClaw: "Tour OpenClaw's code and docs",
        investigateInSandbox: "Investigate an issue in a sandbox",
        openDraftPullRequest: "Fix a bug and open a draft PR",
      },
    },
  },
} satisfies TranslationMap;

export const registerChatWelcomeEnglish = Object.assign(() => mergeCatalog(en, catalog), {
  catalog,
});
