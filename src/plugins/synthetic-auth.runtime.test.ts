/** Covers synthetic and external auth provider refs from manifests and active registries. */
import { beforeEach, describe, expect, it, vi } from "vitest";

type SyntheticAuthRegistrySnapshotResult = {
  source: "persisted" | "provided" | "derived";
  snapshot: {
    plugins: Array<{ syntheticAuthRefs?: string[] }>;
  };
  diagnostics: [];
};

type ExternalAuthManifestRegistryResult = {
  plugins: Array<{ contracts?: { externalAuthProviders?: string[] } }>;
  diagnostics: [];
};

const getPluginRegistryState = vi.hoisted(() => vi.fn());
const pluginRegistryMocks = vi.hoisted(() => ({
  loadPluginRegistrySnapshotWithMetadata: vi.fn(
    (_params?: unknown): SyntheticAuthRegistrySnapshotResult => ({
      source: "persisted",
      snapshot: { plugins: [] },
      diagnostics: [],
    }),
  ),
  loadPluginManifestRegistryForInstalledIndex: vi.fn<() => ExternalAuthManifestRegistryResult>(
    () => ({
      plugins: [],
      diagnostics: [],
    }),
  ),
}));

function poisonedSyntheticAuthPlugin(): { syntheticAuthRefs?: string[] } {
  return Object.defineProperty({}, "syntheticAuthRefs", {
    get() {
      throw new Error("synthetic auth metadata exploded");
    },
  }) as { syntheticAuthRefs?: string[] };
}

function poisonedExternalAuthPlugin(): { contracts?: { externalAuthProviders?: string[] } } {
  return Object.defineProperty({}, "contracts", {
    get() {
      throw new Error("external auth metadata exploded");
    },
  }) as { contracts?: { externalAuthProviders?: string[] } };
}

vi.mock("./runtime-state.js", () => ({
  getPluginRegistryState,
}));

vi.mock("./plugin-registry.js", () => ({
  loadPluginRegistrySnapshotWithMetadata:
    pluginRegistryMocks.loadPluginRegistrySnapshotWithMetadata,
}));

vi.mock("./manifest-registry-installed.js", () => ({
  loadPluginManifestRegistryForInstalledIndex:
    pluginRegistryMocks.loadPluginManifestRegistryForInstalledIndex,
}));

import {
  resolveRuntimeExternalAuthProviderRefs,
  resolveRuntimeSyntheticAuthProviderRefState,
  resolveRuntimeSyntheticAuthProviderRefs,
} from "./synthetic-auth.runtime.js";

