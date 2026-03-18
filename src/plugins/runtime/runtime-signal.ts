import {
  monitorSignalProvider,
  probeSignal,
  sendMessageSignal,
} from "../../../extensions/signal/runtime-api.js";
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
