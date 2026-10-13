// Metadata registry loader tests cover metadata-only plugin registry assembly.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createInfoWarnErrorLogger } from "../../../test/helpers/mock-logger.js";
import type { PluginLoadOptions } from "../loader.js";
import { loadPluginMetadataRegistrySnapshotAsync } from "./metadata-registry-loader.js";

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

// mock-isolation: Loader-option tests capture fixture requests without executing installed plugins.
vi.mock("../loader.js", () => ({
  loadOpenClawPlugins: (...args: unknown[]) => loadOpenClawPluginsMock(...args),
  loadPluginRegistryHandleAsync: async (options: Record<string, unknown> = {}) =>
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

// mock-isolation: Empty fixture manifests keep loader-option checks independent of disk discovery.
vi.mock("./load-context.resolve.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./load-context.resolve.js")>();
  return {
    ...actual,
    resolvePluginRuntimeLoadContextAsync: async (
      options: Parameters<typeof actual.resolvePluginRuntimeLoadContextAsync>[0],
    ) =>
      actual.resolvePluginRuntimeLoadContext({
        ...options,
        manifestRegistry: options?.manifestRegistry ?? { plugins: [], diagnostics: [] },
      }),
  };
});

vi.mock("../control-plane-workspace.js", () => ({
  resolvePluginControlPlaneWorkspace: (params: { workspaceDir?: string }) => ({
    workspaceDir: params.workspaceDir ?? "/resolved-workspace",
    workspaceScope: "selected",
  }),
}));

function getOnlyLoadOpenClawPluginsOptions(): PluginLoadOptions {
  expect(loadOpenClawPluginsMock).toHaveBeenCalledTimes(1);
  const options = loadOpenClawPluginsMock.mock.calls[0]?.[0];
  if (!options || typeof options !== "object") {
    throw new Error("expected loadOpenClawPlugins to receive plugin load options");
  }
  return options as PluginLoadOptions;
}

describe("loadPluginMetadataRegistrySnapshotAsync", () => {
  beforeEach(() => {
    loadConfigMock.mockReset();
    applyPluginAutoEnableMock.mockReset();
    loadOpenClawPluginsMock.mockReset();
    loadConfigMock.mockReturnValue({ plugins: {} });
    applyPluginAutoEnableMock.mockImplementation((params: { config: unknown }) => ({
      config: params.config,
      changes: [],
      autoEnabledReasons: {},
    }));
    loadOpenClawPluginsMock.mockReturnValue({ plugins: [], diagnostics: [] });
  });

  it("defaults to a non-activating validate snapshot", async () => {
    await loadPluginMetadataRegistrySnapshotAsync({
      config: { plugins: {} },
      activationSourceConfig: { plugins: { allow: ["demo"] } },
      env: { HOME: "/tmp/openclaw-home" } as NodeJS.ProcessEnv,
      workspaceDir: "/workspace",
      onlyPluginIds: ["demo"],
    });

    const loadOptions = getOnlyLoadOpenClawPluginsOptions();
    expect(loadOptions).toMatchObject({
      config: { plugins: {} },
      activationSourceConfig: { plugins: { allow: ["demo"] } },
      autoEnabledReasons: {},
      workspaceDir: "/workspace",
      env: { HOME: "/tmp/openclaw-home" },
      throwOnLoadError: true,
      cache: false,
      activate: false,
      mode: "validate",
      loadModules: undefined,
      onlyPluginIds: ["demo"],
    });
    expect(loadOptions.logger).toBeDefined();
  });

  it("forwards explicit manifest-only requests", async () => {
    await loadPluginMetadataRegistrySnapshotAsync({
      config: { plugins: {} },
      loadModules: false,
    });

    const loadOptions = getOnlyLoadOpenClawPluginsOptions();
    expect(loadOptions).toMatchObject({
      config: { plugins: {} },
      activationSourceConfig: { plugins: {} },
      autoEnabledReasons: {},
      workspaceDir: "/resolved-workspace",
      throwOnLoadError: true,
      cache: false,
      activate: false,
      mode: "validate",
      loadModules: false,
    });
    expect(loadOptions.env === process.env).toBe(true);
    expect(loadOptions.logger).toBeDefined();
  });

  it("forwards an explicit logger through metadata snapshots", async () => {
    const logger = createInfoWarnErrorLogger();

    await loadPluginMetadataRegistrySnapshotAsync({
      config: { plugins: {} },
      logger,
      workspaceDir: "/workspace",
    });

    const { env, ...loadOptions } = getOnlyLoadOpenClawPluginsOptions();
    expect(loadOptions).toMatchObject({
      config: { plugins: {} },
      activationSourceConfig: { plugins: {} },
      autoEnabledReasons: {},
      workspaceDir: "/workspace",
      logger,
      throwOnLoadError: true,
      cache: false,
      activate: false,
      mode: "validate",
      loadModules: undefined,
    });
    // Preserve the env subset check without handing its values to the matcher.
    expect(
      env !== undefined && Object.entries(process.env).every(([key, value]) => env[key] === value),
    ).toBe(true);
  });

  it("honors explicit load options when reusing a resolved runtime context", async () => {
    const logger = createInfoWarnErrorLogger();
    const env = { HOME: "/tmp/context-home" } as NodeJS.ProcessEnv;
    const manifestRegistry = { plugins: [], diagnostics: [] };

    await loadPluginMetadataRegistrySnapshotAsync({
      config: { plugins: { allow: ["compat-provider"] } },
      activationSourceConfig: { plugins: { allow: ["raw-plugin"] } },
      workspaceDir: "/compat-workspace",
      env,
      logger,
      manifestRegistry,
      runtimeContext: {
        rawConfig: { plugins: { allow: ["raw-plugin"] } },
        config: { plugins: { allow: ["raw-plugin"] } },
        activationSourceConfig: { plugins: { allow: ["raw-plugin"] } },
        autoEnabledReasons: {},
        workspaceDir: "/context-workspace",
        env,
        logger,
      },
    });

    expect(applyPluginAutoEnableMock).not.toHaveBeenCalled();
    expect(getOnlyLoadOpenClawPluginsOptions()).toEqual({
      config: { plugins: { allow: ["compat-provider"] } },
      activationSourceConfig: { plugins: { allow: ["raw-plugin"] } },
      autoEnabledReasons: {},
      workspaceDir: "/compat-workspace",
      env,
      logger,
      throwOnLoadError: true,
      cache: false,
      activate: false,
      mode: "validate",
      loadModules: undefined,
      manifestRegistry,
      installRecords: undefined,
    });
  });

  it("preserves explicit empty plugin scopes on metadata snapshots", async () => {
    await loadPluginMetadataRegistrySnapshotAsync({
      config: { plugins: {} },
      onlyPluginIds: [],
    });

    const loadOptions = getOnlyLoadOpenClawPluginsOptions();
    expect(loadOptions).toMatchObject({
      config: { plugins: {} },
      activationSourceConfig: { plugins: {} },
      autoEnabledReasons: {},
      workspaceDir: "/resolved-workspace",
      throwOnLoadError: true,
      cache: false,
      activate: false,
      mode: "validate",
      loadModules: undefined,
      onlyPluginIds: [],
    });
    expect(loadOptions.env === process.env).toBe(true);
    expect(loadOptions.logger).toBeDefined();
  });
});
