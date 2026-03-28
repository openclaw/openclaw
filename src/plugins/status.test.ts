import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCompatibilityNotice,
  createCustomHook,
  createPluginLoadResult,
  createPluginRecord,
  createTypedHook,
  HOOK_ONLY_MESSAGE,
  LEGACY_BEFORE_AGENT_START_MESSAGE,
} from "./status.test-helpers.js";

const loadConfigMock = vi.fn();
const loadOpenClawPluginsMock = vi.fn();
const applyPluginAutoEnableMock = vi.fn();
const resolveBundledProviderCompatPluginIdsMock = vi.fn();
const withBundledPluginAllowlistCompatMock = vi.fn();
const withBundledPluginEnablementCompatMock = vi.fn();
let buildPluginStatusReport: typeof import("./status.js").buildPluginStatusReport;
let buildPluginInspectReport: typeof import("./status.js").buildPluginInspectReport;
let buildAllPluginInspectReports: typeof import("./status.js").buildAllPluginInspectReports;
let buildPluginCompatibilityNotices: typeof import("./status.js").buildPluginCompatibilityNotices;
let buildPluginCompatibilityWarnings: typeof import("./status.js").buildPluginCompatibilityWarnings;
let formatPluginCompatibilityNotice: typeof import("./status.js").formatPluginCompatibilityNotice;
let summarizePluginCompatibility: typeof import("./status.js").summarizePluginCompatibility;

vi.mock("../config/config.js", () => ({
  loadConfig: () => loadConfigMock(),
}));

vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: (...args: unknown[]) => applyPluginAutoEnableMock(...args),
}));

vi.mock("./loader.js", () => ({
  loadOpenClawPlugins: (...args: unknown[]) => loadOpenClawPluginsMock(...args),
}));

vi.mock("./providers.js", () => ({
  resolveBundledProviderCompatPluginIds: (...args: unknown[]) =>
    resolveBundledProviderCompatPluginIdsMock(...args),
}));

vi.mock("./bundled-compat.js", () => ({
  withBundledPluginAllowlistCompat: (...args: unknown[]) =>
    withBundledPluginAllowlistCompatMock(...args),
  withBundledPluginEnablementCompat: (...args: unknown[]) =>
    withBundledPluginEnablementCompatMock(...args),
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: () => undefined,
  resolveDefaultAgentId: () => "default",
}));

vi.mock("../agents/workspace.js", () => ({
  resolveDefaultAgentWorkspaceDir: () => "/default-workspace",
}));

function setPluginLoadResult(overrides: Partial<ReturnType<typeof createPluginLoadResult>>) {
  loadOpenClawPluginsMock.mockReturnValue(
    createPluginLoadResult({
      plugins: [],
      ...overrides,
    }),
  );
}

function setSinglePluginLoadResult(
  plugin: ReturnType<typeof createPluginRecord>,
  overrides: Omit<Partial<ReturnType<typeof createPluginLoadResult>>, "plugins"> = {},
) {
  setPluginLoadResult({
    plugins: [plugin],
    ...overrides,
  });
}

function expectInspectReport(pluginId: string) {
  const inspect = buildPluginInspectReport({ id: pluginId });
  expect(inspect).not.toBeNull();
  return inspect;
}

function expectPluginLoaderCall(params: {
  config?: unknown;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}) {
  expect(loadOpenClawPluginsMock).toHaveBeenCalledWith(
    expect.objectContaining({
      ...(params.config !== undefined ? { config: params.config } : {}),
      ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
      ...(params.env ? { env: params.env } : {}),
    }),
  );
}

function expectNoCompatibilityWarnings() {
  expect(buildPluginCompatibilityNotices()).toEqual([]);
  expect(buildPluginCompatibilityWarnings()).toEqual([]);
}

function expectCapabilityKinds(
  inspect: NonNullable<ReturnType<typeof buildPluginInspectReport>>,
  kinds: readonly string[],
) {
  expect(inspect.capabilities.map((entry) => entry.kind)).toEqual(kinds);
}

