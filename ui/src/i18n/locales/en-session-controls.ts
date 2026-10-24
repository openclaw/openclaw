import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Shared controls need these labels before optional session menus are opened.
const enSessionControls = {
  sessionsView: {
    pinRootSessionsOnly: "Only root sessions can be pinned; pin the parent session instead.",
    copyTranscriptChanged: "Conversation changed while copying. Try again.",
    openWindowBlocked: "Allow pop-ups for this site, then try again.",
    splitUnavailable: "Open a conversation on a wide screen to use split view.",
    stopCloudWorker: "Stop cloud worker…",
    stopCloudWorkerConfirm: 'Stop the cloud worker for "{session}"?',
    stopCloudWorkerConfirmAction: "Stop worker",
    moveSessionFailed: "Move failed",
    deleteSessionStale: 'Gateway connection replaced before "{session}" was deleted. Try again.',
    archiveReasonManual: "Archived manually",
    archiveReasonAgeRetention: "Automatically archived by age retention",
    archiveReasonActiveSessionCap:
      "Automatically archived because the active-session limit was reached",
    archiveReasonStaleDashboard: "Automatically archived after dashboard inactivity",
    archiveReasonRestartRecovery: "Archived when a replacement session was recovered",
  },
} satisfies TranslationMap;

export const registerSessionControlsEnglish = Object.assign(
  () => {
    Object.assign(en.sessionsView, enSessionControls.sessionsView);
  },
  { catalog: enSessionControls },
);
