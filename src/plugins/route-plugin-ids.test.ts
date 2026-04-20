import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadPluginManifestRegistry: vi.fn(),
}));

vi.mock("./manifest-registry.js", () => ({
  loadPluginManifestRegistry: (...args: unknown[]) => mocks.loadPluginManifestRegistry(...args),
}));

let resolveScopedRoutePluginIds: typeof import("./route-plugin-ids.js").resolveScopedRoutePluginIds;

describe("resolveScopedRoutePluginIds", () => {
  beforeAll(async () => {
    ({ resolveScopedRoutePluginIds } = await import("./route-plugin-ids.js"));
  });

  beforeEach(() => {
    mocks.loadPluginManifestRegistry.mockReset();
    mocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "bundled-route",
          origin: "bundled",
          enabledByDefault: true,
          activation: {
            onRoutes: ["gateway-plugin-http"],
          },
          providers: [],
          channels: [],
          cliBackends: [],
          skills: [],
          hooks: [],
        },
        {
          id: "global-route",
          origin: "global",
          enabledByDefault: true,
          activation: {
            onRoutes: ["gateway-plugin-http"],
          },
          providers: [],
          channels: [],
          cliBackends: [],
          skills: [],
          hooks: [],
        },
        {
          id: "workspace-route",
          origin: "workspace",
          enabledByDefault: false,
          activation: {
            onRoutes: ["gateway-plugin-http"],
          },
          providers: [],
          channels: [],
          cliBackends: [],
          skills: [],
          hooks: [],
        },
      ],
      diagnostics: [],
    });
  });

  it("keeps bundled route owners and blocks untrusted global owners by default", () => {
    expect(
      resolveScopedRoutePluginIds({
        config: {} as never,
        routeIds: ["gateway-plugin-http"],
        env: {} as NodeJS.ProcessEnv,
      }),
    ).toEqual(["bundled-route"]);
  });

  it("allows explicitly trusted global route owners", () => {
    expect(
      resolveScopedRoutePluginIds({
        config: {
          plugins: {
            allow: ["global-route"],
          },
        } as never,
        routeIds: ["gateway-plugin-http"],
        env: {} as NodeJS.ProcessEnv,
      }),
    ).toEqual(["global-route"]);
  });

  it("requires workspace route owners to be activated and respects explicit disablement", () => {
    expect(
      resolveScopedRoutePluginIds({
        config: {
          plugins: {
            entries: {
              "workspace-route": {
                enabled: true,
              },
            },
          },
        } as never,
        activationSourceConfig: {
          plugins: {
            entries: {
              "workspace-route": {
                enabled: true,
              },
            },
          },
        } as never,
        routeIds: ["gateway-plugin-http"],
        env: {} as NodeJS.ProcessEnv,
      }),
    ).toEqual(["bundled-route", "workspace-route"]);

    expect(
      resolveScopedRoutePluginIds({
        config: {
          plugins: {
            entries: {
              "workspace-route": {
                enabled: true,
              },
            },
          },
        } as never,
        activationSourceConfig: {
          plugins: {
            entries: {
              "workspace-route": {
                enabled: false,
              },
            },
          },
        } as never,
        routeIds: ["gateway-plugin-http"],
        env: {} as NodeJS.ProcessEnv,
      }),
    ).toEqual(["bundled-route"]);
  });
});
