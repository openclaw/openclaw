import { beforeEach, describe, expect, it, vi } from "vitest";
import { createInfoWarnErrorLogger } from "../../../test/helpers/mock-logger.js";
import type { PluginLoadOptions } from "../loader.js";
import { loadPluginMetadataRegistrySnapshot } from "./metadata-registry-loader.js";

const loadConfigMock = vi.fn();
const applyPluginAutoEnableMock = vi.fn();
const loadOpenClawPluginsMock = vi.fn();

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: () => loadConfigMock(),
  loadConfig: () => loadConfigMock(),
}));

vi.mock("../../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: (...args: unknown[]) => applyPluginAutoEnableMock(...args),
}));

vi.mock("../loader.js", () => ({
  loadOpenClawPlugins: (...args: unknown[]) => loadOpenClawPluginsMock(...args),
  loadPluginRegistryHandle: (options: Record<string, unknown> = {}) =>
    loadOpenClawPluginsMock({ ...options, activate: false }),
}));

vi.mock("../../agents/agent-scope.js", () => ({
  listAgentEntries: vi.fn<typeof import("../../agents/agent-scope.js").listAgentEntries>(() => []),
  resolveAgentWorkspaceDir: () => "/resolved-workspace",
  tryResolveConfiguredAgentWorkspaceDir: vi.fn<
    typeof import("../../agents/agent-scope.js").tryResolveConfiguredAgentWorkspaceDir
  >(() => "/resolved-workspace"),
  resolveDefaultAgentId: () => "default",
}));

vi.mock("../control-plane-workspace.js", () => ({
  resolvePluginControlPlaneWorkspace: (params: { workspaceDir?: string }) => ({
    workspaceDir: params.workspaceDir ?? "/resolved-workspace",
    workspaceScope: "selected",
  }),
}));

const config = { plugins: {} };
const defaultLoadOptions = {
  config,
  activationSourceConfig: config,
  autoEnabledReasons: {},
  workspaceDir: "/resolved-workspace",
  throwOnLoadError: true,
  cache: false,
  activate: false,
  mode: "validate" as const,
  loadModules: undefined,
};

function expectLoadOptions(overrides: Partial<PluginLoadOptions> = {}): PluginLoadOptions {
  expect(loadOpenClawPluginsMock).toHaveBeenCalledTimes(1);
  const options = loadOpenClawPluginsMock.mock.calls[0]?.[0];
  expect(options).toMatchObject({ ...defaultLoadOptions, ...overrides });
  expect(options.logger).toBeDefined();
  return options as PluginLoadOptions;
}

describe("loadPluginMetadataRegistrySnapshot", () => {
  beforeEach(() => {
    loadConfigMock.mockReset().mockReturnValue(config);
    applyPluginAutoEnableMock.mockReset();
    loadOpenClawPluginsMock.mockReset();
    applyPluginAutoEnableMock.mockImplementation((params: { config: unknown }) => ({
      config: params.config,
      changes: [],
      autoEnabledReasons: {},
    }));
    loadOpenClawPluginsMock.mockReturnValue({ plugins: [], diagnostics: [] });
  });

  it("defaults to a non-activating validate snapshot", () => {
    loadPluginMetadataRegistrySnapshot({
      config,
      activationSourceConfig: { plugins: { allow: ["demo"] } },
      env: { HOME: "/tmp/openclaw-home" } as NodeJS.ProcessEnv,
      workspaceDir: "/workspace",
      onlyPluginIds: ["demo"],
    });

    expectLoadOptions({
      activationSourceConfig: { plugins: { allow: ["demo"] } },
      workspaceDir: "/workspace",
      env: { HOME: "/tmp/openclaw-home" },
      onlyPluginIds: ["demo"],
    });
  });

  it.each([{ loadModules: false }, { onlyPluginIds: [] }])(
    "preserves explicit metadata scope options: %j",
    (options) => {
      loadPluginMetadataRegistrySnapshot({ config, ...options });
      const loadOptions = expectLoadOptions(options);
      expect(loadOptions.env === process.env).toBe(true);
    },
  );

  it("forwards an explicit logger through metadata snapshots", () => {
    const logger = createInfoWarnErrorLogger();

    loadPluginMetadataRegistrySnapshot({ config, logger, workspaceDir: "/workspace" });

    const { env } = expectLoadOptions({ workspaceDir: "/workspace", logger });
    // Preserve the env subset check without handing its values to the matcher.
    expect(
      env !== undefined && Object.entries(process.env).every(([key, value]) => env[key] === value),
    ).toBe(true);
  });

  it("honors explicit load options when reusing a resolved runtime context", () => {
    const logger = createInfoWarnErrorLogger();
    const env = { HOME: "/tmp/context-home" } as NodeJS.ProcessEnv;
    const manifestRegistry = { plugins: [], diagnostics: [] };
    const sourceConfig = { plugins: { allow: ["raw-plugin"] } };

    loadPluginMetadataRegistrySnapshot({
      config: { plugins: { allow: ["compat-provider"] } },
      activationSourceConfig: sourceConfig,
      workspaceDir: "/compat-workspace",
      env,
      logger,
      manifestRegistry,
      runtimeContext: {
        rawConfig: sourceConfig,
        config: sourceConfig,
        activationSourceConfig: sourceConfig,
        autoEnabledReasons: {},
        workspaceDir: "/context-workspace",
        env,
        logger,
      },
    });

    expect(applyPluginAutoEnableMock).not.toHaveBeenCalled();
    const expected = {
      ...defaultLoadOptions,
      config: { plugins: { allow: ["compat-provider"] } },
      activationSourceConfig: sourceConfig,
      workspaceDir: "/compat-workspace",
      env,
      logger,
      manifestRegistry,
      installRecords: undefined,
    } satisfies PluginLoadOptions;
    expect(expectLoadOptions(expected)).toEqual(expected);
  });
});
