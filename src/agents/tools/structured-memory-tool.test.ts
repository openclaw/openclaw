import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeAllStructuredStores } from "../../memory/structured-store.js";
import {
  createMemoryCollectionsTool,
  createMemoryDeleteTool,
  createMemoryQueryTool,
  createMemoryStoreTool,
} from "./structured-memory-tool.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "struct-mem-tool-test-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", tmpDir);
});

afterEach(() => {
  closeAllStructuredStores();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function extractResult(result: { content: Array<{ text?: string }> }): unknown {
  const text = result.content.find((c) => c.text)?.text;
  return text ? JSON.parse(text) : undefined;
}

describe("structured memory tools", () => {
  const toolOpts = { agentSessionKey: undefined, config: undefined };

  describe("memory_store", () => {
    it("should store a value", async () => {
      const tool = createMemoryStoreTool(toolOpts)!;
      expect(tool).not.toBeNull();

      const result = await tool.execute("call-1", {
        collection: "users",
        key: "alice",
        value: { name: "Alice", age: 30 },
      });
      const data = extractResult(result) as { ok: boolean; collection: string; key: string };
      expect(data.ok).toBe(true);
      expect(data.collection).toBe("users");
      expect(data.key).toBe("alice");
    });

    it("should return error when value is missing", async () => {
      const tool = createMemoryStoreTool(toolOpts)!;
      const result = await tool.execute("call-1", {
        collection: "users",
        key: "alice",
      });
      const data = extractResult(result) as { ok: boolean; error: string };
      expect(data.ok).toBe(false);
      expect(data.error).toContain("value is required");
    });
  });

  describe("memory_query", () => {
    it("should query stored entries", async () => {
      const storeTool = createMemoryStoreTool(toolOpts)!;
      await storeTool.execute("c1", {
        collection: "items",
        key: "a",
        value: { type: "book", title: "Foo" },
      });
      await storeTool.execute("c2", {
        collection: "items",
        key: "b",
        value: { type: "video", title: "Bar" },
      });

      const queryTool = createMemoryQueryTool(toolOpts)!;
      const result = await queryTool.execute("c3", {
        collection: "items",
        filter: { type: "book" },
      });
      const data = extractResult(result) as { count: number; entries: unknown[] };
      expect(data.count).toBe(1);
      expect(data.entries).toHaveLength(1);
    });

    it("should return all entries without filter", async () => {
      const storeTool = createMemoryStoreTool(toolOpts)!;
      await storeTool.execute("c1", { collection: "x", key: "a", value: { v: 1 } });
      await storeTool.execute("c2", { collection: "x", key: "b", value: { v: 2 } });

      const queryTool = createMemoryQueryTool(toolOpts)!;
      const result = await queryTool.execute("c3", { collection: "x" });
      const data = extractResult(result) as { count: number };
      expect(data.count).toBe(2);
    });
  });

  describe("memory_delete", () => {
    it("should delete an entry", async () => {
      const storeTool = createMemoryStoreTool(toolOpts)!;
      await storeTool.execute("c1", { collection: "del", key: "a", value: { v: 1 } });

      const deleteTool = createMemoryDeleteTool(toolOpts)!;
      const result = await deleteTool.execute("c2", { collection: "del", key: "a" });
      const data = extractResult(result) as { ok: boolean; deleted: boolean };
      expect(data.ok).toBe(true);
      expect(data.deleted).toBe(true);
    });

    it("should report non-existent key", async () => {
      const deleteTool = createMemoryDeleteTool(toolOpts)!;
      const result = await deleteTool.execute("c1", { collection: "del", key: "ghost" });
      const data = extractResult(result) as { ok: boolean; deleted: boolean };
      expect(data.ok).toBe(true);
      expect(data.deleted).toBe(false);
    });
  });

  describe("memory_collections", () => {
    it("should list collections", async () => {
      const storeTool = createMemoryStoreTool(toolOpts)!;
      await storeTool.execute("c1", { collection: "a", key: "k1", value: 1 });
      await storeTool.execute("c2", { collection: "a", key: "k2", value: 2 });
      await storeTool.execute("c3", { collection: "b", key: "k1", value: 3 });

      const collTool = createMemoryCollectionsTool(toolOpts)!;
      const result = await collTool.execute("c4", {});
      const data = extractResult(result) as {
        collections: Array<{ collection: string; count: number }>;
      };
      expect(data.collections).toHaveLength(2);
      const sorted = data.collections.toSorted((a, b) => a.collection.localeCompare(b.collection));
      expect(sorted[0]).toEqual({ collection: "a", count: 2 });
      expect(sorted[1]).toEqual({ collection: "b", count: 1 });
    });

    it("should return empty when no data", async () => {
      const collTool = createMemoryCollectionsTool(toolOpts)!;
      const result = await collTool.execute("c1", {});
      const data = extractResult(result) as {
        collections: Array<{ collection: string; count: number }>;
      };
      expect(data.collections).toEqual([]);
    });
  });
});
