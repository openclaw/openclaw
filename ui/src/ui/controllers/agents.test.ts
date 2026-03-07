import { describe, expect, it, vi } from "vitest";
import { loadToolsCatalog } from "./agents.ts";
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
    toolsCatalogLoadingAgentId: null,
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

  it("allows a new agent request to replace a stale in-flight load", async () => {
    const { state, request } = createState();

    let resolveMain:
      | ((value: {
          agentId: string;
          profiles: { id: string; label: string }[];
          groups: {
            id: string;
            label: string;
            source: string;
            tools: { id: string; label: string; description: string; source: string }[];
          }[];
        }) => void)
      | null = null;
    const mainRequest = new Promise<{
      agentId: string;
      profiles: { id: string; label: string }[];
      groups: {
        id: string;
        label: string;
        source: string;
        tools: { id: string; label: string; description: string; source: string }[];
      }[];
    }>((resolve) => {
      resolveMain = resolve;
    });

    const replacementPayload = {
      agentId: "other",
      profiles: [{ id: "full", label: "Full" }],
      groups: [],
    };

    request.mockImplementationOnce(() => mainRequest).mockResolvedValueOnce(replacementPayload);

    const initialLoad = loadToolsCatalog(state, "main");
    await Promise.resolve();

    state.agentsSelectedId = "other";
    await loadToolsCatalog(state, "other");

    expect(request).toHaveBeenNthCalledWith(1, "tools.catalog", {
      agentId: "main",
      includePlugins: true,
    });
    expect(request).toHaveBeenNthCalledWith(2, "tools.catalog", {
      agentId: "other",
      includePlugins: true,
    });
    expect(state.toolsCatalogResult).toEqual(replacementPayload);
    expect(state.toolsCatalogLoading).toBe(false);

    resolveMain?.({
      agentId: "main",
      profiles: [{ id: "full", label: "Full" }],
      groups: [],
    });
    await initialLoad;

    expect(state.toolsCatalogResult).toEqual(replacementPayload);
    expect(state.toolsCatalogLoading).toBe(false);
  });
});
