// Control UI tests cover agents behavior.
import { describe, expect, it, vi } from "vitest";
import {
  loadAgents,
  loadToolsCatalog,
  loadToolsEffective,
  saveAgentsConfig,
  setDefaultAgent,
} from "./index.ts";
import type { AgentsConfigCapability, AgentsState } from "./index.ts";

type TestRequest = (method: string, payload?: unknown) => Promise<unknown>;

function createState(): { state: AgentsState; request: ReturnType<typeof vi.fn<TestRequest>> } {
  const request = vi.fn<TestRequest>();
  const state: AgentsState = {
    client: {
      request,
    } as unknown as AgentsState["client"],
    connected: true,
    agentsLoading: false,
    agentsError: null,
    agentsList: null,
    agentsSelectedId: "main",
    sessions: {
      state: {
        result: null,
        agentId: null,
        modelOverrides: {},
        loading: false,
        error: null,
        deletedSessions: [],
      },
    },
    toolsCatalogLoading: false,
    toolsCatalogError: null,
    toolsCatalogResult: null,
    toolsEffectiveLoading: false,
    toolsEffectiveLoadingKey: null,
    toolsEffectiveResultKey: null,
    toolsEffectiveError: null,
    toolsEffectiveResult: null,
    sessionKey: "main",
    sessionsResult: {
      ts: 0,
      path: "",
      count: 1,
      defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: null },
      sessions: [
        {
          key: "main",
          kind: "direct",
          updatedAt: 0,
          model: "gpt-5-mini",
          modelProvider: "openai",
        },
      ],
    },
    chatModelCatalog: [{ id: "gpt-5-mini", name: "GPT-5 Mini", provider: "openai" }],
    agentsPanel: "overview",
  };
  return { state, request };
}

function createSaveState(): {
  state: AgentsState;
  config: AgentsConfigCapability & {
    state: {
      configFormDirty: boolean;
      configForm: Record<string, unknown>;
      configFormOriginal: Record<string, unknown>;
    };
  };
  request: ReturnType<typeof vi.fn<TestRequest>>;
} {
  const { state, request } = createState();
  const configState = {
    configFormDirty: true,
    configForm: { agents: { list: [{ id: "main" }] } },
    configFormOriginal: { agents: { list: [{ id: "main" }] } },
  };
  const config = {
    state: configState,
    save: vi.fn(async () => true),
    stageDefaultAgent: vi.fn(() => false),
  } satisfies AgentsConfigCapability;
  return {
    state,
    config,
    request,
  };
}

describe("loadAgents", () => {
  it("preserves selected agent when it still exists in the list", async () => {
    const { state, request } = createState();
    state.agentsSelectedId = "kimi";
    request.mockResolvedValue({
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [
        { id: "main", name: "main" },
        { id: "kimi", name: "kimi" },
      ],
    });

    await loadAgents(state);

    expect(state.agentsSelectedId).toBe("kimi");
  });

  it("resets to default when selected agent is removed", async () => {
    const { state, request } = createState();
    state.agentsSelectedId = "removed-agent";
    request.mockResolvedValue({
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [
        { id: "main", name: "main" },
        { id: "kimi", name: "kimi" },
      ],
    });

    await loadAgents(state);

    expect(state.agentsSelectedId).toBe("main");
  });

  it("sets default when no agent is selected", async () => {
    const { state, request } = createState();
    state.agentsSelectedId = null;
    request.mockResolvedValue({
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [
        { id: "main", name: "main" },
        { id: "kimi", name: "kimi" },
      ],
    });

    await loadAgents(state);

    expect(state.agentsSelectedId).toBe("main");
  });
});

