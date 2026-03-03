import { describe, expect, it, vi } from "vitest";
import { cloneAgent, loadToolsCatalog } from "./agents.ts";
import type { AgentsState } from "./agents.ts";

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

describe("cloneAgent", () => {
  it("calls agents.clone and returns payload", async () => {
    const { state, request } = createState();
    const payload = {
      ok: true,
      sourceAgentId: "main",
      agentId: "main-copy",
      name: "Main Agent Copy",
      workspace: "/workspace/main-copy",
      copied: {
        workspace: true,
        agentDir: true,
        sessionsStore: true,
        sessionsTranscripts: true,
        memoryStore: true,
        cronJobs: 2,
        bindings: 1,
      },
    };
    request.mockResolvedValue(payload);

    const result = await cloneAgent(state, { sourceAgentId: "main" });

    expect(request).toHaveBeenCalledWith("agents.clone", { sourceAgentId: "main" });
    expect(result).toEqual(payload);
    expect(state.agentsError).toBeNull();
    expect(state.agentsLoading).toBe(false);
  });

  it("stores error when clone request fails", async () => {
    const { state, request } = createState();
    request.mockRejectedValue(new Error("clone failed"));

    const result = await cloneAgent(state, { sourceAgentId: "main" });

    expect(result).toBeNull();
    expect(state.agentsError).toContain("clone failed");
    expect(state.agentsLoading).toBe(false);
  });
});
