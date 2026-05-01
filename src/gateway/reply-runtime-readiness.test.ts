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
  ensureAuthProfileStore: vi.fn(() => ({ version: 1, profiles: {} })),
  resolveAuthProfileOrder: vi.fn(() => []),
  loadModelCatalog: vi.fn(async () => [
    { provider: "openai", id: "gpt-5.4", name: "GPT-5.4", reasoning: true },
    { provider: "google", id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", reasoning: true },
  ]),
  selectAgentHarness: vi.fn(() => ({ id: "pi", label: "PI", supports: vi.fn() })),
  resolveProviderRuntimePlugin: vi.fn(() => ({ id: "mock-provider-plugin" })),
  resolveProviderAuthProfileId: vi.fn(() => undefined),
  prepareSimpleCompletionModel: vi.fn(async () => ({
    model: {
      provider: "openai",
      id: "gpt-5.4",
      api: "openai-responses",
      name: "gpt-5.4",
      baseUrl: "https://api.example.test/v1",
      contextWindow: 128_000,
      maxTokens: 16_384,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
    auth: {
      apiKey: "test-key",
      mode: "api-key",
      profileId: "default",
      source: "profile:default",
    },
  })),
  resolveOwningPluginIdsForProvider: vi.fn(() => ["mock-provider-plugin"]),
  resolveStorePath: vi.fn(() => "/tmp/openclaw-agent/sessions/sessions.json"),
  loadSessionStore: vi.fn(() => ({})),
  listAgentIds: vi.fn(() => ["default"]),
  resolveAgentWorkspaceDir: vi.fn((_: OpenClawConfig, agentId?: string) =>
    agentId === "worker" ? "/tmp/openclaw-workspace-worker" : "/tmp/openclaw-workspace",
  ),
  resolveAgentDir: vi.fn((_: OpenClawConfig, agentId?: string) =>
    agentId === "worker" ? "/tmp/openclaw-agent-worker" : "/tmp/openclaw-agent",
  ),
  listWebSearchProviders: vi.fn(() => []),
  listWebFetchProviders: vi.fn(() => []),
  prepareWebSearchDefinition: vi.fn(() => null),
  prepareWebFetchDefinition: vi.fn(() => null),
  prepareWebContentExtractors: vi.fn(async () => undefined),
  prepareOpenClawToolsRuntime: vi.fn(async () => undefined),
  prepareWebFetchToolRuntime: vi.fn(async () => undefined),
  createBundleLspToolRuntime: vi.fn(async () => ({
    tools: [],
    sessions: [],
    dispose: vi.fn(async () => undefined),
  })),
}));

vi.mock("../agents/runtime-plugins.js", () => ({
  ensureRuntimePluginsLoaded: hoisted.ensureRuntimePluginsLoaded,
}));

vi.mock("../agents/model-auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/model-auth.js")>();
  return {
    ...actual,
    ensureAuthProfileStore: hoisted.ensureAuthProfileStore,
    resolveAuthProfileOrder: hoisted.resolveAuthProfileOrder,
    resolvePreparedAuthProfileOrder: hoisted.resolveAuthProfileOrder,
  };
});

vi.mock("../agents/harness/selection.js", () => ({
  selectAgentHarness: hoisted.selectAgentHarness,
}));

vi.mock("../agents/model-catalog.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/model-catalog.js")>();
  return {
    ...actual,
    loadModelCatalog: hoisted.loadModelCatalog,
    prepareReplyRuntimeModelCatalog: hoisted.loadModelCatalog,
  };
});

vi.mock("../plugins/provider-hook-runtime.js", () => ({
  resolveProviderRuntimePlugin: hoisted.resolveProviderRuntimePlugin,
  resolveProviderAuthProfileId: hoisted.resolveProviderAuthProfileId,
}));

vi.mock("../plugins/providers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/providers.js")>();
  return {
    ...actual,
    resolveOwningPluginIdsForProvider: hoisted.resolveOwningPluginIdsForProvider,
  };
});

vi.mock("../agents/simple-completion-runtime.js", () => ({
  prepareSimpleCompletionModel: hoisted.prepareSimpleCompletionModel,
}));

vi.mock("../agents/openclaw-tools.runtime.js", () => ({
  prepareOpenClawToolsRuntime: hoisted.prepareOpenClawToolsRuntime,
}));

vi.mock("../agents/pi-bundle-lsp-runtime.js", () => ({
  createBundleLspToolRuntime: hoisted.createBundleLspToolRuntime,
}));

vi.mock("../agents/tools/web-fetch.js", () => ({
  prepareWebFetchToolRuntime: hoisted.prepareWebFetchToolRuntime,
}));

vi.mock("../config/sessions/paths.js", () => ({
  resolveStorePath: hoisted.resolveStorePath,
}));

