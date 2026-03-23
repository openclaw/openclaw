import {
  isXAccountConfigured,
  listXAccountIds,
  resolveDefaultXAccountId,
  resolveXAccount,
} from "../../x/accounts.js";
import { removeClientManager } from "../../x/client.js";
import { monitorXProvider } from "../../x/monitor.js";
import { probeX } from "../../x/probe.js";
import { chunkTextForX, sendMessageX } from "../../x/send.js";
import type { PluginRuntimeChannel } from "./types-channel.js";

export function createRuntimeX(): PluginRuntimeChannel["x"] {
  return {
    defaultAccountId: "default",
    listXAccountIds,
    resolveXAccount,
    isXAccountConfigured,
    resolveDefaultXAccountId,
    chunkTextForX,
    sendMessageX,
    probeX,
    removeClientManager,
    monitorXProvider,
  };
}
