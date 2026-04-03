import { createPluginBoundaryRuntimeSend } from "./plugin-boundary-send.js";

export const runtimeSend = createPluginBoundaryRuntimeSend({
  pluginId: "whatsapp",
  exportName: "sendMessageWhatsApp",
  missingLabel: "WhatsApp plugin runtime",
});
