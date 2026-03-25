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

vi.mock("./loader.js", () => ({
  loadOpenClawPlugins: (...args: unknown[]) => loadOpenClawPluginsMock(...args),
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

describe("buildPluginStatusReport", () => {
  beforeEach(async () => {
    vi.resetModules();
    loadConfigMock.mockReset();
    loadOpenClawPluginsMock.mockReset();
    loadConfigMock.mockReturnValue({});
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

    expect(loadOpenClawPluginsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        config: {},
        workspaceDir: "/workspace",
        env,
      }),
    );
  });

  it("normalizes bundled plugin versions to the core base release", () => {
    setPluginLoadResult({
      plugins: [
        createPluginRecord({
          id: "whatsapp",
          name: "WhatsApp",
          description: "Bundled channel plugin",
          version: "2026.3.22",
          origin: "bundled",
          channelIds: ["whatsapp"],
        }),
      ],
    });

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
    expect(inspect?.capabilities.map((entry) => entry.kind)).toEqual([
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
    expect(inspect[1]?.capabilities.map((entry) => entry.kind)).toEqual([
      "text-inference",
      "web-search",
    ]);
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
    setPluginLoadResult({
      plugins: [
        createPluginRecord({
          id: "modern",
          name: "Modern",
          providerIds: ["modern"],
        }),
      ],
    });

    expect(buildPluginCompatibilityNotices()).toEqual([]);
    expect(buildPluginCompatibilityWarnings()).toEqual([]);
  });

  it("populates bundleCapabilities from plugin record", () => {
    setPluginLoadResult({
      plugins: [
        createPluginRecord({
          id: "claude-bundle",
          name: "Claude Bundle",
          description: "A bundle plugin with skills and commands",
          source: "/tmp/claude-bundle/.claude-plugin/plugin.json",
          format: "bundle",
          bundleFormat: "claude",
          bundleCapabilities: ["skills", "commands", "agents", "settings"],
          rootDir: "/tmp/claude-bundle",
        }),
      ],
    });

    const inspect = buildPluginInspectReport({ id: "claude-bundle" });

    expect(inspect).not.toBeNull();
    expect(inspect?.bundleCapabilities).toEqual(["skills", "commands", "agents", "settings"]);
    expect(inspect?.mcpServers).toEqual([]);
    expect(inspect?.shape).toBe("non-capability");
  });

  it("returns empty bundleCapabilities and mcpServers for non-bundle plugins", () => {
    setPluginLoadResult({
      plugins: [
        createPluginRecord({
          id: "plain-plugin",
          name: "Plain Plugin",
          description: "A regular plugin",
          providerIds: ["plain"],
        }),
      ],
    });

    const inspect = buildPluginInspectReport({ id: "plain-plugin" });

    expect(inspect).not.toBeNull();
    expect(inspect?.bundleCapabilities).toEqual([]);
    expect(inspect?.mcpServers).toEqual([]);
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
