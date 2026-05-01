import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";

function createTool(name: string) {
  return {
    name,
    label: name,
    description: `${name} tool`,
    parameters: {
      type: "object",
      properties: {},
    },
    execute: vi.fn(async () => ({ content: [], details: undefined })),
  };
}

const hoisted = vi.hoisted(() => ({
  ensureRuntimePluginsLoaded: vi.fn(),
  getApiKeyForModel: vi.fn(async () => ({
    apiKey: "test-key",
    mode: "api-key",
    profileId: "default",
  })),
  loadModelCatalog: vi.fn(async () => [
    { provider: "openai", id: "gpt-5.4", name: "GPT-5.4", reasoning: true },
    { provider: "google", id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", reasoning: true },
  ]),
  resolveProviderRuntimePlugin: vi.fn(() => ({ id: "mock-provider-plugin" })),
  prepareProviderRuntimeAuth: vi.fn(async () => undefined),
  resolveOwningPluginIdsForProvider: vi.fn(() => ["mock-provider-plugin"]),
  resolveModelAsync: vi.fn(async (provider: string, model: string) => ({
    model: {
      provider,
      id: model,
      api: "openai-responses",
      name: model,
      baseUrl: "https://api.example.test/v1",
      contextWindow: 128_000,
      maxTokens: 16_384,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
  })),
}));

vi.mock("../agents/runtime-plugins.js", () => ({
  ensureRuntimePluginsLoaded: hoisted.ensureRuntimePluginsLoaded,
}));

vi.mock("../agents/model-auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/model-auth.js")>();
  return {
    ...actual,
    getApiKeyForModel: hoisted.getApiKeyForModel,
  };
});

vi.mock("../agents/model-catalog.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/model-catalog.js")>();
  return {
    ...actual,
    loadModelCatalog: hoisted.loadModelCatalog,
  };
});

vi.mock("../plugins/provider-hook-runtime.js", () => ({
  resolveProviderRuntimePlugin: hoisted.resolveProviderRuntimePlugin,
}));

vi.mock("../plugins/provider-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/provider-runtime.js")>();
  return {
    ...actual,
    prepareProviderRuntimeAuth: hoisted.prepareProviderRuntimeAuth,
  };
});

vi.mock("../plugins/providers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/providers.js")>();
  return {
    ...actual,
    resolveOwningPluginIdsForProvider: hoisted.resolveOwningPluginIdsForProvider,
  };
});

vi.mock("../agents/pi-embedded-runner/model.js", () => ({
  resolveModelAsync: hoisted.resolveModelAsync,
}));

vi.mock("../agents/agent-scope.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/agent-scope.js")>();
  return {
    ...actual,
    resolveAgentWorkspaceDir: vi.fn(() => "/tmp/openclaw-workspace"),
    resolveSessionAgentIds: vi.fn(() => ({ sessionAgentId: "default" })),
  };
});

vi.mock("../agents/openclaw-plugin-tools.js", () => ({
  resolveOpenClawPluginToolsForOptions: vi.fn(() => []),
}));

vi.mock("../agents/openclaw-tools.nodes-workspace-guard.js", () => ({
  applyNodesToolWorkspaceGuard: vi.fn((tool: unknown) => tool),
}));

vi.mock("../agents/openclaw-tools.registration.js", () => ({
  collectPresentOpenClawTools: vi.fn((tools: Array<unknown>) => tools.filter(Boolean)),
  isUpdatePlanToolEnabledForOpenClawTools: vi.fn(() => false),
}));

vi.mock("../agents/workspace-dir.js", () => ({
  resolveWorkspaceRoot: vi.fn((value?: string) => value),
}));

vi.mock("../secrets/runtime.js", () => ({
  getActiveRuntimeWebToolsMetadata: vi.fn(() => undefined),
}));

vi.mock("../agents/tools/canvas-tool.js", () => ({
  createCanvasTool: vi.fn(() => createTool("canvas")),
}));

