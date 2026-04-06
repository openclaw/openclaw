import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const loadOpenClawPluginsMock = vi.fn((_options: unknown): unknown => undefined);
const getActivePluginRegistryMock = vi.fn();
const resolveConfiguredChannelPluginIdsMock = vi.fn(
  (_options: unknown): string[] | undefined => undefined,
);
const resolveChannelPluginIdsMock = vi.fn((_options: unknown): string[] | undefined => undefined);
const applyPluginAutoEnableMock = vi.fn((_params: { config: unknown }): unknown => undefined);
const resolveAgentWorkspaceDirMock = vi.fn(
  (_config: unknown, _agentId: unknown): string => "/resolved-workspace",
);
const resolveDefaultAgentIdMock = vi.fn((_config: unknown): string => "default");

let ensurePluginRegistryLoaded: typeof import("./runtime-registry-loader.js").ensurePluginRegistryLoaded;
let resetPluginRegistryLoadedForTests: typeof import("./runtime-registry-loader.js").__testing.resetPluginRegistryLoadedForTests;

vi.mock("../loader.js", () => ({
  loadOpenClawPlugins: (options: unknown) => loadOpenClawPluginsMock(options),
}));

vi.mock("../runtime.js", () => ({
  getActivePluginRegistry: () => getActivePluginRegistryMock(),
}));

vi.mock("../channel-plugin-ids.js", () => ({
  resolveConfiguredChannelPluginIds: (options: unknown) =>
    resolveConfiguredChannelPluginIdsMock(options),
  resolveChannelPluginIds: (options: unknown) => resolveChannelPluginIdsMock(options),
}));

vi.mock("../../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: (params: { config: unknown }) => applyPluginAutoEnableMock(params),
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: (config: unknown, agentId: unknown) =>
    resolveAgentWorkspaceDirMock(config, agentId),
  resolveDefaultAgentId: (config: unknown) => resolveDefaultAgentIdMock(config),
}));

describe("ensurePluginRegistryLoaded", () => {
  beforeAll(async () => {
    const mod = await import("./runtime-registry-loader.js");
    ensurePluginRegistryLoaded = mod.ensurePluginRegistryLoaded;
    resetPluginRegistryLoadedForTests = () => mod.__testing.resetPluginRegistryLoadedForTests();
  });

  beforeEach(() => {
    loadOpenClawPluginsMock.mockReset();
    getActivePluginRegistryMock.mockReset();
    resolveConfiguredChannelPluginIdsMock.mockReset();
    resolveChannelPluginIdsMock.mockReset();
    applyPluginAutoEnableMock.mockReset();
    resolveAgentWorkspaceDirMock.mockClear();
    resolveDefaultAgentIdMock.mockClear();
    resetPluginRegistryLoadedForTests();

    getActivePluginRegistryMock.mockReturnValue({
      plugins: [],
      channels: [],
      tools: [],
    });
    applyPluginAutoEnableMock.mockImplementation((params: { config: unknown }) => ({
      config:
        params.config && typeof params.config === "object"
          ? {
              ...params.config,
              plugins: {
                entries: {
                  demo: { enabled: true },
                },
              },
            }
          : params.config,
      changes: [],
      autoEnabledReasons: {
        demo: ["demo configured"],
      },
    }));
  });

  it("uses the shared runtime load context for configured-channel loads", () => {
    const rawConfig = { channels: { demo: { enabled: true } } };
    const resolvedConfig = {
      ...rawConfig,
      plugins: {
        entries: {
          demo: { enabled: true },
        },
      },
    };
    const env = { HOME: "/tmp/openclaw-home" } as NodeJS.ProcessEnv;

    resolveConfiguredChannelPluginIdsMock.mockReturnValue(["demo-channel"]);
    ensurePluginRegistryLoaded({
      scope: "configured-channels",
      config: rawConfig as never,
      env,
      activationSourceConfig: { plugins: { allow: ["demo-channel"] } } as never,
    });

    expect(resolveConfiguredChannelPluginIdsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        config: resolvedConfig,
        env,
        workspaceDir: "/resolved-workspace",
      }),
    );
    expect(applyPluginAutoEnableMock).toHaveBeenCalledWith({
      config: rawConfig,
      env,
    });
    expect(loadOpenClawPluginsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        config: resolvedConfig,
        activationSourceConfig: { plugins: { allow: ["demo-channel"] } },
        autoEnabledReasons: {
          demo: ["demo configured"],
        },
        workspaceDir: "/resolved-workspace",
        onlyPluginIds: ["demo-channel"],
        throwOnLoadError: true,
      }),
    );
  });

  it("does not cache scoped loads by explicit plugin ids", () => {
    ensurePluginRegistryLoaded({
      scope: "configured-channels",
      config: {} as never,
      onlyPluginIds: ["demo-a"],
    });
    ensurePluginRegistryLoaded({
      scope: "configured-channels",
      config: {} as never,
      onlyPluginIds: ["demo-b"],
    });

    expect(loadOpenClawPluginsMock).toHaveBeenCalledTimes(2);
    expect(loadOpenClawPluginsMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ onlyPluginIds: ["demo-a"] }),
    );
    expect(loadOpenClawPluginsMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ onlyPluginIds: ["demo-b"] }),
    );
  });
});
