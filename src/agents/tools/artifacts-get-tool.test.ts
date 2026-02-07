import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createArtifactRegistry } from "../../artifacts/artifact-registry.js";
import { createArtifactsGetTool, __testing } from "./artifacts-get-tool.js";

async function withTempStateDir<T>(fn: (stateDir: string) => Promise<T>) {
  const previous = process.env.OPENCLAW_STATE_DIR;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-artifacts-get-"));
  process.env.OPENCLAW_STATE_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    if (previous === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previous;
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("artifacts.get tool", () => {
  it("rejects invalid ids", async () => {
    const tool = createArtifactsGetTool();
    await expect(tool.execute("call1", { id: "../nope" })).rejects.toThrow(
      /64-char lowercase hex sha256/i,
    );
    await expect(tool.execute("call2", { id: "A".repeat(64) })).rejects.toThrow(
      /64-char lowercase hex sha256/i,
    );

    expect(__testing.isSha256Hex("a".repeat(64))).toBe(true);
    expect(__testing.isSha256Hex("g".repeat(64))).toBe(false);
  });

  it("reads stored artifact and returns meta + content", async () => {
    await withTempStateDir(async (stateDir) => {
      const registry = createArtifactRegistry({ rootDir: path.join(stateDir, "artifacts") });
      const meta = await registry.storeText({ content: "hello world", mime: "text/plain" });

      const tool = createArtifactsGetTool();
      const result = await tool.execute("call1", { id: meta.id });

      expect(result.details).toBeDefined();
      const details = result.details as any;
      expect(details.meta).toEqual(meta);
      expect(details.content).toBe("hello world");
      expect(details.truncated).toBe(false);
    });
  });

  it("enforces truncation cap", async () => {
    await withTempStateDir(async (stateDir) => {
      const registry = createArtifactRegistry({ rootDir: path.join(stateDir, "artifacts") });
      const content = "x".repeat(__testing.DEFAULT_MAX_CHARS + 50);
      const meta = await registry.storeText({ content, mime: "text/plain" });

      const tool = createArtifactsGetTool();
      const result = await tool.execute("call1", { id: meta.id });
      const details = result.details as any;

      expect(details.meta.id).toBe(meta.id);
      expect(details.truncated).toBe(true);
      expect(details.maxChars).toBe(__testing.DEFAULT_MAX_CHARS);
      expect(details.originalChars).toBe(content.length);
      expect(details.content).toHaveLength(__testing.DEFAULT_MAX_CHARS);
      expect(details.note).toMatch(/truncated/i);
    });
  });
});
