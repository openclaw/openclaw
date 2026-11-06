import { beforeEach, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { withPluginRuntimeGenerationRegistryScope } from "./runtime/generation-state.js";

const getPluginRegistryState = vi.hoisted(() => vi.fn());
type Snapshot = {
  source: "persisted" | "derived";
  snapshot: { plugins: Array<{ syntheticAuthRefs: string[] }> };
  diagnostics: [];
};
const loadSnapshot = vi.hoisted(() => vi.fn<() => Snapshot>());

// mock-isolation: control the ambient registry independently of captured generations.
vi.mock("./runtime-state.js", () => ({ getPluginRegistryState }));

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

function setSnapshot(source: Snapshot["source"], plugins: Snapshot["snapshot"]["plugins"] = []) {
  loadSnapshot.mockReturnValue({ source, snapshot: { plugins }, diagnostics: [] });
}

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

it.each([
  ["persisted", ["local-provider", "local-cli", "remote-provider"], true],
  ["derived", [], false],
] as const)(
  "resolves %s metadata using the current scope without deriving a registry",
  (source, refs, complete) => {
    setSnapshot(source, [
      { syntheticAuthRefs: [" local-provider ", "local-provider", "local-cli"] },
      { syntheticAuthRefs: ["remote-provider"] },
      { syntheticAuthRefs: [] },
    ]);

    const params = {
      config: { plugins: { allow: ["local-provider"] } },
      workspaceDir: "/tmp/workspace",
      env: { OPENCLAW_HOME: "/tmp/openclaw-home" },
    };
    expect(resolveRuntimeSyntheticAuthProviderRefState(params)).toEqual({ refs, complete });
    expect(loadSnapshot).toHaveBeenCalledWith(params);
  },
);

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

  expect(resolveRuntimeSyntheticAuthProviderRefState()).toEqual({
    refs: ["manifest-provider", "runtime-provider", "runtime-cli"],
    complete: true,
  });
  expect(loadSnapshot).not.toHaveBeenCalled();
});
