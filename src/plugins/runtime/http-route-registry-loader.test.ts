import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../registry.js";

const mocks = vi.hoisted(() => ({
  loadOpenClawPlugins: vi.fn<typeof import("../loader.js").loadOpenClawPlugins>(),
  resolveScopedRoutePluginIds:
    vi.fn<typeof import("../route-plugin-ids.js").resolveScopedRoutePluginIds>(),
  applyPluginAutoEnable:
    vi.fn<typeof import("../../config/plugin-auto-enable.js").applyPluginAutoEnable>(),
  resolveAgentWorkspaceDir: vi.fn<
    typeof import("../../agents/agent-scope.js").resolveAgentWorkspaceDir
  >(() => "/resolved-workspace"),
  resolveDefaultAgentId: vi.fn<typeof import("../../agents/agent-scope.js").resolveDefaultAgentId>(
    () => "default",
  ),
}));

vi.mock("../loader.js", () => ({
  loadOpenClawPlugins: (...args: Parameters<typeof mocks.loadOpenClawPlugins>) =>
    mocks.loadOpenClawPlugins(...args),
}));

vi.mock("../route-plugin-ids.js", () => ({
  resolveScopedRoutePluginIds: (...args: Parameters<typeof mocks.resolveScopedRoutePluginIds>) =>
    mocks.resolveScopedRoutePluginIds(...args),
}));

vi.mock("../../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: (...args: Parameters<typeof mocks.applyPluginAutoEnable>) =>
    mocks.applyPluginAutoEnable(...args),
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: (...args: Parameters<typeof mocks.resolveAgentWorkspaceDir>) =>
    mocks.resolveAgentWorkspaceDir(...args),
  resolveDefaultAgentId: (...args: Parameters<typeof mocks.resolveDefaultAgentId>) =>
    mocks.resolveDefaultAgentId(...args),
}));

let loadScopedGatewayPluginHttpRouteRegistry: typeof import("./http-route-registry-loader.js").loadScopedGatewayPluginHttpRouteRegistry;

describe("loadScopedGatewayPluginHttpRouteRegistry", () => {
  beforeAll(async () => {
    ({ loadScopedGatewayPluginHttpRouteRegistry } =
      await import("./http-route-registry-loader.js"));
  });

  beforeEach(() => {
    mocks.loadOpenClawPlugins.mockReset();
    mocks.resolveScopedRoutePluginIds.mockReset();
    mocks.applyPluginAutoEnable.mockReset();
    mocks.resolveAgentWorkspaceDir.mockClear();
    mocks.resolveDefaultAgentId.mockClear();

    mocks.applyPluginAutoEnable.mockImplementation((params) => ({
      config:
        params.config && typeof params.config === "object"
          ? {
              ...params.config,
              plugins: {
                entries: {
                  auto: { enabled: true },
                },
              },
            }
          : {},
      changes: [],
      autoEnabledReasons: {
        auto: ["auto enabled"],
      },
    }));
    mocks.loadOpenClawPlugins.mockReturnValue(createEmptyPluginRegistry());
  });

  it("loads a scoped route registry when planned owners exist", () => {
    const coreGatewayHandlers = {
      "sessions.get": () => undefined,
    };
    mocks.resolveScopedRoutePluginIds.mockReturnValue(["diffs", "webhooks"]);

    const registry = loadScopedGatewayPluginHttpRouteRegistry({
      config: {} as never,
      activationSourceConfig: { plugins: { allow: ["diffs"] } } as never,
      env: { HOME: "/tmp/openclaw-home" } as NodeJS.ProcessEnv,
      coreGatewayHandlers,
    });

    expect(registry).toBeDefined();
    expect(mocks.resolveScopedRoutePluginIds).toHaveBeenCalledWith(
      expect.objectContaining({
        config: {
          plugins: {
            entries: {
              auto: { enabled: true },
            },
          },
        },
        activationSourceConfig: { plugins: { allow: ["diffs"] } },
        routeIds: ["gateway-plugin-http"],
        workspaceDir: "/resolved-workspace",
      }),
    );
    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        onlyPluginIds: ["diffs", "webhooks"],
        coreGatewayHandlers,
        runtimeOptions: {
          allowGatewaySubagentBinding: true,
        },
        throwOnLoadError: true,
        workspaceDir: "/resolved-workspace",
      }),
    );
  });

  it("does not load when route planning finds no owners", () => {
    mocks.resolveScopedRoutePluginIds.mockReturnValue([]);

    expect(loadScopedGatewayPluginHttpRouteRegistry({ config: {} as never })).toBeUndefined();
    expect(mocks.loadOpenClawPlugins).not.toHaveBeenCalled();
  });
});
