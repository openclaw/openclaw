import { monitorIMessageProvider } from "../../../extensions/imessage/src/monitor.js";
import { probeIMessage } from "../../../extensions/imessage/src/probe.js";
import { sendMessageIMessage } from "../../../extensions/imessage/src/send.js";
import type { PluginRuntimeChannel } from "./types-channel.js";

export function createRuntimeIMessage(): PluginRuntimeChannel["imessage"] {
  return {
    monitorIMessageProvider,
    probeIMessage,
    sendMessageIMessage,
  };
}
