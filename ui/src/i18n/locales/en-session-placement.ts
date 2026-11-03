import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Shared session menus and lazy placement surfaces register their placement copy.
const enSessionPlacement = {
  sessionsView: {
    moveFrom: "From",
    moveServerCloud: "Server & cloud",
    moveShowMore: "Show more",
    moveShowLess: "Show less",
    placementFactService: "Service",
    placementFactProfile: "Profile",
    placementFactMachine: "Machine",
    placementFactState: "State",
    placementFactDisk: "Disk",
    placementFactInference: "Inference",
    inferenceWorker: "Direct from worker",
    placementDiskFree: "{free} free",
    runsOnDevice: "Runs on device",
    runsOnWorker: "Runs on worker",
    stopWorker: "Stop worker…",
    stopWorkerConfirm: 'Stop the worker for "{session}"?',
    stopWorkerConfirmAction: "Stop worker",
    deviceOffline: "Device offline",
    waitingForDevice: "Waiting for device to reconnect; retry after it returns.",
    continueOnGatewayMenu: "Continue on Gateway…",
    continueOnGatewayAction: "Continue on Gateway",
    continueOnGatewayTitle: "Continue “{session}” on the Gateway?",
    continueOnGatewayConfirm:
      "Unsynced device files and in-flight work may be lost. OpenClaw continues from the last Gateway-synced state and won’t replay the interrupted turn.",
    discardWorkspaceTitle: "Discard unsynced changes?",
    discardWorkspaceDeleteConfirm:
      "The device for “{session}” is offline with unsynced changes. Reconnect it to keep them, or discard them to delete now. Interrupted work won’t be replayed.",
    discardWorkspaceDeleteAction: "Discard changes and delete",
    discardWorkspaceArchiveConfirm:
      "The device for “{session}” is offline with unsynced changes. Reconnect it to keep them, or discard them to archive now. Interrupted work won’t be replayed.",
    discardWorkspaceArchiveAction: "Discard changes and archive",
    workspaceRecoveryBatchHint:
      "Recover each offline session separately before retrying this selection.",
    stopDeviceWorker: "Stop device worker…",
    offlineDeviceStopUnavailable:
      "Reconnect the device to stop and sync its workspace, or Continue on Gateway.",
    stopDeviceWorkerConfirm: 'Stop the device worker for "{session}"?',
    stopDeviceWorkerConfirmAction: "Stop device worker",
    restartSession: "Restart session…",
    restartingSession: "Restarting session…",
    restartSessionTitle: "Restart session",
    restartSessionDescription: 'Choose where "{session}" should restart.',
    restartSessionWarning:
      "The session restarts from its last saved workspace on the selected destination. Changes that the previous worker did not upload may be lost.",
    restartSessionAction: "Restart session",
    chooseWorker: "Choose worker…",
    dispatchingSession: "Starting worker…",
    repositoryWorkerRequiredLabel: "Worker required",
    repositoryWorkerRequiredTitle: "Repository worker required",
    repositoryWorkerRequiredPrompt:
      "Choose a device or cloud worker before sending another message in this repository session.",
    moveSessionRequiredProfile:
      "This Gateway requires its configured worker profile and machine defaults.",
    moveToCloud: "Move to cloud…",
    retrySessionMove: "Retry move",
    moveLocalSessionBusy: "Wait for the active turn to finish before moving this session.",
    moveSessionWorkspaceRequired:
      "Moving requires a session-owned worktree or repository workspace.",
    dispatchLocalSessionNotice:
      "Continue the same session on a configured cloud worker or device. The active turn must finish before moving.",
    dispatchSessionTitle: "Choose a worker",
    dispatchSessionDescription: 'Choose where "{session}" should continue.',
    dispatchSessionNotice:
      "This repository exists only on workers, so the Gateway cannot run this session locally.",
    dispatchSessionAction: "Continue on worker",
    stoppingSession: "Stopping session…",
    finishingSessionMove: "Finishing session move…",
    syncingCloudFiles: "Worker · syncing files",
    syncingCloudFilesComposer: "Send now; your message starts automatically after workspace sync.",
    syncingCloudFilesDetail: "Finalizing worker workspace",
    failedSessionTitle: "Runner failed",
    failedSessionRestartPrompt: "Restart this session to continue.",
    failedSessionStopPrompt: "Stop the failed worker before restarting this session.",
    failedSessionUnavailable: "This session's runner failed and cannot accept messages.",
  },
} satisfies TranslationMap;

export const registerSessionPlacementEnglish = Object.assign(
  () => {
    Object.assign(en.sessionsView, enSessionPlacement.sessionsView);
  },
  { catalog: enSessionPlacement },
);
