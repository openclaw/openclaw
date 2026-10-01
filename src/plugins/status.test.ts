import { expectDefined } from "@openclaw/normalization-core";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import {
  createAutoEnabledStatusConfig,
  createCompatChainFixture,
  createCompatibilityNotice,
  createCustomHook,
  createInstalledPluginIndexSnapshot,
  createPluginLoadResult,
  createPluginRecord,
  HOOK_ONLY_MESSAGE,
  REMOVED_SESSION_TRANSCRIPT_FILE_API_MESSAGE,
} from "./status.test-fixtures.js";

const mocks = vi.hoisted(() => ({
  config: vi.fn(),
  load: vi.fn(),
  runtimeRegistry: vi.fn(),
  metadataRegistry: vi.fn(),
  metadataSnapshot: vi.fn(),
  autoEnable: vi.fn(),
  compatIds: vi.fn(),
  compatConfig: vi.fn(),
  facadeIds: vi.fn(),
  runtimeIds: vi.fn(),
}));
let status: typeof import("./status.js");

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: mocks.config,
  loadConfig: mocks.config,
}));
vi.mock("../config/io.plugin-metadata.js", () => ({
  resolveConfigWidePluginMetadataSnapshot: mocks.metadataSnapshot,
}));
vi.mock("../config/plugin-auto-enable.js", () => ({ applyPluginAutoEnable: mocks.autoEnable }));
vi.mock("./loader.js", () => ({
  loadOpenClawPlugins: mocks.load,
  loadPluginRegistryHandle: (options: Record<string, unknown> = {}) =>
    mocks.load({ ...options, activate: false }),
  resolveCompatibleRuntimePluginRegistry: mocks.runtimeRegistry,
}));
vi.mock("./runtime/metadata-registry-loader.js", () => ({
  loadPluginMetadataRegistrySnapshot: mocks.metadataRegistry,
}));
vi.mock("./plugin-metadata-snapshot.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./plugin-metadata-snapshot.js")>();
  return {
    loadPluginMetadataSnapshot: mocks.metadataSnapshot,
    projectPluginMetadataSnapshot: actual.projectPluginMetadataSnapshot,
    resolvePluginMetadataSnapshot: (params?: { pluginMetadataSnapshot?: unknown }) =>
      params?.pluginMetadataSnapshot ?? mocks.metadataSnapshot(params),
  };
});
vi.mock("./providers.js", () => ({ resolveBundledProviderCompatPluginIds: mocks.compatIds }));
vi.mock("./bundled-compat.js", () => ({ withBundledPluginEnablementCompat: mocks.compatConfig }));
vi.mock("../plugin-sdk/facade-runtime.js", () => ({
  listImportedBundledPluginFacadeIds: mocks.facadeIds,
}));
vi.mock("./runtime.js", () => ({
  getActivePluginChannelRegistry: () => null,
  listImportedRuntimePluginIds: mocks.runtimeIds,
}));
vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: () => undefined,
  resolveDefaultAgentId: () => "default",
  tryResolveConfiguredAgentWorkspaceDir: () => undefined,
  tryResolveSystemAgentWorkspaceDir: () => undefined,
}));
vi.mock("../agents/workspace.js", () => ({
  resolveDefaultAgentWorkspaceDir: () => "/default-workspace",
}));

function setReport(overrides: Partial<ReturnType<typeof createPluginLoadResult>> = {}) {
  const report = createPluginLoadResult({ plugins: [], ...overrides });
  mocks.load.mockReturnValue(report);
  mocks.metadataRegistry.mockReturnValue(report);
  return report;
}

function inspect(id: string, report: ReturnType<typeof createPluginLoadResult>) {
  return expectDefined(status.buildPluginInspectReport({ id, report }), `inspect ${id}`);
}

