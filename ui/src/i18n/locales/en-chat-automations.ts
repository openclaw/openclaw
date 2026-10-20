import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enChatAutomations = {
  chat: {
    messages: {
      automationScheduled: "Scheduled",
      automationChecking: "Checking now",
      automationAttention: "Needs attention",
      automationPaused: "Paused",
      automationIdle: "No check scheduled",
      automationOffline: "Offline",
      automationUnavailable: "Status unavailable",
      automationNextCheck: "next check",
      automationCheck: "1 check",
      automationChecks: "{count} checks",
      automationLoadedChecks: "{count} checks in loaded history",
      automationCurrentStatus: "Current automation status",
    },
  },
} satisfies TranslationMap;

export const registerChatAutomationsEnglish = Object.assign(
  () => Object.assign(en.chat.messages, enChatAutomations.chat.messages),
  { catalog: enChatAutomations },
);
