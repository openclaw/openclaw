import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

let backend: "builtin" | "qmd" = "builtin";
let searchImpl: () => Promise<unknown[]> = async () => [
  {
    path: "MEMORY.md",
    startLine: 5,
    endLine: 7,
    score: 0.9,
    snippet: "@@ -5,3 @@\nAssistant: noted",
    source: "memory" as const,
  },
];
let readFileImpl: () => Promise<string> = async () => "";

const stubManager = {
  search: vi.fn(async () => await searchImpl()),
  readFile: vi.fn(async () => await readFileImpl()),
  status: () => ({
    backend,
    files: 1,
    chunks: 1,
    dirty: false,
    workspaceDir: "/workspace",
    dbPath: "/workspace/.memory/index.sqlite",
    provider: "builtin",
    model: "builtin",
    requestedProvider: "builtin",
    sources: ["memory" as const],
    sourceCounts: [{ source: "memory" as const, files: 1, chunks: 1 }],
  }),
  sync: vi.fn(),
  probeVectorAvailability: vi.fn(async () => true),
  close: vi.fn(),
};

vi.mock("../../memory/index.js", () => {
  return {
    getMemorySearchManager: async () => ({ manager: stubManager }),
  };
});

import { createMemoryGetTool, createMemorySearchTool } from "./memory-tool.js";

function asOpenClawConfig(config: Partial<OpenClawConfig>): OpenClawConfig {
  return config as OpenClawConfig;
}

beforeEach(() => {
  backend = "builtin";
  searchImpl = async () => [
    {
      path: "MEMORY.md",
      startLine: 5,
      endLine: 7,
      score: 0.9,
      snippet: "@@ -5,3 @@\nAssistant: noted",
      source: "memory" as const,
    },
  ];
  readFileImpl = async () => "";
  vi.clearAllMocks();
});

describe("memory search citations", () => {
  it("appends source information when citations are enabled", async () => {
    backend = "builtin";
    const cfg = asOpenClawConfig({
      memory: { citations: "on" },
      agents: { list: [{ id: "main", default: true }] },
    });
    const tool = createMemorySearchTool({ config: cfg });
    if (!tool) {
      throw new Error("tool missing");
    }
    const result = await tool.execute("call_citations_on", { query: "notes" });
    const details = result.details as { results: Array<{ snippet: string; citation?: string }> };
    expect(details.results[0]?.snippet).toMatch(/Source: MEMORY.md#L5-L7/);
    expect(details.results[0]?.citation).toBe("MEMORY.md#L5-L7");
  });

  it("leaves snippet untouched when citations are off", async () => {
    backend = "builtin";
    const cfg = asOpenClawConfig({
      memory: { citations: "off" },
      agents: { list: [{ id: "main", default: true }] },
    });
    const tool = createMemorySearchTool({ config: cfg });
    if (!tool) {
      throw new Error("tool missing");
    }
    const result = await tool.execute("call_citations_off", { query: "notes" });
    const details = result.details as { results: Array<{ snippet: string; citation?: string }> };
    expect(details.results[0]?.snippet).not.toMatch(/Source:/);
    expect(details.results[0]?.citation).toBeUndefined();
  });

  it("clamps decorated snippets to qmd injected budget", async () => {
    backend = "qmd";
    const cfg = asOpenClawConfig({
      memory: { citations: "on", backend: "qmd", qmd: { limits: { maxInjectedChars: 20 } } },
      agents: { list: [{ id: "main", default: true }] },
    });
    const tool = createMemorySearchTool({ config: cfg });
    if (!tool) {
      throw new Error("tool missing");
    }
    const result = await tool.execute("call_citations_qmd", { query: "notes" });
    const details = result.details as { results: Array<{ snippet: string; citation?: string }> };
    expect(details.results[0]?.snippet.length).toBeLessThanOrEqual(20);
  });

  it("honors auto mode for direct chats", async () => {
    backend = "builtin";
    const cfg = asOpenClawConfig({
      memory: { citations: "auto" },
      agents: { list: [{ id: "main", default: true }] },
    });
    const tool = createMemorySearchTool({
      config: cfg,
      agentSessionKey: "agent:main:discord:dm:u123",
    });
    if (!tool) {
      throw new Error("tool missing");
    }
    const result = await tool.execute("auto_mode_direct", { query: "notes" });
    const details = result.details as { results: Array<{ snippet: string }> };
    expect(details.results[0]?.snippet).toMatch(/Source:/);
  });

  it("suppresses citations for auto mode in group chats", async () => {
    backend = "builtin";
    const cfg = asOpenClawConfig({
      memory: { citations: "auto" },
      agents: { list: [{ id: "main", default: true }] },
    });
    const tool = createMemorySearchTool({
      config: cfg,
      agentSessionKey: "agent:main:discord:group:c123",
    });
    if (!tool) {
      throw new Error("tool missing");
    }
    const result = await tool.execute("auto_mode_group", { query: "notes" });
    const details = result.details as { results: Array<{ snippet: string }> };
    expect(details.results[0]?.snippet).not.toMatch(/Source:/);
  });
});

describe("memory tools", () => {
  it("does not throw when memory_search fails (e.g. embeddings 429)", async () => {
    searchImpl = async () => {
      throw new Error("openai embeddings failed: 429 insufficient_quota");
    };

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
    readFileImpl = async () => {
      throw new Error("path required");
    };

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
