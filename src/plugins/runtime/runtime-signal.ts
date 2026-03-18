import {
  monitorSignalProvider,
  probeSignal,
  signalMessageActions,
  sendMessageSignal,
} from "../../../extensions/signal/runtime-api.js";
import type { PluginRuntimeChannel } from "./types-channel.js";

export function createRuntimeSignal(): PluginRuntimeChannel["signal"] {
  return {
    probeSignal,
    sendMessageSignal,
    monitorSignalProvider,
    messageActions: signalMessageActions,
  };
}
