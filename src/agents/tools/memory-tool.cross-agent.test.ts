import { describe, expect, it, vi } from "vitest";

vi.mock("../../memory/index.js", () => {
  const buildManager = (agentId: string) => ({
    search: async () => [
      {
        path: "MEMORY.md",
        source: "memory" as const,
        snippet: `${agentId} memory`,
        score: agentId === "ops" ? 0.8 : agentId === "research" ? 0.7 : 0.6,
        startLine: 1,
        endLine: 1,
      },
    ],
    readFile: async () => ({
      path: "MEMORY.md",
      text: `${agentId} file`,
    }),
    status: () => ({
      backend: "builtin",
      files: 1,
      chunks: 1,
      dirty: false,
      workspaceDir: `/tmp/${agentId}`,
      dbPath: `/tmp/${agentId}/index.sqlite`,
      provider: "openai",
      model: "text-embedding-3-small",
      requestedProvider: "openai",
    }),
  });

  return {
    getMemorySearchManager: async ({ agentId }: { agentId: string }) => {
      if (agentId === "main" || agentId === "ops" || agentId === "research") {
        return { manager: buildManager(agentId) };
      }
      return { manager: null, error: "memory unavailable" };
    },
  };
});

import { createMemorySearchTool } from "./memory-tool.js";

describe("memory tools cross-agent access", () => {
  it("defaults to self-only when no allowlist configured", async () => {
    const cfg = {
      agents: { list: [{ id: "main", default: true }, { id: "ops" }] },
    };
    const tool = createMemorySearchTool({ config: cfg });
    expect(tool).not.toBeNull();
    if (!tool) {
      throw new Error("tool missing");
    }

    const result = await tool.execute("call_1", { query: "hello" });
    const details = result.details as { results: Array<{ agentId: string }> };
    expect(details.results).toHaveLength(1);
    expect(details.results[0]?.agentId).toBe("main");
  });

  it("allows explicit agent target when allowlisted", async () => {
    const cfg = {
      agents: {
        list: [{ id: "main", default: true, memory: { allowReadFrom: ["ops"] } }, { id: "ops" }],
      },
    };
    const tool = createMemorySearchTool({ config: cfg });
    expect(tool).not.toBeNull();
    if (!tool) {
      throw new Error("tool missing");
    }

    const result = await tool.execute("call_2", { query: "hello", agent: "ops" });
    const details = result.details as { results: Array<{ agentId: string }> };
    expect(details.results).toHaveLength(1);
    expect(details.results[0]?.agentId).toBe("ops");
  });

  it("rejects unauthorized targets", async () => {
    const cfg = {
      agents: { list: [{ id: "main", default: true }, { id: "ops" }] },
    };
    const tool = createMemorySearchTool({ config: cfg });
    expect(tool).not.toBeNull();
    if (!tool) {
      throw new Error("tool missing");
    }

    const result = await tool.execute("call_3", { query: "hello", agent: "ops" });
    const details = result.details as { error?: string; disabled?: boolean };
    expect(details.disabled).toBe(true);
    expect(details.error).toContain("not allowed");
  });

  it("merges results across all allowed agents", async () => {
    const cfg = {
      agents: {
        list: [
          { id: "main", default: true, memory: { allowReadFrom: ["ops", "research"] } },
          { id: "ops" },
          { id: "research" },
        ],
      },
    };
    const tool = createMemorySearchTool({ config: cfg });
    expect(tool).not.toBeNull();
    if (!tool) {
      throw new Error("tool missing");
    }

    const result = await tool.execute("call_4", { query: "hello", all: true });
    const details = result.details as { results: Array<{ agentId: string; score?: number }> };
    expect(details.results).toHaveLength(3);
    expect(details.results[0]?.agentId).toBe("ops");
    expect(details.results.map((entry) => entry.agentId).toSorted()).toEqual(
      ["main", "ops", "research"].toSorted(),
    );
  });
});
