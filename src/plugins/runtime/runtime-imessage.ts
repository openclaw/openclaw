import {
  monitorIMessageProvider,
  probeIMessage,
  sendMessageIMessage,
} from "../../plugin-sdk/imessage.js";
import type { PluginRuntimeChannel } from "./types-channel.js";

export function createRuntimeIMessage(): PluginRuntimeChannel["imessage"] {
  return {
    monitorIMessageProvider,
    probeIMessage,
    sendMessageIMessage,
  };
}
