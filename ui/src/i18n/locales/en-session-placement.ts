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
    cloudDevice: "Cloud device",
    cloudDeviceProfile: "Cloud device · {profile}",
    runsOnDevice: "Runs on device",
    runsOnWorker: "Runs on a device",
    deviceOffline: "Device disconnected",
    waitingForDevice: "Waiting for the device to reconnect. Retry when it’s connected.",
    continueOnGatewayMenu: "Continue on Gateway…",
    continueOnGatewayAction: "Continue on Gateway",
    continueOnGatewayTitle: "Continue “{session}” on the Gateway?",
    continueOnGatewayConfirm:
      "Unsynced device files and work in progress may be lost. OpenClaw will continue from the last Gateway-synced state and won’t replay the interrupted reply.",
    discardWorkspaceTitle: "Discard unsynced changes?",
    discardWorkspaceDeleteConfirm:
      "The device for “{session}” is offline with unsynced changes. Reconnect it to keep them, or discard them to delete now. Interrupted work won’t be replayed.",
    discardWorkspaceDeleteAction: "Discard changes and delete",
    discardWorkspaceArchiveConfirm:
      "The device for “{session}” is offline with unsynced changes. Reconnect it to keep them, or discard them to archive now. Interrupted work won’t be replayed.",
    discardWorkspaceArchiveAction: "Discard changes and archive",
    workspaceRecoveryBatchHint:
      "Recover each offline session separately before retrying this selection.",
    stopDeviceWorker: "Stop session on device…",
    offlineDeviceStopUnavailable:
      "Reconnect the device to stop and sync its workspace, or continue on the Gateway.",
    stopDeviceWorkerConfirm: "Stop “{session}” on its device?",
    stopDeviceWorkerConfirmAction: "Stop",
    restartSession: "Restart session…",
    restartingSession: "Restarting session…",
    restartSessionTitle: "Restart this session?",
    restartSessionDescription: "Choose where “{session}” should restart.",
    restartSessionWarning:
      "The session restarts from its last saved workspace on the selected destination. Changes that the previous device didn’t upload may be lost.",
    restartSessionAction: "Restart session",
    chooseWorker: "Choose device…",
    dispatchingSession: "Preparing device…",
    repositoryWorkerRequiredLabel: "Device required",
    repositoryWorkerRequiredTitle: "This repository needs a device",
    repositoryWorkerRequiredPrompt:
      "Choose a paired or cloud device before sending another message in this repository session.",
    moveSessionRequiredProfile:
      "This Gateway requires its configured cloud profile and device defaults.",
    moveToCloud: "Move to cloud…",
    retrySessionMove: "Retry move",
    moveLocalSessionBusy: "Wait for the current reply to finish before moving this session.",
    moveSessionWorkspaceRequired:
      "Moving requires a session-owned worktree or repository workspace.",
    dispatchLocalSessionNotice:
      "Continue the same session on a configured cloud device or paired device. The active reply must finish before moving.",
    dispatchSessionTitle: "Choose a device",
    dispatchSessionDescription: "Choose where “{session}” should continue.",
    dispatchSessionNotice:
      "This repository is only available on devices, so the Gateway can’t run this session locally.",
    dispatchSessionAction: "Continue on device",
    stoppingSession: "Stopping session…",
    finishingSessionMove: "Finishing session move…",
    syncingCloudFiles: "Device · syncing files",
    syncingCloudFilesComposer: "Send now; your message starts automatically after workspace sync.",
    syncingCloudFilesDetail: "Saving workspace changes",
    failedSessionTitle: "Couldn’t continue this session",
    failedSessionRestartPrompt: "Restart this session to continue.",
    failedSessionStopPrompt: "Stop this session on its device before restarting it.",
    failedSessionUnavailable: "This session stopped and can’t accept messages.",
  },
} satisfies TranslationMap;

export const registerSessionPlacementEnglish = Object.assign(
  () => {
    Object.assign(en.sessionsView, enSessionPlacement.sessionsView);
  },
  { catalog: enSessionPlacement },
);