vi.mock("../agents/tools/cron-tool.js", () => ({
  createCronTool: vi.fn(() => createTool("cron")),
}));

vi.mock("../agents/tools/gateway-tool.js", () => ({
  createGatewayTool: vi.fn(() => createTool("gateway")),
}));

vi.mock("../agents/tools/message-tool.js", () => ({
  createMessageTool: vi.fn(() => createTool("message")),
}));

vi.mock("../agents/tools/nodes-tool.js", () => ({
  createNodesTool: vi.fn(() => createTool("nodes")),
}));

vi.mock("../agents/tools/tts-tool.js", () => ({
  createTtsTool: vi.fn(() => createTool("tts")),
}));

vi.mock("../agents/tools/agents-list-tool.js", () => ({
  createAgentsListTool: vi.fn(() => createTool("agents_list")),
}));

vi.mock("../agents/tools/sessions-list-tool.js", () => ({
  createSessionsListTool: vi.fn(() => createTool("sessions_list")),
}));

vi.mock("../agents/tools/sessions-history-tool.js", () => ({
  createSessionsHistoryTool: vi.fn(() => createTool("sessions_history")),
}));

vi.mock("../agents/tools/sessions-send-tool.js", () => ({
  createSessionsSendTool: vi.fn(() => createTool("sessions_send")),
}));

vi.mock("../agents/tools/sessions-spawn-tool.js", () => ({
  createSessionsSpawnTool: vi.fn(() => createTool("sessions_spawn")),
}));

vi.mock("../agents/tools/sessions-yield-tool.js", () => ({
  createSessionsYieldTool: vi.fn(() => createTool("sessions_yield")),
}));

vi.mock("../agents/tools/subagents-tool.js", () => ({
  createSubagentsTool: vi.fn(() => createTool("subagents")),
}));

vi.mock("../agents/tools/session-status-tool.js", () => ({
  createSessionStatusTool: vi.fn(() => createTool("session_status")),
}));

vi.mock("../agents/tools/image-generate-tool.js", () => ({
  createImageGenerateTool: vi.fn(() => createTool("image_generate")),
}));

vi.mock("../agents/tools/music-generate-tool.js", () => ({
  createMusicGenerateTool: vi.fn(() => createTool("music_generate")),
}));

vi.mock("../agents/tools/video-generate-tool.js", () => ({
  createVideoGenerateTool: vi.fn(() => createTool("video_generate")),
}));

vi.mock("../agents/tools/image-tool.js", () => ({
  createImageTool: vi.fn(() => null),
}));

vi.mock("../agents/tools/pdf-tool.js", () => ({
  createPdfTool: vi.fn((options?: { config?: OpenClawConfig }) => {
    const primary =
      typeof options?.config?.agents?.defaults?.model === "object"
        ? options.config.agents?.defaults?.model?.primary
        : options?.config?.agents?.defaults?.model;
    return primary?.toString().includes("google/") && process.env.GOOGLE_API_KEY
      ? createTool("pdf")
      : null;
  }),
}));

vi.mock("../agents/tools/web-tools.js", () => ({
  createWebFetchTool: vi.fn(() => null),
  createWebSearchTool: vi.fn((options?: { config?: OpenClawConfig }) => {
    const provider = options?.config?.tools?.web?.search?.provider?.trim().toLowerCase();
    return provider === "brave" || provider === "perplexity"
      ? {
          ...createTool("web_search"),
          parameters: {
            type: "object",
            properties: {
              provider: { type: "string", const: provider },
            },
          },
        }
      : null;
  }),
}));

import { createOpenClawTools } from "../agents/openclaw-tools.js";
import { resetReplyRuntimeReadinessMonitorForTest } from "./reply-runtime-readiness-monitor.js";
import { prepareReplyRuntimeForChannels } from "./reply-runtime-readiness.js";

