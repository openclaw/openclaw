import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runRegisteredCli } from "../test-utils/command-runner.js";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({})),
  buildPluginStatusReport: vi.fn(() => ({
    plugins: [],
    diagnostics: [],
    hooks: [],
    typedHooks: [],
  })),
  buildPluginInspectReport: vi.fn(),
  buildAllPluginInspectReports: vi.fn(() => []),
  buildPluginCompatibilityNotices: vi.fn(() => []),
  defaultRuntime: {
    log: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../config/config.js", () => ({
  loadConfig: mocks.loadConfig,
  writeConfigFile: vi.fn(),
}));

vi.mock("../plugins/status.js", () => ({
  buildPluginStatusReport: mocks.buildPluginStatusReport,
  buildPluginInspectReport: mocks.buildPluginInspectReport,
  buildAllPluginInspectReports: mocks.buildAllPluginInspectReports,
  buildPluginCompatibilityNotices: mocks.buildPluginCompatibilityNotices,
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: mocks.defaultRuntime,
}));

let registerPluginsCli: typeof import("./plugins-cli.js").registerPluginsCli;

beforeAll(async () => {
  ({ registerPluginsCli } = await import("./plugins-cli.js"));
});

describe("plugins cli", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadConfig.mockReturnValue({});
    mocks.buildPluginStatusReport.mockReturnValue({
      plugins: [],
      diagnostics: [],
      hooks: [],
      typedHooks: [],
    });
    mocks.buildPluginInspectReport.mockReset();
    mocks.buildAllPluginInspectReports.mockReturnValue([]);
    mocks.buildPluginCompatibilityNotices.mockReturnValue([]);
  });

  it("renders compatibility warnings in plugins inspect output", async () => {
    mocks.buildPluginStatusReport.mockReturnValue({
      plugins: [
        {
          id: "legacy-plugin",
          name: "Legacy Plugin",
          description: "legacy seam",
          source: "/tmp/legacy.ts",
          origin: "workspace",
          enabled: true,
          status: "loaded",
          format: "openclaw",
          bundleFormat: undefined,
          version: "1.0.0",
          bundleCapabilities: [],
        },
      ],
      diagnostics: [],
      hooks: [],
      typedHooks: [],
    });
    mocks.buildPluginInspectReport.mockReturnValue({
      plugin: {
        id: "legacy-plugin",
        name: "Legacy Plugin",
        description: "legacy seam",
        source: "/tmp/legacy.ts",
        origin: "workspace",
        status: "loaded",
        format: "openclaw",
        bundleFormat: undefined,
        version: "1.0.0",
        bundleCapabilities: [],
      },
      shape: "hook-only",
      capabilityMode: "none",
      capabilityCount: 0,
      capabilities: [],
      typedHooks: [{ name: "before_agent_start" }],
      customHooks: [],
      tools: [],
      commands: [],
      cliCommands: [],
      services: [],
      gatewayMethods: [],
      httpRouteCount: 0,
      diagnostics: [],
      policy: {
        allowPromptInjection: undefined,
        allowModelOverride: undefined,
        allowedModels: [],
        hasAllowedModelsConfig: false,
      },
      usesLegacyBeforeAgentStart: true,
      compatibility: [
        {
          pluginId: "legacy-plugin",
          code: "legacy-before-agent-start",
          severity: "warn",
          message:
            "still relies on legacy before_agent_start; keep upgrade coverage on this plugin and prefer before_model_resolve/before_prompt_build for new work.",
        },
        {
          pluginId: "legacy-plugin",
          code: "hook-only",
          severity: "info",
          message:
            "is hook-only; this remains supported for compatibility, but it has not migrated to explicit capability registration.",
        },
      ],
    });

    await runRegisteredCli({
      register: registerPluginsCli as (program: import("commander").Command) => void,
      argv: ["plugins", "inspect", "legacy-plugin"],
    });

    const output = mocks.defaultRuntime.log.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("Compatibility warnings");
    expect(output).toContain("legacy-plugin still relies on legacy before_agent_start");
    expect(output).toContain("legacy-plugin is hook-only");
  });

  it("renders compatibility notices in plugins doctor", async () => {
    mocks.buildPluginStatusReport.mockReturnValue({
      plugins: [],
      diagnostics: [],
      hooks: [],
      typedHooks: [],
    });
    mocks.buildPluginCompatibilityNotices.mockReturnValue([
      {
        pluginId: "legacy-plugin",
        code: "legacy-before-agent-start",
        severity: "warn",
        message:
          "still relies on legacy before_agent_start; keep upgrade coverage on this plugin and prefer before_model_resolve/before_prompt_build for new work.",
      },
    ]);

    await runRegisteredCli({
      register: registerPluginsCli as (program: import("commander").Command) => void,
      argv: ["plugins", "doctor"],
    });

    const output = mocks.defaultRuntime.log.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("Compatibility:");
    expect(output).toContain("legacy-plugin");
    expect(output).toContain("still relies on legacy before_agent_start");
  });
});
