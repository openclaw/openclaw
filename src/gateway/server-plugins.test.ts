import { describe, expect, test, vi } from "vitest";
import type { PluginRegistry } from "../plugins/registry.js";
import type { PluginDiagnostic } from "../plugins/types.js";
import { loadGatewayPlugins } from "./server-plugins.js";

const loadDNAPlugins = vi.hoisted(() => vi.fn());

vi.mock("../plugins/loader.js", () => ({
  loadDNAPlugins,
}));

const createRegistry = (diagnostics: PluginDiagnostic[]): PluginRegistry => ({
  plugins: [],
  tools: [],
  hooks: [],
  typedHooks: [],
  channels: [],
  providers: [],
  gatewayHandlers: {},
  httpHandlers: [],
  httpRoutes: [],
  cliRegistrars: [],
  services: [],
  diagnostics,
});

describe("loadGatewayPlugins", () => {
  test("logs plugin errors with details", () => {
    const diagnostics: PluginDiagnostic[] = [
      {
        level: "error",
        pluginId: "telegram",
        source: "/tmp/telegram/index.ts",
        message: "failed to load plugin: boom",
      },
    ];
    loadDNAPlugins.mockReturnValue(createRegistry(diagnostics));

    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    loadGatewayPlugins({
      cfg: {},
      workspaceDir: "/tmp",
      log,
      coreGatewayHandlers: {},
      baseMethods: [],
    });

    expect(loadDNAPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        cache: false,
        workspaceDir: "/tmp",
      }),
    );
    expect(log.error).toHaveBeenCalledWith(
      "[plugins] failed to load plugin: boom (plugin=telegram, source=/tmp/telegram/index.ts)",
    );
    expect(log.warn).not.toHaveBeenCalled();
  });
});
