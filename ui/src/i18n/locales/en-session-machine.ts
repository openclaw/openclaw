import type { TranslationMap } from "../lib/types.ts";
import { registerSessionOrganizationSharedEnglish } from "./en-session-organization-shared.ts";
import { en } from "./en.ts";

const sharedSessions = registerSessionOrganizationSharedEnglish.catalog.sessionsView;
const copy = {
  sessionsView: {
    workerStopCloudTitle: sharedSessions.stopCloudWorkerConfirm,
    workerStopDeviceTitle: "Stop this session on the device?",
    workerStopDeviceFallback: "this device",
    workerStopTitle: "Stop this session?",
    workerStopDescription: sharedSessions.stopWorkerDescription,
    workerStopCloudDescription: sharedSessions.stopCloudWorkerDescription,
    workerStopDeviceDescription:
      "This session stops working on {device} after saving workspace changes. Other sessions on the device keep running.",
    workerStopping: "Stopping…",
    workerStopped: "Session stopped on device",
    machineConnected: "Connected",
    machineOffline: "Disconnected",
    machineLocal: "Local",
    machineId: "ID",
    machineConfiguration: "Configuration",
    machineLastKnownState: "Last known device state",
    machineKeepGoing: "Keep the session going",
    machineRecoveryDescription:
      "This device can’t reply right now. Wait for it to reconnect, or continue on the Gateway from the last synchronized state.",
  },
} satisfies TranslationMap;

export const registerSessionMachineEnglish = Object.assign(
  () => Object.assign(en.sessionsView, copy.sessionsView),
  {
    catalog: copy,
  },
);