describe("loadToolsCatalog", () => {
  it("loads catalog and stores result", async () => {
    const { state, request } = createState();
    const payload = {
      agentId: "main",
      profiles: [{ id: "full", label: "Full" }],
      groups: [
        {
          id: "media",
          label: "Media",
          source: "core",
          tools: [{ id: "tts", label: "tts", description: "Text-to-speech", source: "core" }],
        },
      ],
    };
    request.mockResolvedValue(payload);

    await loadToolsCatalog(state, "main");

    expect(request).toHaveBeenCalledWith("tools.catalog", {
      agentId: "main",
      includePlugins: true,
    });
    expect(state.toolsCatalogResult).toEqual(payload);
    expect(state.toolsCatalogError).toBeNull();
    expect(state.toolsCatalogLoading).toBe(false);
  });

  it("captures request errors for fallback UI handling", async () => {
    const { state, request } = createState();
    request.mockRejectedValue(new Error("gateway unavailable"));

    await loadToolsCatalog(state, "main");

    expect(state.toolsCatalogResult).toBeNull();
    expect(state.toolsCatalogError).toBe("Error: gateway unavailable");
    expect(state.toolsCatalogLoading).toBe(false);
  });

  it("ignores catalog responses after selected agent changes mid-request", async () => {
    const { state, request } = createState();
    const resolvers: Array<(value: unknown) => void> = [];
    request.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );

    const pending = loadToolsCatalog(state, "main");
    state.agentsSelectedId = "other-agent";
    resolvers.shift()?.({
      agentId: "main",
      profiles: [{ id: "full", label: "Full" }],
      groups: [],
    });
    await pending;

    expect(state.toolsCatalogResult).toBeNull();
    expect(state.toolsCatalogError).toBeNull();
    expect(state.toolsCatalogLoading).toBe(false);
  });
});

describe("loadToolsEffective", () => {
  it("loads effective tools for the active session", async () => {
    const { state, request } = createState();
    const payload = {
      agentId: "main",
      profile: "coding",
      groups: [
        {
          id: "core",
          label: "Built-in tools",
          source: "core",
          tools: [
            {
              id: "read",
              label: "Read",
              description: "Read files",
              rawDescription: "Read files",
              source: "core",
            },
          ],
        },
      ],
    };
    request.mockResolvedValue(payload);

    await loadToolsEffective(state, { agentId: "main", sessionKey: "main" });

    expect(request).toHaveBeenCalledWith("tools.effective", {
      agentId: "main",
      sessionKey: "main",
    });
    expect(state.toolsEffectiveResult).toEqual(payload);
    expect(state.toolsEffectiveResultKey).toBe("main:main:model=openai/gpt-5-mini");
    expect(state.toolsEffectiveError).toBeNull();
    expect(state.toolsEffectiveLoading).toBe(false);
  });

  it("captures effective-tool request errors", async () => {
    const { state, request } = createState();
    request.mockRejectedValue(new Error("gateway unavailable"));

    await loadToolsEffective(state, { agentId: "main", sessionKey: "main" });

    expect(state.toolsEffectiveResult).toBeNull();
    expect(state.toolsEffectiveResultKey).toBeNull();
    expect(state.toolsEffectiveError).toBe("Error: gateway unavailable");
    expect(state.toolsEffectiveLoading).toBe(false);
  });

  it("ignores effective-tool responses after selected agent changes mid-request", async () => {
    const { state, request } = createState();
    const resolvers: Array<(value: unknown) => void> = [];
    request.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );

    const pending = loadToolsEffective(state, { agentId: "main", sessionKey: "main" });
    state.agentsSelectedId = "other-agent";
    resolvers.shift()?.({
      agentId: "main",
      profile: "coding",
      groups: [],
    });
    await pending;

    expect(state.toolsEffectiveResult).toBeNull();
    expect(state.toolsEffectiveResultKey).toBeNull();
    expect(state.toolsEffectiveError).toBeNull();
    expect(state.toolsEffectiveLoading).toBe(false);
  });

  it("uses the catalog provider when the active session reports a stale provider", async () => {
    const { state, request } = createState();
    const sessionsResult = state.sessionsResult!;
    state.sessionsResult = {
      ts: sessionsResult.ts,
      path: sessionsResult.path,
      count: 1,
      defaults: sessionsResult.defaults,
      sessions: [
        {
          key: "main",
          kind: "direct",
          updatedAt: 0,
          model: "deepseek-chat",
          modelProvider: "zai",
        },
      ],
    };
    state.chatModelCatalog = [{ id: "deepseek-chat", name: "DeepSeek Chat", provider: "deepseek" }];
    request.mockResolvedValue({
      agentId: "main",
      profile: "coding",
      groups: [],
    });

    await loadToolsEffective(state, { agentId: "main", sessionKey: "main" });

    expect(state.toolsEffectiveResultKey).toBe("main:main:model=deepseek/deepseek-chat");
  });

  it("preserves already-qualified session models when the active session provider is stale and the catalog is empty", async () => {
    const { state, request } = createState();
    const sessionsResult = state.sessionsResult!;
    state.sessionsResult = {
      ts: sessionsResult.ts,
      path: sessionsResult.path,
      count: 1,
      defaults: sessionsResult.defaults,
      sessions: [
        {
          key: "main",
          kind: "direct",
          updatedAt: 0,
          model: "openai/gpt-5-mini",
          modelProvider: "zai",
        },
      ],
    };
    state.chatModelCatalog = [];
    request.mockResolvedValue({
      agentId: "main",
      profile: "coding",
      groups: [],
    });

    await loadToolsEffective(state, { agentId: "main", sessionKey: "main" });

    expect(state.toolsEffectiveResultKey).toBe("main:main:model=openai/gpt-5-mini");
  });
});

