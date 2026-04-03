import { createPluginBoundaryRuntimeSend } from "./plugin-boundary-send.js";

export const runtimeSend = createPluginBoundaryRuntimeSend({
  pluginId: "signal",
  exportName: "sendMessageSignal",
  missingLabel: "Signal plugin runtime",
});
