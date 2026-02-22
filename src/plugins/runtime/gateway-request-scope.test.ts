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
  it("reuses AsyncLocalStorage across reloaded module instances", async () => {
    const first = await import("./gateway-request-scope.js");

    await first.withPluginRuntimeGatewayRequestScope(TEST_SCOPE, async () => {
      vi.resetModules();
      const second = await import("./gateway-request-scope.js");
      expect(second.getPluginRuntimeGatewayRequestScope()).toEqual(TEST_SCOPE);
    });
  });
});
