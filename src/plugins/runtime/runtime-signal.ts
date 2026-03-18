import {
  monitorSignalProvider,
  probeSignal,
  signalMessageActions,
  sendMessageSignal,
} from "openclaw/plugin-sdk/signal";
import type { PluginRuntimeChannel } from "./types-channel.js";

export function createRuntimeSignal(): PluginRuntimeChannel["signal"] {
  return {
    probeSignal,
    sendMessageSignal,
    monitorSignalProvider,
    messageActions: signalMessageActions,
  };
}
