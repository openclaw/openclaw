import type { TranslationMap } from "../lib/types.ts";
import { registerChatGoalsEnglish } from "./en-chat-goals.ts";
import { en } from "./en.ts";

const enChatGoalsOptional = {
  chat: {
    goals: {
      startHint: "Describe what “done” looks like.",
      editHint: "Save without starting a reply.",
      cancel: "Cancel goal entry",
      recoveryTitle: "Goal update not confirmed",
      recoveryHint: "Check the saved request. It won’t repeat a successful update.",
      checking: "Checking goal update…",
      checkOutcome: "Check outcome",
      refreshCurrent: "Review current goal",
      recoveryExpired:
        "This request expired after 24 hours. Review the current goal before changing it.",
      recoveryInvalid: "Couldn’t recover this request. Review the current goal before retrying.",
      replaceTitle: "Replace goal objective?",
      replaceMessage: "Update the objective without changing the goal’s status.",
      replaceRunningMessage: "Interrupt this reply, replace the objective, and resume the goal.",
      goalChanged: "The goal changed. Review it and try again. Your draft is unchanged.",
      edit: "Edit goal",
      editUnavailable: "Goal editing is unavailable. Your draft is unchanged.",
      editFailed: "Couldn’t save the goal. Review its current status and try again.",
      empty: "No goal",
      editChip: "Edit",
      pause: "Pause goal",
      pauseChip: "Pause",
      resume: "Resume goal",
      resumeChip: "Resume",
      resumeUnconfirmed: "Resume not confirmed",
      retryResume: "Retry resume",
      clear: "Clear goal",
      clearChip: "Clear",
      showDetails: "Show goal details",
      hideDetails: "Hide goal details",
    },
  },
} satisfies TranslationMap;

export const registerChatGoalsOptionalEnglish = Object.assign(
  () => {
    registerChatGoalsEnglish();
    Object.assign(en.chat.goals, enChatGoalsOptional.chat.goals);
  },
  { catalog: enChatGoalsOptional },
);
