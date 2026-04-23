import { beforeEach, describe, expect, it, vi } from "vitest";

const callOrder: string[] = [];

const installBundledRuntimeDeps = vi.fn(() => {
  callOrder.push("repair");
});
const scanBundledPluginRuntimeDeps = vi.fn(() => ({
  deps: [
    {
      name: "@larksuiteoapi/node-sdk",
      version: "1.41.0",
      pluginIds: ["feishu"],
    },
  ],
  missing: [
    {
      name: "@larksuiteoapi/node-sdk",
      version: "1.41.0",
      pluginIds: ["feishu"],
    },
  ],
  conflicts: [],
}));
const runChannelPluginStartupMaintenance = vi.fn(async () => {
  callOrder.push("maintenance");
});
const runStartupSessionMigration = vi.fn(async () => {
  callOrder.push("migration");
});
const loadGatewayStartupPlugins = vi.fn(() => {
  callOrder.push("plugins");
  return {
    pluginRegistry: { diagnostics: [] },
    gatewayMethods: ["chat.send"],
  };
});

vi.mock("../agents/agent-scope.js", () => ({
  resolveDefaultAgentId: vi.fn(() => "main"),
  resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace"),
}));

vi.mock("../agents/subagent-registry.js", () => ({
  initSubagentRegistry: vi.fn(() => {
    callOrder.push("init");
  }),
}));

vi.mock("../channels/plugins/lifecycle-startup.js", () => ({
  runChannelPluginStartupMaintenance,
}));

vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: vi.fn(({ config }) => ({ config, changes: [] })),
}));

vi.mock("../infra/openclaw-root.js", () => ({
  resolveOpenClawPackageRootSync: vi.fn(() => "/opt/openclaw"),
}));

vi.mock("../plugins/bundled-runtime-deps.js", () => ({
  installBundledRuntimeDeps,
  resolveBundledRuntimeDependencyPackageInstallRoot: vi.fn(() => "/opt/openclaw"),
  scanBundledPluginRuntimeDeps,
}));

vi.mock("../plugins/channel-plugin-ids.js", () => ({
  resolveConfiguredDeferredChannelPluginIds: vi.fn(() => []),
  resolveGatewayStartupPluginIds: vi.fn(() => ["feishu"]),
}));

vi.mock("../plugins/registry.js", () => ({
  createEmptyPluginRegistry: vi.fn(() => ({ diagnostics: [] })),
}));

vi.mock("../plugins/runtime.js", () => ({
  getActivePluginRegistry: vi.fn(() => null),
  setActivePluginRegistry: vi.fn(),
}));

vi.mock("./server-methods-list.js", () => ({
  listGatewayMethods: vi.fn(() => ["chat.send"]),
}));

vi.mock("./server-methods.js", () => ({
  coreGatewayHandlers: {},
}));

vi.mock("./server-plugin-bootstrap.js", () => ({
  loadGatewayStartupPlugins,
}));

vi.mock("./server-startup-session-migration.js", () => ({
  runStartupSessionMigration,
}));