describe("buildPluginStatusReport", () => {
  beforeEach(async () => {
    vi.resetModules();
    loadConfigMock.mockReset();
    loadOpenClawPluginsMock.mockReset();
    applyPluginAutoEnableMock.mockReset();
    resolveBundledProviderCompatPluginIdsMock.mockReset();
    withBundledPluginAllowlistCompatMock.mockReset();
    withBundledPluginEnablementCompatMock.mockReset();
    loadConfigMock.mockReturnValue({});
    applyPluginAutoEnableMock.mockImplementation((params: { config: unknown }) => ({
      config: params.config,
      changes: [],
    }));
    resolveBundledProviderCompatPluginIdsMock.mockReturnValue([]);
    withBundledPluginAllowlistCompatMock.mockImplementation(
      (params: { config: unknown }) => params.config,
    );
    withBundledPluginEnablementCompatMock.mockImplementation(
      (params: { config: unknown }) => params.config,
    );
    setPluginLoadResult({ plugins: [] });
    ({
      buildAllPluginInspectReports,
      buildPluginCompatibilityNotices,
      buildPluginCompatibilityWarnings,
      buildPluginInspectReport,
      buildPluginStatusReport,
      formatPluginCompatibilityNotice,
      summarizePluginCompatibility,
    } = await import("./status.js"));
  });

  it("forwards an explicit env to plugin loading", () => {
    const env = { HOME: "/tmp/openclaw-home" } as NodeJS.ProcessEnv;

    buildPluginStatusReport({
      config: {},
      workspaceDir: "/workspace",
      env,
    });

    expectPluginLoaderCall({
      config: {},
      workspaceDir: "/workspace",
      env,
    });
  });

  it("loads plugin status from the auto-enabled config snapshot", () => {
    const rawConfig = {
      plugins: {},
      channels: { demo: { enabled: true } },
    };
    const autoEnabledConfig = {
      ...rawConfig,
      plugins: {
        entries: {
          demo: { enabled: true },
        },
      },
    };
    applyPluginAutoEnableMock.mockReturnValue({ config: autoEnabledConfig, changes: [] });

    buildPluginStatusReport({ config: rawConfig });

    expect(applyPluginAutoEnableMock).toHaveBeenCalledWith({
      config: rawConfig,
      env: process.env,
    });
    expect(loadOpenClawPluginsMock).toHaveBeenCalledWith(
      expect.objectContaining({ config: autoEnabledConfig }),
    );
  });

  it("uses the auto-enabled config snapshot for inspect policy summaries", () => {
    const rawConfig = {
      plugins: {},
      channels: { demo: { enabled: true } },
    };
    const autoEnabledConfig = {
      ...rawConfig,
      plugins: {
        entries: {
          demo: {
            enabled: true,
            subagent: {
              allowModelOverride: true,
              allowedModels: ["openai/gpt-5.4"],
              hasAllowedModelsConfig: true,
            },
          },
        },
      },
    };
    applyPluginAutoEnableMock.mockReturnValue({ config: autoEnabledConfig, changes: [] });
    setSinglePluginLoadResult(
      createPluginRecord({
        id: "demo",
        name: "Demo",
        description: "Auto-enabled plugin",
        origin: "bundled",
        providerIds: ["demo"],
      }),
    );

    const inspect = buildPluginInspectReport({ id: "demo", config: rawConfig });

    expect(inspect).not.toBeNull();
    expect(inspect?.policy).toEqual({
      allowPromptInjection: undefined,
      allowModelOverride: true,
      allowedModels: ["openai/gpt-5.4"],
      hasAllowedModelsConfig: true,
    });
  });

  it("applies the full bundled provider compat chain before loading plugins", () => {
    const config = { plugins: { allow: ["telegram"] } };
    loadConfigMock.mockReturnValue(config);
    resolveBundledProviderCompatPluginIdsMock.mockReturnValue(["anthropic", "openai"]);
    const compatConfig = { plugins: { allow: ["telegram", "anthropic", "openai"] } };
    const enabledConfig = {
      plugins: {
        allow: ["telegram", "anthropic", "openai"],
        entries: {
          anthropic: { enabled: true },
          openai: { enabled: true },
        },
      },
    };
    withBundledPluginAllowlistCompatMock.mockReturnValue(compatConfig);
    withBundledPluginEnablementCompatMock.mockReturnValue(enabledConfig);

    buildPluginStatusReport({ config });

    expect(withBundledPluginAllowlistCompatMock).toHaveBeenCalledWith({
      config,
      pluginIds: ["anthropic", "openai"],
    });
    expect(withBundledPluginEnablementCompatMock).toHaveBeenCalledWith({
      config: compatConfig,
      pluginIds: ["anthropic", "openai"],
    });
    expect(loadOpenClawPluginsMock).toHaveBeenCalledWith(
      expect.objectContaining({ config: enabledConfig }),
    );
  });

  it("normalizes bundled plugin versions to the core base release", () => {
    setSinglePluginLoadResult(
      createPluginRecord({
        id: "whatsapp",
        name: "WhatsApp",
        description: "Bundled channel plugin",
        version: "2026.3.22",
        origin: "bundled",
        channelIds: ["whatsapp"],
      }),
    );

    const report = buildPluginStatusReport({
      config: {},
      env: {
        OPENCLAW_VERSION: "2026.3.23-1",
      } as NodeJS.ProcessEnv,
    });

    expect(report.plugins[0]?.version).toBe("2026.3.23");
  });

  it("builds an inspect report with capability shape and policy", () => {
    loadConfigMock.mockReturnValue({
      plugins: {
        entries: {
          google: {
            hooks: { allowPromptInjection: false },
            subagent: {
              allowModelOverride: true,
              allowedModels: ["openai/gpt-5.4"],
            },
          },
        },
      },
    });
    setPluginLoadResult({
      plugins: [
        createPluginRecord({
          id: "google",
          name: "Google",
          description: "Google provider plugin",
          origin: "bundled",
          cliBackendIds: ["google-gemini-cli"],
          providerIds: ["google"],
          mediaUnderstandingProviderIds: ["google"],
          imageGenerationProviderIds: ["google"],
          webSearchProviderIds: ["google"],
        }),
      ],
      diagnostics: [{ level: "warn", pluginId: "google", message: "watch this surface" }],
      typedHooks: [createTypedHook({ pluginId: "google", hookName: "before_agent_start" })],
    });

    const inspect = buildPluginInspectReport({ id: "google" });

    expect(inspect).not.toBeNull();
    expect(inspect?.shape).toBe("hybrid-capability");
    expect(inspect?.capabilityMode).toBe("hybrid");
    expectCapabilityKinds(inspect!, [
      "cli-backend",
      "text-inference",
      "media-understanding",
      "image-generation",
      "web-search",
    ]);
    expect(inspect?.usesLegacyBeforeAgentStart).toBe(true);
    expect(inspect?.compatibility).toEqual([
      createCompatibilityNotice({ pluginId: "google", code: "legacy-before-agent-start" }),
    ]);
    expect(inspect?.policy).toEqual({
      allowPromptInjection: false,
      allowModelOverride: true,
      allowedModels: ["openai/gpt-5.4"],
      hasAllowedModelsConfig: true,
    });
    expect(inspect?.diagnostics).toEqual([
      { level: "warn", pluginId: "google", message: "watch this surface" },
    ]);
  });

  it("builds inspect reports for every loaded plugin", () => {
    setPluginLoadResult({
      plugins: [
        createPluginRecord({
          id: "lca",
          name: "LCA",
          description: "Legacy hook plugin",
          hookCount: 1,
        }),
        createPluginRecord({
          id: "microsoft",
          name: "Microsoft",
          description: "Hybrid capability plugin",
          origin: "bundled",
          providerIds: ["microsoft"],
          webSearchProviderIds: ["microsoft"],
        }),
      ],
      hooks: [createCustomHook({ pluginId: "lca", events: ["message"] })],
      typedHooks: [createTypedHook({ pluginId: "lca", hookName: "before_agent_start" })],
    });

    const inspect = buildAllPluginInspectReports();

    expect(inspect.map((entry) => entry.plugin.id)).toEqual(["lca", "microsoft"]);
    expect(inspect.map((entry) => entry.shape)).toEqual(["hook-only", "hybrid-capability"]);
    expect(inspect[0]?.usesLegacyBeforeAgentStart).toBe(true);
    expectCapabilityKinds(inspect[1], ["text-inference", "web-search"]);
  });

  it("treats a CLI-backend-only plugin as a plain capability", () => {
    setSinglePluginLoadResult(
      createPluginRecord({
        id: "anthropic",
        name: "Anthropic",
        cliBackendIds: ["claude-cli"],
      }),
    );

    const inspect = expectInspectReport("anthropic");

    expect(inspect?.shape).toBe("plain-capability");
    expect(inspect?.capabilityMode).toBe("plain");
    expectCapabilityKinds(inspect!, ["cli-backend"]);
    expect(inspect?.capabilities).toEqual([{ kind: "cli-backend", ids: ["claude-cli"] }]);
  });

  it("builds compatibility warnings for legacy compatibility paths", () => {
    setPluginLoadResult({
      plugins: [
        createPluginRecord({
          id: "lca",
          name: "LCA",
          description: "Legacy hook plugin",
          hookCount: 1,
        }),
      ],
      typedHooks: [createTypedHook({ pluginId: "lca", hookName: "before_agent_start" })],
    });

    expect(buildPluginCompatibilityWarnings()).toEqual([
      `lca ${LEGACY_BEFORE_AGENT_START_MESSAGE}`,
      `lca ${HOOK_ONLY_MESSAGE}`,
    ]);
  });

  it("builds structured compatibility notices with deterministic ordering", () => {
    setPluginLoadResult({
      plugins: [
        createPluginRecord({
          id: "hook-only",
          name: "Hook Only",
          hookCount: 1,
        }),
        createPluginRecord({
          id: "legacy-only",
          name: "Legacy Only",
          providerIds: ["legacy-only"],
          hookCount: 1,
        }),
      ],
      hooks: [createCustomHook({ pluginId: "hook-only", events: ["message"] })],
      typedHooks: [createTypedHook({ pluginId: "legacy-only", hookName: "before_agent_start" })],
    });

    expect(buildPluginCompatibilityNotices()).toEqual([
      createCompatibilityNotice({ pluginId: "hook-only", code: "hook-only" }),
      createCompatibilityNotice({ pluginId: "legacy-only", code: "legacy-before-agent-start" }),
    ]);
  });

  it("returns no compatibility warnings for modern capability plugins", () => {
    setSinglePluginLoadResult(
      createPluginRecord({
        id: "modern",
        name: "Modern",
        providerIds: ["modern"],
      }),
    );

    expectNoCompatibilityWarnings();
  });

  it.each([
    {
      name: "populates bundleCapabilities from plugin record",
      plugin: createPluginRecord({
        id: "claude-bundle",
        name: "Claude Bundle",
        description: "A bundle plugin with skills and commands",
        source: "/tmp/claude-bundle/.claude-plugin/plugin.json",
        format: "bundle",
        bundleFormat: "claude",
        bundleCapabilities: ["skills", "commands", "agents", "settings"],
        rootDir: "/tmp/claude-bundle",
      }),
      expectedId: "claude-bundle",
      expectedBundleCapabilities: ["skills", "commands", "agents", "settings"],
      expectedShape: "non-capability",
    },
    {
      name: "returns empty bundleCapabilities and mcpServers for non-bundle plugins",
      plugin: createPluginRecord({
        id: "plain-plugin",
        name: "Plain Plugin",
        description: "A regular plugin",
        providerIds: ["plain"],
      }),
      expectedId: "plain-plugin",
      expectedBundleCapabilities: [],
      expectedShape: "plain-capability",
    },
  ])("$name", ({ plugin, expectedId, expectedBundleCapabilities, expectedShape }) => {
    setSinglePluginLoadResult(plugin);

    const inspect = expectInspectReport(expectedId);

    expect(inspect?.bundleCapabilities).toEqual(expectedBundleCapabilities);
    expect(inspect?.mcpServers).toEqual([]);
    expect(inspect?.shape).toBe(expectedShape);
  });

  it("formats and summarizes compatibility notices", () => {
    const notice = createCompatibilityNotice({
      pluginId: "legacy-plugin",
      code: "legacy-before-agent-start",
    });

    expect(formatPluginCompatibilityNotice(notice)).toBe(
      `legacy-plugin ${LEGACY_BEFORE_AGENT_START_MESSAGE}`,
    );
    expect(
      summarizePluginCompatibility([
        notice,
        createCompatibilityNotice({ pluginId: "legacy-plugin", code: "hook-only" }),
      ]),
    ).toEqual({
      noticeCount: 2,
      pluginCount: 1,
    });
  });
});
