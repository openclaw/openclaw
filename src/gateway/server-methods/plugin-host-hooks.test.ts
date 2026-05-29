import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import type { PluginRegistry } from "../../plugins/registry.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { consumePluginUiEntryPointLaunchToken } from "../plugin-ui-entry-launch-tokens.js";
import { coreGatewayHandlers } from "../server-methods.js";
import { pluginHostHookHandlers } from "./plugin-host-hooks.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

function invokeUiEntryPoints(params: {
  registry: PluginRegistry;
  scopes?: string[];
  requestParams?: Record<string, unknown>;
}) {
  setActivePluginRegistry(params.registry);
  const respond = vi.fn();
  void pluginHostHookHandlers["plugins.uiEntryPoints"]({
    params: params.requestParams ?? {},
    respond,
    client: {
      connect: {
        role: "operator",
        scopes: params.scopes ?? [],
      },
    },
  } as unknown as GatewayRequestHandlerOptions);
  return respond;
}

function invokeUiEntryPointLaunch(params: {
  registry: PluginRegistry;
  scopes?: string[];
  requestParams?: Record<string, unknown>;
}) {
  setActivePluginRegistry(params.registry);
  const respond = vi.fn();
  void pluginHostHookHandlers["plugins.uiEntryPointLaunch"]({
    params: params.requestParams ?? {},
    respond,
    client: {
      connect: {
        role: "operator",
        scopes: params.scopes ?? [],
      },
    },
  } as unknown as GatewayRequestHandlerOptions);
  return respond;
}

