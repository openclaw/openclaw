import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRequestHandlerOptions } from "./types.js";

const mocks = vi.hoisted(() => ({
  listManagedPlugins: vi.fn(),
  inspectManagedPlugin: vi.fn(),
  doctorManagedPlugins: vi.fn(),
  inspectManagedPluginRegistry: vi.fn(),
  refreshManagedPluginRegistry: vi.fn(),
  installManagedPlugin: vi.fn(),
  updateManagedPlugins: vi.fn(),
  uninstallManagedPlugin: vi.fn(),
  setManagedPluginEnabled: vi.fn(),
}));

vi.mock("../../plugins/management.js", () => ({
  listManagedPlugins: mocks.listManagedPlugins,
  inspectManagedPlugin: mocks.inspectManagedPlugin,
  doctorManagedPlugins: mocks.doctorManagedPlugins,
  inspectManagedPluginRegistry: mocks.inspectManagedPluginRegistry,
  refreshManagedPluginRegistry: mocks.refreshManagedPluginRegistry,
  installManagedPlugin: mocks.installManagedPlugin,
  updateManagedPlugins: mocks.updateManagedPlugins,
  uninstallManagedPlugin: mocks.uninstallManagedPlugin,
  setManagedPluginEnabled: mocks.setManagedPluginEnabled,
}));

const { pluginManagementHandlers } = await import("./plugins.js");

function createOptions(
  method: string,
  params: Record<string, unknown>,
  overrides?: Partial<GatewayRequestHandlerOptions>,
): GatewayRequestHandlerOptions {
  return {
    req: { type: "req", id: "req-1", method, params },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond: vi.fn(),
    context: {},
    ...overrides,
  } as unknown as GatewayRequestHandlerOptions;
}

describe("pluginManagementHandlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls the plugin install service for validated install requests", async () => {
    mocks.installManagedPlugin.mockResolvedValue({
      ok: true,
      installed: true,
      id: "demo",
    });
    const opts = createOptions("plugins.install", {
      source: "npm",
      spec: "@openclaw/demo-plugin",
      force: true,
    });

    await pluginManagementHandlers["plugins.install"](opts);

    expect(mocks.installManagedPlugin).toHaveBeenCalledWith({
      source: "npm",
      spec: "@openclaw/demo-plugin",
      force: true,
    });
    expect(opts.respond).toHaveBeenCalledWith(
      true,
      { ok: true, installed: true, id: "demo" },
      undefined,
    );
  });

  it("returns registry status payloads from the plugin registry service", async () => {
    const registryStatus = {
      registry: {
        plugins: [],
        diagnostics: [],
      },
    };
    mocks.inspectManagedPluginRegistry.mockResolvedValue(registryStatus);
    const opts = createOptions("plugins.registry.status", {});

    await pluginManagementHandlers["plugins.registry.status"](opts);

    expect(mocks.inspectManagedPluginRegistry).toHaveBeenCalledWith();
    expect(opts.respond).toHaveBeenCalledWith(true, registryStatus, undefined);
  });

  it("maps update selection errors to invalid request", async () => {
    mocks.updateManagedPlugins.mockResolvedValue({
      ok: false,
      error: {
        kind: "invalid-request",
        message: "plugins.update requires either id or all=true",
      },
    });
    const opts = createOptions("plugins.update", {});

    await pluginManagementHandlers["plugins.update"](opts);

    expect(opts.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: "plugins.update: plugins.update requires either id or all=true",
      }),
    );
  });

  it("maps not-found service errors to invalid request", async () => {
    mocks.uninstallManagedPlugin.mockResolvedValue({
      ok: false,
      error: {
        kind: "not-found",
        message: "plugin not found: demo",
      },
    });
    const opts = createOptions("plugins.uninstall", {
      id: "demo",
      force: true,
    });

    await pluginManagementHandlers["plugins.uninstall"](opts);

    expect(opts.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: "plugins.uninstall: plugin not found: demo",
      }),
    );
  });

  it("maps missing install source fields to invalid request", async () => {
    const opts = createOptions("plugins.install", {
      source: "npm",
    });

    await pluginManagementHandlers["plugins.install"](opts);

    expect(mocks.installManagedPlugin).not.toHaveBeenCalled();
    expect(opts.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: 'plugins.install: plugins.install source "npm" requires "spec"',
      }),
    );
  });

  it("maps inspect not-found service errors to invalid request", async () => {
    mocks.inspectManagedPlugin.mockResolvedValue({
      ok: false,
      error: {
        kind: "not-found",
        message: "Plugin not found: demo",
      },
    });
    const opts = createOptions("plugins.inspect", {
      id: "demo",
    });

    await pluginManagementHandlers["plugins.inspect"](opts);

    expect(opts.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: "plugins.inspect: Plugin not found: demo",
      }),
    );
  });

  it("maps enable conflicts to invalid request", async () => {
    mocks.setManagedPluginEnabled.mockResolvedValue({
      ok: false,
      error: {
        kind: "conflict",
        message: 'Plugin "demo" could not be enabled (blocked by denylist).',
      },
    });
    const opts = createOptions("plugins.enable", {
      id: "demo",
    });

    await pluginManagementHandlers["plugins.enable"](opts);

    expect(mocks.setManagedPluginEnabled).toHaveBeenCalledWith({
      id: "demo",
      enabled: true,
    });
    expect(opts.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: 'plugins.enable: Plugin "demo" could not be enabled (blocked by denylist).',
      }),
    );
  });
});
