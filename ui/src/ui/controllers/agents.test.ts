import { describe, expect, it, vi } from "vitest";
import { cloneAgent, deleteAgent, loadToolsCatalog } from "./agents.ts";
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

  it("passes a custom clone name when provided", async () => {
    const { state, request } = createState();
    request.mockResolvedValue({
      ok: true,
      sourceAgentId: "main",
      agentId: "coordi",
      name: "coordi",
      workspace: "/workspace/coordi",
      copied: {
        workspace: true,
        agentDir: true,
        sessionsStore: true,
        sessionsTranscripts: true,
        memoryStore: true,
        cronJobs: 2,
        bindings: 1,
      },
    });

    await cloneAgent(state, { sourceAgentId: "main", name: "coordi" });

    expect(request).toHaveBeenCalledWith("agents.clone", {
      sourceAgentId: "main",
      name: "coordi",
    });
  });
});

describe("deleteAgent", () => {
  it("confirms and calls agents.delete with full cleanup flags", async () => {
    const { state, request } = createState();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const payload = {
      ok: true,
      agentId: "main-copy",
      removedBindings: 1,
      removedAllow: 1,
      removedSessions: 3,
      removedCronJobs: 2,
    };
    request.mockResolvedValue(payload);

    const result = await deleteAgent(state, { agentId: "main-copy" });

    expect(confirmSpy).toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith("agents.delete", {
      agentId: "main-copy",
      deleteFiles: true,
      purgeState: true,
    });
    expect(result).toEqual(payload);
    confirmSpy.mockRestore();
  });

  it("does not request deletion when confirmation is cancelled", async () => {
    const { state, request } = createState();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);

    const result = await deleteAgent(state, { agentId: "main-copy" });

    expect(result).toBeNull();
    expect(request).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("retries deletion without purgeState for legacy gateways", async () => {
    const { state, request } = createState();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    request
      .mockRejectedValueOnce(
        new Error(
          "GatewayRequestError: invalid agents.delete params: at root: unexpected property 'purgeState'",
        ),
      )
      .mockResolvedValueOnce({
        ok: true,
        agentId: "main-copy",
        removedBindings: 1,
        removedAllow: 0,
      });

    const result = await deleteAgent(state, { agentId: "main-copy" });

    expect(result).toEqual({
      ok: true,
      agentId: "main-copy",
      removedBindings: 1,
      removedAllow: 0,
    });
    expect(request).toHaveBeenNthCalledWith(1, "agents.delete", {
      agentId: "main-copy",
      deleteFiles: true,
      purgeState: true,
    });
    expect(request).toHaveBeenNthCalledWith(2, "agents.delete", {
      agentId: "main-copy",
      deleteFiles: true,
    });
    confirmSpy.mockRestore();
  });
});
