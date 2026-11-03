import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const copy = {
  sessionsView: {
    workerStopTitle: "Stop worker?",
    workerStopDescription: "This will save workspace changes and stop this session’s worker.",
    workerStopCloudDescription:
      "This will save workspace changes and stop this session’s worker in the cloud.",
    workerStopDeviceDescription:
      "This will save workspace changes and stop this session’s worker on",
    workerStopContinue: "Send a new message to continue.",
    workerStopping: "Stopping…",
    workerStopped: "Worker stopped",
    machineConnected: "Connected",
    machineOffline: "Offline",
    machineLocal: "Local",
    machineId: "ID",
    machineConfiguration: "Configuration",
    machineLastKnownState: "Last known worker state",
    machineKeepGoing: "Keep the session going",
    machineRecoveryDescription:
      "This device can’t run your messages right now. Wait for it to reconnect, or continue on the Gateway from the last synchronized state.",
  },
} satisfies TranslationMap;

export const registerSessionMachineEnglish = Object.assign(
  () => Object.assign(en.sessionsView, copy.sessionsView),
  {
    catalog: copy,
  },
);
