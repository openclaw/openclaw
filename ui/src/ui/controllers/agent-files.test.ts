import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../gateway.ts";
import { loadAgentFileContent, type AgentFilesState } from "./agent-files.ts";

const mockRequest = vi.fn().mockResolvedValue(null);

function createState(overrides?: Partial<AgentFilesState>): AgentFilesState {
  mockRequest.mockClear().mockResolvedValue(null);
  return {
    client: { request: mockRequest } as unknown as GatewayBrowserClient,
    connected: true,
    agentFilesLoading: false,
    agentFilesError: null,
    agentFilesList: null,
    agentFileContents: {},
    agentFileDrafts: {},
    agentFileActive: null,
    agentFileSaving: false,
    ...overrides,
  };
}

describe("loadAgentFileContent", () => {
  it("skips fetch when content is cached and force is not set", async () => {
    const state = createState({
      agentFileContents: { "AGENTS.md": "old content" },
    });
    await loadAgentFileContent(state, "main", "AGENTS.md");
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it("fetches fresh content when force is true even if cached", async () => {
    const state = createState({
      agentFileContents: { "AGENTS.md": "old content" },
      agentFileDrafts: { "AGENTS.md": "old content" },
    });
    mockRequest.mockResolvedValue({
      file: { name: "AGENTS.md", content: "new content" },
    });

    await loadAgentFileContent(state, "main", "AGENTS.md", {
      force: true,
      preserveDraft: false,
    });

    expect(mockRequest).toHaveBeenCalledWith("agents.files.get", {
      agentId: "main",
      name: "AGENTS.md",
    });
    expect(state.agentFileContents["AGENTS.md"]).toBe("new content");
    expect(state.agentFileDrafts["AGENTS.md"]).toBe("new content");
  });

  it("preserves user draft when preserveDraft is true and draft differs from base", async () => {
    const state = createState({
      agentFileContents: { "AGENTS.md": "original" },
      agentFileDrafts: { "AGENTS.md": "user edits" },
    });
    mockRequest.mockResolvedValue({
      file: { name: "AGENTS.md", content: "updated externally" },
    });

    await loadAgentFileContent(state, "main", "AGENTS.md", {
      force: true,
      preserveDraft: true,
    });

    expect(state.agentFileContents["AGENTS.md"]).toBe("updated externally");
    expect(state.agentFileDrafts["AGENTS.md"]).toBe("user edits");
  });
});
