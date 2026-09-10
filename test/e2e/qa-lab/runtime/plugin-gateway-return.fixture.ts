import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

const plugin = {
  id: "ts-gateway-return",
  register(api: OpenClawPluginApi) {
    api.registerGatewayMethod("ts-gateway-return.echo", async () => ({
      ok: true,
      source: "typescript",
    }));
  },
};

export default plugin;
