import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enChatGoals = {
  chat: {
    goals: {
      composerMode: "Goal",
      sessionChanged: "Session changed. Cancel and select Goal again.",
      start: "Start goal",
      save: "Save goal",
      startHint: "Describe what “done” looks like.",
      editHint: "Save without starting a reply.",
      objectivePlaceholder: "What should this goal accomplish?",
      cancel: "Cancel goal entry",
      offline: "Reconnect to manage goals.",
      busy: "Wait for this reply to finish. Your draft is unchanged.",
      annotationUnsupported: "Send or remove annotations first. Your draft is unchanged.",
      actionPending: "Wait for the pending goal action.",
      invalidRequest: "Couldn’t update the goal. Check the objective and try again.",
      outcomeUnknown: "Goal update not confirmed. Check its outcome before changing it.",
      recoveryTitle: "Goal update not confirmed",
      recoveryHint: "Check the saved request. It won’t repeat a successful update.",
      checking: "Checking goal update…",
      checkOutcome: "Check outcome",
      refreshCurrent: "Review current goal",
      recoveryExpired:
        "This request expired after 24 hours. Review the current goal before changing it.",
      recoveryUnavailable:
        "Couldn’t save the recovery request. Free browser storage and try again. Your goal update wasn’t sent.",
      recoveryInvalid: "Couldn’t recover this request. Review the current goal before retrying.",
      admissionImmutable: "Retry or remove this request. To edit it, start a new goal.",
      replaceTitle: "Replace goal objective?",
      replaceMessage: "Update the objective without changing the goal’s status.",
      replaceRunningMessage: "Interrupt this reply, replace the objective, and resume the goal.",
      replace: "Replace objective",
      goalChanged: "The goal changed. Review it and try again. Your draft is unchanged.",
      edit: "Edit goal",
      editUnavailable: "Goal editing is unavailable. Your draft is unchanged.",
      editFailed: "Couldn’t save the goal. Review its current status and try again.",
      empty: "No goal",
      editChip: "Edit",
      pause: "Pause goal",
      pauseChip: "Pause",
      resume: "Resume goal",
      resumeNote: "What changed",
      resumeNoteRequired: "Enter what changed before resuming.",
      resumeChip: "Resume",
      resuming: "Resuming goal…",
      resumeUnconfirmed: "Resume not confirmed",
      retryResume: "Retry resume",
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
