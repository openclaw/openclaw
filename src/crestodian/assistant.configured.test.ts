// Configured Crestodian assistant tests cover route-owned, tool-free planning.
import { describe, expect, it, vi } from "vitest";
import type { RunCliAgentParams } from "../agents/cli-runner/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { planCrestodianCommandWithConfiguredModel } from "./assistant.js";
import type { CrestodianOverview } from "./overview.js";

function overview(defaultModel?: string): CrestodianOverview {
  return {
    config: {
      path: "/tmp/openclaw.json",
      exists: true,
      valid: true,
      issues: [],
      hash: "hash",
    },
    agents: [],
    defaultAgentId: "main",
    ...(defaultModel ? { defaultModel } : {}),
    tools: {
      codex: { command: "codex", found: false },
      claude: { command: "claude", found: false },
      gemini: { command: "gemini", found: false },
      apiKeys: { openai: false, anthropic: false },
    },
    gateway: { url: "ws://127.0.0.1:18789", source: "local loopback", reachable: false },
    references: {
      docsUrl: "https://docs.openclaw.ai",
      sourceUrl: "https://github.com/openclaw/openclaw",
    },
  };
}

function snapshot(config: OpenClawConfig) {
  return {
    path: "/tmp/openclaw.json",
    exists: true,
    valid: true,
    hash: "hash",
    config,
    runtimeConfig: config,
    sourceConfig: config,
    issues: [],
  };
}

describe("Crestodian configured-model planner", () => {
  it("skips planning when no config file exists", async () => {
    const runCliAgent = vi.fn();
    const runEmbeddedAgent = vi.fn();

    await expect(
      planCrestodianCommandWithConfiguredModel({
        input: "please set up my model",
        overview: overview(),
        deps: {
          readConfigFileSnapshot: vi.fn(async () => ({
            ...snapshot({}),
            exists: false,
          })) as never,
          runCliAgent,
          runEmbeddedAgent,
        },
      }),
    ).resolves.toBeNull();

    expect(runCliAgent).not.toHaveBeenCalled();
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
  });

  it("plans through the configured default agent CLI route with native tools disabled", async () => {
    const config: OpenClawConfig = {
      agents: {
        defaults: { cliBackends: { "claude-cli": { command: "claude" } } },
        list: [
          {
            id: "ops",
            default: true,
            agentDir: "/tmp/ops-agent",
            model: "claude-cli/claude-opus-4-8@claude-cli:ops",
          },
        ],
      },
    };
    const runCliAgent = vi.fn(async (_params: RunCliAgentParams) => ({
      meta: {
        finalAssistantVisibleText:
          '{"reply":"I can do that.","command":"setup workspace /tmp/work"}',
      },
    }));
    const removeTempDir = vi.fn(async () => {});

    const result = await planCrestodianCommandWithConfiguredModel({
      input: "please finish setup",
      overview: overview("claude-cli/claude-opus-4-8"),
      deps: {
        readConfigFileSnapshot: vi.fn(async () => snapshot(config)) as never,
        runCliAgent: runCliAgent as never,
        runEmbeddedAgent: vi.fn() as never,
        createTempDir: async () => "/tmp/crestodian-planner",
        removeTempDir,
      },
    });

    expect(result).toEqual({
      reply: "I can do that.",
      command: "setup workspace /tmp/work",
      modelLabel: "claude-cli/claude-opus-4-8",
    });
    expect(runCliAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "claude-cli",
        model: "claude-opus-4-8",
        agentDir: "/tmp/ops-agent",
        authProfileId: "claude-cli:ops",
        executionMode: "side-question",
        disableTools: true,
        workspaceDir: "/tmp/crestodian-planner",
        cwd: "/tmp/crestodian-planner",
        cleanupCliLiveSessionOnRunEnd: true,
      }),
    );
    expect(runCliAgent.mock.calls[0]?.[0]?.toolsAllow).toBeUndefined();
    expect(removeTempDir).toHaveBeenCalledWith("/tmp/crestodian-planner");
  });

  it("plans through the configured default agent embedded runtime without tools", async () => {
    const config: OpenClawConfig = {
      agents: {
        list: [
          {
            id: "ops",
            default: true,
            agentDir: "/tmp/ops-agent",
            model: "openai/gpt-5.4@openai:ops",
            models: { "openai/gpt-5.4": { agentRuntime: { id: "codex" } } },
          },
        ],
      },
    };
    const runEmbeddedAgent = vi.fn(async () => ({
      payloads: [{ text: '{"reply":"Ready.","command":"gateway status"}' }],
    }));

    const result = await planCrestodianCommandWithConfiguredModel({
      input: "is the gateway healthy",
      overview: overview("openai/gpt-5.4"),
      deps: {
        readConfigFileSnapshot: vi.fn(async () => snapshot(config)) as never,
        runCliAgent: vi.fn() as never,
        runEmbeddedAgent: runEmbeddedAgent as never,
        createTempDir: async () => "/tmp/crestodian-planner",
        removeTempDir: async () => {},
      },
    });

    expect(result).toEqual({
      reply: "Ready.",
      command: "gateway status",
      modelLabel: "openai/gpt-5.4",
    });
    expect(runEmbeddedAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        model: "gpt-5.4",
        agentDir: "/tmp/ops-agent",
        authProfileId: "openai:ops",
        authProfileIdSource: "user",
        agentHarnessRuntimeOverride: "codex",
        disableTools: true,
        toolsAllow: [],
      }),
    );
  });
});
