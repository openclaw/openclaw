import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { MemoryFileSummarizer, checkMemoryFileSizeThreshold, findLargeMemoryFiles } from "./memory-file-summarizer.js";

describe("MemoryFileSummarizer", () => {
  describe("checkMemoryFileSizeThreshold", () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = path.join(process.cwd(), `test-memory-${Date.now()}`);
      await fs.mkdir(tempDir, { recursive: true });
    });

    afterEach(async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    it("should return true for files exceeding threshold", async () => {
      const filePath = path.join(tempDir, "large.md");
      const largeContent = "x".repeat(2000);
      await fs.writeFile(filePath, largeContent);

      const result = await checkMemoryFileSizeThreshold(filePath, 1000);
      expect(result).toBe(true);
    });

    it("should return false for files below threshold", async () => {
      const filePath = path.join(tempDir, "small.md");
      await fs.writeFile(filePath, "small content");

      const result = await checkMemoryFileSizeThreshold(filePath, 1000);
      expect(result).toBe(false);
    });

    it("should return false for non-existent files", async () => {
      const result = await checkMemoryFileSizeThreshold("/nonexistent/file.md", 1000);
      expect(result).toBe(false);
    });
  });

  describe("findLargeMemoryFiles", () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = path.join(process.cwd(), `test-memory-find-${Date.now()}`);
      const memoryDir = path.join(tempDir, "memory");
      await fs.mkdir(memoryDir, { recursive: true });
    });

    afterEach(async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    it("should find files exceeding threshold", async () => {
      const memoryDir = path.join(tempDir, "memory");
      const largeFile = path.join(memoryDir, "large.md");
      await fs.writeFile(largeFile, "x".repeat(2000));

      const files = await findLargeMemoryFiles({
        workspaceDir: tempDir,
        thresholdBytes: 1000,
      });

      expect(files.length).toBe(1);
      expect(files[0]).toContain("large.md");
    });

    it("should respect maxFiles limit", async () => {
      const memoryDir = path.join(tempDir, "memory");
      for (let i = 0; i < 5; i++) {
        await fs.writeFile(path.join(memoryDir, `file${i}.md`), "x".repeat(2000));
      }

      const files = await findLargeMemoryFiles({
        workspaceDir: tempDir,
        thresholdBytes: 1000,
        maxFiles: 3,
      });

      expect(files.length).toBe(3);
    });

    it("should ignore non-markdown files", async () => {
      const memoryDir = path.join(tempDir, "memory");
      await fs.writeFile(path.join(memoryDir, "large.txt"), "x".repeat(2000));

      const files = await findLargeMemoryFiles({
        workspaceDir: tempDir,
        thresholdBytes: 1000,
      });

      expect(files.length).toBe(0);
    });

    it("should return empty array if no memory directory", async () => {
      const files = await findLargeMemoryFiles({
        workspaceDir: "/nonexistent",
        thresholdBytes: 1000,
      });

      expect(files).toEqual([]);
    });
  });

  describe("MemoryFileSummarizer class", () => {
    it("should refuse to summarize small files", async () => {
      const summarizer = new MemoryFileSummarizer({
        apiKey: "test-key",
        baseUrl: "https://api.anthropic.com/v1",
        model: "claude-sonnet-4-20250514",
      });

      const tempFile = path.join(process.cwd(), `test-small-${Date.now()}.md`);
      await fs.writeFile(tempFile, "small");

      const result = await summarizer.summarizeFile(tempFile);

      expect(result.success).toBe(false);
      expect(result.error).toContain("too small");

      await fs.unlink(tempFile);
    });

    it("should fail gracefully with invalid API key", async () => {
      const summarizer = new MemoryFileSummarizer({
        apiKey: "invalid-key",
        baseUrl: "https://api.anthropic.com/v1",
        model: "claude-sonnet-4-20250514",
      });

      const tempFile = path.join(process.cwd(), `test-large-${Date.now()}.md`);
      await fs.writeFile(tempFile, "x".repeat(2000));

      const result = await summarizer.summarizeFile(tempFile);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();

      await fs.unlink(tempFile);
    });
  });
});
