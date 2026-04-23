import { beforeEach, describe, expect, it, vi } from "vitest";

const callOrder: string[] = [];

const installBundledRuntimeDeps = vi.fn(() => {
  callOrder.push("repair");
});
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
  scanBundledPluginRuntimeDeps: vi.fn(() => ({
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
  })),
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
});
