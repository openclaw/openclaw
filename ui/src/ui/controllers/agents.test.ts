import { describe, expect, it, vi } from "vitest";
import { loadAgents, loadToolsCatalog, saveAgentsConfig } from "./agents.ts";
import type { AgentsConfigSaveState, AgentsState } from "./agents.ts";

function createState(): { state: AgentsState; request: ReturnType<typeof vi.fn> } {
  const request = vi.fn();
  const state: AgentsState = {
    client: {
      request,
    } as unknown as AgentsState["client"],
    connected: true,
    agentsLoading: false,
    agentsError: null,
    agentsList: null,
    agentsSelectedId: "main",
    toolsCatalogLoading: false,
    toolsCatalogError: null,
    toolsCatalogResult: null,
  };
  return { state, request };
}

function createSaveState(): {
  state: AgentsConfigSaveState;
  request: ReturnType<typeof vi.fn>;
} {
  const { state, request } = createState();
  return {
    state: {
      ...state,
      configSaving: false,
      configSnapshot: { hash: "hash-1" },
      configFormDirty: true,
      configFormMode: "form",
      configForm: { agents: { list: [{ id: "main" }] } },
      configRaw: "{}",
      configSchema: null,
      lastError: null,
    },
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
    expect(state.toolsCatalogError).toContain("gateway unavailable");
    expect(state.toolsCatalogLoading).toBe(false);
  });
});

describe("saveAgentsConfig", () => {
  it("restores the pre-save agent after reload when it still exists", async () => {
    const { state, request } = createSaveState();
    state.agentsSelectedId = "kimi";
    request
      .mockImplementationOnce(async () => undefined)
      .mockImplementationOnce(async () => {
        state.agentsSelectedId = null;
        return {
          hash: "hash-2",
          raw: '{"agents":{"list":[{"id":"main"},{"id":"kimi"}]}}',
          config: {
            agents: {
              list: [{ id: "main" }, { id: "kimi" }],
            },
          },
          valid: true,
          issues: [],
        };
      })
      .mockImplementationOnce(async () => {
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

    await saveAgentsConfig(state);

    expect(request).toHaveBeenNthCalledWith(
      1,
      "config.set",
      expect.objectContaining({ baseHash: "hash-1" }),
    );
    expect(JSON.parse(request.mock.calls[0]?.[1]?.raw as string)).toEqual({
      agents: { list: [{ id: "main" }] },
    });
    expect(request).toHaveBeenNthCalledWith(2, "config.get", {});
    expect(request).toHaveBeenNthCalledWith(3, "agents.list", {});
    expect(state.agentsSelectedId).toBe("kimi");
  });

  it("falls back to the default agent when the saved agent disappears", async () => {
    const { state, request } = createSaveState();
    state.agentsSelectedId = "kimi";
    request
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        hash: "hash-2",
        raw: '{"agents":{"list":[{"id":"main"}]}}',
        config: {
          agents: {
            list: [{ id: "main" }],
          },
        },
        valid: true,
        issues: [],
      })
      .mockResolvedValueOnce({
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender",
        agents: [{ id: "main", name: "main" }],
      });

    await saveAgentsConfig(state);

    expect(state.agentsSelectedId).toBe("main");
  });
});