describe("saveAgentsConfig", () => {
  it("restores the pre-save agent after reload when it still exists", async () => {
    const { state, config, request } = createSaveState();
    state.agentsSelectedId = "kimi";
    request.mockImplementationOnce(async () => {
      state.agentsSelectedId = null;
      return {
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender",
        agents: [
          { id: "main", name: "main" },
          { id: "kimi", name: "kimi" },
        ],
      };
    });

    await saveAgentsConfig(state, config);

    expect(config.save).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenNthCalledWith(1, "agents.list", {});
    expect(state.agentsSelectedId).toBe("kimi");
  });

  it("falls back to the default agent when the saved agent disappears", async () => {
    const { state, config, request } = createSaveState();
    state.agentsSelectedId = "kimi";
    request.mockResolvedValueOnce({
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [{ id: "main", name: "main" }],
    });

    await saveAgentsConfig(state, config);

    expect(config.save).toHaveBeenCalledTimes(1);
    expect(state.agentsSelectedId).toBe("main");
  });
});

describe("setDefaultAgent", () => {
  it("stages the default agent and persists a clean draft", async () => {
    const { state, config, request } = createSaveState();
    config.state.configForm = { agents: { list: [{ id: "main" }, { id: "kimi" }] } };
    config.state.configFormOriginal = { agents: { list: [{ id: "main" }, { id: "kimi" }] } };
    config.state.configFormDirty = false;
    vi.mocked(config.stageDefaultAgent).mockImplementation(() => {
      config.state.configFormDirty = true;
      return true;
    });
    request.mockResolvedValueOnce({
      defaultId: "kimi",
      mainKey: "main",
      scope: "per-sender",
      agents: [
        { id: "main", name: "main" },
        { id: "kimi", name: "kimi" },
      ],
    });

    await setDefaultAgent(state, config, "kimi");

    expect(config.stageDefaultAgent).toHaveBeenCalledWith("kimi");
    expect(config.save).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("agents.list", {});
  });

  it("does not persist when the agent is absent from the config list", async () => {
    const { state, config, request } = createSaveState();
    config.state.configForm = { agents: { list: [{ id: "main" }] } };
    vi.mocked(config.stageDefaultAgent).mockReturnValue(false);

    await setDefaultAgent(state, config, "ghost");

    expect(config.stageDefaultAgent).toHaveBeenCalledWith("ghost");
    expect(config.save).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("does not persist unrelated dirty agent config drafts", async () => {
    const { state, config, request } = createSaveState();
    config.state.configFormDirty = true;
    config.state.configFormOriginal = { agents: { list: [{ id: "main" }, { id: "kimi" }] } };
    config.state.configForm = {
      agents: {
        list: [{ id: "main", model: "gpt-5.5" }, { id: "kimi" }],
      },
    };
    vi.mocked(config.stageDefaultAgent).mockImplementation(() => {
      config.state.configForm = {
        agents: {
          list: [
            { id: "main", model: "gpt-5.5" },
            { id: "kimi", default: true },
          ],
        },
      };
      config.state.configFormDirty = true;
      return true;
    });

    await setDefaultAgent(state, config, "kimi");

    expect(config.stageDefaultAgent).toHaveBeenCalledWith("kimi");
    expect(config.save).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(config.state.configForm).toEqual({
      agents: {
        list: [
          { id: "main", model: "gpt-5.5" },
          { id: "kimi", default: true },
        ],
      },
    });
    expect(config.state.configFormDirty).toBe(true);
  });
});
