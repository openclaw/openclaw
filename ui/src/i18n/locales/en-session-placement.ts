import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Session-placement recovery copy is registered with the lazy chat placement
// surfaces so device recovery does not tax every Control UI startup.
const enSessionPlacement = {
  sessionsView: {
    placementFactService: "Service",
    placementFactProfile: "Profile",
    placementFactMachine: "Machine",
    placementFactState: "State",
    placementFactDisk: "Disk",
    placementFactInference: "Inference",
    inferenceGateway: "Through Gateway",
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
    continueOnGatewayConfirm:
      'Continue "{session}" on the Gateway? Unsynced device files and in-flight work may be lost. OpenClaw will continue from the last Gateway-synced state and will not replay the interrupted turn.',
    discardWorkspaceDeleteConfirm:
      'The device for "{session}" is offline and has changes that have not synced. Reconnect it to keep those changes. To delete this session now, discard unsynced device files and in-flight work, then retry deletion once. The last Gateway-synced workspace is used; interrupted work is not replayed.',
    discardWorkspaceDeleteAction: "Discard changes and delete",
    discardWorkspaceArchiveConfirm:
      'The device for "{session}" is offline and has changes that have not synced. Reconnect it to keep those changes. To archive this session now, discard unsynced device files and in-flight work, then retry archiving once. The last Gateway-synced workspace is used; interrupted work is not replayed.',
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
    dispatchSessionTitle: "Choose a worker",
    dispatchSessionDescription: 'Choose where "{session}" should continue.',
    dispatchSessionNotice:
      "This repository exists only on workers, so the Gateway cannot run this session locally.",
    dispatchSessionAction: "Continue on worker",
    stoppingSession: "Stopping session…",
    finishingSessionMove: "Finishing session move…",
    syncingCloudFiles: "Cloud · syncing files",
    syncingCloudFilesComposer: "Send now; your message starts automatically after workspace sync.",
    syncingCloudFilesDetail: "Safely applying cloud edits",
    failedSessionTitle: "Runner failed",
    failedSessionRestartPrompt: "Restart this session to continue.",
    failedSessionStopPrompt: "Stop the failed worker before restarting this session.",
    failedSessionUnavailable: "This session's runner failed and cannot accept messages.",
  },
} satisfies TranslationMap;

export const registerSessionPlacementEnglish = Object.assign(
  () => {
    // SAFETY: The canonical English catalog defines sessionsView as an object; this only extends it.
    Object.assign(en.sessionsView as TranslationMap, enSessionPlacement.sessionsView);
  },
  { catalog: enSessionPlacement },
);
