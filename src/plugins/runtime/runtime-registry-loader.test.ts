import { beforeEach, describe, expect, it, vi } from "vitest";
import * as runtimeConfig from "../../config/io.runtime.js";

const mocks = vi.hoisted(() => ({
  load: vi.fn<typeof import("../loader.js").loadAndActivateRootPluginRegistry>(),
  configuredChannels:
    vi.fn<typeof import("../channel-plugin-ids.js").resolveConfiguredChannelPluginIds>(),
  resolveChannelPluginIds:
    vi.fn<typeof import("../channel-plugin-ids.js").resolveChannelPluginIds>(),
  effectiveIds: vi.fn<typeof import("../effective-plugin-ids.js").resolveEffectivePluginIds>(),
  embeddingIds:
    vi.fn<
      typeof import("../gateway-startup-plugin-ids.js").collectConfiguredMemoryEmbeddingProviderIds
    >(),
  applyPluginAutoEnable:
    vi.fn<typeof import("../../config/plugin-auto-enable.js").applyPluginAutoEnable>(),
  metadata: vi.fn<typeof import("../plugin-metadata-snapshot.js").resolvePluginMetadataSnapshot>(),
  resolvePluginControlPlaneWorkspace: vi.fn<
    typeof import("../control-plane-workspace.js").resolvePluginControlPlaneWorkspace
  >((params) => ({
    workspaceDir: params.workspaceDir ?? "/resolved-workspace",
    workspaceScope: "selected",
  })),
}));

vi.mock("../loader.js", () => ({
  loadAndActivateRootPluginRegistry: mocks.load,
}));

// mock-isolation: Loader scope uses fixture channel ids without persisted channel discovery.
vi.mock("../channel-plugin-ids.js", () => ({
  resolveConfiguredChannelPluginIdsAsync: async (
    ...args: Parameters<typeof mocks.configuredChannels>
  ) => mocks.configuredChannels(...args),
  resolveChannelPluginIds: mocks.resolveChannelPluginIds,
}));

// mock-isolation: Loader scope uses fixture plugin ids without installed-plugin discovery.
vi.mock("../effective-plugin-ids.js", () => ({
  resolveEffectivePluginIdsAsync: async (...args: Parameters<typeof mocks.effectiveIds>) =>
    mocks.effectiveIds(...args),
}));

vi.mock("../gateway-startup-plugin-ids.js", () => ({
  collectConfiguredMemoryEmbeddingProviderIds: mocks.embeddingIds,
}));

vi.mock("../../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: mocks.applyPluginAutoEnable,
}));

vi.mock("../../config/io.plugin-metadata.js", () => ({
  resolveConfigWidePluginMetadataSnapshot: mocks.metadata,
}));

vi.mock("../plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugin-metadata-snapshot.js")>()),
  resolvePluginMetadataSnapshot: mocks.metadata,
}));

vi.mock("../control-plane-workspace.js", () => ({
  resolvePluginControlPlaneWorkspace: mocks.resolvePluginControlPlaneWorkspace,
}));

import { ensurePluginRegistryLoaded } from "./runtime-registry-loader.js";

function enabledPlugins(...ids: string[]) {
  return Object.fromEntries(ids.map((id) => [id, { enabled: true }]));
}

function metadata(pluginIds: string[], embeddingOwner?: { pluginId: string; adapterId: string }) {
  return {
    policyHash: "test",
    index: {
      installRecords: {},
      plugins: pluginIds.map((pluginId) => ({
        pluginId,
        startup: { sidecar: false, memory: false, agentHarnesses: [] },
        ...(embeddingOwner?.pluginId === pluginId
          ? { contributions: { contracts: { embeddingProviders: [embeddingOwner.adapterId] } } }
          : {}),
      })),
    },
    manifestRegistry: { plugins: [], diagnostics: [] },
  };
}

function expectLoad(expected: object) {
  expect(requireLoadOptions()).toEqual(expect.objectContaining(expected));
}

function requireLoadOptions() {
  const options = mocks.load.mock.calls[0]?.[0];
  if (!options) {
    throw new Error("expected plugin load options");
  }
  return options;
}

