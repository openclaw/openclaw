import { afterEach, describe, expect, it, vi } from "vitest";

const loadPluginRegistrySnapshotMock = vi.hoisted(() => vi.fn());
const loadPluginManifestRegistryForInstalledIndexMock = vi.hoisted(() => vi.fn());
const loadPluginMetadataSnapshotMock = vi.hoisted(() => vi.fn());

vi.mock("./plugin-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./plugin-registry.js")>()),
  loadPluginRegistrySnapshot: loadPluginRegistrySnapshotMock,
}));
vi.mock("./manifest-registry-installed.js", () => ({
  loadPluginManifestRegistryForInstalledIndex: loadPluginManifestRegistryForInstalledIndexMock,
}));
vi.mock("./plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: loadPluginMetadataSnapshotMock,
}));

afterEach(() => {
  loadPluginRegistrySnapshotMock.mockReset();
  loadPluginManifestRegistryForInstalledIndexMock.mockReset();
  loadPluginMetadataSnapshotMock.mockReset();
});

describe("setup-registry runtime fallback", () => {
  it("uses bundled registry cliBackends when the setup-registry runtime is unavailable", async () => {
    loadPluginMetadataSnapshotMock.mockReturnValue({
      index: {
        diagnostics: [],
        plugins: [
          {
            pluginId: "openai",
            origin: "bundled",
            enabled: true,
          },
          {
            pluginId: "disabled",
            origin: "bundled",
            enabled: false,
          },
          {
            pluginId: "local",
            origin: "workspace",
            enabled: true,
          },
        ],
      },
      plugins: [
        {
          id: "openai",
          origin: "bundled",
          cliBackends: ["Codex-CLI", "legacy-openai-cli"],
        },
      ],
    });

    const { __testing, resolvePluginSetupCliBackendRuntime } =
      await import("./setup-registry.runtime.js");
    __testing.resetRuntimeState();
    __testing.setRuntimeModuleForTest(null);

    expect(resolvePluginSetupCliBackendRuntime({ backend: "codex-cli" })).toEqual({
      pluginId: "openai",
      backend: { id: "Codex-CLI" },
    });
    expect(resolvePluginSetupCliBackendRuntime({ backend: "local-cli" })).toBeUndefined();
    expect(resolvePluginSetupCliBackendRuntime({ backend: "disabled-cli" })).toBeUndefined();
    // Bundled CLI backends are memoized process-wide (fixed for the process
    // lifetime, not user/workspace scoped) - one snapshot load must serve
    // every resolvePluginSetupCliBackendRuntime() call, not one per call.
    // Re-deriving on every call used to call loadPluginMetadataSnapshot with
    // an empty config object, which never matched the real gateway
    // snapshot's policy hash and forced a full synchronous plugin manifest
    // rescan on every isCliProvider() check (e.g. once per session row in
    // sessions.list) - see mctl-openclaw#34.
    expect(loadPluginMetadataSnapshotMock).toHaveBeenCalledTimes(1);
    expect(loadPluginMetadataSnapshotMock).toHaveBeenCalledWith({
      config: {},
      env: process.env,
    });
  });

  it("preserves fail-closed setup lookup when the runtime module explicitly declines to resolve", async () => {
    loadPluginMetadataSnapshotMock.mockReturnValue({
      index: {
        diagnostics: [],
        plugins: [
          {
            pluginId: "openai",
            origin: "bundled",
            enabled: true,
          },
        ],
      },
      plugins: [],
    });

    const { __testing, resolvePluginSetupCliBackendRuntime } =
      await import("./setup-registry.runtime.js");
    __testing.resetRuntimeState();
    __testing.setRuntimeModuleForTest({
      resolvePluginSetupCliBackend: () => undefined,
    });

    expect(resolvePluginSetupCliBackendRuntime({ backend: "codex-cli" })).toBeUndefined();
    expect(loadPluginMetadataSnapshotMock).not.toHaveBeenCalled();
  });
});