describe("synthetic auth runtime refs", () => {
  beforeEach(() => {
    getPluginRegistryState.mockReset();
    pluginRegistryMocks.loadPluginRegistrySnapshotWithMetadata.mockReset().mockReturnValue({
      source: "persisted",
      snapshot: { plugins: [] as Array<{ syntheticAuthRefs?: string[] }> },
      diagnostics: [],
    });
    pluginRegistryMocks.loadPluginManifestRegistryForInstalledIndex.mockReset().mockReturnValue({
      plugins: [],
      diagnostics: [],
    } satisfies ExternalAuthManifestRegistryResult);
  });

  it("uses persisted registry synthetic auth refs before the runtime registry exists", () => {
    pluginRegistryMocks.loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "persisted",
      snapshot: {
        plugins: [
          { syntheticAuthRefs: [" local-provider ", "local-provider", "local-cli"] },
          { syntheticAuthRefs: ["remote-provider"] },
          { syntheticAuthRefs: [] },
        ],
      },
      diagnostics: [],
    });

    expect(resolveRuntimeSyntheticAuthProviderRefs()).toEqual([
      "local-provider",
      "local-cli",
      "remote-provider",
    ]);
    expect(pluginRegistryMocks.loadPluginRegistrySnapshotWithMetadata).toHaveBeenCalledWith({});
  });

  it("skips unreadable persisted synthetic auth plugin metadata", () => {
    pluginRegistryMocks.loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "persisted",
      snapshot: {
        plugins: [
          { syntheticAuthRefs: ["local-provider"] },
          poisonedSyntheticAuthPlugin(),
          { syntheticAuthRefs: ["remote-provider"] },
        ],
      },
      diagnostics: [],
    });

    expect(resolveRuntimeSyntheticAuthProviderRefs()).toEqual([
      "local-provider",
      "remote-provider",
    ]);
  });

  it("loads manifest synthetic auth refs with the current runtime scope", () => {
    const config = { plugins: { allow: ["external-local"] } };
    const env = { OPENCLAW_HOME: "/tmp/openclaw-home" };
    pluginRegistryMocks.loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "persisted",
      snapshot: {
        plugins: [{ syntheticAuthRefs: ["external-local"] }],
      },
      diagnostics: [],
    });

    expect(
      resolveRuntimeSyntheticAuthProviderRefState({
        config: config as never,
        workspaceDir: "/tmp/workspace",
        env,
      }),
    ).toEqual({
      refs: ["external-local"],
      complete: true,
    });
    expect(pluginRegistryMocks.loadPluginRegistrySnapshotWithMetadata).toHaveBeenCalledWith({
      config,
      workspaceDir: "/tmp/workspace",
      env,
    });
  });

  it("uses persisted registry external auth provider refs before the runtime registry exists", () => {
    const snapshot = {
      plugins: [{ syntheticAuthRefs: [] }],
    };
    pluginRegistryMocks.loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "persisted",
      snapshot,
      diagnostics: [],
    });
    pluginRegistryMocks.loadPluginManifestRegistryForInstalledIndex.mockReturnValue({
      plugins: [
        { contracts: { externalAuthProviders: [" runtime-provider ", "runtime-provider"] } },
        { contracts: { externalAuthProviders: ["external-cli"] } },
        { contracts: {} },
      ],
      diagnostics: [],
    });

    expect(resolveRuntimeExternalAuthProviderRefs()).toEqual(["runtime-provider", "external-cli"]);
    expect(pluginRegistryMocks.loadPluginManifestRegistryForInstalledIndex).toHaveBeenCalledWith({
      index: snapshot,
    });
  });

  it("skips unreadable persisted external auth plugin metadata", () => {
    pluginRegistryMocks.loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "persisted",
      snapshot: { plugins: [] },
      diagnostics: [],
    });
    pluginRegistryMocks.loadPluginManifestRegistryForInstalledIndex.mockReturnValue({
      plugins: [
        { contracts: { externalAuthProviders: ["runtime-provider"] } },
        poisonedExternalAuthPlugin(),
        { contracts: { externalAuthProviders: ["external-cli"] } },
      ],
      diagnostics: [],
    });

    expect(resolveRuntimeExternalAuthProviderRefs()).toEqual(["runtime-provider", "external-cli"]);
  });

  it("does not derive the registry just to resolve synthetic auth refs", () => {
    pluginRegistryMocks.loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "derived",
      snapshot: {
        plugins: [
          { syntheticAuthRefs: [" local-provider ", "local-provider", "local-cli"] },
          { syntheticAuthRefs: ["remote-provider"] },
          { syntheticAuthRefs: [] },
        ],
      },
      diagnostics: [],
    });

    expect(resolveRuntimeSyntheticAuthProviderRefs()).toStrictEqual([]);
    expect(resolveRuntimeSyntheticAuthProviderRefState()).toStrictEqual({
      refs: [],
      complete: false,
    });
  });

  it("does not derive the registry just to resolve external auth refs", () => {
    pluginRegistryMocks.loadPluginRegistrySnapshotWithMetadata.mockReturnValue({
      source: "derived",
      snapshot: { plugins: [] },
      diagnostics: [],
    });

    expect(resolveRuntimeExternalAuthProviderRefs()).toStrictEqual([]);
    expect(pluginRegistryMocks.loadPluginManifestRegistryForInstalledIndex).not.toHaveBeenCalled();
  });

  it("does not treat a provided index with registry diagnostics as validated synthetic auth", () => {
    const index = {
      plugins: [{ syntheticAuthRefs: ["local-provider"] }],
    };

    expect(
      resolveRuntimeSyntheticAuthProviderRefs({
        index: index as unknown as NonNullable<
          Parameters<typeof resolveRuntimeSyntheticAuthProviderRefs>[0]
        >["index"],
        registryDiagnostics: [{ code: "persisted-registry-missing" }],
      }),
    ).toStrictEqual([]);
    expect(pluginRegistryMocks.loadPluginRegistrySnapshotWithMetadata).not.toHaveBeenCalled();
  });

  it("does not treat a provided index with registry diagnostics as validated external auth", () => {
    const index = {
      plugins: [{ syntheticAuthRefs: [] }],
    };

    expect(
      resolveRuntimeExternalAuthProviderRefs({
        index: index as unknown as NonNullable<
          Parameters<typeof resolveRuntimeExternalAuthProviderRefs>[0]
        >["index"],
        registryDiagnostics: [{ code: "persisted-registry-missing" }],
      }),
    ).toStrictEqual([]);
    expect(pluginRegistryMocks.loadPluginManifestRegistryForInstalledIndex).not.toHaveBeenCalled();
  });

  it("prefers the active runtime registry when plugins are already loaded", () => {
    getPluginRegistryState.mockReturnValue({
      activeRegistry: {
        providers: [
          {
            provider: {
              id: "runtime-provider",
              resolveSyntheticAuth: () => undefined,
            },
          },
          {
            provider: {
              id: "plain-provider",
            },
          },
        ],
        cliBackends: [
          {
            backend: {
              id: "runtime-cli",
              resolveSyntheticAuth: () => undefined,
            },
          },
        ],
        plugins: [
          {
            syntheticAuthRefs: ["manifest-provider"],
            contracts: {
              externalAuthProviders: ["manifest-provider"],
            },
          },
        ],
      },
    });

    expect(resolveRuntimeSyntheticAuthProviderRefs()).toEqual([
      "manifest-provider",
      "runtime-provider",
      "runtime-cli",
    ]);
    expect(resolveRuntimeSyntheticAuthProviderRefState()).toEqual({
      refs: ["manifest-provider", "runtime-provider", "runtime-cli"],
      complete: true,
    });
    expect(pluginRegistryMocks.loadPluginRegistrySnapshotWithMetadata).not.toHaveBeenCalled();
  });

  it("skips unreadable active runtime synthetic auth plugin metadata", () => {
    getPluginRegistryState.mockReturnValue({
      activeRegistry: {
        providers: [
          {
            provider: {
              id: "runtime-provider",
              resolveSyntheticAuth: () => undefined,
            },
          },
        ],
        cliBackends: [
          {
            backend: {
              id: "runtime-cli",
              resolveSyntheticAuth: () => undefined,
            },
          },
        ],
        plugins: [
          { syntheticAuthRefs: ["manifest-provider"] },
          poisonedSyntheticAuthPlugin(),
          { syntheticAuthRefs: ["manifest-cli"] },
        ],
      },
    });

    expect(resolveRuntimeSyntheticAuthProviderRefs()).toEqual([
      "manifest-provider",
      "manifest-cli",
      "runtime-provider",
      "runtime-cli",
    ]);
  });

  it("prefers active runtime registry external auth refs when plugins are already loaded", () => {
    getPluginRegistryState.mockReturnValue({
      activeRegistry: {
        plugins: [
          {
            contracts: {
              externalAuthProviders: ["manifest-provider"],
            },
          },
        ],
        providers: [
          {
            provider: {
              id: "runtime-provider",
              resolveExternalAuthProfiles: () => [],
            },
          },
        ],
        cliBackends: [
          {
            backend: {
              id: "runtime-cli",
              resolveExternalAuthProfiles: () => [],
            },
          },
        ],
      },
    });

    expect(resolveRuntimeExternalAuthProviderRefs()).toEqual([
      "manifest-provider",
      "runtime-provider",
      "runtime-cli",
    ]);
    expect(pluginRegistryMocks.loadPluginRegistrySnapshotWithMetadata).not.toHaveBeenCalled();
  });

  it("skips unreadable active runtime external auth plugin metadata", () => {
    getPluginRegistryState.mockReturnValue({
      activeRegistry: {
        plugins: [
          {
            contracts: {
              externalAuthProviders: ["manifest-provider"],
            },
          },
          poisonedExternalAuthPlugin(),
          {
            contracts: {
              externalAuthProviders: ["manifest-cli"],
            },
          },
        ],
        providers: [
          {
            provider: {
              id: "runtime-provider",
              resolveExternalAuthProfiles: () => [],
            },
          },
        ],
        cliBackends: [
          {
            backend: {
              id: "runtime-cli",
              resolveExternalAuthProfiles: () => [],
            },
          },
        ],
      },
    });

    expect(resolveRuntimeExternalAuthProviderRefs()).toEqual([
      "manifest-provider",
      "manifest-cli",
      "runtime-provider",
      "runtime-cli",
    ]);
  });
});
