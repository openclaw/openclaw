import { afterEach, describe, expect, it } from "vitest";
import { createEmptyPluginRegistry } from "./registry.js";
import {
  getActivePluginHttpRouteRegistryVersion,
  getActivePluginRegistryVersion,
  getActivePluginRegistry,
  pinActivePluginHttpRouteRegistry,
  releasePinnedPluginHttpRouteRegistry,
  resetPluginRuntimeStateForTest,
  resolveActivePluginHttpRouteRegistry,
  setActivePluginRegistry,
} from "./runtime.js";

function createRegistryWithRoute(path: string) {
  const registry = createEmptyPluginRegistry();
  registry.httpRoutes.push({
    path,
    auth: "plugin",
    match: path === "/plugins/diffs" ? "prefix" : "exact",
    handler: () => true,
    pluginId: path === "/plugins/diffs" ? "diffs" : "demo",
    source: "test",
  });
  return registry;
}

function createRuntimeRegistryPair() {
  return {
    startupRegistry: createEmptyPluginRegistry(),
    laterRegistry: createEmptyPluginRegistry(),
  };
}

function expectRegistryVersions(params: { active: number; routes: number }) {
  expect(getActivePluginRegistryVersion()).toBe(params.active);
  expect(getActivePluginHttpRouteRegistryVersion()).toBe(params.routes);
}

function expectActiveRouteRegistryResolution(params: {
  pinnedRegistry: ReturnType<typeof createEmptyPluginRegistry>;
  explicitRegistry: ReturnType<typeof createEmptyPluginRegistry>;
  expectedRegistry: "pinned" | "explicit";
}) {
  setActivePluginRegistry(params.pinnedRegistry);
  pinActivePluginHttpRouteRegistry(params.pinnedRegistry);

  expect(resolveActivePluginHttpRouteRegistry(params.explicitRegistry)).toBe(
    params.expectedRegistry === "pinned" ? params.pinnedRegistry : params.explicitRegistry,
  );
}

function expectPinnedRouteRegistry(
  startupRegistry: ReturnType<typeof createEmptyPluginRegistry>,
  laterRegistry: ReturnType<typeof createEmptyPluginRegistry>,
) {
  setActivePluginRegistry(startupRegistry);
  pinActivePluginHttpRouteRegistry(startupRegistry);
  setActivePluginRegistry(laterRegistry);
  expect(resolveActivePluginHttpRouteRegistry(laterRegistry)).toBe(startupRegistry);
}

function expectRouteRegistryState(params: { setup: () => void; assert: () => void }) {
  params.setup();
  params.assert();
}

describe("plugin runtime route registry", () => {
  afterEach(() => {
    releasePinnedPluginHttpRouteRegistry();
    resetPluginRuntimeStateForTest();
  });

  it("stays empty until a caller explicitly installs or requires a registry", () => {
    resetPluginRuntimeStateForTest();

    expect(getActivePluginRegistry()).toBeNull();
  });

  it.each([
    {
      name: "keeps the pinned route registry when the active plugin registry changes",
      run: () => {
        const { startupRegistry, laterRegistry } = createRuntimeRegistryPair();
        expectPinnedRouteRegistry(startupRegistry, laterRegistry);
      },
    },
    {
      name: "tracks route registry repins separately from the active registry version",
      run: () => {
        const { startupRegistry, laterRegistry } = createRuntimeRegistryPair();
        const repinnedRegistry = createEmptyPluginRegistry();

        setActivePluginRegistry(startupRegistry);
        pinActivePluginHttpRouteRegistry(laterRegistry);

        const activeVersionBeforeRepin = getActivePluginRegistryVersion();
        const routeVersionBeforeRepin = getActivePluginHttpRouteRegistryVersion();

        pinActivePluginHttpRouteRegistry(repinnedRegistry);

        expectRegistryVersions({
          active: activeVersionBeforeRepin,
          routes: routeVersionBeforeRepin + 1,
        });
      },
    },
  ] as const)("$name", ({ run }) => {
    expectRouteRegistryState({
      setup: () => {},
      assert: run,
    });
  });

  it.each([
    {
      name: "falls back to the provided registry when the pinned route registry has no routes",
      pinnedRegistry: createEmptyPluginRegistry(),
      explicitRegistry: createRegistryWithRoute("/demo"),
      expected: "explicit",
    },
    {
      name: "prefers the pinned route registry when it already owns routes",
      pinnedRegistry: createRegistryWithRoute("/bluebubbles-webhook"),
      explicitRegistry: createRegistryWithRoute("/plugins/diffs"),
      expected: "pinned",
    },
  ] as const)("$name", ({ pinnedRegistry, explicitRegistry, expected }) => {
    expectActiveRouteRegistryResolution({
      pinnedRegistry,
      explicitRegistry,
      expectedRegistry: expected,
    });
  });
});
