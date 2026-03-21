import {
  monitorIMessageProvider,
  probeIMessage,
  sendMessageIMessage,
} from "../../../extensions/imessage/runtime-api.js";
import type { PluginRuntimeChannel } from "./types-channel.js";

export function createRuntimeIMessage(): PluginRuntimeChannel["imessage"] {
  return {
    monitorIMessageProvider,
    probeIMessage,
    sendMessageIMessage,
  };
}
