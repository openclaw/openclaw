import { getActivePluginRegistry } from "../../plugins/runtime.js";
import type { GatewayRequestHandlers } from "./types.js";

export const pluginHostHookHandlers: GatewayRequestHandlers = {
  "plugins.uiDescriptors": ({ respond }) => {
    const descriptors = (getActivePluginRegistry()?.controlUiDescriptors ?? []).map((entry) =>
      Object.assign({}, entry.descriptor, {
        pluginId: entry.pluginId,
        pluginName: entry.pluginName,
      }),
    );
    respond(true, { ok: true, descriptors }, undefined);
  },
};
