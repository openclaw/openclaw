import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { withPluginRuntimeGenerationRegistryScope } from "./runtime/generation-state.js";

type SyntheticAuthRegistrySnapshotResult = {
  source: "persisted" | "provided" | "derived";
  snapshot: {
    plugins: Array<{ syntheticAuthRefs?: string[] }>;
  };
  diagnostics: [];
};

const getPluginRegistryState = vi.hoisted(() => vi.fn());
const loadSnapshot = vi.hoisted(() =>
  vi.fn<(_params?: unknown) => SyntheticAuthRegistrySnapshotResult>(),
);

vi.mock("./runtime-state.js", () => ({
  getPluginRegistryState,
}));

// mock-isolation: supply registry snapshots without loading installed plugins.
vi.mock("./plugin-registry.js", () => ({
  loadPluginRegistrySnapshotWithMetadata: loadSnapshot,
}));

import {
  resolveRuntimeSyntheticAuthProviderRefState,
  resolveRuntimeSyntheticAuthProviderRefs,
} from "./synthetic-auth.runtime.js";

function authProvider(id: string) {
  return {
    pluginId: id,
    source: "fixture",
    provider: {
      id: `${id}-auth`,
      label: id,
      auth: [],
      prepareSyntheticAuth: async () => undefined,
    },
  };
}

function setSnapshot(
  source: SyntheticAuthRegistrySnapshotResult["source"],
  plugins = [
    { syntheticAuthRefs: [" local-provider ", "local-provider", "local-cli"] },
    { syntheticAuthRefs: ["remote-provider"] },
    { syntheticAuthRefs: [] },
  ],
) {
  loadSnapshot.mockReturnValue({
    source,
    snapshot: { plugins },
    diagnostics: [],
  });
}

function expectRuntimeRefs(refs: string[], complete = true) {
  expect(resolveRuntimeSyntheticAuthProviderRefs()).toStrictEqual(refs);
  expect(resolveRuntimeSyntheticAuthProviderRefState()).toStrictEqual({ refs, complete });
}

describe("synthetic auth runtime refs", () => {
  it("keeps captured generation auth separate from the ambient registry", () => {
    const ambient = createEmptyPluginRegistry();
    ambient.providers.push(authProvider("ambient"));
    getPluginRegistryState.mockReturnValue({ activeRegistry: ambient });
    const captured = createEmptyPluginRegistry();
    expect(
      withPluginRuntimeGenerationRegistryScope(captured, resolveRuntimeSyntheticAuthProviderRefs),
    ).toEqual([]);
    captured.providers.push(authProvider("captured"));
    expect(
      withPluginRuntimeGenerationRegistryScope(captured, resolveRuntimeSyntheticAuthProviderRefs),
    ).toEqual(["captured-auth"]);
    expect(resolveRuntimeSyntheticAuthProviderRefs()).toEqual(["ambient-auth"]);
  });

  beforeEach(() => {
    getPluginRegistryState.mockReset();
    loadSnapshot.mockReset();
    setSnapshot("persisted", []);
  });

  it("uses persisted registry synthetic auth refs before the runtime registry exists", () => {
    setSnapshot("persisted");

    expectRuntimeRefs(["local-provider", "local-cli", "remote-provider"]);
    expect(loadSnapshot).toHaveBeenCalledWith({});
  });

  it("loads manifest synthetic auth refs with the current runtime scope", () => {
    setSnapshot("persisted", [{ syntheticAuthRefs: ["external-local"] }]);
    const params = {
      config: { plugins: { allow: ["external-local"] } },
      workspaceDir: "/tmp/workspace",
      env: { OPENCLAW_HOME: "/tmp/openclaw-home" },
    };
    expect(resolveRuntimeSyntheticAuthProviderRefState(params)).toEqual({
      refs: ["external-local"],
      complete: true,
    });
    expect(loadSnapshot).toHaveBeenCalledWith(params);
  });

  it("does not derive the registry just to resolve synthetic auth refs", () => {
    setSnapshot("derived");

    expect(resolveRuntimeSyntheticAuthProviderRefs()).toStrictEqual([]);
    expect(resolveRuntimeSyntheticAuthProviderRefState()).toStrictEqual({
      refs: [],
      complete: false,
    });
  });

  it("does not treat a provided index with registry diagnostics as validated synthetic auth", () => {
    expect(
      resolveRuntimeSyntheticAuthProviderRefs({
        index: { plugins: [{ syntheticAuthRefs: ["local-provider"] }] } as unknown as NonNullable<
          Parameters<typeof resolveRuntimeSyntheticAuthProviderRefs>[0]
        >["index"],
        registryDiagnostics: [{ code: "persisted-registry-missing" }],
      }),
    ).toStrictEqual([]);
    expect(loadSnapshot).not.toHaveBeenCalled();
  });

  it("prefers the active runtime registry when plugins are already loaded", () => {
    getPluginRegistryState.mockReturnValue({
      activeRegistry: {
        providers: [
          { provider: { id: "runtime-provider", resolveSyntheticAuth: () => undefined } },
          { provider: { id: "plain-provider" } },
        ],
        cliBackends: [{ backend: { id: "runtime-cli", resolveSyntheticAuth: () => undefined } }],
        plugins: [{ syntheticAuthRefs: ["manifest-provider"] }],
      },
    });

    expectRuntimeRefs(["manifest-provider", "runtime-provider", "runtime-cli"]);
    expect(loadSnapshot).not.toHaveBeenCalled();
  });
});
