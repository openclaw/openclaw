import {
  monitorSignalProvider,
  probeSignal,
  signalMessageActions,
  sendMessageSignal,
} from "../../plugin-sdk/signal.js";
import type { PluginRuntimeChannel } from "./types-channel.js";

export function createRuntimeSignal(): PluginRuntimeChannel["signal"] {
  return {
    probeSignal,
    sendMessageSignal,
    monitorSignalProvider,
    messageActions: signalMessageActions,
  };
}
