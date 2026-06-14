// Load context tests cover agent and workspace context resolution for plugin runtimes.
import { beforeEach, describe, expect, it, vi } from "vitest";

const loadConfigMock = vi.fn<typeof import("../../config/config.js").loadConfig>();
const applyPluginAutoEnableMock =
  vi.fn<typeof import("../../config/plugin-auto-enable.js").applyPluginAutoEnable>();
const resolveAgentWorkspaceDirMock = vi.fn<
  typeof import("../../agents/agent-scope.js").resolveAgentWorkspaceDir
>(() => "/resolved-workspace");
const resolveDefaultAgentIdMock = vi.fn<
  typeof import("../../agents/agent-scope.js").resolveDefaultAgentId
>(() => "default");
const manifestRegistry = { diagnostics: [], plugins: [] };
const metadataSnapshot = {
  configFingerprint: "fingerprint",
  diagnostics: [],
  index: { plugins: [], policyHash: "policy" },
  manifestRegistry,
  plugins: [],
  policyHash: "policy",
  workspaceDir: "/resolved-workspace",
};
const loadPluginMetadataSnapshotMock = vi.fn(() => metadataSnapshot);
const getCurrentPluginMetadataSnapshotMock = vi.fn(() => undefined);
const setCurrentPluginMetadataSnapshotMock = vi.fn();
const clearCurrentPluginMetadataSnapshotMock = vi.fn();

let resolvePluginRuntimeLoadContext: typeof import("./load-context.js").resolvePluginRuntimeLoadContext;
let buildPluginRuntimeLoadOptions: typeof import("./load-context.js").buildPluginRuntimeLoadOptions;
let clearRuntimeConfigSnapshot: typeof import("../../config/runtime-snapshot.js").clearRuntimeConfigSnapshot;
let setRuntimeConfigSnapshot: typeof import("../../config/runtime-snapshot.js").setRuntimeConfigSnapshot;

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: loadConfigMock,
  loadConfig: loadConfigMock,
}));

vi.mock("../../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: applyPluginAutoEnableMock,
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: resolveAgentWorkspaceDirMock,
  resolveDefaultAgentId: resolveDefaultAgentIdMock,
}));

vi.mock("../plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: loadPluginMetadataSnapshotMock,
  resolvePluginMetadataSnapshot: loadPluginMetadataSnapshotMock,
}));

vi.mock("../current-plugin-metadata-snapshot.js", () => ({
  clearCurrentPluginMetadataSnapshot: clearCurrentPluginMetadataSnapshotMock,
  getCurrentPluginMetadataSnapshot: getCurrentPluginMetadataSnapshotMock,
  isReusableCurrentPluginMetadataSnapshot: (
    _snapshot: typeof metadataSnapshot & { registrySource?: "derived" },
  ) => true,
  setCurrentPluginMetadataSnapshot: setCurrentPluginMetadataSnapshotMock,
}));

