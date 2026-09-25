import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enChatGoals = {
  chat: {
    goals: {
      composerMode: "Goal",
      sessionChanged: "Conversation changed. Cancel and select Goal again.",
      start: "Start goal",
      save: "Save goal",
      startHint: "Enter your objective.",
      editHint: "Save without starting a run.",
      objectivePlaceholder: "What should this goal accomplish?",
      cancel: "Cancel goal entry",
      offline: "Reconnect to manage goals.",
      busy: "Wait for this run to finish. Your draft is unchanged.",
      annotationUnsupported: "Send or remove browser annotations first. Your draft is unchanged.",
      actionPending: "Wait for the pending goal action.",
      invalidRequest: "Goal update is invalid. Check the objective and try again.",
      outcomeUnknown: "Goal update not confirmed. Check its outcome before making another change.",
      recoveryTitle: "Goal update not confirmed",
      recoveryHint: "Check the saved request. If it already succeeded, it will not run again.",
      checking: "Checking goal update…",
      checkOutcome: "Check outcome",
      refreshCurrent: "Review current goal",
      recoveryExpired:
        "The saved request expired after 24 hours. Review the current goal before making another change.",
      recoveryUnavailable:
        "Goal update was not sent because its recovery request could not be saved.",
      recoveryInvalid:
        "The saved goal request is invalid; review the current goal before retrying.",
      admissionImmutable: "Retry or remove this request. Editing requires a new goal.",
      edit: "Edit goal",
      editChip: "Edit",
      pause: "Pause goal",
      pauseChip: "Pause",
      resume: "Resume goal",
      resumeChip: "Resume",
      clear: "Clear goal",
      clearChip: "Clear",
      showDetails: "Show goal details",
      hideDetails: "Hide goal details",
    },
  },
} satisfies TranslationMap;

export const registerChatGoalsEnglish = Object.assign(
  () => Object.assign(en.chat.goals, enChatGoals.chat.goals),
  { catalog: enChatGoals },
);
