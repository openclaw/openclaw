import { createPluginBoundaryRuntimeSend } from "./plugin-boundary-send.js";

export const runtimeSend = createPluginBoundaryRuntimeSend({
  pluginId: "slack",
  exportName: "sendMessageSlack",
  missingLabel: "Slack plugin runtime",
});
