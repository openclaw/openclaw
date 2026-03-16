import { monitorSignalProvider } from "../../../extensions/signal/src/index.js";
import { probeSignal } from "../../../extensions/signal/src/probe.js";
import { sendMessageSignal } from "../../../extensions/signal/src/send.js";
import { signalMessageActions } from "../../channels/plugins/actions/signal.js";
import type { PluginRuntimeChannel } from "./types-channel.js";

export function createRuntimeSignal(): PluginRuntimeChannel["signal"] {
  return {
    probeSignal,
    sendMessageSignal,
    monitorSignalProvider,
    messageActions: signalMessageActions,
  };
}
