import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import type { PluginRegistry } from "../plugins/registry.js";
import type { PluginDiagnostic } from "../plugins/types.js";
import { loadGatewayPlugins, autoUpdatePluginsOnStartup } from "./server-plugins.js";

const loadOpenClawPlugins = vi.hoisted(() => vi.fn());
const updateNpmInstalledPlugins = vi.hoisted(() => vi.fn());
const writeConfigFile = vi.hoisted(() => vi.fn());

vi.mock("../plugins/loader.js", () => ({
  loadOpenClawPlugins,
}));

vi.mock("../plugins/update.js", () => ({
  updateNpmInstalledPlugins,
}));

vi.mock("../config/config-file.js", () => ({
  writeConfigFile,
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

const createLog = () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
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
    loadOpenClawPlugins.mockReturnValue(createRegistry(diagnostics));

    const log = createLog();

    loadGatewayPlugins({
      cfg: {},
      workspaceDir: "/tmp",
      log,
      coreGatewayHandlers: {},
      baseMethods: [],
    });

    expect(log.error).toHaveBeenCalledWith(
      "[plugins] failed to load plugin: boom (plugin=telegram, source=/tmp/telegram/index.ts)",
    );
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe("autoUpdatePluginsOnStartup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("skips when autoUpdate is false", async () => {
    const log = createLog();
    const cfg = { plugins: { autoUpdate: false } };

    const result = await autoUpdatePluginsOnStartup({ cfg, log });

    expect(result).toBe(cfg);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("skips when no npm plugins installed", async () => {
    const log = createLog();
    const cfg = {
      plugins: {
        installs: {
          "local-plugin": { source: "path" as const },
        },
      },
    };

    const result = await autoUpdatePluginsOnStartup({ cfg, log });

    expect(result).toBe(cfg);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("skips plugin checked within 5 minutes", async () => {
    const log = createLog();
    const recentTime = new Date(Date.now() - 60 * 1000).toISOString(); // 1 minute ago
    const cfg = {
      plugins: {
        installs: {
          "my-plugin": {
            source: "npm" as const,
            spec: "my-plugin",
            version: "1.0.0",
            installedAt: recentTime,
          },
        },
      },
    };

    const result = await autoUpdatePluginsOnStartup({ cfg, log });

    expect(result).toBe(cfg);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("checks npm registry for outdated plugins", async () => {
    const log = createLog();
    const oldTime = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 minutes ago
    const cfg = {
      plugins: {
        installs: {
          "my-plugin": {
            source: "npm" as const,
            spec: "my-plugin",
            version: "1.0.0",
            installedAt: oldTime,
          },
        },
      },
    };

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ version: "1.0.0" }),
    } as Response);

    const result = await autoUpdatePluginsOnStartup({ cfg, log });

    expect(fetch).toHaveBeenCalledWith(
      "https://registry.npmjs.org/my-plugin/latest",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result).toBe(cfg);
    expect(updateNpmInstalledPlugins).not.toHaveBeenCalled();
  });

  test("updates plugin when new version available", async () => {
    const log = createLog();
    const oldTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const cfg = {
      plugins: {
        installs: {
          "my-plugin": {
            source: "npm" as const,
            spec: "my-plugin",
            version: "1.0.0",
            installedAt: oldTime,
          },
        },
      },
    };

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ version: "2.0.0" }),
    } as Response);

    const updatedConfig = { ...cfg, updated: true };
    updateNpmInstalledPlugins.mockResolvedValue({
      config: updatedConfig,
      changed: true,
      outcomes: [{ pluginId: "my-plugin", status: "updated", message: "Updated my-plugin" }],
    });

    const result = await autoUpdatePluginsOnStartup({ cfg, log });

    expect(updateNpmInstalledPlugins).toHaveBeenCalledWith({
      config: cfg,
      pluginIds: ["my-plugin"],
      logger: expect.any(Object),
    });
    expect(writeConfigFile).toHaveBeenCalledWith(updatedConfig);
    expect(log.info).toHaveBeenCalledWith("[plugins] Update available: my-plugin 1.0.0 -> 2.0.0");
    expect(result).toBe(updatedConfig);
  });

  test("handles fetch failure gracefully", async () => {
    const log = createLog();
    const oldTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const cfg = {
      plugins: {
        installs: {
          "my-plugin": {
            source: "npm" as const,
            spec: "my-plugin",
            version: "1.0.0",
            installedAt: oldTime,
          },
        },
      },
    };

    vi.mocked(fetch).mockRejectedValue(new Error("Network error"));

    const result = await autoUpdatePluginsOnStartup({ cfg, log });

    expect(result).toBe(cfg);
    expect(updateNpmInstalledPlugins).not.toHaveBeenCalled();
  });
});
