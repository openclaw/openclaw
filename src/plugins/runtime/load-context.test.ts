import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const loadConfigMock = vi.fn();
const applyPluginAutoEnableMock = vi.fn((_params: { config: unknown }): unknown => undefined);
const resolveAgentWorkspaceDirMock = vi.fn(
  (_config: unknown, _agentId: unknown): string => "/resolved-workspace",
);
const resolveDefaultAgentIdMock = vi.fn((_config: unknown): string => "default");

let resolvePluginRuntimeLoadContext: typeof import("./load-context.js").resolvePluginRuntimeLoadContext;
let buildPluginRuntimeLoadOptions: typeof import("./load-context.js").buildPluginRuntimeLoadOptions;

vi.mock("../../config/config.js", () => ({
  loadConfig: () => loadConfigMock(),
}));

vi.mock("../../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: (params: { config: unknown }) => applyPluginAutoEnableMock(params),
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: (config: unknown, agentId: unknown) =>
    resolveAgentWorkspaceDirMock(config, agentId),
  resolveDefaultAgentId: (config: unknown) => resolveDefaultAgentIdMock(config),
}));

describe("resolvePluginRuntimeLoadContext", () => {
  beforeAll(async () => {
    ({ resolvePluginRuntimeLoadContext, buildPluginRuntimeLoadOptions } =
      await import("./load-context.js"));
  });

  beforeEach(() => {
    loadConfigMock.mockReset();
    applyPluginAutoEnableMock.mockReset();
    resolveAgentWorkspaceDirMock.mockClear();
    resolveDefaultAgentIdMock.mockClear();

    loadConfigMock.mockReturnValue({ plugins: {} });
    applyPluginAutoEnableMock.mockImplementation((params: { config: unknown }) => ({
      config: params.config,
      changes: [],
      autoEnabledReasons: {},
    }));
  });

  it("builds the runtime plugin load context from the auto-enabled config", () => {
    const rawConfig = { plugins: {} };
    const resolvedConfig = {
      plugins: {
        entries: {
          demo: { enabled: true },
        },
      },
    };
    const env = { HOME: "/tmp/openclaw-home" } as NodeJS.ProcessEnv;

    applyPluginAutoEnableMock.mockReturnValue({
      config: resolvedConfig,
      changes: [],
      autoEnabledReasons: {
        demo: ["demo configured"],
      },
    });

    const context = resolvePluginRuntimeLoadContext({
      config: rawConfig,
      env,
    });

    expect(context).toEqual(
      expect.objectContaining({
        rawConfig,
        config: resolvedConfig,
        activationSourceConfig: rawConfig,
        env,
        workspaceDir: "/resolved-workspace",
        autoEnabledReasons: {
          demo: ["demo configured"],
        },
      }),
    );
    expect(applyPluginAutoEnableMock).toHaveBeenCalledWith({
      config: rawConfig,
      env,
    });
    expect(resolveDefaultAgentIdMock).toHaveBeenCalledWith(resolvedConfig);
    expect(resolveAgentWorkspaceDirMock).toHaveBeenCalledWith(resolvedConfig, "default");
  });

  it("builds plugin load options from the shared runtime context", () => {
    const context = resolvePluginRuntimeLoadContext({
      config: { plugins: {} },
      env: { HOME: "/tmp/openclaw-home" } as NodeJS.ProcessEnv,
      workspaceDir: "/explicit-workspace",
    });

    expect(
      buildPluginRuntimeLoadOptions(context, {
        cache: false,
        activate: false,
        onlyPluginIds: ["demo"],
      }),
    ).toEqual(
      expect.objectContaining({
        config: context.config,
        activationSourceConfig: context.activationSourceConfig,
        autoEnabledReasons: context.autoEnabledReasons,
        workspaceDir: "/explicit-workspace",
        env: context.env,
        logger: context.logger,
        cache: false,
        activate: false,
        onlyPluginIds: ["demo"],
      }),
    );
  });
});
