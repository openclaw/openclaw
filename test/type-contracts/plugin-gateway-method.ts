import { expectTypeOf } from "vitest";
import type { OpenClawPluginApi as CorePluginApi } from "../../src/plugin-sdk/core.js";
import type { GatewayRequestHandlers } from "../../src/plugin-sdk/gateway-runtime.js";
import type { OpenClawPluginApi } from "../../src/plugin-sdk/plugin-entry.js";

function registerGatewayMethods(api: OpenClawPluginApi): void {
  api.registerGatewayMethod("example.sync", () => ({ status: "ready" }));
  api.registerGatewayMethod("example.async", async () => ({ status: "ready" }));
  api.registerGatewayMethod("example.false", async () => false);
  api.registerGatewayMethod("example.null", () => null);
  api.registerGatewayMethod("example.callback", ({ respond }) => {
    respond(true, { status: "ready" });
  });
  api.registerGatewayMethod("example.async-callback", async ({ respond }) => {
    respond(true, { status: "ready" });
  });
}
void registerGatewayMethods;

expectTypeOf<OpenClawPluginApi["registerGatewayMethod"]>().toEqualTypeOf<
  CorePluginApi["registerGatewayMethod"]
>();
expectTypeOf<ReturnType<GatewayRequestHandlers[string]>>().toEqualTypeOf<void | Promise<void>>();
