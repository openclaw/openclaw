import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveRuntimePluginRegistryMock = vi.fn();
const applyPluginAutoEnableMock = vi.fn();
const getMemoryRuntimeMock = vi.fn();

vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: (...args: unknown[]) => applyPluginAutoEnableMock(...args),
}));

vi.mock("./loader.js", () => ({
  resolveRuntimePluginRegistry: (...args: unknown[]) => resolveRuntimePluginRegistryMock(...args),
}));

vi.mock("./memory-state.js", () => ({
  getMemoryRuntime: () => getMemoryRuntimeMock(),
}));

let getActiveMemorySearchManager: typeof import("./memory-runtime.js").getActiveMemorySearchManager;
let resolveActiveMemoryBackendConfig: typeof import("./memory-runtime.js").resolveActiveMemoryBackendConfig;
let closeActiveMemorySearchManagers: typeof import("./memory-runtime.js").closeActiveMemorySearchManagers;

describe("memory runtime auto-enable loading", () => {
  beforeEach(async () => {
    vi.resetModules();
    resolveRuntimePluginRegistryMock.mockReset();
    applyPluginAutoEnableMock.mockReset();
    getMemoryRuntimeMock.mockReset();
    applyPluginAutoEnableMock.mockImplementation((params: { config: unknown }) => ({
      config: params.config,
      changes: [],
    }));
    ({
      getActiveMemorySearchManager,
      resolveActiveMemoryBackendConfig,
      closeActiveMemorySearchManagers,
    } = await import("./memory-runtime.js"));
  });

  it("loads memory runtime from the auto-enabled config snapshot", async () => {
    const rawConfig = {
      plugins: {},
      channels: { memory: { enabled: true } },
    };
    const autoEnabledConfig = {
      ...rawConfig,
      plugins: {
        entries: {
          memory: { enabled: true },
        },
      },
    };
    const runtime = {
      getMemorySearchManager: vi.fn(async () => ({ manager: null, error: "no index" })),
      resolveMemoryBackendConfig: vi.fn(() => ({ backend: "builtin" as const })),
    };
    applyPluginAutoEnableMock.mockReturnValue({ config: autoEnabledConfig, changes: [] });
    getMemoryRuntimeMock.mockReturnValueOnce(undefined).mockReturnValue(runtime);

    await getActiveMemorySearchManager({
      cfg: rawConfig as never,
      agentId: "main",
    });

    expect(applyPluginAutoEnableMock).toHaveBeenCalledWith({
      config: rawConfig,
      env: process.env,
    });
    expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledWith({
      config: autoEnabledConfig,
    });
  });

  it("reuses the same auto-enabled load path for backend config resolution", () => {
    const rawConfig = {
      plugins: {},
      channels: { memory: { enabled: true } },
    };
    const autoEnabledConfig = {
      ...rawConfig,
      plugins: {
        entries: {
          memory: { enabled: true },
        },
      },
    };
    const runtime = {
      getMemorySearchManager: vi.fn(async () => ({ manager: null })),
      resolveMemoryBackendConfig: vi.fn(() => ({ backend: "builtin" as const })),
    };
    applyPluginAutoEnableMock.mockReturnValue({ config: autoEnabledConfig, changes: [] });
    getMemoryRuntimeMock.mockReturnValueOnce(undefined).mockReturnValue(runtime);

    const result = resolveActiveMemoryBackendConfig({
      cfg: rawConfig as never,
      agentId: "main",
    });

    expect(result).toEqual({ backend: "builtin" });
    expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledWith({
      config: autoEnabledConfig,
    });
  });

  it("does not bootstrap the memory runtime just to close managers", async () => {
    const rawConfig = {
      plugins: {},
      channels: { memory: { enabled: true } },
    };
    getMemoryRuntimeMock.mockReturnValue(undefined);

    await closeActiveMemorySearchManagers(rawConfig as never);

    expect(applyPluginAutoEnableMock).not.toHaveBeenCalled();
    expect(resolveRuntimePluginRegistryMock).not.toHaveBeenCalled();
  });

  it("closes an already-registered memory runtime without reloading plugins", async () => {
    const runtime = {
      closeAllMemorySearchManagers: vi.fn(async () => {}),
    };
    getMemoryRuntimeMock.mockReturnValue(runtime);

    await closeActiveMemorySearchManagers({} as never);

    expect(runtime.closeAllMemorySearchManagers).toHaveBeenCalledTimes(1);
    expect(resolveRuntimePluginRegistryMock).not.toHaveBeenCalled();
  });
});