vi.mock("../config/sessions/store.js", () => ({
  loadSessionStore: hoisted.loadSessionStore,
}));

vi.mock("../web-search/runtime.js", () => ({
  listWebSearchProviders: hoisted.listWebSearchProviders,
  prepareWebSearchDefinition: hoisted.prepareWebSearchDefinition,
}));

vi.mock("../web-fetch/runtime.js", () => ({
  listWebFetchProviders: hoisted.listWebFetchProviders,
  prepareWebFetchDefinition: hoisted.prepareWebFetchDefinition,
}));

vi.mock("../web-fetch/content-extractors.runtime.js", () => ({
  prepareWebContentExtractors: hoisted.prepareWebContentExtractors,
}));

vi.mock("../agents/agent-scope.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/agent-scope.js")>();
  return {
    ...actual,
    listAgentIds: hoisted.listAgentIds,
    resolveAgentWorkspaceDir: hoisted.resolveAgentWorkspaceDir,
    resolveAgentDir: hoisted.resolveAgentDir,
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
    hoisted.ensureAuthProfileStore.mockClear();
    hoisted.loadModelCatalog.mockClear();
    hoisted.resolveAuthProfileOrder.mockClear();
    hoisted.selectAgentHarness.mockReset().mockReturnValue({ id: "pi", label: "PI" });
    hoisted.resolveProviderRuntimePlugin.mockClear();
    hoisted.resolveProviderAuthProfileId.mockReset();
    hoisted.resolveProviderAuthProfileId.mockReturnValue(undefined);
    hoisted.prepareSimpleCompletionModel.mockClear();
    hoisted.resolveOwningPluginIdsForProvider.mockClear();
    hoisted.resolveStorePath.mockClear();
    hoisted.loadSessionStore.mockClear();
    hoisted.listWebSearchProviders.mockReset();
    hoisted.listWebSearchProviders.mockReturnValue([]);
    hoisted.listWebFetchProviders.mockReset();
    hoisted.listWebFetchProviders.mockReturnValue([]);
    hoisted.prepareWebSearchDefinition.mockClear();
    hoisted.prepareWebFetchDefinition.mockClear();
    hoisted.prepareWebContentExtractors.mockClear();
    hoisted.prepareOpenClawToolsRuntime.mockClear();
    hoisted.prepareWebFetchToolRuntime.mockClear();
    hoisted.createBundleLspToolRuntime.mockClear();
    hoisted.listAgentIds.mockReset().mockReturnValue(["default"]);
    hoisted.resolveAgentWorkspaceDir
      .mockReset()
      .mockImplementation((_, agentId?: string) =>
        agentId === "worker" ? "/tmp/openclaw-workspace-worker" : "/tmp/openclaw-workspace",
      );
    hoisted.resolveAgentDir
      .mockReset()
      .mockImplementation((_, agentId?: string) =>
        agentId === "worker" ? "/tmp/openclaw-agent-worker" : "/tmp/openclaw-agent",
      );
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("warms PI reply models through the shared completion prep seam", async () => {
    hoisted.loadModelCatalog.mockResolvedValueOnce([
      {
        provider: "amazon-bedrock",
        id: "us.anthropic.claude-opus-4-6-v1:0",
        name: "Claude Opus 4.6",
        reasoning: true,
      },
    ]);
    hoisted.prepareSimpleCompletionModel.mockResolvedValueOnce({
      model: {
        provider: "amazon-bedrock",
        id: "us.anthropic.claude-opus-4-6-v1:0",
      },
      auth: {
        apiKey: undefined,
        mode: "aws-sdk",
        source: "aws-sdk default chain",
      },
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
    expect(hoisted.prepareSimpleCompletionModel).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "amazon-bedrock",
        modelId: "us.anthropic.claude-opus-4-6-v1:0",
        workspaceDir: "/tmp/openclaw-workspace",
        primeReplyRuntimeCache: true,
      }),
    );
  });

  it("warms all configured agents instead of only the default agent", async () => {
    hoisted.listAgentIds.mockReturnValue(["default", "worker"]);
    hoisted.resolveStorePath.mockImplementation((_, params?: { agentId?: string }) =>
      params?.agentId === "worker"
        ? "/tmp/openclaw-agent-worker/sessions/sessions.json"
        : "/tmp/openclaw-agent/sessions/sessions.json",
    );
    hoisted.loadSessionStore.mockImplementation((storePath: string) =>
      storePath.includes("worker")
        ? {
            "agent:worker:main": {
              providerOverride: "google",
              modelOverride: "gemini-2.5-pro",
            },
          }
        : {},
    );

    const result = await prepareReplyRuntimeForChannels({
      cfg: {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.4" },
          },
          list: [
            {
              id: "worker",
              model: { primary: "google/gemini-2.5-pro" },
            },
          ],
        },
      } as OpenClawConfig,
      workspaceDir: "/tmp/openclaw-workspace",
    });

    expect(result.status).toBe("ready");
    expect(hoisted.prepareSimpleCompletionModel).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        modelId: "gpt-5.4",
        agentDir: "/tmp/openclaw-agent",
        workspaceDir: "/tmp/openclaw-workspace",
        primeReplyRuntimeCache: true,
      }),
    );
    expect(hoisted.prepareSimpleCompletionModel).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "google",
        modelId: "gemini-2.5-pro",
        agentDir: "/tmp/openclaw-agent-worker",
        workspaceDir: "/tmp/openclaw-workspace",
        primeReplyRuntimeCache: true,
      }),
    );
  });

  it("warms configured allowlist model targets used for reply-time model switching", async () => {
    hoisted.loadModelCatalog.mockResolvedValueOnce([
      { provider: "openai", id: "gpt-5.4", name: "GPT-5.4", reasoning: true },
      {
        provider: "anthropic",
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        reasoning: true,
      },
    ]);

    const result = await prepareReplyRuntimeForChannels({
      cfg: {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.4" },
            models: {
              "anthropic/claude-sonnet-4-6": { alias: "Sonnet" },
            },
          },
        },
      } as OpenClawConfig,
      workspaceDir: "/tmp/openclaw-workspace",
    });

    expect(result.status).toBe("ready");
    expect(hoisted.prepareSimpleCompletionModel).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "anthropic",
        modelId: "claude-sonnet-4-6",
        workspaceDir: "/tmp/openclaw-workspace",
        primeReplyRuntimeCache: true,
      }),
    );
  });

  it("primes PI auth profile candidates with the same runtime workspace", async () => {
    hoisted.loadModelCatalog.mockResolvedValueOnce([
      {
        provider: "openai",
        id: "gpt-5.4",
        name: "GPT-5.4",
        reasoning: true,
      },
    ]);
    hoisted.resolveAuthProfileOrder.mockReturnValueOnce(["openai:work"]);

    const result = await prepareReplyRuntimeForChannels({
      cfg: {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.4" },
          },
        },
      } as OpenClawConfig,
      workspaceDir: "/tmp/openclaw-workspace",
    });

    expect(result.status).toBe("ready");
    expect(hoisted.prepareSimpleCompletionModel).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        provider: "openai",
        modelId: "gpt-5.4",
        workspaceDir: "/tmp/openclaw-workspace",
        primeReplyRuntimeCache: true,
      }),
    );
    expect(hoisted.prepareSimpleCompletionModel).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        provider: "openai",
        modelId: "gpt-5.4",
        workspaceDir: "/tmp/openclaw-workspace",
        skipPiDiscovery: true,
        primeReplyRuntimeCache: true,
      }),
    );
    expect(hoisted.prepareSimpleCompletionModel).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        provider: "openai",
        modelId: "gpt-5.4",
        profileId: "openai:work",
        workspaceDir: "/tmp/openclaw-workspace",
        primeReplyRuntimeCache: true,
      }),
    );
  });

  it("primes the full provider-ordered PI auth profile candidate set", async () => {
    hoisted.loadModelCatalog.mockResolvedValueOnce([
      {
        provider: "openai",
        id: "gpt-5.4",
        name: "GPT-5.4",
        reasoning: true,
      },
    ]);
    hoisted.resolveAuthProfileOrder.mockReturnValueOnce(["openai:alpha", "openai:beta"]);
    hoisted.resolveProviderAuthProfileId.mockReturnValueOnce("openai:beta");

    const result = await prepareReplyRuntimeForChannels({
      cfg: {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.4" },
          },
        },
      } as OpenClawConfig,
      workspaceDir: "/tmp/openclaw-workspace",
    });

    expect(result.status).toBe("ready");
    expect(hoisted.prepareSimpleCompletionModel).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        profileId: "openai:beta",
        workspaceDir: "/tmp/openclaw-workspace",
        primeReplyRuntimeCache: true,
      }),
    );
    expect(hoisted.prepareSimpleCompletionModel).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({
        profileId: "openai:alpha",
        workspaceDir: "/tmp/openclaw-workspace",
        primeReplyRuntimeCache: true,
      }),
    );
  });

  it("loads runtime plugins before selecting and warming a non-pi harness", async () => {
    const callOrder: string[] = [];
    const prepareReplyRuntime = vi.fn(async () => {
      callOrder.push("prepareReplyRuntime");
    });
    hoisted.ensureRuntimePluginsLoaded.mockImplementation(() => {
      callOrder.push("ensureRuntimePluginsLoaded");
    });
    hoisted.resolveAuthProfileOrder.mockReturnValueOnce(["openai-codex:work"]);
    hoisted.selectAgentHarness.mockImplementationOnce(() => {
      callOrder.push("selectAgentHarness");
      return {
        id: "codex",
        label: "Codex",
        prepareReplyRuntime,
      };
    });

    const result = await prepareReplyRuntimeForChannels({
      cfg: {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.4" },
            agentRuntime: { id: "codex", fallback: "none" },
          },
        },
      } as OpenClawConfig,
      workspaceDir: "/tmp/openclaw-workspace",
    });

    expect(result.status).toBe("ready");
    expect(hoisted.prepareSimpleCompletionModel).not.toHaveBeenCalled();
    expect(hoisted.ensureAuthProfileStore).toHaveBeenCalled();
    expect(hoisted.resolveAuthProfileOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai-codex",
      }),
    );
    expect(prepareReplyRuntime).toHaveBeenCalledWith({
      config: expect.objectContaining({
        agents: expect.objectContaining({
          defaults: expect.objectContaining({
            model: expect.objectContaining({ primary: "openai/gpt-5.4" }),
          }),
        }),
      }),
      agentDir: expect.any(String),
      workspaceDir: "/tmp/openclaw-workspace",
      provider: "openai",
      modelId: "gpt-5.4",
      authProfileId: expect.any(String),
    });
    expect(callOrder).toEqual([
      "ensureRuntimePluginsLoaded",
      "selectAgentHarness",
      "prepareReplyRuntime",
    ]);
  });

  it("degrades readiness when non-pi harness warmup times out", async () => {
    hoisted.resolveAuthProfileOrder.mockReturnValueOnce(["openai-codex:work"]);
    hoisted.selectAgentHarness.mockReturnValueOnce({
      id: "codex",
      label: "Codex",
      prepareReplyRuntime: vi.fn(async () => {
        throw new Error("codex app-server initialize timed out");
      }),
    });

    const result = await prepareReplyRuntimeForChannels({
      cfg: {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.4" },
            agentRuntime: { id: "codex", fallback: "none" },
          },
        },
      } as OpenClawConfig,
      workspaceDir: "/tmp/openclaw-workspace",
    });

    expect(result.status).toBe("degraded");
    expect(result.reasons).toContain(
      "selected-provider-auth: codex app-server initialize timed out",
    );
    expect(result.phases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: "selected-provider-auth",
          status: "degraded",
        }),
      ]),
    );
  });

  it("keeps createOpenClawTools contracts unchanged before and after readiness warmup", async () => {
    const cases: OpenClawConfig[] = [
      {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.4" },
            models: {
              "openai/gpt-5.4": { alias: "GPT" },
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

  it("primes warmed web provider and extractor surfaces during tool-contract preparation", async () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.4" },
        },
      },
    } as OpenClawConfig;
    hoisted.listWebSearchProviders.mockReturnValue([{ id: "perplexity" }, { id: "brave" }]);
    hoisted.listWebFetchProviders.mockReturnValue([{ id: "firecrawl" }, { id: "jina" }]);

    const result = await prepareReplyRuntimeForChannels({
      cfg: config,
      workspaceDir: "/tmp/openclaw-workspace",
    });

    expect(result.status).toBe("ready");
    expect(hoisted.prepareWebSearchDefinition).toHaveBeenCalledWith(
      expect.objectContaining({
        config,
        preferRuntimeProviders: true,
      }),
    );
    expect(hoisted.prepareWebSearchDefinition).toHaveBeenCalledWith(
      expect.objectContaining({
        config,
        providerId: "perplexity",
        preferRuntimeProviders: true,
      }),
    );
    expect(hoisted.prepareWebSearchDefinition).toHaveBeenCalledWith(
      expect.objectContaining({
        config,
        providerId: "brave",
        preferRuntimeProviders: true,
      }),
    );
    expect(hoisted.prepareWebFetchDefinition).toHaveBeenCalledWith(
      expect.objectContaining({
        config,
        preferRuntimeProviders: true,
      }),
    );
    expect(hoisted.prepareWebFetchDefinition).toHaveBeenCalledWith(
      expect.objectContaining({
        config,
        providerId: "firecrawl",
        preferRuntimeProviders: true,
      }),
    );
    expect(hoisted.prepareWebFetchDefinition).toHaveBeenCalledWith(
      expect.objectContaining({
        config,
        providerId: "jina",
        preferRuntimeProviders: true,
      }),
    );
    expect(hoisted.createBundleLspToolRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:default:main",
        workspaceDir: "/tmp/openclaw-workspace",
        cfg: config,
      }),
    );
    expect(hoisted.prepareWebContentExtractors).toHaveBeenCalledWith({ config });
  });
});
