import { afterEach, describe, expect, it, vi } from "vitest";

const loadPluginRegistrySnapshotMock = vi.hoisted(() => vi.fn());

vi.mock("./plugin-registry.js", () => ({
  loadPluginRegistrySnapshot: loadPluginRegistrySnapshotMock,
}));

afterEach(() => {
  loadPluginRegistrySnapshotMock.mockReset();
});

describe("setup-registry runtime fallback", () => {
  it("uses bundled registry cliBackends when the setup-registry runtime is unavailable", async () => {
    loadPluginRegistrySnapshotMock.mockReturnValue({
      diagnostics: [],
      plugins: [
        {
          pluginId: "openai",
          origin: "bundled",
          enabled: true,
          contributions: {
            cliBackends: ["Codex-CLI", "legacy-openai-cli"],
          },
        },
        {
          pluginId: "disabled",
          origin: "bundled",
          enabled: false,
          contributions: {
            cliBackends: ["disabled-cli"],
          },
        },
        {
          pluginId: "local",
          origin: "workspace",
          enabled: true,
          contributions: {
            cliBackends: ["local-cli"],
          },
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
    expect(loadPluginRegistrySnapshotMock).toHaveBeenCalledTimes(1);
    expect(loadPluginRegistrySnapshotMock).toHaveBeenCalledWith({ cache: true });
  });

  it("preserves fail-closed setup lookup when the runtime module explicitly declines to resolve", async () => {
    loadPluginRegistrySnapshotMock.mockReturnValue({
      diagnostics: [],
      plugins: [
        {
          pluginId: "openai",
          origin: "bundled",
          enabled: true,
          contributions: {
            cliBackends: ["Codex-CLI", "legacy-openai-cli"],
          },
        },
      ],
    });

    const { __testing, resolvePluginSetupCliBackendRuntime } =
      await import("./setup-registry.runtime.js");
    __testing.resetRuntimeState();
    __testing.setRuntimeModuleForTest({
      resolvePluginSetupCliBackend: () => undefined,
    });

    expect(resolvePluginSetupCliBackendRuntime({ backend: "codex-cli" })).toBeUndefined();
    expect(loadPluginRegistrySnapshotMock).not.toHaveBeenCalled();
  });
});
