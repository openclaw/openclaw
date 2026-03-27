import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntimeRequestAttributionScope } from "./request-attribution-scope.js";

const TEST_SCOPE: PluginRuntimeRequestAttributionScope = {
  agentId: "agent-alpha",
  sessionKey: "agent:agent-alpha:web:conv-1",
};

afterEach(() => {
  vi.resetModules();
});

describe("request attribution scope", () => {
  it("reuses AsyncLocalStorage across reloaded module instances", async () => {
    const first = await import("./request-attribution-scope.js");

    await first.withPluginRuntimeRequestAttributionScope(TEST_SCOPE, async () => {
      vi.resetModules();
      const second = await import("./request-attribution-scope.js");
      expect(second.getPluginRuntimeRequestAttributionScope()).toEqual(TEST_SCOPE);
    });
  });
});
