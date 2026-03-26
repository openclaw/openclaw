import { beforeEach, describe, expect, it } from "vitest";
import {
  buildPluginInspectReport,
  buildPluginStatusReport,
  inspectChatgptApps,
  resetPluginsCliTestState,
  runPluginsCommand,
} from "./plugins-cli-test-helpers.js";

function createInspectReport() {
  return {
    plugin: {
      id: "openai",
      name: "OpenAI",
      description: "OpenAI provider runtime",
      source: "/tmp/openai-plugin",
      origin: "bundled",
      status: "loaded",
      format: "openclaw",
      version: "1.0.0",
    },
    shape: "plain-capability",
    capabilityMode: "runtime",
    usesLegacyBeforeAgentStart: false,
    bundleCapabilities: [],
    capabilities: [],
    typedHooks: [],
    compatibility: [],
    customHooks: [],
    tools: [],
    commands: [],
    cliCommands: [],
    services: [],
    gatewayMethods: [],
    mcpServers: [],
    lspServers: [],
    httpRouteCount: 0,
    policy: {
      allowPromptInjection: undefined,
      allowModelOverride: undefined,
      hasAllowedModelsConfig: false,
      allowedModels: [],
    },
    diagnostics: [],
  };
}

function createChatgptAppsInspection() {
  return {
    diagnostics: [
      {
        scope: "sidecar",
        status: "ok",
        message: "Codex app-server sidecar started successfully.",
      },
    ],
    enabled: true,
    layout: {
      sessionKey: "/tmp/openai-chatgpt-apps/session",
      sandboxDir: "/tmp/openai-chatgpt-apps",
      configFilePath: "/tmp/openai-chatgpt-apps/config.toml",
    },
    config: {
      chatgptBaseUrl: "https://chatgpt.com",
      appServer: {
        command: "codex",
        args: [],
      },
      connectors: [],
    },
    sidecar: {
      status: "ready",
      message: null,
    },
    auth: {
      status: "ready",
      message: null,
      accountId: "acct-123",
      email: "owner@example.com",
      profileName: "owner@example.com",
      projectedEmail: "owner@example.com",
      planType: "plus",
      requiresOpenaiAuth: false,
    },
    inventory: {
      status: "ready",
      message: null,
      total: 0,
      accessible: 0,
      enabled: 0,
      source: "rpc",
      updatedAt: null,
      apps: [],
    },
    mcpServers: {
      status: "ready",
      message: null,
      servers: [],
    },
  };
}

describe("plugins cli inspect", () => {
  beforeEach(() => {
    resetPluginsCliTestState();
    buildPluginStatusReport.mockReturnValue({
      workspaceDir: "/tmp/openclaw-workspace",
      plugins: [
        {
          id: "openai",
          name: "OpenAI",
          description: "OpenAI provider runtime",
          source: "/tmp/openai-plugin",
          origin: "bundled",
          status: "loaded",
          format: "openclaw",
          providerIds: [],
        },
      ],
      diagnostics: [],
    });
    buildPluginInspectReport.mockReturnValue(createInspectReport());
    inspectChatgptApps.mockResolvedValue(createChatgptAppsInspection());
  });

  it("uses cached inventory by default when inspecting the OpenAI plugin", async () => {
    await runPluginsCommand(["plugins", "inspect", "openai"]);

    expect(inspectChatgptApps).toHaveBeenCalledWith(
      expect.objectContaining({
        forceRefetch: false,
        workspaceDir: "/tmp/openclaw-workspace",
      }),
    );
  });

  it("forwards --hard-refresh to the OpenAI ChatGPT apps inspection", async () => {
    await runPluginsCommand(["plugins", "inspect", "openai", "--hard-refresh"]);

    expect(inspectChatgptApps).toHaveBeenCalledWith(
      expect.objectContaining({
        forceRefetch: true,
        workspaceDir: "/tmp/openclaw-workspace",
      }),
    );
  });
});
