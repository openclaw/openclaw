import { describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import {
  createExtensionHostGatewayExtraHandlers,
  logExtensionHostPluginDiagnostics,
  resolveExtensionHostGatewayMethods,
} from "./gateway-methods.js";

describe("resolveExtensionHostGatewayMethods", () => {
  it("adds plugin methods without duplicating base methods", () => {
    const registry = createEmptyPluginRegistry();
    registry.gatewayHandlers.health = vi.fn();
    registry.gatewayHandlers["plugin.echo"] = vi.fn();

    expect(
      resolveExtensionHostGatewayMethods({
        registry,
        baseMethods: ["health", "config.get"],
      }),
    ).toEqual(["health", "config.get", "plugin.echo"]);
  });
});

describe("createExtensionHostGatewayExtraHandlers", () => {
  it("lets caller-provided handlers override plugin handlers", () => {
    const pluginHandler = vi.fn();
    const callerHandler = vi.fn();
    const registry = createEmptyPluginRegistry();
    registry.gatewayHandlers.demo = pluginHandler;

    const handlers = createExtensionHostGatewayExtraHandlers({
      registry,
      extraHandlers: { demo: callerHandler, health: vi.fn() },
    });

    expect(handlers.demo).toBe(callerHandler);
    expect(handlers.health).toBeTypeOf("function");
  });
});

describe("logExtensionHostPluginDiagnostics", () => {
  it("routes error diagnostics to error and others to info", () => {
    const log = {
      info: vi.fn(),
      error: vi.fn(),
    };

    logExtensionHostPluginDiagnostics({
      diagnostics: [
        {
          level: "warn",
          pluginId: "demo",
          source: "bundled",
          message: "warned",
        },
        {
          level: "error",
          pluginId: "demo",
          source: "bundled",
          message: "failed",
        },
      ],
      log,
    });

    expect(log.info).toHaveBeenCalledWith("[plugins] warned (plugin=demo, source=bundled)");
    expect(log.error).toHaveBeenCalledWith("[plugins] failed (plugin=demo, source=bundled)");
  });
});
