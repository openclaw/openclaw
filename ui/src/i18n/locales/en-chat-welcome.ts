import { mergeCatalog } from "../lib/merge-catalog.ts";
import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const catalog = {
  chat: {
    welcome: {
      recentSessions: "Recent sessions",
      quickStart: {
        hint: "Not sure where to begin? Pick a starting point, then edit your message before sending.",
        getStarted: {
          label: "Help me get started",
          prompt:
            "Help me get started with OpenClaw. Ask what I want to accomplish, then suggest one small next step using the access I already have.",
        },
        explore: {
          label: "Explore OpenClaw",
          prompt:
            "Give me a short introduction to OpenClaw and a few useful things I can try with my current access.",
        },
        startTask: {
          label: "Start a task",
          prompt:
            "I want help with a task. Ask me what I want to accomplish and help me choose a clear first step.",
        },
      },
      suggestions: {
        whatCanYouDo: en.chat.welcome.suggestions.whatCanYouDo,
        summarizeRecentSessions: "Summarize my recent sessions",
        configureChannel: "Help me configure a channel",
        checkSystemHealth: "Check system health",
        exploreOpenClaw: "Tour OpenClaw’s code and docs",
        investigateInSandbox: "Investigate an issue in a sandbox",
        openDraftPullRequest: "Fix a bug and open a draft PR",
      },
    },
  },
} satisfies TranslationMap;

export const registerChatWelcomeEnglish = Object.assign(() => mergeCatalog(en, catalog), {
  catalog,
});
