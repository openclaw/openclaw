import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const copy = {
  sessionsView: {
    workerStopCloudTitle: "Stop this cloud device?",
    workerStopDeviceTitle: "Stop this session on the device?",
    workerStopDeviceFallback: "this device",
    workerStopTitle: "Stop this session?",
    workerStopDescription:
      "This session stops working on its device after saving workspace changes. Your conversation and saved changes stay.",
    workerStopCloudDescription:
      "The session stops working on it and the machine is released. Your conversation and accepted changes stay.",
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
