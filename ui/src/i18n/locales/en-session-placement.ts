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
    placementFactMachine: "Device",
    placementFactState: "State",
    placementFactDisk: "Disk",
    placementFactInference: "Inference",
    inferenceWorker: "Direct from device",
    placementDiskFree: "{free} free",
    runsOnDevice: "Runs on device",
    runsOnWorker: "Runs on device",
    stopWorker: "Stop cloud device…",
    stopWorkerConfirm: "Stop this cloud device?",
    stopWorkerConfirmAction: "Stop",
    deviceOffline: "Device disconnected",
    waitingForDevice: "Reconnect the device to try again.",
    continueOnGatewayMenu: "Continue on Gateway…",
    continueOnGatewayAction: "Continue on Gateway",
    continueOnGatewayTitle: "Continue “{session}” on the Gateway?",
    continueOnGatewayConfirm:
      "Unsynced device files and active work may be lost. OpenClaw continues from the last Gateway-synced state and won’t replay the interrupted reply.",
    discardWorkspaceTitle: "Discard unsynced changes?",
    discardWorkspaceDeleteConfirm:
      "The device for “{session}” is offline with unsynced changes. Reconnect it to keep them, or discard them to delete now. Interrupted work won’t be replayed.",
    discardWorkspaceDeleteAction: "Discard changes and delete",
    discardWorkspaceArchiveConfirm:
      "The device for “{session}” is offline with unsynced changes. Reconnect it to keep them, or discard them to archive now. Interrupted work won’t be replayed.",
    discardWorkspaceArchiveAction: "Discard changes and archive",
    workspaceRecoveryBatchHint:
      "Recover each offline session separately before retrying this selection.",
    stopDeviceWorker: "Stop work on device…",
    offlineDeviceStopUnavailable:
      "Reconnect the device to stop and sync its workspace, or Continue on Gateway.",
    stopDeviceWorkerConfirm: "Stop work on this device?",
    stopDeviceWorkerConfirmAction: "Stop",
    restartSession: "Restart session…",
    restartingSession: "Restarting session…",
    restartSessionTitle: "Restart this session?",
    restartSessionDescription: "Choose where “{session}” should restart.",
    restartSessionWarning:
      "The session restarts from its last saved workspace on the selected device. Changes that the previous device didn’t upload may be lost.",
    restartSessionAction: "Restart session",
    chooseWorker: "Choose device…",
    dispatchingSession: "Starting device…",
    repositoryWorkerRequiredLabel: "Device required",
    repositoryWorkerRequiredTitle: "Repository device required",
    repositoryWorkerRequiredPrompt:
      "Choose a device before sending another message in this repository session.",
    moveSessionRequiredProfile: "This Gateway requires its configured device profile and defaults.",
    moveToCloud: "Move to cloud…",
    retrySessionMove: "Retry move",
    moveLocalSessionBusy: "Wait for the active reply to finish before moving this session.",
    moveSessionWorkspaceRequired:
      "Moving requires a session-owned worktree or repository workspace.",
    dispatchLocalSessionNotice:
      "Continue the same session on a configured cloud device or paired device. The active reply must finish before moving.",
    dispatchSessionTitle: "Choose a device",
    dispatchSessionDescription: "Choose where “{session}” should continue.",
    dispatchSessionNotice:
      "This repository exists only on other devices, so the Gateway can’t run this session locally.",
    dispatchSessionAction: "Continue on device",
    stoppingSession: "Stopping session…",
    finishingSessionMove: "Finishing session move…",
    syncingCloudFiles: "Device · syncing files",
    syncingCloudFilesComposer: "Send now; your message starts automatically after workspace sync.",
    syncingCloudFilesDetail: "Finalizing device workspace",
    failedSessionTitle: "Device failed",
    failedSessionRestartPrompt: "Restart this session to continue.",
    failedSessionStopPrompt: "Stop work on the failed device before restarting this session.",
    failedSessionUnavailable: "This session’s device failed and can’t accept messages.",
  },
} satisfies TranslationMap;

export const registerSessionPlacementEnglish = Object.assign(
  () => {
    Object.assign(en.sessionsView, enSessionPlacement.sessionsView);
  },
  { catalog: enSessionPlacement },
);
