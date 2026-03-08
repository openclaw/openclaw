import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  resetMemoryToolMockState,
  setMemoryReadFileImpl,
  setMemorySearchImpl,
} from "../../../test/helpers/memory-tool-manager-mock.js";
import type { OpenClawConfig } from "../../config/config.js";
import { ToolInputError } from "./common.js";
import {
  createMemoryGetTool,
  createMemorySearchTool,
  createMemoryUpsertTool,
  createMemoryWriteTool,
} from "./memory-tool.js";

function asOpenClawConfig(config: Partial<OpenClawConfig>): OpenClawConfig {
  return config as OpenClawConfig;
}

function createToolConfig() {
  return asOpenClawConfig({ agents: { list: [{ id: "main", default: true }] } });
}

function createMemoryGetToolOrThrow(config: OpenClawConfig = createToolConfig()) {
  const tool = createMemoryGetTool({ config });
  if (!tool) {
    throw new Error("tool missing");
  }
  return tool;
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

describe("memory_search unavailable payloads", () => {
  beforeEach(() => {
    resetMemoryToolMockState({ searchImpl: async () => [] });
  });

  it("returns explicit unavailable metadata for quota failures", async () => {
    setMemorySearchImpl(async () => {
      throw new Error("openai embeddings failed: 429 insufficient_quota");
    });

    const tool = createMemorySearchTool({
      config: { agents: { list: [{ id: "main", default: true }] } },
    });
    if (!tool) {
      throw new Error("tool missing");
    }

    const result = await tool.execute("quota", { query: "hello" });
    expect(result.details).toEqual({
      results: [],
      disabled: true,
      unavailable: true,
      error: "openai embeddings failed: 429 insufficient_quota",
      warning: "Memory search is unavailable because the embedding provider quota is exhausted.",
      action: "Top up or switch embedding provider, then retry memory_search.",
    });
  });

  it("returns explicit unavailable metadata for non-quota failures", async () => {
    setMemorySearchImpl(async () => {
      throw new Error("embedding provider timeout");
    });

    const tool = createMemorySearchTool({
      config: { agents: { list: [{ id: "main", default: true }] } },
    });
    if (!tool) {
      throw new Error("tool missing");
    }

    const result = await tool.execute("generic", { query: "hello" });
    expect(result.details).toEqual({
      results: [],
      disabled: true,
      unavailable: true,
      error: "embedding provider timeout",
      warning: "Memory search is unavailable due to an embedding/provider error.",
      action: "Check embedding provider configuration and retry memory_search.",
    });
  });
});

describe("memory tools", () => {
  it("does not throw when memory_get fails", async () => {
    setMemoryReadFileImpl(async () => {
      throw new Error("path required");
    });

    const tool = createMemoryGetToolOrThrow();

    const result = await tool.execute("call_2", { path: "memory/NOPE.md" });
    expect(result.details).toEqual({
      path: "memory/NOPE.md",
      text: "",
      disabled: true,
      error: "path required",
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

  it("memory_write inserts a separator when the file lacks a trailing newline", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-write-separator-"));
    await fs.mkdir(path.join(workspace, "memory"), { recursive: true });
    await fs.writeFile(
      path.join(workspace, "memory", "2026-02-18.md"),
      "- existing entry without newline",
      "utf-8",
    );
    const cfg = configWithWorkspace(workspace);
    const tool = createMemoryWriteTool({ config: cfg });
    expect(tool).not.toBeNull();
    if (!tool) {
      throw new Error("tool missing");
    }

    await tool.execute("call_write_separator", {
      text: "remember this",
      date: "2026-02-18",
    });

    const content = await fs.readFile(path.join(workspace, "memory", "2026-02-18.md"), "utf-8");
    expect(content).toBe("- existing entry without newline\n- remember this\n");
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

  it("memory_upsert collapses duplicate keyed entries down to one line", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-upsert-dedupe-"));
    await fs.writeFile(
      path.join(workspace, "MEMORY.md"),
      "- [key:favorite-food] pizza\n- [key:favorite-food] tacos\n",
      "utf-8",
    );
    const cfg = configWithWorkspace(workspace);
    const tool = createMemoryUpsertTool({ config: cfg });
    expect(tool).not.toBeNull();
    if (!tool) {
      throw new Error("tool missing");
    }

    await tool.execute("call_upsert_dedupe", {
      key: "favorite-food",
      text: "sushi",
      target: "longterm",
    });

    const content = await fs.readFile(path.join(workspace, "MEMORY.md"), "utf-8");
    expect(content).toBe("- [key:favorite-food] sushi\n");
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

  it("memory_write normalizes metadata into a single delimiter-safe line", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-write-meta-"));
    const cfg = configWithWorkspace(workspace);
    const tool = createMemoryWriteTool({ config: cfg });
    expect(tool).not.toBeNull();
    if (!tool) {
      throw new Error("tool missing");
    }

    await tool.execute("call_write_meta", {
      text: "remember this",
      date: "2026-02-18",
      kind: "preference,\nprimary",
      source: "user)\n- [key:evil] injected",
    });

    const content = await fs.readFile(path.join(workspace, "memory", "2026-02-18.md"), "utf-8");
    expect(content.split(/\r?\n/).filter(Boolean)).toHaveLength(1);
    expect(content).toContain("kind:preference primary");
    expect(content).toContain("source:user - key:evil injected");
    expect(content).not.toContain("[key:evil]");
  });

  it("memory_upsert does not allow metadata to inject extra keyed entries", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-upsert-meta-"));
    const cfg = configWithWorkspace(workspace);
    const tool = createMemoryUpsertTool({ config: cfg });
    expect(tool).not.toBeNull();
    if (!tool) {
      throw new Error("tool missing");
    }

    await tool.execute("call_upsert_meta", {
      key: "favorite-food",
      text: "pizza",
      target: "longterm",
      source: "user)\n- [key:evil] injected",
    });

    const content = await fs.readFile(path.join(workspace, "MEMORY.md"), "utf-8");
    expect(content.split(/\r?\n/).filter(Boolean)).toHaveLength(1);
    expect(content).toContain("[key:favorite-food]");
    expect(content).not.toContain("\n- [key:evil]");
  });

  it("memory_write escapes a leading key marker in freeform text", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-write-text-"));
    const cfg = configWithWorkspace(workspace);
    const tool = createMemoryWriteTool({ config: cfg });
    expect(tool).not.toBeNull();
    if (!tool) {
      throw new Error("tool missing");
    }

    await tool.execute("call_write_text_marker", {
      text: "[key:favorite-food] do not treat this as an upsert entry",
      target: "longterm",
    });

    const content = await fs.readFile(path.join(workspace, "MEMORY.md"), "utf-8");
    expect(content).toBe("- \\[key:favorite-food] do not treat this as an upsert entry\n");
  });

  it("memory_write surfaces invalid target/date as ToolInputError", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-write-invalid-"));
    const cfg = configWithWorkspace(workspace);
    const tool = createMemoryWriteTool({ config: cfg });
    expect(tool).not.toBeNull();
    if (!tool) {
      throw new Error("tool missing");
    }

    await expect(
      tool.execute("call_write_invalid_target", {
        text: "remember this",
        target: "weekly",
      }),
    ).rejects.toMatchObject({
      name: "ToolInputError",
      message: 'target must be "daily" or "longterm"',
    } satisfies Partial<ToolInputError>);

    await expect(
      tool.execute("call_write_invalid_date", {
        text: "remember this",
        target: "daily",
        date: "03-08-2026",
      }),
    ).rejects.toMatchObject({
      name: "ToolInputError",
      message: "date must be YYYY-MM-DD",
    } satisfies Partial<ToolInputError>);
  });

  it("memory_upsert surfaces invalid normalized keys as ToolInputError", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-upsert-invalid-"));
    const cfg = configWithWorkspace(workspace);
    const tool = createMemoryUpsertTool({ config: cfg });
    expect(tool).not.toBeNull();
    if (!tool) {
      throw new Error("tool missing");
    }

    await expect(
      tool.execute("call_upsert_invalid_key", {
        key: "!!!",
        text: "remember this",
      }),
    ).rejects.toMatchObject({
      name: "ToolInputError",
      message: "key is required",
    } satisfies Partial<ToolInputError>);
  });

  it("ignores incidental date values for longterm memory writes and upserts", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-longterm-date-"));
    const cfg = configWithWorkspace(workspace);
    const writeTool = createMemoryWriteTool({ config: cfg });
    const upsertTool = createMemoryUpsertTool({ config: cfg });
    expect(writeTool).not.toBeNull();
    expect(upsertTool).not.toBeNull();
    if (!writeTool || !upsertTool) {
      throw new Error("tool missing");
    }

    await expect(
      writeTool.execute("call_write_longterm_date", {
        text: "remember this",
        target: "longterm",
        date: "next week",
      }),
    ).resolves.toBeDefined();

    await expect(
      upsertTool.execute("call_upsert_longterm_date", {
        key: "favorite-food",
        text: "sushi",
        target: "longterm",
        date: "next week",
      }),
    ).resolves.toBeDefined();

    const content = await fs.readFile(path.join(workspace, "MEMORY.md"), "utf-8");
    expect(content).toContain("remember this");
    expect(content).toContain("[key:favorite-food]");
    expect(content).toContain("sushi");
  });
});
