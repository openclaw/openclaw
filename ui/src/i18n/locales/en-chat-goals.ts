import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enChatGoals = {
  chat: {
    goals: {
      composerMode: "Goal",
      sessionChanged: "Session changed. Cancel and select Goal again.",
      start: "Start goal",
      save: "Save goal",
      objectivePlaceholder: "What should this goal accomplish?",
      offline: "Reconnect to manage goals.",
      busy: "Wait for this reply to finish. Your draft is unchanged.",
      annotationUnsupported: "Send or remove annotations first. Your draft is unchanged.",
      actionPending: "Wait for the pending goal action.",
      invalidRequest: "Couldn’t update the goal. Check the objective and try again.",
      outcomeUnknown: "Goal update not confirmed. Check its outcome before changing it.",
      recoveryUnavailable:
        "Couldn’t save the recovery request. Free browser storage and try again. Your goal update wasn’t sent.",
      admissionImmutable: "Retry or remove this request. To edit it, start a new goal.",
      replace: "Replace objective",
      resuming: "Resuming goal…",
    },
  },
} satisfies TranslationMap;

export const registerChatGoalsEnglish = Object.assign(
  () => Object.assign(en.chat.goals, enChatGoals.chat.goals),
  { catalog: enChatGoals },
);
