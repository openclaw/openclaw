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

function createMemoryAutoEnableFixture() {
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
  return { rawConfig, autoEnabledConfig };
}

function createMemoryRuntimeFixture() {
  return {
    getMemorySearchManager: vi.fn(async () => ({ manager: null, error: "no index" })),
    resolveMemoryBackendConfig: vi.fn(() => ({ backend: "builtin" as const })),
  };
}

function expectMemoryRuntimeLoaded(autoEnabledConfig: unknown) {
  expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledWith({
    config: autoEnabledConfig,
  });
}

function setAutoEnabledMemoryRuntime() {
  const { rawConfig, autoEnabledConfig } = createMemoryAutoEnableFixture();
  const runtime = createMemoryRuntimeFixture();
  applyPluginAutoEnableMock.mockReturnValue({ config: autoEnabledConfig, changes: [] });
  getMemoryRuntimeMock.mockReturnValueOnce(undefined).mockReturnValue(runtime);
  return { rawConfig, autoEnabledConfig, runtime };
}

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

  it.each([
    {
      name: "loads memory runtime from the auto-enabled config snapshot",
      run: async (rawConfig: unknown) =>
        getActiveMemorySearchManager({
          cfg: rawConfig as never,
          agentId: "main",
        }),
      expectedResult: undefined,
    },
    {
      name: "reuses the same auto-enabled load path for backend config resolution",
      run: async (rawConfig: unknown) =>
        resolveActiveMemoryBackendConfig({
          cfg: rawConfig as never,
          agentId: "main",
        }),
      expectedResult: { backend: "builtin" },
    },
  ] as const)("$name", async ({ run, expectedResult }) => {
    const { rawConfig, autoEnabledConfig } = setAutoEnabledMemoryRuntime();

    const result = await run(rawConfig);

    if (expectedResult !== undefined) {
      expect(result).toEqual(expectedResult);
    }
    expect(applyPluginAutoEnableMock).toHaveBeenCalledWith({
      config: rawConfig,
      env: process.env,
    });
    expectMemoryRuntimeLoaded(autoEnabledConfig);
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