function summarizeTools(tools: ReturnType<typeof createOpenClawTools>) {
  return tools.map((tool) => ({
    name: tool.name,
    parameters: tool.parameters,
  }));
}

function createToolSurface(config: OpenClawConfig) {
  return summarizeTools(
    createOpenClawTools({
      config,
      agentDir: "/tmp/openclaw-agent",
      workspaceDir: "/tmp/openclaw-workspace",
      agentSessionKey: "agent:default:main",
      disablePluginTools: true,
    }),
  );
}

describe("reply-runtime readiness", () => {
  beforeEach(() => {
    resetReplyRuntimeReadinessMonitorForTest();
    hoisted.ensureRuntimePluginsLoaded.mockClear();
    hoisted.getApiKeyForModel.mockClear();
    hoisted.loadModelCatalog.mockClear();
    hoisted.resolveProviderRuntimePlugin.mockClear();
    hoisted.prepareProviderRuntimeAuth.mockClear();
    hoisted.resolveOwningPluginIdsForProvider.mockClear();
    hoisted.resolveModelAsync.mockClear();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("accepts aws-sdk auth without a static api key during readiness", async () => {
    hoisted.loadModelCatalog.mockResolvedValueOnce([
      {
        provider: "amazon-bedrock",
        id: "us.anthropic.claude-opus-4-6-v1:0",
        name: "Claude Opus 4.6",
        reasoning: true,
      },
    ]);
    hoisted.getApiKeyForModel.mockResolvedValueOnce({
      apiKey: undefined,
      mode: "aws-sdk",
      source: "aws-sdk default chain",
    });

    const result = await prepareReplyRuntimeForChannels({
      cfg: {
        agents: {
          defaults: {
            model: { primary: "amazon-bedrock/us.anthropic.claude-opus-4-6-v1:0" },
          },
        },
      } as OpenClawConfig,
      workspaceDir: "/tmp/openclaw-workspace",
    });

    expect(result.status).toBe("ready");
    expect(hoisted.prepareProviderRuntimeAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "amazon-bedrock",
        context: expect.objectContaining({
          apiKey: "__aws_sdk_auth__",
          authMode: "aws-sdk",
        }),
      }),
    );
  });

  it("keeps createOpenClawTools contracts unchanged before and after readiness warmup", async () => {
    const cases: OpenClawConfig[] = [
      {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.4" },
          },
        },
      } as OpenClawConfig,
      {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.4" },
          },
        },
        tools: {
          web: {
            search: {
              provider: "brave",
              apiKey: "brave-test-key",
            },
          },
        },
      } as OpenClawConfig,
      {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.4" },
          },
        },
        tools: {
          web: {
            search: {
              provider: "perplexity",
              apiKey: "perplexity-test-key",
            },
          },
        },
      } as OpenClawConfig,
    ];
    const pdfConfig = {
      agents: {
        defaults: {
          model: { primary: "google/gemini-2.5-pro" },
        },
      },
    } as OpenClawConfig;

    for (const config of cases) {
      const before = createToolSurface(config);
      await prepareReplyRuntimeForChannels({
        cfg: config,
        workspaceDir: "/tmp/openclaw-workspace",
      });
      expect(createToolSurface(config)).toEqual(before);
    }

    vi.stubEnv("GOOGLE_API_KEY", "google-test-key");
    const pdfBefore = createToolSurface(pdfConfig);
    await prepareReplyRuntimeForChannels({
      cfg: pdfConfig,
      workspaceDir: "/tmp/openclaw-workspace",
    });
    expect(createToolSurface(pdfConfig)).toEqual(pdfBefore);

    vi.unstubAllEnvs();
    const noPdfBefore = createToolSurface(pdfConfig);
    await prepareReplyRuntimeForChannels({
      cfg: pdfConfig,
      workspaceDir: "/tmp/openclaw-workspace",
    });
    expect(createToolSurface(pdfConfig)).toEqual(noPdfBefore);
  });
});
