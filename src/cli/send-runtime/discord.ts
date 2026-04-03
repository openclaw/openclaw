import { createPluginBoundaryRuntimeSend } from "./plugin-boundary-send.js";

export const runtimeSend = createPluginBoundaryRuntimeSend({
  pluginId: "discord",
  exportName: "sendMessageDiscord",
  missingLabel: "Discord plugin runtime",
});
