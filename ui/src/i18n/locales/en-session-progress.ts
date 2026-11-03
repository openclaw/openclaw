import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enSessionProgress = {
  sessionProgressCard: {
    title: "Progress",
    composerTitle: en.sessionProgressCard.composerTitle,
    stepCount: "Step {current} of {total}",
    hide: "Hide this card",
    noteLabel: "Progress note",
    dismiss: "Dismiss progress card",
    clearSaved: "Clear saved progress for everyone",
    clearFailed: en.sessionProgressCard.clearFailed,
    refresh: {
      label: "Refresh task progress",
      retry: "Retry progress refresh",
      pending: "Refreshing task progress…",
      failed: "Could not refresh. Previous update kept.",
      timeout: "No new update yet. The request may still be running.",
      updated: "Task progress updated",
    },
    widgetLabel: "Session progress",
    widgetLoading: "Loading session progress…",
    widgetEmpty: "No progress card yet",
    detailsEmptyTitle: "No saved progress",
    detailsEmptyDescription: "Progress saved by this session appears here.",
    showInChat: "Show in chat",
    widgetUnavailable: "Session progress is unavailable.",
    widgetAccessDenied: "Select a session you can access or change sharing for this session.",
    countLabel: "{completed} of {total} completed",
    runtime: {
      children: "Delegated work: {activity}",
      running: "{count} running",
      queued: "{count} queued",
      waiting: "{count} waiting",
      failed: "{count} failed",
      stopped: "{count} stopped",
      delegated: "Waiting for delegated work",
      queuedSelf: "Queued",
      working: "Working",
      idle: "No active work",
      unknown: "Activity unavailable",
      offline: "Connection lost · Activity may be outdated",
    },
    activity: {
      updated: "Updated {time}",
      completed: "Completed {time}",
      failed: "Failed {time}",
      stopped: "Stopped {time}",
    },
    outcome: {
      completed: "Completed",
      failed: "Failed",
      stopped: "Stopped",
    },
    stepLabel: "{step}, {status}",
    status: {
      completed: "completed",
      failed: "failed",
      inProgress: "in progress",
      paused: "paused",
      pending: "pending",
      stopped: "stopped",
    },
    receipt: en.sessionProgressCard.receipt,
  },
} satisfies TranslationMap;

export const registerSessionProgressEnglish = Object.assign(
  () => {
    const { refresh, runtime, activity, outcome, status, ...labels } =
      enSessionProgress.sessionProgressCard;
    Object.assign(en.sessionProgressCard, labels);
    Object.assign(en.sessionProgressCard.refresh, refresh);
    Object.assign(en.sessionProgressCard.runtime, runtime);
    Object.assign(en.sessionProgressCard.activity, activity);
    Object.assign(en.sessionProgressCard.outcome, outcome);
    Object.assign(en.sessionProgressCard.status, status);
  },
  { catalog: enSessionProgress },
);
