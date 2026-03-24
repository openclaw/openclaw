import { beforeEach, describe, expect, it, vi } from "vitest";

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

describe("buildPluginStatusReport", () => {
  beforeEach(async () => {
    vi.resetModules();
    loadConfigMock.mockReset();
    loadOpenClawPluginsMock.mockReset();
    loadConfigMock.mockReturnValue({});
    loadOpenClawPluginsMock.mockReturnValue({
      plugins: [],
      diagnostics: [],
      channels: [],
      providers: [],
      speechProviders: [],
      mediaUnderstandingProviders: [],
      imageGenerationProviders: [],
      videoGenerationProviders: [],
      webSearchProviders: [],
      tools: [],
      hooks: [],
      typedHooks: [],
      channelSetups: [],
      httpRoutes: [],
      gatewayHandlers: {},
      cliRegistrars: [],
      services: [],
      commands: [],
    });
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
    loadOpenClawPluginsMock.mockReturnValue({
      plugins: [
        {
          id: "whatsapp",
          name: "WhatsApp",
          description: "Bundled channel plugin",
          version: "2026.3.22",
          source: "/tmp/whatsapp/index.ts",
          origin: "bundled",
          enabled: true,
          status: "loaded",
          toolNames: [],
          hookNames: [],
          channelIds: ["whatsapp"],
          providerIds: [],
          speechProviderIds: [],
          mediaUnderstandingProviderIds: [],
          imageGenerationProviderIds: [],
          videoGenerationProviderIds: [],
          webSearchProviderIds: [],
          gatewayMethods: [],
          cliCommands: [],
          services: [],
          commands: [],
          httpRoutes: 0,
          hookCount: 0,
          configSchema: false,
        },
      ],
      diagnostics: [],
      channels: [],
      providers: [],
      speechProviders: [],
      mediaUnderstandingProviders: [],
      imageGenerationProviders: [],
      videoGenerationProviders: [],
      webSearchProviders: [],
      tools: [],
      hooks: [],
      typedHooks: [],
      channelSetups: [],
      httpRoutes: [],
      gatewayHandlers: {},
      cliRegistrars: [],
      services: [],
      commands: [],
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
    loadOpenClawPluginsMock.mockReturnValue({
      plugins: [
        {
          id: "google",
          name: "Google",
          description: "Google provider plugin",
          source: "/tmp/google/index.ts",
          origin: "bundled",
          enabled: true,
          status: "loaded",
          toolNames: [],
          hookNames: [],
          channelIds: [],
          providerIds: ["google"],
          speechProviderIds: [],
          mediaUnderstandingProviderIds: ["google"],
          imageGenerationProviderIds: ["google"],
          videoGenerationProviderIds: [],
          webSearchProviderIds: ["google"],
          gatewayMethods: [],
          cliCommands: [],
          services: [],
          commands: [],
          httpRoutes: 0,
          hookCount: 0,
          configSchema: false,
        },
      ],
      diagnostics: [{ level: "warn", pluginId: "google", message: "watch this surface" }],
      channels: [],
      channelSetups: [],
      providers: [],
      speechProviders: [],
      mediaUnderstandingProviders: [],
      imageGenerationProviders: [],
      videoGenerationProviders: [],
      webSearchProviders: [],
      tools: [],
      hooks: [],
      typedHooks: [
        {
          pluginId: "google",
          hookName: "before_agent_start",
          handler: () => undefined,
          source: "/tmp/google/index.ts",
        },
      ],
      httpRoutes: [],
      gatewayHandlers: {},
      cliRegistrars: [],
      services: [],
      commands: [],
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
      {
        pluginId: "google",
        code: "legacy-before-agent-start",
        severity: "warn",
        message:
          "still uses legacy before_agent_start; keep regression coverage on this plugin, and prefer before_model_resolve/before_prompt_build for new work.",
      },
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
    loadOpenClawPluginsMock.mockReturnValue({
      plugins: [
        {
          id: "lca",
          name: "LCA",
          description: "Legacy hook plugin",
          source: "/tmp/lca/index.ts",
          origin: "workspace",
          enabled: true,
          status: "loaded",
          toolNames: [],
          hookNames: [],
          channelIds: [],
          providerIds: [],
          speechProviderIds: [],
          mediaUnderstandingProviderIds: [],
          imageGenerationProviderIds: [],
          videoGenerationProviderIds: [],
          webSearchProviderIds: [],
          gatewayMethods: [],
          cliCommands: [],
          services: [],
          commands: [],
          httpRoutes: 0,
          hookCount: 1,
          configSchema: false,
        },
        {
          id: "microsoft",
          name: "Microsoft",
          description: "Hybrid capability plugin",
          source: "/tmp/microsoft/index.ts",
          origin: "bundled",
          enabled: true,
          status: "loaded",
          toolNames: [],
          hookNames: [],
          channelIds: [],
          providerIds: ["microsoft"],
          speechProviderIds: [],
          mediaUnderstandingProviderIds: [],
          imageGenerationProviderIds: [],
          videoGenerationProviderIds: [],
          webSearchProviderIds: ["microsoft"],
          gatewayMethods: [],
          cliCommands: [],
          services: [],
          commands: [],
          httpRoutes: 0,
          hookCount: 0,
          configSchema: false,
        },
      ],
      diagnostics: [],
      channels: [],
      channelSetups: [],
      providers: [],
      speechProviders: [],
      mediaUnderstandingProviders: [],
      imageGenerationProviders: [],
      videoGenerationProviders: [],
      webSearchProviders: [],
      tools: [],
      hooks: [
        {
          pluginId: "lca",
          events: ["message"],
          entry: {
            hook: {
              name: "legacy",
              handler: () => undefined,
            },
          },
        },
      ],
      typedHooks: [
        {
          pluginId: "lca",
          hookName: "before_agent_start",
          handler: () => undefined,
          source: "/tmp/lca/index.ts",
        },
      ],
      httpRoutes: [],
      gatewayHandlers: {},
      cliRegistrars: [],
      services: [],
      commands: [],
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
    loadOpenClawPluginsMock.mockReturnValue({
      plugins: [
        {
          id: "lca",
          name: "LCA",
          description: "Legacy hook plugin",
          source: "/tmp/lca/index.ts",
          origin: "workspace",
          enabled: true,
          status: "loaded",
          toolNames: [],
          hookNames: [],
          channelIds: [],
          providerIds: [],
          speechProviderIds: [],
          mediaUnderstandingProviderIds: [],
          imageGenerationProviderIds: [],
          videoGenerationProviderIds: [],
          webSearchProviderIds: [],
          gatewayMethods: [],
          cliCommands: [],
          services: [],
          commands: [],
          httpRoutes: 0,
          hookCount: 1,
          configSchema: false,
        },
      ],
      diagnostics: [],
      channels: [],
      channelSetups: [],
      providers: [],
      speechProviders: [],
      mediaUnderstandingProviders: [],
      imageGenerationProviders: [],
      videoGenerationProviders: [],
      webSearchProviders: [],
      tools: [],
      hooks: [],
      typedHooks: [
        {
          pluginId: "lca",
          hookName: "before_agent_start",
          handler: () => undefined,
          source: "/tmp/lca/index.ts",
        },
      ],
      httpRoutes: [],
      gatewayHandlers: {},
      cliRegistrars: [],
      services: [],
      commands: [],
    });

    expect(buildPluginCompatibilityWarnings()).toEqual([
      "lca still uses legacy before_agent_start; keep regression coverage on this plugin, and prefer before_model_resolve/before_prompt_build for new work.",
      "lca is hook-only. This remains a supported compatibility path, but it has not migrated to explicit capability registration yet.",
    ]);
  });

  it("builds structured compatibility notices with deterministic ordering", () => {
    loadOpenClawPluginsMock.mockReturnValue({
      plugins: [
        {
          id: "hook-only",
          name: "Hook Only",
          description: "",
          source: "/tmp/hook-only/index.ts",
          origin: "workspace",
          enabled: true,
          status: "loaded",
          toolNames: [],
          hookNames: [],
          channelIds: [],
          providerIds: [],
          speechProviderIds: [],
          mediaUnderstandingProviderIds: [],
          imageGenerationProviderIds: [],
          videoGenerationProviderIds: [],
          webSearchProviderIds: [],
          gatewayMethods: [],
          cliCommands: [],
          services: [],
          commands: [],
          httpRoutes: 0,
          hookCount: 1,
          configSchema: false,
        },
        {
          id: "legacy-only",
          name: "Legacy Only",
          description: "",
          source: "/tmp/legacy-only/index.ts",
          origin: "workspace",
          enabled: true,
          status: "loaded",
          toolNames: [],
          hookNames: [],
          channelIds: [],
          providerIds: ["legacy-only"],
          speechProviderIds: [],
          mediaUnderstandingProviderIds: [],
          imageGenerationProviderIds: [],
          videoGenerationProviderIds: [],
          webSearchProviderIds: [],
          gatewayMethods: [],
          cliCommands: [],
          services: [],
          commands: [],
          httpRoutes: 0,
          hookCount: 1,
          configSchema: false,
        },
      ],
      diagnostics: [],
      channels: [],
      channelSetups: [],
      providers: [],
      speechProviders: [],
      mediaUnderstandingProviders: [],
      imageGenerationProviders: [],
      videoGenerationProviders: [],
      webSearchProviders: [],
      tools: [],
      hooks: [
        {
          pluginId: "hook-only",
          events: ["message"],
          entry: {
            hook: {
              name: "legacy",
              handler: () => undefined,
            },
          },
        },
      ],
      typedHooks: [
        {
          pluginId: "legacy-only",
          hookName: "before_agent_start",
          handler: () => undefined,
          source: "/tmp/legacy-only/index.ts",
        },
      ],
      httpRoutes: [],
      gatewayHandlers: {},
      cliRegistrars: [],
      services: [],
      commands: [],
    });

    expect(buildPluginCompatibilityNotices()).toEqual([
      {
        pluginId: "hook-only",
        code: "hook-only",
        severity: "info",
        message:
          "is hook-only. This remains a supported compatibility path, but it has not migrated to explicit capability registration yet.",
      },
      {
        pluginId: "legacy-only",
        code: "legacy-before-agent-start",
        severity: "warn",
        message:
          "still uses legacy before_agent_start; keep regression coverage on this plugin, and prefer before_model_resolve/before_prompt_build for new work.",
      },
    ]);
  });

  it("returns no compatibility warnings for modern capability plugins", () => {
    loadOpenClawPluginsMock.mockReturnValue({
      plugins: [
        {
          id: "modern",
          name: "Modern",
          description: "",
          source: "/tmp/modern/index.ts",
          origin: "workspace",
          enabled: true,
          status: "loaded",
          toolNames: [],
          hookNames: [],
          channelIds: [],
          providerIds: ["modern"],
          speechProviderIds: [],
          mediaUnderstandingProviderIds: [],
          imageGenerationProviderIds: [],
          videoGenerationProviderIds: [],
          webSearchProviderIds: [],
          gatewayMethods: [],
          cliCommands: [],
          services: [],
          commands: [],
          httpRoutes: 0,
          hookCount: 0,
          configSchema: false,
        },
      ],
      diagnostics: [],
      channels: [],
      channelSetups: [],
      providers: [],
      speechProviders: [],
      mediaUnderstandingProviders: [],
      imageGenerationProviders: [],
      videoGenerationProviders: [],
      webSearchProviders: [],
      tools: [],
      hooks: [],
      typedHooks: [],
      httpRoutes: [],
      gatewayHandlers: {},
      cliRegistrars: [],
      services: [],
      commands: [],
    });

    expect(buildPluginCompatibilityNotices()).toEqual([]);
    expect(buildPluginCompatibilityWarnings()).toEqual([]);
  });

  it("populates bundleCapabilities from plugin record", () => {
    loadOpenClawPluginsMock.mockReturnValue({
      plugins: [
        {
          id: "claude-bundle",
          name: "Claude Bundle",
          description: "A bundle plugin with skills and commands",
          source: "/tmp/claude-bundle/.claude-plugin/plugin.json",
          origin: "workspace",
          enabled: true,
          status: "loaded",
          format: "bundle",
          bundleFormat: "claude",
          bundleCapabilities: ["skills", "commands", "agents", "settings"],
          rootDir: "/tmp/claude-bundle",
          toolNames: [],
          hookNames: [],
          channelIds: [],
          providerIds: [],
          speechProviderIds: [],
          mediaUnderstandingProviderIds: [],
          imageGenerationProviderIds: [],
          videoGenerationProviderIds: [],
          webSearchProviderIds: [],
          gatewayMethods: [],
          cliCommands: [],
          services: [],
          commands: [],
          httpRoutes: 0,
          hookCount: 0,
          configSchema: false,
        },
      ],
      diagnostics: [],
      channels: [],
      channelSetups: [],
      providers: [],
      speechProviders: [],
      mediaUnderstandingProviders: [],
      imageGenerationProviders: [],
      videoGenerationProviders: [],
      webSearchProviders: [],
      tools: [],
      hooks: [],
      typedHooks: [],
      httpRoutes: [],
      gatewayHandlers: {},
      cliRegistrars: [],
      services: [],
      commands: [],
    });

    const inspect = buildPluginInspectReport({ id: "claude-bundle" });

    expect(inspect).not.toBeNull();
    expect(inspect?.bundleCapabilities).toEqual(["skills", "commands", "agents", "settings"]);
    expect(inspect?.mcpServers).toEqual([]);
    expect(inspect?.shape).toBe("non-capability");
  });

  it("returns empty bundleCapabilities and mcpServers for non-bundle plugins", () => {
    loadOpenClawPluginsMock.mockReturnValue({
      plugins: [
        {
          id: "plain-plugin",
          name: "Plain Plugin",
          description: "A regular plugin",
          source: "/tmp/plain-plugin/index.ts",
          origin: "workspace",
          enabled: true,
          status: "loaded",
          toolNames: [],
          hookNames: [],
          channelIds: [],
          providerIds: ["plain"],
          speechProviderIds: [],
          mediaUnderstandingProviderIds: [],
          imageGenerationProviderIds: [],
          videoGenerationProviderIds: [],
          webSearchProviderIds: [],
          gatewayMethods: [],
          cliCommands: [],
          services: [],
          commands: [],
          httpRoutes: 0,
          hookCount: 0,
          configSchema: false,
        },
      ],
      diagnostics: [],
      channels: [],
      channelSetups: [],
      providers: [],
      speechProviders: [],
      mediaUnderstandingProviders: [],
      imageGenerationProviders: [],
      videoGenerationProviders: [],
      webSearchProviders: [],
      tools: [],
      hooks: [],
      typedHooks: [],
      httpRoutes: [],
      gatewayHandlers: {},
      cliRegistrars: [],
      services: [],
      commands: [],
    });

    const inspect = buildPluginInspectReport({ id: "plain-plugin" });

    expect(inspect).not.toBeNull();
    expect(inspect?.bundleCapabilities).toEqual([]);
    expect(inspect?.mcpServers).toEqual([]);
  });

  it("formats and summarizes compatibility notices", () => {
    const notice = {
      pluginId: "legacy-plugin",
      code: "legacy-before-agent-start" as const,
      severity: "warn" as const,
      message:
        "still uses legacy before_agent_start; keep regression coverage on this plugin, and prefer before_model_resolve/before_prompt_build for new work.",
    };

    expect(formatPluginCompatibilityNotice(notice)).toBe(
      "legacy-plugin still uses legacy before_agent_start; keep regression coverage on this plugin, and prefer before_model_resolve/before_prompt_build for new work.",
    );
    expect(
      summarizePluginCompatibility([
        notice,
        {
          pluginId: "legacy-plugin",
          code: "hook-only",
          severity: "info",
          message:
            "is hook-only. This remains a supported compatibility path, but it has not migrated to explicit capability registration yet.",
        },
      ]),
    ).toEqual({
      noticeCount: 2,
      pluginCount: 1,
    });
  });
});
