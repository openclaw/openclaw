import { beforeEach, describe, expect, it, vi } from "vitest";

const loadConfigMock = vi.fn();
const loadOpenClawPluginsMock = vi.fn();
let buildPluginStatusReport: typeof import("./status.js").buildPluginStatusReport;
let buildPluginInspectReport: typeof import("./status.js").buildPluginInspectReport;
let buildAllPluginInspectReports: typeof import("./status.js").buildAllPluginInspectReports;
let buildPluginCompatibilityNotices: typeof import("./status.js").buildPluginCompatibilityNotices;
let buildPluginCompatibilityWarnings: typeof import("./status.js").buildPluginCompatibilityWarnings;

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
      diagnostics: [{ level: "warn", pluginId: "google", message: "watch this seam" }],
      channels: [],
      channelSetups: [],
      providers: [],
      speechProviders: [],
      mediaUnderstandingProviders: [],
      imageGenerationProviders: [],
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
          "still relies on legacy before_agent_start; keep upgrade coverage on this plugin and prefer before_model_resolve/before_prompt_build for new work.",
      },
    ]);
    expect(inspect?.policy).toEqual({
      allowPromptInjection: false,
      allowModelOverride: true,
      allowedModels: ["openai/gpt-5.4"],
      hasAllowedModelsConfig: true,
    });
    expect(inspect?.diagnostics).toEqual([
      { level: "warn", pluginId: "google", message: "watch this seam" },
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
      "lca still relies on legacy before_agent_start; keep upgrade coverage on this plugin and prefer before_model_resolve/before_prompt_build for new work.",
      "lca is hook-only; this remains supported for compatibility, but it has not migrated to explicit capability registration.",
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
          "is hook-only; this remains supported for compatibility, but it has not migrated to explicit capability registration.",
      },
      {
        pluginId: "legacy-only",
        code: "legacy-before-agent-start",
        severity: "warn",
        message:
          "still relies on legacy before_agent_start; keep upgrade coverage on this plugin and prefer before_model_resolve/before_prompt_build for new work.",
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
});
