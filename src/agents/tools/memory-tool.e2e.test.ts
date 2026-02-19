import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
type MemoryReadParams = { relPath: string; from?: number; lines?: number };
type MemoryReadResult = { text: string; path: string };
let readFileImpl: (params: MemoryReadParams) => Promise<MemoryReadResult> = async (params) => ({
  text: "",
  path: params.relPath,
});

const stubManager = {
  search: vi.fn(async () => await searchImpl()),
  readFile: vi.fn(async (params: MemoryReadParams) => await readFileImpl(params)),
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

import {
  createMemoryGetTool,
  createMemorySearchTool,
  createMemoryUpsertTool,
  createMemoryWriteTool,
} from "./memory-tool.js";

function asOpenClawConfig(config: Partial<OpenClawConfig>): OpenClawConfig {
  return config as OpenClawConfig;
}

function configWithWorkspace(workspace: string): OpenClawConfig {
  return {
    agents: {
      defaults: {
        workspace,
        memorySearch: { enabled: true },
      },
      list: [{ id: "main", default: true }],
    },
  } as unknown as OpenClawConfig;
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
  readFileImpl = async (params: MemoryReadParams) => ({ text: "", path: params.relPath });
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
      unavailable: true,
      error: "openai embeddings failed: 429 insufficient_quota",
      warning: "Memory search is unavailable because the embedding provider quota is exhausted.",
      action: "Top up or switch embedding provider, then retry memory_search.",
    });
  });

  it("does not throw when memory_get fails", async () => {
    readFileImpl = async (_params: MemoryReadParams) => {
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

  it("returns empty text without error when file does not exist (ENOENT)", async () => {
    readFileImpl = async (_params: MemoryReadParams) => {
      return { text: "", path: "memory/2026-02-19.md" };
    };

    const cfg = { agents: { list: [{ id: "main", default: true }] } };
    const tool = createMemoryGetTool({ config: cfg });
    expect(tool).not.toBeNull();
    if (!tool) {
      throw new Error("tool missing");
    }

    const result = await tool.execute("call_enoent", { path: "memory/2026-02-19.md" });
    expect(result.details).toEqual({
      text: "",
      path: "memory/2026-02-19.md",
    });
  });
});

describe("memory write tools", () => {
  it("memory_write appends to daily memory file", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-write-"));
    const cfg = configWithWorkspace(workspace);
    const tool = createMemoryWriteTool({ config: cfg });
    expect(tool).not.toBeNull();
    if (!tool) {
      throw new Error("tool missing");
    }

    const result = await tool.execute("call_write", {
      text: "remember this",
      date: "2026-02-18",
      kind: "preference",
    });
    const details = result.details as { path: string; target: string };
    expect(details.path).toBe("memory/2026-02-18.md");
    expect(details.target).toBe("daily");

    const content = await fs.readFile(path.join(workspace, "memory", "2026-02-18.md"), "utf-8");
    expect(content).toContain("remember this");
    expect(content).toContain("kind:preference");
  });

  it("memory_upsert updates existing keyed entries", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-upsert-"));
    const cfg = configWithWorkspace(workspace);
    const tool = createMemoryUpsertTool({ config: cfg });
    expect(tool).not.toBeNull();
    if (!tool) {
      throw new Error("tool missing");
    }

    await tool.execute("call_upsert_1", {
      key: "favorite-food",
      text: "pizza",
      target: "longterm",
    });
    await tool.execute("call_upsert_2", {
      key: "favorite-food",
      text: "sushi",
      target: "longterm",
    });

    const content = await fs.readFile(path.join(workspace, "MEMORY.md"), "utf-8");
    expect(content).toContain("[key:favorite-food]");
    expect(content).toContain("sushi");
    expect(content).not.toContain("pizza");
    expect(content.match(/\[key:favorite-food\]/g)?.length).toBe(1);
  });

  it("memory_upsert preserves all concurrent keyed writes to the same file", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-memory-upsert-concurrent-"),
    );
    const cfg = configWithWorkspace(workspace);
    const tool = createMemoryUpsertTool({ config: cfg });
    expect(tool).not.toBeNull();
    if (!tool) {
      throw new Error("tool missing");
    }

    const count = 20;
    await Promise.all(
      Array.from({ length: count }, (_, index) =>
        tool.execute(`call_upsert_concurrent_${index}`, {
          key: `pref-${index}`,
          text: `value-${index}`,
          target: "longterm",
        }),
      ),
    );

    const content = await fs.readFile(path.join(workspace, "MEMORY.md"), "utf-8");
    for (let index = 0; index < count; index += 1) {
      expect(content).toContain(`[key:pref-${index}]`);
      expect(content).toContain(`value-${index}`);
    }
  });
});
