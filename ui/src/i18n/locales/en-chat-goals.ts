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
      offlineStatus: "Goal status unavailable",
      busy: "Wait for this run to finish. Your draft is unchanged.",
      annotationUnsupported: "Send or remove browser annotations first. Your draft is unchanged.",
      actionPending: "Wait for the pending goal action.",
      invalidRequest: "Goal update is invalid. Check the objective and try again.",
      outcomeUnknown: "Goal update not confirmed. Check its outcome before making another change.",
      currentObjective: "Current goal",
      requestedObjective: "Requested objective",
      technicalDetails: "Technical details",
      reconnectRecovery: "Reconnect to try again.",
      recovery: {
        edit: {
          title: "Edit not confirmed",
          pending: "Saving goal…",
          description: "The edit may already be saved.",
          action: "Retry save",
        },
        pause: {
          title: "Pause not confirmed",
          pending: "Pausing goal…",
          description: "The goal may already be paused.",
          action: "Retry pause",
        },
        resume: {
          title: "Resume not confirmed",
          pending: "Resuming goal…",
          description: "The resume request may already have started a run.",
          action: "Retry resume",
        },
        clear: {
          title: "Removal not confirmed",
          pending: "Removing goal…",
          description: "The goal may already be removed.",
          action: "Retry removal",
        },
        complete: {
          title: "Completion not confirmed",
          pending: "Completing goal…",
          description: "The goal may already be marked complete.",
          action: "Retry completion",
        },
        block: {
          title: "Block not confirmed",
          pending: "Blocking goal…",
          description: "The goal may already be marked blocked.",
          action: "Retry block",
        },
        unknown: {
          title: "Goal update not confirmed",
          pending: "Updating goal…",
          description: "The last change may already have taken effect.",
          action: "Retry update",
        },
        retired: {
          title: "Goal status needs refreshing",
          pending: "Refreshing goal…",
          action: "Refresh goal",
        },
      },
      recoveryExpired: "This request expired. Refresh the goal to see its current state.",
      recoveryUnavailable:
        "Goal update was not sent because its recovery request could not be saved.",
      recoveryInvalid:
        "This request can no longer be retried. Refresh the goal to see its current state.",
      admissionImmutable: "Retry or remove this request. Editing requires a new goal.",
      edit: "Edit goal",
      editUnavailable: "Goal editing is unavailable. Your draft is unchanged.",
      editFailed: "Couldn't save the goal. Review its current status and try again.",
      empty: "No goal",
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
