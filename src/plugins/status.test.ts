import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DecisionProviderHost } from "../decisions/provider-host.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { warnPluginSdkDeprecation } from "./sdk-deprecation.js";
import * as status from "./status.js";
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
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => {
    clearPluginMetadataLifecycleCaches();
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.config.mockReturnValue({});
    mocks.metadataSnapshot.mockImplementation(() => {
      const manifestRegistry = { plugins: [], diagnostics: [] };
      return {
        index: createInstalledPluginIndexSnapshot([]),
        manifestRegistry,
        plugins: manifestRegistry.plugins,
        byPluginId: new Map(),
        diagnostics: [],
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
    expect(mocks.metadataRegistry).toHaveBeenCalledWith(
      expect.objectContaining({ config: enabledConfig, loadModules: false }),
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
      plugin: { id },
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

  it("projects imported state before and after diagnostics evaluate native modules", async () => {
    setReport({
      plugins: [
        createPluginRecord({ id: "runtime-loaded", origin: "bundled", version: "2026.3.22" }),
        createPluginRecord({ id: "facade-loaded" }),
        createPluginRecord({ id: "broken-plugin", status: "error" }),
        createPluginRecord({ id: "bundle-loaded", format: "bundle" }),
        createPluginRecord({ id: "cold-plugin" }),
      ],
    });
    mocks.runtimeIds.mockReturnValue(["runtime-loaded", "broken-plugin", "bundle-loaded"]);
    mocks.facadeIds.mockReturnValue(["facade-loaded"]);
    const importedState = (report: status.PluginStatusReport) =>
      report.plugins.map(({ id, imported }) => [id, imported]);
    const imports = [
      ["runtime-loaded", true],
      ["facade-loaded", true],
      ["broken-plugin", true],
      ["bundle-loaded", false],
    ];
    expect(importedState(status.buildPluginSnapshotReport({ config: {} }))).toEqual([
      ...imports,
      ["cold-plugin", false],
    ]);
    await status.withPluginDiagnosticsReport(
      { config: {}, env: { OPENCLAW_VERSION: "2026.3.23-1" } },
      (report) => {
        expect(report.plugins[0]?.version).toBe("2026.3.23");
        expect(importedState(report)).toEqual([...imports, ["cold-plugin", true]]);
        expect(report.plugins.find((plugin) => plugin.id === "broken-plugin")?.status).toBe(
          "error",
        );
      },
    );
  });

  it.each(["single", "all"])("uses the inspected config for %s decision diagnostics", (scope) => {
    mocks.config.mockReturnValue({ agents: { defaults: { decisionModel: "other/model" } } });
    const plugin = createPluginRecord({ id: "inspect-decisions" });
    const report = setReport({
      plugins: [plugin, createPluginRecord({ id: "unrelated" })],
      decisionProviders: [
        {
          pluginId: plugin.id,
          host: new DecisionProviderHost(
            {
              id: "inspect-decisions",
              contractVersion: 1,
              async evaluate() {
                throw new Error("Inspection must not evaluate decisions");
              },
            },
            plugin,
          ),
        },
      ],
    });
    const config = { agents: { defaults: { decisionModel: "inspect-decisions/model" } } };
    const inspected =
      scope === "single"
        ? status.buildPluginInspectReport({ id: plugin.id, config, report })
        : status
            .buildAllPluginInspectReports({ config, report })
            .find((entry) => entry.plugin.id === plugin.id);
    expect(inspected?.decisions).toMatchObject([
      { pluginId: "inspect-decisions", providerId: "inspect-decisions", configured: true },
    ]);
  });

  it("inspects each decision provider once per all-plugin report", () => {
    const plugins = Array.from({ length: 40 }, (_, index) =>
      createPluginRecord({ id: `decision-${index}` }),
    );
    const decisionProviders = plugins.map((plugin) => ({
      pluginId: plugin.id,
      host: new DecisionProviderHost(
        {
          id: plugin.id,
          contractVersion: 1,
          async evaluate() {
            throw new Error("Inspection must not evaluate decisions");
          },
        },
        plugin,
      ),
    }));
    const inspections = decisionProviders.map(({ host }) => vi.spyOn(host, "inspect"));
    const report = setReport({ plugins, decisionProviders });

    for (const selected of [0, 39]) {
      const config = { agents: { defaults: { decisionModel: `decision-${selected}/model` } } };
      const results = status.buildAllPluginInspectReports({ config, report });
      expect(results.map(({ plugin, decisions }) => [plugin.id, decisions])).toMatchObject(
        plugins.map((plugin, index) => [
          plugin.id,
          [{ pluginId: plugin.id, providerId: plugin.id, configured: index === selected }],
        ]),
      );
      for (const inspection of inspections) {
        expect(inspection).toHaveBeenCalledTimes(1);
        inspection.mockClear();
      }
    }
    status.buildPluginInspectReport({ id: "decision-0", config: {}, report });
    for (const [index, inspection] of inspections.entries()) {
      expect(inspection).toHaveBeenCalledTimes(index === 0 ? 1 : 0);
    }
  });

  it("includes observed SDK calls in inspection and CLI compatibility output", () => {
    const pluginId = "status-deprecated-sdk";
    vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    warnPluginSdkDeprecation({
      pluginId,
      family: "session-store",
      method: "getSessionEntry",
      replacement: "getSessionEntryAsync",
    });
    const report = setReport({ plugins: [createPluginRecord({ id: pluginId })] });
    const notices = status.buildPluginCompatibilityNotices({ report });
    expect(notices).toMatchObject([
      {
        pluginId,
        code: "deprecated-sdk-api",
        severity: "info",
        apis: [{ displayName: "getSessionEntry", replacement: "getSessionEntryAsync" }],
      },
    ]);
    expect(inspect(pluginId, report).compatibility).toEqual(notices);
    expect(status.buildPluginCompatibilityWarnings({ report })).toEqual([
      `${pluginId} ${notices[0]?.message}`,
    ]);
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
  });

  it("projects bundle capabilities without native capabilities", () => {
    const capabilities = ["skills", "commands", "agents", "settings"];
    const plugin = createPluginRecord({
      id: "bundle",
      format: "bundle",
      bundleFormat: "claude",
      rootDir: "/tmp/claude-bundle",
      bundleCapabilities: capabilities,
    });
    const result = inspect(plugin.id, setReport({ plugins: [plugin] }));
    expect(result.bundleCapabilities).toEqual(["skills", "commands", "agents", "settings"]);
    expect(result.mcpServers).toStrictEqual([]);
    expect(result.shape).toBe("non-capability");
  });

  it("classifies native MCP transports", () => {
    const plugin = createPluginRecord({
      id: "native-mcp",
      rootDir: "/tmp/native-mcp",
      mcpServers: {
        app: { transport: "stdio", command: "node", args: ["./mcp-server.js"] },
        remote: { type: "http", url: "https://example.test/mcp" },
        incomplete: { transport: "streamable-http" },
        invalidScheme: { transport: "streamable-http", url: "ftp://example.test/mcp" },
        invalidTransport: { transport: "http", url: "https://example.test/mcp" },
      },
    });
    const result = inspect(plugin.id, setReport({ plugins: [plugin] }));
    expect(result.bundleCapabilities).toEqual([]);
    expect(result.shape).toBe("non-capability");
    expect(result.mcpServers).toStrictEqual([
      { name: "app", hasStdioTransport: true },
      { name: "remote", hasStdioTransport: false },
      { name: "incomplete", hasStdioTransport: false, unsupported: true },
      { name: "invalidScheme", hasStdioTransport: false, unsupported: true },
      { name: "invalidTransport", hasStdioTransport: false, unsupported: true },
    ]);
  });
});