describe("gateway startup plugin bootstrap", () => {
  beforeEach(() => {
    callOrder.length = 0;
    installBundledRuntimeDeps.mockClear();
    scanBundledPluginRuntimeDeps.mockReset();
    scanBundledPluginRuntimeDeps.mockReturnValue({
      deps: [
        {
          name: "@larksuiteoapi/node-sdk",
          version: "1.41.0",
          pluginIds: ["feishu"],
        },
      ],
      missing: [
        {
          name: "@larksuiteoapi/node-sdk",
          version: "1.41.0",
          pluginIds: ["feishu"],
        },
      ],
      conflicts: [],
    });
    runChannelPluginStartupMaintenance.mockClear();
    runStartupSessionMigration.mockClear();
    loadGatewayStartupPlugins.mockClear();
  });

  it("repairs bundled runtime deps before startup plugin maintenance and loading", async () => {
    const { prepareGatewayPluginBootstrap } = await import("./server-startup-plugins.js");

    await prepareGatewayPluginBootstrap({
      cfgAtStart: {
        channels: {
          feishu: {
            appId: "cli-app",
          },
        },
      },
      startupRuntimeConfig: {
        channels: {
          feishu: {
            appId: "cli-app",
          },
        },
      },
      minimalTestGateway: false,
      log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
    });

    expect(callOrder).toContain("repair");
    expect(callOrder.indexOf("repair")).toBeLessThan(callOrder.indexOf("maintenance"));
    expect(callOrder.indexOf("repair")).toBeLessThan(callOrder.indexOf("migration"));
    expect(callOrder.indexOf("repair")).toBeLessThan(callOrder.indexOf("plugins"));
    expect(installBundledRuntimeDeps).toHaveBeenCalledWith({
      installRoot: "/opt/openclaw",
      missingSpecs: ["@larksuiteoapi/node-sdk@1.41.0"],
      env: process.env,
    });
  });

  it("installs only the missing bundled runtime deps during gateway startup preflight", async () => {
    scanBundledPluginRuntimeDeps.mockReturnValue({
      deps: [
        {
          name: "@larksuiteoapi/node-sdk",
          version: "1.41.0",
          pluginIds: ["feishu"],
        },
        {
          name: "@slack/web-api",
          version: "7.11.0",
          pluginIds: ["slack"],
        },
      ],
      missing: [
        {
          name: "@larksuiteoapi/node-sdk",
          version: "1.41.0",
          pluginIds: ["feishu"],
        },
      ],
      conflicts: [],
    });
    const { prepareGatewayPluginBootstrap } = await import("./server-startup-plugins.js");

    await prepareGatewayPluginBootstrap({
      cfgAtStart: {
        channels: {
          feishu: {
            appId: "cli-app",
          },
          slack: {
            botToken: "xoxb-test",
          },
        },
      },
      startupRuntimeConfig: {
        channels: {
          feishu: {
            appId: "cli-app",
          },
          slack: {
            botToken: "xoxb-test",
          },
        },
      },
      minimalTestGateway: false,
      log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
    });

    expect(installBundledRuntimeDeps).toHaveBeenCalledWith({
      installRoot: "/opt/openclaw",
      missingSpecs: ["@larksuiteoapi/node-sdk@1.41.0"],
      env: process.env,
    });
  });

  it("warns and continues when bundled runtime dep scan fails during startup preflight", async () => {
    scanBundledPluginRuntimeDeps.mockImplementation(() => {
      throw new Error("unsupported spec");
    });
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const { prepareGatewayPluginBootstrap } = await import("./server-startup-plugins.js");

    await prepareGatewayPluginBootstrap({
      cfgAtStart: {
        channels: {
          feishu: {
            appId: "cli-app",
          },
        },
      },
      startupRuntimeConfig: {
        channels: {
          feishu: {
            appId: "cli-app",
          },
        },
      },
      minimalTestGateway: false,
      log,
    });

    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "gateway: unable to scan bundled plugin runtime deps during startup preflight; continuing without repair",
      ),
    );
    expect(callOrder).toContain("maintenance");
    expect(callOrder).toContain("migration");
    expect(callOrder).toContain("plugins");
    expect(installBundledRuntimeDeps).not.toHaveBeenCalled();
  });

  it("warns and continues when bundled runtime dep install fails during startup preflight", async () => {
    installBundledRuntimeDeps.mockImplementation(() => {
      throw new Error("unwritable stage dir");
    });
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const { prepareGatewayPluginBootstrap } = await import("./server-startup-plugins.js");

    await prepareGatewayPluginBootstrap({
      cfgAtStart: {
        channels: {
          feishu: {
            appId: "cli-app",
          },
        },
      },
      startupRuntimeConfig: {
        channels: {
          feishu: {
            appId: "cli-app",
          },
        },
      },
      minimalTestGateway: false,
      log,
    });

    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "gateway: unable to install bundled plugin runtime deps during startup preflight; continuing without repair",
      ),
    );
    expect(callOrder).toContain("maintenance");
    expect(callOrder).toContain("migration");
    expect(callOrder).toContain("plugins");
  });
});
