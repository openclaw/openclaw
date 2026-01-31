import { describe, expect, it, vi } from "vitest";

vi.mock("../../memory/index.js", () => {
  return {
    getMemorySearchManager: async () => {
      return {
        manager: {
          search: async () => {
            throw new Error("openai embeddings failed: 429 insufficient_quota");
          },
          readFile: async () => {
            throw new Error("path required");
          },
          status: () => ({
            files: 0,
            chunks: 0,
            dirty: true,
            workspaceDir: "/tmp",
            dbPath: "/tmp/index.sqlite",
            provider: "openai",
            model: "text-embedding-3-small",
            requestedProvider: "openai",
          }),
        },
      };
    },
  };
});

import { createMemoryGetTool, createMemorySearchTool } from "./memory-tool.js";

describe("memory tools", () => {
  it("does not throw when memory_search fails (e.g. embeddings 429)", async () => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } };
    const tool = createMemorySearchTool({ config: cfg });
    expect(tool).not.toBeNull();
    if (!tool) {
      throw new Error("tool missing");
    }

    const result = await tool.execute("call_1", { query: "hello" });
    expect(result.details).toEqual({
      results: [],
      disabled: true,
      error: "openai embeddings failed: 429 insufficient_quota",
    });
  });

  it("does not throw when memory_get fails", async () => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } };
    const tool = createMemoryGetTool({ config: cfg });
    expect(tool).not.toBeNull();
    if (!tool) {
      throw new Error("tool missing");
    }

    const result = await tool.execute("call_2", { path: "memory/NOPE.md" });
    expect(result.details).toEqual({
      path: "memory/NOPE.md",
      text: "",
      disabled: true,
      error: "path required",
    });
  });
});
