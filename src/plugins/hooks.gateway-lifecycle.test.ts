import { describe, expect, it, vi } from "vitest";
import type { PluginRegistry } from "./registry.js";
import type { PluginHookRegistration } from "./types.js";
import { createHookRunner } from "./hooks.js";

/**
 * Helper to build a minimal PluginRegistry with the given typed hooks.
 */
function makeRegistry(typedHooks: PluginHookRegistration[] = []): PluginRegistry {
  return {
    plugins: [],
    tools: [],
    hooks: [],
    typedHooks,
    channels: [],
    providers: [],
    gatewayHandlers: {},
    httpHandlers: [],
    httpRoutes: [],
    cliRegistrars: [],
    services: [],
    commands: [],
    diagnostics: [],
  };
}

describe("gateway lifecycle hooks", () => {
  // -----------------------------------------------------------------------
  // gateway_start
  // -----------------------------------------------------------------------

  it("fires all registered gateway_start handlers", async () => {
    const calls: Array<{ port: number }> = [];
    const registry = makeRegistry([
      {
        pluginId: "plugin-a",
        hookName: "gateway_start",
        handler: async (event) => {
          calls.push({ port: (event as { port: number }).port });
        },
        source: "test",
      },
      {
        pluginId: "plugin-b",
        hookName: "gateway_start",
        handler: async (event) => {
          calls.push({ port: (event as { port: number }).port });
        },
        source: "test",
      },
    ]);
    const runner = createHookRunner(registry, { catchErrors: true });

    await runner.runGatewayStart({ port: 18789 }, {});

    expect(calls).toHaveLength(2);
    expect(calls[0]?.port).toBe(18789);
    expect(calls[1]?.port).toBe(18789);
  });

  // -----------------------------------------------------------------------
  // gateway_stop
  // -----------------------------------------------------------------------

  it("fires all registered gateway_stop handlers", async () => {
    const calls: Array<{ reason?: string }> = [];
    const registry = makeRegistry([
      {
        pluginId: "plugin-a",
        hookName: "gateway_stop",
        handler: async (event) => {
          calls.push({ reason: (event as { reason?: string }).reason });
        },
        source: "test",
      },
      {
        pluginId: "plugin-b",
        hookName: "gateway_stop",
        handler: async (event) => {
          calls.push({ reason: (event as { reason?: string }).reason });
        },
        source: "test",
      },
    ]);
    const runner = createHookRunner(registry, { catchErrors: true });

    await runner.runGatewayStop({ reason: "shutdown" }, {});

    expect(calls).toHaveLength(2);
    expect(calls[0]?.reason).toBe("shutdown");
    expect(calls[1]?.reason).toBe("shutdown");
  });

  // -----------------------------------------------------------------------
  // No-op when empty
  // -----------------------------------------------------------------------

  it("is a no-op when no gateway_start handlers are registered", async () => {
    const registry = makeRegistry([]);
    const runner = createHookRunner(registry, { catchErrors: true });

    // Should resolve without errors
    await expect(runner.runGatewayStart({ port: 3000 }, {})).resolves.toBeUndefined();
  });

  it("is a no-op when no gateway_stop handlers are registered", async () => {
    const registry = makeRegistry([]);
    const runner = createHookRunner(registry, { catchErrors: true });

    await expect(runner.runGatewayStop({ reason: "test" }, {})).resolves.toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // Error handling
  // -----------------------------------------------------------------------

  it("catches handler errors gracefully for gateway_start", async () => {
    const errorLogger = { warn: vi.fn(), error: vi.fn() };
    const registry = makeRegistry([
      {
        pluginId: "bad-plugin",
        hookName: "gateway_start",
        handler: async () => {
          throw new Error("boom");
        },
        source: "test",
      },
      {
        pluginId: "good-plugin",
        hookName: "gateway_start",
        handler: async () => {
          /* success */
        },
        source: "test",
      },
    ]);
    const runner = createHookRunner(registry, { catchErrors: true, logger: errorLogger });

    // Should not throw
    await expect(runner.runGatewayStart({ port: 5000 }, {})).resolves.toBeUndefined();

    // Error should have been logged
    expect(errorLogger.error).toHaveBeenCalledWith(expect.stringContaining("bad-plugin"));
  });

  it("catches handler errors gracefully for gateway_stop", async () => {
    const errorLogger = { warn: vi.fn(), error: vi.fn() };
    const registry = makeRegistry([
      {
        pluginId: "bad-plugin",
        hookName: "gateway_stop",
        handler: async () => {
          throw new Error("kaboom");
        },
        source: "test",
      },
    ]);
    const runner = createHookRunner(registry, { catchErrors: true, logger: errorLogger });

    await expect(runner.runGatewayStop({ reason: "test" }, {})).resolves.toBeUndefined();

    expect(errorLogger.error).toHaveBeenCalledWith(expect.stringContaining("bad-plugin"));
  });
});