describe("ensurePluginRegistryLoaded", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.metadata.mockReset().mockReturnValue(metadata(["openai"]) as never);
    mocks.applyPluginAutoEnable.mockImplementation((params) => ({
      config: params.config ?? {},
      changes: [],
      autoEnabledReasons: {},
    }));
  });

  it("prepares omitted config before loading configured channel owners", async () => {
    const config = { channels: { demo: { enabled: true } } };
    const reader = Object.assign(async () => config, { assertCurrent: () => {} });
    const capture = vi
      .spyOn(runtimeConfig, "captureRuntimeConfigAsyncReader")
      .mockReturnValue(reader);
    mocks.configuredChannels.mockReturnValue(["demo-channel"]);
    try {
      await ensurePluginRegistryLoaded({ scope: "configured-channels" });
      expect(mocks.configuredChannels).toHaveBeenCalledWith(expect.objectContaining({ config }));
    } finally {
      capture.mockRestore();
    }
  });

  it("loads configured channel owners through the canonical root loader", async () => {
    const config = { channels: { demo: { enabled: true } } };
    mocks.configuredChannels.mockReturnValue(["demo-channel"]);

    await ensurePluginRegistryLoaded({ scope: "configured-channels", config: config as never });

    expect(mocks.configuredChannels).toHaveBeenCalledWith(
      expect.objectContaining({ config, workspaceDir: "/resolved-workspace" }),
    );
    expectLoad({
      onlyPluginIds: ["demo-channel"],
      throwOnLoadError: true,
      workspaceDir: "/resolved-workspace",
    });
  });

  it("keeps an empty configured-channel scope empty", async () => {
    mocks.configuredChannels.mockReturnValue([]);

    await ensurePluginRegistryLoaded({ scope: "configured-channels", config: {} });

    expect(requireLoadOptions().onlyPluginIds).toEqual([]);
  });

  it("loads effective plugin ids for the all scope", async () => {
    const env = { HOME: "/tmp/openclaw-home" };
    const config = { plugins: { enabled: true } };
    mocks.effectiveIds.mockReturnValue(["demo", "memory-core"]);

    await ensurePluginRegistryLoaded({ scope: "all", config, env });

    expect(mocks.effectiveIds).toHaveBeenCalledWith({
      config,
      env,
      workspaceDir: "/resolved-workspace",
    });
    expectLoad({ onlyPluginIds: ["demo", "memory-core"], throwOnLoadError: true });
  });

  it("loads only matching configured sandbox backend owners, never unrelated broken plugins", async () => {
    const config = {
      agents: {
        defaults: { sandbox: { backend: "sandbox-owner" } },
        entries: { research: { sandbox: { backend: "research-owner" } } },
      },
      plugins: {
        entries: enabledPlugins("sandbox-owner", "research-owner", "broken-plugin"),
      },
    };
    mocks.metadata.mockReturnValue(
      metadata(["sandbox-owner", "research-owner", "broken-plugin"]) as never,
    );
    mocks.load.mockImplementationOnce(async (options) => {
      if (options?.onlyPluginIds?.includes("broken-plugin")) {
        throw new Error("unrelated plugin failed to initialize");
      }
      return undefined as never;
    });

    await expect(
      ensurePluginRegistryLoaded({ scope: "sandbox-backends", config }),
    ).resolves.toBeUndefined();
    expect(requireLoadOptions().onlyPluginIds).toEqual(["research-owner", "sandbox-owner"]);
    expect(mocks.effectiveIds).not.toHaveBeenCalled();
  });

  it("loads installed persisted sandbox owners after configuration switches to Docker", async () => {
    const config = {
      agents: { defaults: { sandbox: { backend: "docker" } } },
      plugins: {
        entries: enabledPlugins("openshell", "broken-plugin"),
      },
    };
    mocks.metadata.mockReturnValue(metadata(["openshell", "broken-plugin"]) as never);

    await ensurePluginRegistryLoaded({
      scope: "sandbox-backends",
      config,
      persistedSandboxBackendIds: ["openshell", "docker", "missing-owner"],
    });

    expect(requireLoadOptions().onlyPluginIds).toEqual(["openshell"]);
  });

  it("loads only the selected memory backend and embedding provider owners", async () => {
    const config = {
      memory: { search: { provider: "openai" } },
      plugins: {
        allow: ["acpx", "memory-core"],
        slots: { memory: "memory-core" },
        entries: { unrelated: { enabled: true } },
      },
    };
    mocks.embeddingIds.mockReturnValue(new Set(["openai"]));

    await ensurePluginRegistryLoaded({ scope: "memory", config });

    expect(mocks.embeddingIds).toHaveBeenCalledWith(config);
    expectLoad({
      config,
      activationSourceConfig: config,
      onlyPluginIds: ["memory-core", "openai"],
      throwOnLoadError: true,
    });
  });

  it("keeps a denied memory provider owner denied", async () => {
    const config = {
      memory: { search: { provider: "gemini" } },
      plugins: {
        allow: ["memory-core"],
        deny: ["google"],
        slots: { memory: "memory-core" },
      },
    };
    mocks.embeddingIds.mockReturnValue(new Set(["gemini"]));
    mocks.metadata.mockReturnValue(
      metadata(["google"], { adapterId: "gemini", pluginId: "google" }) as never,
    );

    await ensurePluginRegistryLoaded({ scope: "memory", config });

    expectLoad({
      onlyPluginIds: ["google", "memory-core"],
      config,
      activationSourceConfig: config,
    });
  });

  it("keeps an empty memory scope empty when no backend is selected", async () => {
    mocks.embeddingIds.mockReturnValue(new Set());

    await ensurePluginRegistryLoaded({
      scope: "memory",
      config: { plugins: { slots: { memory: "none" } } },
    });

    expect(requireLoadOptions().onlyPluginIds).toEqual([]);
  });
});
