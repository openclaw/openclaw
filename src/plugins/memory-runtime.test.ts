/** Covers plugin memory provider runtime loading and registration contracts. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveRuntimePluginRegistryMock =
  vi.fn<typeof import("./loader.js").resolveRuntimePluginRegistry>();
const restoreCachedMemoryPromptStateMock =
  vi.fn<typeof import("./loader.js").restoreCachedMemoryPromptState>();
const getLoadedRuntimePluginRegistryMock =
  vi.fn<typeof import("./active-runtime-registry.js").getLoadedRuntimePluginRegistry>();
const ensureStandaloneRuntimePluginRegistryLoadedMock = vi.hoisted(() =>
  vi.fn<
    typeof import("./runtime/standalone-runtime-registry-loader.js").ensureStandaloneRuntimePluginRegistryLoaded
  >(),
);
const applyPluginAutoEnableMock =
  vi.fn<typeof import("../config/plugin-auto-enable.js").applyPluginAutoEnable>();
const getMemoryRuntimeMock = vi.fn<typeof import("./memory-state.js").getMemoryRuntime>();
const getMemoryCapabilityRegistrationMock =
  vi.fn<typeof import("./memory-state.js").getMemoryCapabilityRegistration>();
const getActivePluginRuntimeSubagentModeMock = vi.fn<
  typeof import("./runtime.js").getActivePluginRuntimeSubagentMode
>(() => "default");
const resolveAgentWorkspaceDirMock =
  vi.fn<typeof import("../agents/agent-scope.js").resolveAgentWorkspaceDir>();
const resolveDefaultAgentIdMock = vi.fn<
  typeof import("../agents/agent-scope.js").resolveDefaultAgentId
>(() => "default");

vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: applyPluginAutoEnableMock,
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: resolveAgentWorkspaceDirMock,
  resolveDefaultAgentId: resolveDefaultAgentIdMock,
}));

vi.mock("./loader.js", () => ({
  resolveRuntimePluginRegistry: resolveRuntimePluginRegistryMock,
  restoreCachedMemoryPromptState: restoreCachedMemoryPromptStateMock,
}));

vi.mock("./active-runtime-registry.js", () => ({
  getLoadedRuntimePluginRegistry: getLoadedRuntimePluginRegistryMock,
}));

vi.mock("./runtime/standalone-runtime-registry-loader.js", () => ({
  ensureStandaloneRuntimePluginRegistryLoaded: ensureStandaloneRuntimePluginRegistryLoadedMock,
}));

vi.mock("./memory-state.js", () => ({
  getMemoryCapabilityRegistration: () => getMemoryCapabilityRegistrationMock(),
  getMemoryRuntime: () => getMemoryRuntimeMock(),
}));

vi.mock("./runtime.js", () => ({
  getActivePluginRuntimeSubagentMode: () => getActivePluginRuntimeSubagentModeMock(),
}));

let ensureActiveMemoryCapability: typeof import("./memory-runtime.js").ensureActiveMemoryCapability;
let getActiveMemorySearchManager: typeof import("./memory-runtime.js").getActiveMemorySearchManager;
let resolveActiveMemoryBackendConfig: typeof import("./memory-runtime.js").resolveActiveMemoryBackendConfig;
let closeActiveMemorySearchManager: typeof import("./memory-runtime.js").closeActiveMemorySearchManager;
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
    closeMemorySearchManager: vi.fn(async () => {}),
  };
}

function expectMemoryRuntimeLoaded(
  config: unknown,
  pluginIds: readonly string[] = ["memory-core"],
) {
  expect(getLoadedRuntimePluginRegistryMock).toHaveBeenCalledWith({
    requiredPluginIds: pluginIds,
  });
  expect(ensureStandaloneRuntimePluginRegistryLoadedMock).toHaveBeenCalledWith({
    requiredPluginIds: pluginIds,
    loadOptions: {
      config,
      onlyPluginIds: pluginIds,
      workspaceDir: "/resolved-workspace",
    },
  });
}

function expectMemoryAutoEnableApplied(rawConfig: unknown, autoEnabledConfig: unknown) {
  expect(applyPluginAutoEnableMock).not.toHaveBeenCalled();
  expectMemoryRuntimeLoaded(rawConfig);
  expect(rawConfig).not.toBe(autoEnabledConfig);
}

function setAutoEnabledMemoryRuntime() {
  const { rawConfig, autoEnabledConfig } = createMemoryAutoEnableFixture();
  const runtime = createMemoryRuntimeFixture();
  applyPluginAutoEnableMock.mockReturnValue({
    config: autoEnabledConfig,
    changes: [],
    autoEnabledReasons: {},
  });
  getMemoryRuntimeMock
    .mockReturnValueOnce(undefined)
    .mockReturnValueOnce(undefined)
    .mockReturnValue(runtime);
  return { rawConfig, autoEnabledConfig, runtime };
}

function expectNoMemoryRuntimeBootstrap() {
  expect(applyPluginAutoEnableMock).not.toHaveBeenCalled();
  expect(resolveRuntimePluginRegistryMock).not.toHaveBeenCalled();
  expect(restoreCachedMemoryPromptStateMock).not.toHaveBeenCalled();
  expect(getLoadedRuntimePluginRegistryMock).not.toHaveBeenCalled();
  expect(ensureStandaloneRuntimePluginRegistryLoadedMock).not.toHaveBeenCalled();
}

async function expectAutoEnabledMemoryRuntimeCase(params: {
  run: (rawConfig: unknown) => Promise<unknown>;
  expectedResult: unknown;
}) {
  const { rawConfig, autoEnabledConfig } = setAutoEnabledMemoryRuntime();
  const result = await params.run(rawConfig);

  if (params.expectedResult !== undefined) {
    expect(result).toEqual(params.expectedResult);
  }
  expectMemoryAutoEnableApplied(rawConfig, autoEnabledConfig);
}

async function expectCloseMemoryRuntimeCase(params: {
  config: unknown;
  setup: () => { closeAllMemorySearchManagers: ReturnType<typeof vi.fn> } | undefined;
}) {
  const runtime = params.setup();
  await closeActiveMemorySearchManagers(params.config as never);

  if (runtime) {
    expect(runtime.closeAllMemorySearchManagers).toHaveBeenCalledTimes(1);
  }
  expectNoMemoryRuntimeBootstrap();
}

describe("memory runtime auto-enable loading", () => {
  beforeEach(async () => {
    vi.resetModules();
    ({
      ensureActiveMemoryCapability,
      getActiveMemorySearchManager,
      resolveActiveMemoryBackendConfig,
      closeActiveMemorySearchManager,
      closeActiveMemorySearchManagers,
    } = await import("./memory-runtime.js"));
    resolveRuntimePluginRegistryMock.mockReset();
    restoreCachedMemoryPromptStateMock.mockReset();
    getLoadedRuntimePluginRegistryMock.mockReset();
    ensureStandaloneRuntimePluginRegistryLoadedMock.mockReset();
    applyPluginAutoEnableMock.mockReset();
    getMemoryRuntimeMock.mockReset();
    getMemoryCapabilityRegistrationMock.mockReset();
    getActivePluginRuntimeSubagentModeMock.mockReset();
    getActivePluginRuntimeSubagentModeMock.mockReturnValue("default");
    resolveAgentWorkspaceDirMock.mockReset();
    resolveDefaultAgentIdMock.mockClear();
    applyPluginAutoEnableMock.mockImplementation((params) => ({
      config: params.config ?? {},
      changes: [],
      autoEnabledReasons: {},
    }));
    resolveAgentWorkspaceDirMock.mockReturnValue("/resolved-workspace");
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
    await expectAutoEnabledMemoryRuntimeCase({ run, expectedResult });
  });

  it("loads only the configured memory slot plugin", async () => {
    const rawConfig = {
      plugins: {
        slots: {
          memory: "memory-lancedb",
        },
      },
    };
    const runtime = createMemoryRuntimeFixture();
    applyPluginAutoEnableMock.mockReturnValue({
      config: rawConfig,
      changes: [],
      autoEnabledReasons: {},
    });
    getMemoryRuntimeMock
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(undefined)
      .mockReturnValue(runtime);

    await getActiveMemorySearchManager({
      cfg: rawConfig as never,
      agentId: "main",
    });

    expectMemoryRuntimeLoaded(rawConfig, ["memory-lancedb"]);
  });

  it("does not fall back to broad plugin loading when the memory slot is disabled", async () => {
    const rawConfig = {
      plugins: {
        slots: {
          memory: "none",
        },
      },
    };
    applyPluginAutoEnableMock.mockReturnValue({
      config: rawConfig,
      changes: [],
      autoEnabledReasons: {},
    });
    getMemoryRuntimeMock.mockReturnValue(undefined);

    await expect(
      getActiveMemorySearchManager({
        cfg: rawConfig as never,
        agentId: "main",
      }),
    ).resolves.toEqual({ manager: null, error: "memory plugin unavailable" });

    expect(applyPluginAutoEnableMock).not.toHaveBeenCalled();
    expect(resolveRuntimePluginRegistryMock).not.toHaveBeenCalled();
    expect(getLoadedRuntimePluginRegistryMock).not.toHaveBeenCalled();
    expect(ensureStandaloneRuntimePluginRegistryLoadedMock).not.toHaveBeenCalled();
  });

  it("does not standalone-load the memory plugin when plugins are globally disabled", async () => {
    const rawConfig = {
      plugins: {
        enabled: false,
      },
    };
    getMemoryRuntimeMock.mockReturnValue(undefined);

    await expect(
      getActiveMemorySearchManager({
        cfg: rawConfig as never,
        agentId: "main",
      }),
    ).resolves.toEqual({ manager: null, error: "memory plugin unavailable" });

    expectNoMemoryRuntimeBootstrap();
  });

  it.each([
    {
      name: "denied",
      plugins: {
        deny: ["memory-core"],
        slots: {
          memory: "memory-core",
        },
      },
    },
    {
      name: "entry-disabled",
      plugins: {
        entries: {
          "memory-core": { enabled: false },
        },
        slots: {
          memory: "memory-core",
        },
      },
    },
  ] as const)("does not standalone-load a $name memory slot plugin", async ({ plugins }) => {
    getMemoryRuntimeMock.mockReturnValue(undefined);

    await expect(
      getActiveMemorySearchManager({
        cfg: { plugins } as never,
        agentId: "main",
      }),
    ).resolves.toEqual({ manager: null, error: "memory plugin unavailable" });

    expectNoMemoryRuntimeBootstrap();
  });

  it("does not standalone-load plugins when the memory runtime is already registered", () => {
    const rawConfig = {
      plugins: {
        slots: {
          memory: "memory-core",
        },
      },
    };
    const runtime = createMemoryRuntimeFixture();
    getLoadedRuntimePluginRegistryMock.mockReturnValue({} as never);
    getMemoryRuntimeMock.mockReturnValueOnce(undefined).mockReturnValue(runtime);

    resolveActiveMemoryBackendConfig({
      cfg: rawConfig as never,
      agentId: "main",
    });

    expect(getLoadedRuntimePluginRegistryMock).toHaveBeenCalled();
    expect(ensureStandaloneRuntimePluginRegistryLoadedMock).not.toHaveBeenCalled();
  });

  it("restores cached memory prompt state without force-loading the active registry", () => {
    const rawConfig = {
      plugins: {
        slots: {
          memory: "memory-core",
        },
      },
    };
    const capability = {
      pluginId: "memory-core",
      capability: {
        promptBuilder: () => ["## Memory Recall", "Search memory first."],
      },
    };
    const staleCapability = {
      pluginId: "memory-lancedb",
      capability: {
        promptBuilder: () => ["## Stale Memory", "Do not use stale memory."],
      },
    };
    let registeredCapability: typeof capability | typeof staleCapability | undefined =
      staleCapability;
    getActivePluginRuntimeSubagentModeMock.mockReturnValue("gateway-bindable");
    getLoadedRuntimePluginRegistryMock.mockReturnValue({
      plugins: [
        { id: "telegram", status: "loaded" },
        { id: "memory-core", status: "loaded" },
        { id: "codex", status: "loaded" },
      ],
    } as never);
    getMemoryCapabilityRegistrationMock.mockImplementation(() => registeredCapability as never);
    restoreCachedMemoryPromptStateMock.mockImplementation(() => {
      registeredCapability = capability;
      return undefined as never;
    });

    const result = ensureActiveMemoryCapability({
      cfg: rawConfig as never,
      pluginId: "memory-core",
    });

    expect(result).toBe(capability);
    expect(getLoadedRuntimePluginRegistryMock).toHaveBeenCalledWith({
      requiredPluginIds: ["memory-core"],
    });
    expect(restoreCachedMemoryPromptStateMock).toHaveBeenCalledWith({
      config: rawConfig,
      onlyPluginIds: ["memory-core"],
      workspaceDir: "/resolved-workspace",
      runtimeOptions: { allowGatewaySubagentBinding: true },
      preferBuiltPluginArtifacts: true,
    });
    expect(ensureStandaloneRuntimePluginRegistryLoadedMock).not.toHaveBeenCalled();
  });

  it("does not restore cached state when the selected prompt capability is already registered", () => {
    const rawConfig = {
      plugins: {
        slots: {
          memory: "memory-core",
        },
      },
    };
    const capability = {
      pluginId: "memory-core",
      capability: {
        promptBuilder: () => ["## Memory Recall", "Search memory first."],
      },
    };
    getMemoryCapabilityRegistrationMock.mockReturnValue(capability as never);

    const result = ensureActiveMemoryCapability({
      cfg: rawConfig as never,
      pluginId: "memory-core",
    });

    expect(result).toBe(capability);
    expect(getLoadedRuntimePluginRegistryMock).not.toHaveBeenCalled();
    expect(restoreCachedMemoryPromptStateMock).not.toHaveBeenCalled();
    expect(ensureStandaloneRuntimePluginRegistryLoadedMock).not.toHaveBeenCalled();
  });

  it("ignores prompt capabilities from non-selected memory plugins", () => {
    const rawConfig = {
      plugins: {
        slots: {
          memory: "memory-core",
        },
      },
    };
    getMemoryCapabilityRegistrationMock.mockReturnValue({
      pluginId: "memory-lancedb",
      capability: {
        promptBuilder: () => ["## Stale Memory", "Do not use stale memory."],
      },
    } as never);

    const result = ensureActiveMemoryCapability({
      cfg: rawConfig as never,
      pluginId: "memory-lancedb",
    });

    expect(result).toBeUndefined();
    expect(getLoadedRuntimePluginRegistryMock).not.toHaveBeenCalled();
    expect(ensureStandaloneRuntimePluginRegistryLoadedMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "does not bootstrap the memory runtime just to close managers",
      config: {
        plugins: {},
        channels: { memory: { enabled: true } },
      },
      setup: () => {
        getMemoryRuntimeMock.mockReturnValue(undefined);
        return undefined;
      },
    },
    {
      name: "closes an already-registered memory runtime without reloading plugins",
      config: {},
      setup: () => {
        const runtime = {
          getMemorySearchManager: vi.fn(async () => ({ manager: null, error: "no index" })),
          resolveMemoryBackendConfig: vi.fn(() => ({ backend: "builtin" as const })),
          closeAllMemorySearchManagers: vi.fn(async () => {}),
        };
        getMemoryRuntimeMock.mockReturnValue(runtime);
        return runtime;
      },
    },
  ] as const)("$name", async ({ config, setup }) => {
    await expectCloseMemoryRuntimeCase({ config, setup });
  });

  it("delegates scoped cleanup to the loaded memory runtime without reloading plugins", async () => {
    const runtime = createMemoryRuntimeFixture();
    const cfg = { plugins: {} };
    getMemoryRuntimeMock.mockReturnValue(runtime);

    await closeActiveMemorySearchManager({ cfg: cfg as never, agentId: "main" });

    expect(runtime.closeMemorySearchManager).toHaveBeenCalledWith({
      cfg,
      agentId: "main",
    });
    expectNoMemoryRuntimeBootstrap();
  });
});