describe("pluginHostHookHandlers", () => {
  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("filters Control UI entry points by caller scopes", () => {
    const registry = createEmptyPluginRegistry();
    registry.controlUiEntryPoints = [
      {
        pluginId: "notes-plugin",
        pluginName: "Session Search",
        source: "/tmp/notes-plugin/index.ts",
        entryPoint: {
          id: "sessions",
          surface: "app-nav",
          label: "Sessions",
          path: "/plugins/notes-plugin/",
          openMode: "in-app",
          requiredScopes: ["operator.read"],
        },
      },
      {
        pluginId: "admin-panel",
        pluginName: "Admin Panel",
        source: "/tmp/admin-panel/index.ts",
        entryPoint: {
          id: "admin",
          surface: "app-nav",
          label: "Admin",
          path: "/plugins/admin-panel/",
          requiredScopes: ["operator.admin"],
        },
      },
    ];

    const respond = invokeUiEntryPoints({
      registry,
      scopes: ["operator.read"],
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      {
        ok: true,
        entryPoints: [
          {
            id: "sessions",
            pluginId: "notes-plugin",
            pluginName: "Session Search",
            surface: "app-nav",
            label: "Sessions",
            path: "/plugins/notes-plugin/",
            openMode: "in-app",
            requiredScopes: ["operator.read"],
          },
        ],
      },
      undefined,
    );
  });

  it("allows admin callers to see every Control UI entry point", () => {
    const registry = createEmptyPluginRegistry();
    registry.controlUiEntryPoints = [
      {
        pluginId: "admin-panel",
        source: "/tmp/admin-panel/index.ts",
        entryPoint: {
          id: "admin",
          surface: "app-nav",
          label: "Admin",
          path: "/plugins/admin-panel/",
          requiredScopes: ["operator.admin"],
        },
      },
    ];

    const respond = invokeUiEntryPoints({
      registry,
      scopes: ["operator.admin"],
    });

    expect(respond.mock.calls[0]?.[1]).toMatchObject({
      ok: true,
      entryPoints: [
        {
          id: "admin",
          pluginId: "admin-panel",
          surface: "app-nav",
          path: "/plugins/admin-panel/",
        },
      ],
    });
  });

  it("issues a short-lived launch path for visible Control UI entry points", () => {
    const registry = createEmptyPluginRegistry();
    registry.controlUiEntryPoints = [
      {
        pluginId: "notes-plugin",
        source: "/tmp/notes-plugin/index.ts",
        entryPoint: {
          id: "sessions",
          surface: "app-nav",
          label: "Sessions",
          path: "/plugins/notes-plugin/",
          requiredScopes: ["operator.read"],
        },
      },
    ];

    const respond = invokeUiEntryPointLaunch({
      registry,
      scopes: ["operator.read"],
      requestParams: {
        id: "sessions",
        pluginId: "notes-plugin",
        path: "/plugins/notes-plugin/",
      },
    });

    expect(respond.mock.calls[0]?.[0]).toBe(true);
    expect(respond.mock.calls[0]?.[1]).toMatchObject({
      ok: true,
      expiresInMs: 60_000,
    });
    expect(respond.mock.calls[0]?.[1]?.path).toMatch(
      /^\/plugins\/notes-plugin\/\?__openclaw_plugin_entry=/,
    );
  });

  it("routes Control UI entry point RPCs through core gateway handlers", async () => {
    const registry = createEmptyPluginRegistry();
    registry.controlUiEntryPoints = [
      {
        pluginId: "notes-plugin",
        pluginName: "Session Search",
        source: "/tmp/notes-plugin/index.ts",
        entryPoint: {
          id: "sessions",
          surface: "app-nav",
          label: "Sessions",
          path: "/plugins/notes-plugin/",
          requiredScopes: ["operator.read"],
        },
      },
    ];
    setActivePluginRegistry(registry);

    const listRespond = vi.fn();
    await coreGatewayHandlers["plugins.uiEntryPoints"]({
      params: {},
      respond: listRespond,
      client: {
        connect: {
          role: "operator",
          scopes: ["operator.read"],
        },
      },
    } as unknown as GatewayRequestHandlerOptions);

    expect(listRespond.mock.calls[0]?.[1]).toMatchObject({
      ok: true,
      entryPoints: [
        {
          id: "sessions",
          pluginId: "notes-plugin",
          pluginName: "Session Search",
          path: "/plugins/notes-plugin/",
        },
      ],
    });

    const launchRespond = vi.fn();
    await coreGatewayHandlers["plugins.uiEntryPointLaunch"]({
      params: {
        id: "sessions",
        pluginId: "notes-plugin",
        path: "/plugins/notes-plugin/",
      },
      respond: launchRespond,
      client: {
        connect: {
          role: "operator",
          scopes: ["operator.read"],
        },
      },
    } as unknown as GatewayRequestHandlerOptions);

    expect(launchRespond.mock.calls[0]?.[0]).toBe(true);
    expect(launchRespond.mock.calls[0]?.[1]).toMatchObject({
      ok: true,
      expiresInMs: 60_000,
    });
  });

  it("mints Control UI entry launch tokens from entry scopes instead of caller scopes", () => {
    const registry = createEmptyPluginRegistry();
    registry.controlUiEntryPoints = [
      {
        pluginId: "notes-plugin",
        source: "/tmp/notes-plugin/index.ts",
        entryPoint: {
          id: "sessions",
          surface: "app-nav",
          label: "Sessions",
          path: "/plugins/notes-plugin/",
        },
      },
      {
        pluginId: "approvals-plugin",
        source: "/tmp/approvals-plugin/index.ts",
        entryPoint: {
          id: "approvals",
          surface: "app-nav",
          label: "Approvals",
          path: "/plugins/approvals-plugin/",
          requiredScopes: ["operator.approvals"],
        },
      },
    ];

    const defaultRespond = invokeUiEntryPointLaunch({
      registry,
      scopes: ["operator.admin"],
      requestParams: {
        id: "sessions",
        pluginId: "notes-plugin",
        path: "/plugins/notes-plugin/",
      },
    });
    const defaultLaunchPath = defaultRespond.mock.calls[0]?.[1]?.path;
    expect(typeof defaultLaunchPath).toBe("string");
    const defaultToken = consumePluginUiEntryPointLaunchToken({
      req: { url: defaultLaunchPath } as never,
      path: "/plugins/notes-plugin/",
    });
    expect(defaultToken).toMatchObject({ ok: true, scopes: ["operator.read"] });

    const scopedRespond = invokeUiEntryPointLaunch({
      registry,
      scopes: ["operator.admin"],
      requestParams: {
        id: "approvals",
        pluginId: "approvals-plugin",
        path: "/plugins/approvals-plugin/",
      },
    });
    const scopedLaunchPath = scopedRespond.mock.calls[0]?.[1]?.path;
    expect(typeof scopedLaunchPath).toBe("string");
    const scopedToken = consumePluginUiEntryPointLaunchToken({
      req: { url: scopedLaunchPath } as never,
      path: "/plugins/approvals-plugin/",
    });
    expect(scopedToken).toMatchObject({ ok: true, scopes: ["operator.approvals"] });
  });

  it("rejects launch requests for entry points hidden by caller scopes", () => {
    const registry = createEmptyPluginRegistry();
    registry.controlUiEntryPoints = [
      {
        pluginId: "admin-panel",
        source: "/tmp/admin-panel/index.ts",
        entryPoint: {
          id: "admin",
          surface: "app-nav",
          label: "Admin",
          path: "/plugins/admin-panel/",
          requiredScopes: ["operator.admin"],
        },
      },
    ];

    const respond = invokeUiEntryPointLaunch({
      registry,
      scopes: ["operator.read"],
      requestParams: {
        id: "admin",
        pluginId: "admin-panel",
        path: "/plugins/admin-panel/",
      },
    });

    expect(respond.mock.calls[0]?.[0]).toBe(false);
    expect(respond.mock.calls[0]?.[2]?.message).toBe("plugin UI entry point is not available");
  });
});