describe("plugin status reports", () => {
  beforeAll(async () => {
    status = await import("./status.js");
  });
  beforeEach(() => {
    clearPluginMetadataLifecycleCaches();
    for (const mock of Object.values(mocks)) {
      mock.mockReset();
    }
    mocks.config.mockReturnValue({});
    mocks.metadataSnapshot.mockImplementation(() => {
      const manifestRegistry = { plugins: [], diagnostics: [] };
      return {
        index: createInstalledPluginIndexSnapshot([]),
        manifestRegistry,
        plugins: manifestRegistry.plugins,
        byPluginId: new Map(),
      };
    });
    mocks.autoEnable.mockImplementation((params: { config: unknown }) => ({
      config: params.config,
      changes: [],
      autoEnabledReasons: {},
    }));
    mocks.compatIds.mockReturnValue([]);
    mocks.compatConfig.mockImplementation((params: { config: unknown }) => params.config);
    mocks.facadeIds.mockReturnValue([]);
    mocks.runtimeIds.mockReturnValue([]);
    setReport();
  });

  it("applies the full bundled provider compat chain before loading plugins", () => {
    const { config, pluginIds, enabledConfig } = createCompatChainFixture();
    mocks.compatIds.mockReturnValue(pluginIds);
    mocks.compatConfig.mockReturnValue(enabledConfig);
    status.buildPluginSnapshotReport({ config });
    expect(mocks.compatConfig).toHaveBeenCalledWith({ config, pluginIds, activation: "defaults" });
    expect(mocks.metadataRegistry).toHaveBeenCalledWith(
      expect.objectContaining({
        config: enabledConfig,
        loadModules: false,
      }),
    );
  });

  it("inspects registered capabilities and normalized policy from auto-enabled config", () => {
    const { rawConfig, autoEnabledConfig } = createAutoEnabledStatusConfig(
      {
        google: {
          enabled: true,
          hooks: {
            allowPromptInjection: false,
            allowConversationAccess: true,
            timeoutMs: 1700,
            timeouts: { gateway_stop: 1300 },
          },
          subagent: { allowModelOverride: true, allowedModels: ["openai/gpt-5.5"] },
        },
      },
      { channels: { google: { enabled: true } } },
    );
    mocks.config.mockReturnValue(rawConfig);
    mocks.autoEnable.mockReturnValue({
      config: autoEnabledConfig,
      changes: [],
      autoEnabledReasons: {},
    });
    const id = "GoOgLe";
    const report = setReport({
      plugins: [
        createPluginRecord({
          id,
          origin: "bundled",
          kind: "context-engine",
          contextEngineIds: ["context"],
          contracts: { webContentExtractors: ["readability"] },
          webFetchProviderIds: ["fetch"],
          webSearchProviderIds: ["search"],
          migrationProviderIds: ["importer"],
        }),
      ],
      hooks: [createCustomHook({ pluginId: id, events: ["message"] })],
      diagnostics: [{ level: "warn", pluginId: id, message: "watch this surface" }],
    });
    const result = inspect(id, report);
    expect(result).toMatchObject({
      shape: "hybrid-capability",
      capabilityMode: "hybrid",
      compatibility: [],
    });
    expect(result.capabilities).toEqual([
      { kind: "web-content-extractors", ids: ["readability"] },
      { kind: "web-fetch", ids: ["fetch"] },
      { kind: "web-search", ids: ["search"] },
      { kind: "migration-provider", ids: ["importer"] },
      { kind: "context-engine", ids: ["context"] },
    ]);
    expect(result.policy).toEqual({
      allowPromptInjection: false,
      allowConversationAccess: true,
      hookTimeoutMs: 1700,
      hookTimeouts: { gateway_stop: 1300 },
      allowModelOverride: true,
      allowedModels: ["openai/gpt-5.5"],
      hasAllowedModelsConfig: true,
    });
    expect(result.diagnostics).toEqual(report.diagnostics);
    expect(result.plugin.id).toBe(id);
    expect(status.buildAllPluginInspectReports({ report })).toEqual([result]);
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it("prefers exact plugin ids over display names in individual and all inspect reports", () => {
    const report = setReport({
      plugins: [
        createPluginRecord({ id: "lca", name: "microsoft" }),
        createPluginRecord({ id: "microsoft", name: "Microsoft" }),
      ],
    });
    expect(inspect("microsoft", report).plugin.id).toBe("microsoft");
    expect(inspect("Microsoft", report).plugin.id).toBe("microsoft");
    const results = status.buildAllPluginInspectReports({ report });
    expect(results.map((entry) => entry.plugin.id)).toEqual(["lca", "microsoft"]);
  });

  it("normalizes bundled plugin versions to the core base release", async () => {
    setReport({
      plugins: [createPluginRecord({ id: "bundled", version: "2026.3.22", origin: "bundled" })],
    });
    await status.withPluginDiagnosticsReport(
      { config: {}, env: { OPENCLAW_VERSION: "2026.3.23-1" } },
      (report) => {
        expect(report.plugins[0]?.version).toBe("2026.3.23");
      },
    );
  });

  it("projects imported state before and after diagnostics evaluate native modules", async () => {
    setReport({
      plugins: [
        createPluginRecord({ id: "runtime-loaded" }),
        createPluginRecord({ id: "facade-loaded" }),
        createPluginRecord({ id: "broken-plugin", status: "error" }),
        createPluginRecord({ id: "bundle-loaded", format: "bundle" }),
        createPluginRecord({ id: "cold-plugin" }),
      ],
    });
    mocks.runtimeIds.mockReturnValue(["runtime-loaded", "broken-plugin", "bundle-loaded"]);
    mocks.facadeIds.mockReturnValue(["facade-loaded"]);
    const snapshot = status.buildPluginSnapshotReport({ config: {} });
    expect(snapshot.plugins.map(({ id, imported }) => [id, imported])).toEqual([
      ["runtime-loaded", true],
      ["facade-loaded", true],
      ["broken-plugin", true],
      ["bundle-loaded", false],
      ["cold-plugin", false],
    ]);
    await status.withPluginDiagnosticsReport({ config: {} }, (report) => {
      expect(report.plugins.map(({ id, imported }) => [id, imported])).toEqual([
        ["runtime-loaded", true],
        ["facade-loaded", true],
        ["broken-plugin", true],
        ["bundle-loaded", false],
        ["cold-plugin", true],
      ]);
      expect(report.plugins.find((plugin) => plugin.id === "broken-plugin")?.status).toBe("error");
    });
  });

  it("exposes gateway discovery only after its service is registered", () => {
    const cold = setReport({ plugins: [createPluginRecord({ id: "bonjour" })] });
    expect(inspect("bonjour", cold)).toMatchObject({
      shape: "non-capability",
      capabilityCount: 0,
      capabilities: [],
    });
    const registered = setReport({
      plugins: [createPluginRecord({ id: "bonjour", gatewayDiscoveryServiceIds: ["bonjour"] })],
    });
    expect(inspect("bonjour", registered)).toMatchObject({
      shape: "plain-capability",
      capabilityMode: "plain",
      capabilityCount: 1,
      capabilities: [{ kind: "gateway-discovery", ids: ["bonjour"] }],
    });
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it("orders compatibility notices by plugin without attributing unrelated load failures", () => {
    const report = setReport({
      plugins: [
        createPluginRecord({ id: "old", hookCount: 1 }),
        createPluginRecord({
          id: "api",
          providerIds: ["api"],
          status: "error",
          error: "saveSessionStore missing",
        }),
        createPluginRecord({ id: "bundled", origin: "bundled", error: "sessionFile missing" }),
        createPluginRecord({ id: "unrelated" }),
      ],
      hooks: [createCustomHook({ pluginId: "old", events: ["message"] })],
      diagnostics: [
        { level: "error", pluginId: "api", message: "SessionTranscriptUpdate.sessionFile missing" },
        { level: "error", message: "sessionFile missing" },
        { level: "error", pluginId: "old", message: "sessionFile missing" },
      ],
    });
    const notices = status.buildPluginCompatibilityNotices({ report });
    expect(notices).toEqual([
      createCompatibilityNotice({ pluginId: "old", code: "hook-only" }),
      createCompatibilityNotice({ pluginId: "old", code: "removed-session-transcript-file-api" }),
      createCompatibilityNotice({ pluginId: "api", code: "removed-session-transcript-file-api" }),
    ]);
    expect(status.buildPluginCompatibilityWarnings({ report })).toEqual([
      `old ${HOOK_ONLY_MESSAGE}`,
      `old ${REMOVED_SESSION_TRANSCRIPT_FILE_API_MESSAGE}`,
      `api ${REMOVED_SESSION_TRANSCRIPT_FILE_API_MESSAGE}`,
    ]);
    expect(status.summarizePluginCompatibility(notices)).toEqual({
      noticeCount: 3,
      pluginCount: 2,
    });
  });

  it.each([
    {
      plugin: createPluginRecord({
        id: "bundle",
        format: "bundle",
        bundleFormat: "claude",
        rootDir: "/tmp/claude-bundle",
        bundleCapabilities: ["skills", "commands", "agents", "settings"],
      }),
      bundleCapabilities: ["skills", "commands", "agents", "settings"],
      mcpServers: [],
    },
    {
      plugin: createPluginRecord({
        id: "native-mcp",
        rootDir: "/tmp/native-mcp",
        mcpServers: {
          app: { transport: "stdio", command: "node", args: ["./mcp-server.js"] },
          remote: { type: "http", url: "https://example.test/mcp" },
          incomplete: { transport: "streamable-http" },
          invalidScheme: { transport: "streamable-http", url: "ftp://example.test/mcp" },
          invalidTransport: { transport: "http", url: "https://example.test/mcp" },
        },
      }),
      bundleCapabilities: [],
      mcpServers: [
        { name: "app", hasStdioTransport: true },
        { name: "remote", hasStdioTransport: false },
        { name: "incomplete", hasStdioTransport: false, unsupported: true },
        { name: "invalidScheme", hasStdioTransport: false, unsupported: true },
        { name: "invalidTransport", hasStdioTransport: false, unsupported: true },
      ],
    },
  ])(
    "projects $plugin.id bundle and MCP inspection metadata",
    ({ plugin, bundleCapabilities, mcpServers }) => {
      const result = inspect(plugin.id, setReport({ plugins: [plugin] }));
      expect(result.bundleCapabilities).toEqual(bundleCapabilities);
      expect(result.mcpServers).toStrictEqual(mcpServers);
      expect(result.shape).toBe("non-capability");
    },
  );
});
