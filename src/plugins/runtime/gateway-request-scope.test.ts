import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntimeGatewayRequestScope } from "./gateway-request-scope.js";

const TEST_SCOPE: PluginRuntimeGatewayRequestScope = {
  context: {} as PluginRuntimeGatewayRequestScope["context"],
  isWebchatConnect: (() => false) as PluginRuntimeGatewayRequestScope["isWebchatConnect"],
};

afterEach(() => {
  vi.resetModules();
});

describe("gateway request scope", () => {
  async function importGatewayRequestScopeModule() {
    return await import("./gateway-request-scope.js");
  }

  async function withTestGatewayScope<T>(
    run: (runtimeScope: Awaited<ReturnType<typeof importGatewayRequestScopeModule>>) => Promise<T>,
  ) {
    const runtimeScope = await importGatewayRequestScopeModule();
    return await runtimeScope.withPluginRuntimeGatewayRequestScope(TEST_SCOPE, async () => {
      return await run(runtimeScope);
    });
  }

  it("reuses AsyncLocalStorage across reloaded module instances", async () => {
    const first = await importGatewayRequestScopeModule();

    await first.withPluginRuntimeGatewayRequestScope(TEST_SCOPE, async () => {
      vi.resetModules();
      const second = await importGatewayRequestScopeModule();
      expect(second.getPluginRuntimeGatewayRequestScope()).toEqual(TEST_SCOPE);
    });
  });

  it("attaches plugin id to the active scope", async () => {
    await withTestGatewayScope(async (runtimeScope) => {
      await runtimeScope.withPluginRuntimePluginIdScope("voice-call", async () => {
        expect(runtimeScope.getPluginRuntimeGatewayRequestScope()).toEqual({
          ...TEST_SCOPE,
          pluginId: "voice-call",
        });
      });
    });
  });
});