describe("resolvePluginRuntimeLoadContext", () => {
  beforeEach(async () => {
    vi.resetModules();
    ({ clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } =
      await import("../../config/runtime-snapshot.js"));
    ({ resolvePluginRuntimeLoadContext, buildPluginRuntimeLoadOptions } =
      await import("./load-context.js"));
    loadConfigMock.mockReset();
    applyPluginAutoEnableMock.mockReset();
    getCurrentPluginMetadataSnapshotMock.mockReset();
    getCurrentPluginMetadataSnapshotMock.mockReturnValue(undefined);
    loadPluginMetadataSnapshotMock.mockClear();
    getCurrentPluginMetadataSnapshotMock.mockClear();
    setCurrentPluginMetadataSnapshotMock.mockClear();
    clearCurrentPluginMetadataSnapshotMock.mockClear();
    resolveAgentWorkspaceDirMock.mockClear();
    resolveDefaultAgentIdMock.mockClear();

    loadConfigMock.mockReturnValue({ plugins: {} });
    applyPluginAutoEnableMock.mockImplementation((params) => ({
      config: params.config ?? {},
      changes: [],
      autoEnabledReasons: {},
    }));
    clearRuntimeConfigSnapshot();
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

    expect(context).toEqual({
      rawConfig,
      config: resolvedConfig,
      activationSourceConfig: rawConfig,
      autoEnabledReasons: {
        demo: ["demo configured"],
      },
      workspaceDir: "/resolved-workspace",
      env: context.env,
      logger: context.logger,
      manifestRegistry,
      installRecords: {},
      rawConfigEnvVarsResolved: false,
    });
    expect(loadPluginMetadataSnapshotMock).toHaveBeenCalledWith({
      allowWorkspaceScopedCurrent: true,
      config: rawConfig,
      env: context.env,
      workspaceDir: "/resolved-workspace",
    });
    expect(applyPluginAutoEnableMock).toHaveBeenCalledWith({
      config: rawConfig,
      env: context.env,
      manifestRegistry,
    });
    expect(setCurrentPluginMetadataSnapshotMock).toHaveBeenCalledWith(metadataSnapshot, {
      config: rawConfig,
      compatibleConfigs: [resolvedConfig, rawConfig],
      env: context.env,
      workspaceDir: "/resolved-workspace",
    });
    expect(resolveDefaultAgentIdMock).toHaveBeenCalledWith(resolvedConfig);
    expect(resolveAgentWorkspaceDirMock).toHaveBeenCalledWith(resolvedConfig, "default");
  });

  it("stores derived metadata as the reusable runtime snapshot", () => {
    const derivedSnapshot = { ...metadataSnapshot } as typeof metadataSnapshot & {
      registrySource: "derived";
    };
    derivedSnapshot.registrySource = "derived";
    loadPluginMetadataSnapshotMock.mockReturnValueOnce(derivedSnapshot);

    resolvePluginRuntimeLoadContext({
      config: { plugins: {} },
      env: { HOME: "/tmp/openclaw-home" } as NodeJS.ProcessEnv,
    });

    expect(setCurrentPluginMetadataSnapshotMock).toHaveBeenCalledWith(derivedSnapshot, {
      config: { plugins: {} },
      compatibleConfigs: [{ plugins: {} }, { plugins: {} }],
      env: expect.objectContaining({ HOME: "/tmp/openclaw-home" }),
      workspaceDir: "/resolved-workspace",
    });
    expect(clearCurrentPluginMetadataSnapshotMock).not.toHaveBeenCalled();
  });

  it("uses the source runtime snapshot for plugin activation source config", () => {
    const runtimeConfig = { plugins: {} };
    const sourceConfig = {
      plugins: {
        allow: ["trusted-plugin"],
      },
    };

    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);
    loadConfigMock.mockReturnValue(runtimeConfig);

    const context = resolvePluginRuntimeLoadContext();

    expect(context.rawConfig).toBe(runtimeConfig);
    expect(context.activationSourceConfig).toEqual(sourceConfig);
    expect(applyPluginAutoEnableMock).toHaveBeenCalledWith({
      config: runtimeConfig,
      env: expect.objectContaining(process.env),
      manifestRegistry,
    });
  });

  it("threads install records from the metadata snapshot into the context and load options", () => {
    const snapshotWithRecords = {
      ...metadataSnapshot,
      index: {
        installRecords: {
          demo: { source: "registry", version: "1.0.0" },
        },
        plugins: [],
        policyHash: "policy",
      },
    };
    loadPluginMetadataSnapshotMock.mockReturnValueOnce(snapshotWithRecords);

    const context = resolvePluginRuntimeLoadContext({
      config: { plugins: {} },
      env: { HOME: "/tmp/openclaw-home" } as NodeJS.ProcessEnv,
    });

    expect(context.installRecords).toEqual({
      demo: { source: "registry", version: "1.0.0" },
    });
    expect(buildPluginRuntimeLoadOptions(context).installRecords).toEqual({
      demo: { source: "registry", version: "1.0.0" },
    });
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
    ).toEqual({
      config: context.config,
      activationSourceConfig: context.activationSourceConfig,
      autoEnabledReasons: context.autoEnabledReasons,
      workspaceDir: "/explicit-workspace",
      env: context.env,
      logger: context.logger,
      manifestRegistry,
      installRecords: {},
      cache: false,
      activate: false,
      onlyPluginIds: ["demo"],
    });
  });

  it("resolves plugin config env placeholders for raw configs that opt into resolution", () => {
    const rawConfig = {
      env: {
        vars: {
          PIONEER_API_KEY: "resolved-from-config",
        },
      },
      plugins: {
        entries: {
          pioneer: {
            enabled: true,
            config: {
              apiKey: "${PIONEER_API_KEY}",
            },
          },
        },
      },
    };

    applyPluginAutoEnableMock.mockImplementation((params) => ({
      config: params.config ?? {},
      changes: [],
      autoEnabledReasons: {},
    }));

    const context = resolvePluginRuntimeLoadContext({
      config: rawConfig,
      env: { HOME: "/tmp/openclaw-home" } as NodeJS.ProcessEnv,
      resolveRawConfigEnvVars: true,
    });

    const options = buildPluginRuntimeLoadOptions(context);
    expect(context.env.PIONEER_API_KEY).toBe("resolved-from-config");
    expect(context.config.plugins?.entries?.pioneer?.config).toEqual({
      apiKey: "resolved-from-config",
    });
    expect(options.resolveRawConfigEnvVars).toBeUndefined();
    // The load options keep the raw-mode marker so the loader applies raw
    // cache semantics (no registry reuse, redacted cache keys) without
    // resolving a second time.
    expect(context.rawConfigEnvVarsResolved).toBe(true);
    expect(options.rawConfigEnvVarsResolved).toBe(true);
  });

  it("preserves $${VAR} escapes as literals when resolving a raw config", () => {
    const rawConfig = {
      env: {
        vars: {
          PIONEER_API_KEY: "resolved-from-config",
        },
      },
      plugins: {
        entries: {
          pioneer: {
            enabled: true,
            config: {
              apiKey: "$${PIONEER_API_KEY}",
            },
          },
        },
      },
    };

    applyPluginAutoEnableMock.mockImplementation((params) => ({
      config: params.config ?? {},
      changes: [],
      autoEnabledReasons: {},
    }));

    const context = resolvePluginRuntimeLoadContext({
      config: rawConfig,
      env: { HOME: "/tmp/openclaw-home" } as NodeJS.ProcessEnv,
      resolveRawConfigEnvVars: true,
    });

    expect(context.config.plugins?.entries?.pioneer?.config).toEqual({
      apiKey: "${PIONEER_API_KEY}",
    });
  });

  it("never re-resolves prepared configs, so escaped literals survive runtime loads", () => {
    // A prepared config already went through the single substitution pass, so
    // an escaped $${VAR} arrives here as the literal ${VAR}. Resolving again
    // would turn that literal into the real env value.
    const preparedConfig = {
      env: {
        vars: {
          PIONEER_API_KEY: "real-secret",
        },
      },
      plugins: {
        entries: {
          pioneer: {
            enabled: true,
            config: {
              apiKey: "${PIONEER_API_KEY}",
            },
          },
        },
      },
    };

    applyPluginAutoEnableMock.mockImplementation((params) => ({
      config: params.config ?? {},
      changes: [],
      autoEnabledReasons: {},
    }));

    const context = resolvePluginRuntimeLoadContext({
      config: preparedConfig,
      env: { HOME: "/tmp/openclaw-home" } as NodeJS.ProcessEnv,
    });

    expect(context.config.plugins?.entries?.pioneer?.config).toEqual({
      apiKey: "${PIONEER_API_KEY}",
    });
    expect(context.activationSourceConfig).toBe(preparedConfig);
    expect(context.rawConfigEnvVarsResolved).toBe(false);
    expect(buildPluginRuntimeLoadOptions(context).rawConfigEnvVarsResolved).toBeUndefined();
  });
});
