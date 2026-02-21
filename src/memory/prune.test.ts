import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_MEMORY_WARN_CHARS, pruneMemoryFile, splitAtHeadingBoundary } from "./prune.js";

describe("splitAtHeadingBoundary", () => {
  it("returns full content when keepChars >= length", () => {
    const content = "# Title\n\nSome text\n";
    const [kept, archived] = splitAtHeadingBoundary(content, content.length + 100);
    expect(kept).toBe(content);
    expect(archived).toBe("");
  });

  it("splits at heading boundary before keepChars", () => {
    const content =
      "# Title\n\nFirst section\n\n## Second\n\nSecond text\n\n## Third\n\nThird text\n";
    const [kept, archived] = splitAtHeadingBoundary(content, 35);
    expect(kept).toBe("# Title\n\nFirst section\n\n");
    expect(archived).toBe("## Second\n\nSecond text\n\n## Third\n\nThird text\n");
  });

  it("falls back to newline boundary when no heading before keepChars", () => {
    const content = "Line one\nLine two\nLine three\nLine four\n";
    const [kept, archived] = splitAtHeadingBoundary(content, 20);
    expect(kept).toBe("Line one\nLine two\n");
    expect(archived).toBe("Line three\nLine four\n");
  });

  it("handles keepChars <= 0", () => {
    const content = "Some content";
    const [kept, archived] = splitAtHeadingBoundary(content, 0);
    expect(kept).toBe("");
    expect(archived).toBe("Some content");
  });
});

describe("pruneMemoryFile", () => {
  let tmpDir: string;
  let memoryFile: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "prune-test-"));
    memoryFile = path.join(tmpDir, "MEMORY.md");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns pruned: false when file is below threshold", async () => {
    const content = "# Small file\n\nNot much here.\n";
    await fs.writeFile(memoryFile, content, "utf-8");

    const result = await pruneMemoryFile({ filePath: memoryFile });
    expect(result.pruned).toBe(false);
    expect(result.originalChars).toBe(content.length);
    expect(result.keptChars).toBe(content.length);
    expect(result.archivedChars).toBe(0);
  });

  it("dry-run mode returns result without writing", async () => {
    const content = "# Title\n\n" + "x".repeat(DEFAULT_MEMORY_WARN_CHARS + 100) + "\n";
    await fs.writeFile(memoryFile, content, "utf-8");

    const result = await pruneMemoryFile({ filePath: memoryFile, dryRun: true });
    expect(result.pruned).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.archiveFilePath).toBeDefined();

    const afterContent = await fs.readFile(memoryFile, "utf-8");
    expect(afterContent).toBe(content);
  });

  it("splits at heading boundary correctly", async () => {
    const head = "# Title\n\nImportant stuff\n\n";
    const tail = "## Old Section\n\n" + "y".repeat(DEFAULT_MEMORY_WARN_CHARS) + "\n";
    const content = head + tail;
    await fs.writeFile(memoryFile, content, "utf-8");

    const result = await pruneMemoryFile({
      filePath: memoryFile,
      keepChars: head.length + 5,
      warnChars: 100,
    });
    expect(result.pruned).toBe(true);
    expect(result.dryRun).toBe(false);

    const keptContent = await fs.readFile(memoryFile, "utf-8");
    expect(keptContent).toBe(head);
    expect(result.archiveFilePath).toBeDefined();

    const archiveContent = await fs.readFile(result.archiveFilePath!, "utf-8");
    expect(archiveContent).toContain("## Archived from MEMORY.md on");
    expect(archiveContent).toContain(tail);
  });

  it("falls back to newline boundary when no heading before keepChars", async () => {
    const content = "Line one\nLine two\n" + "z".repeat(DEFAULT_MEMORY_WARN_CHARS + 100) + "\n";
    await fs.writeFile(memoryFile, content, "utf-8");

    const result = await pruneMemoryFile({
      filePath: memoryFile,
      keepChars: 15,
      warnChars: 100,
    });
    expect(result.pruned).toBe(true);
    const keptContent = await fs.readFile(memoryFile, "utf-8");
    expect(keptContent).toBe("Line one\n");
  });

  it("creates memory/ directory if missing", async () => {
    const content = "# Title\n\n## Old\n\n" + "a".repeat(200) + "\n";
    await fs.writeFile(memoryFile, content, "utf-8");

    const result = await pruneMemoryFile({
      filePath: memoryFile,
      keepChars: 12,
      warnChars: 50,
    });
    expect(result.pruned).toBe(true);
    expect(result.archiveFilePath).toBeDefined();

    const archiveStat = await fs.stat(result.archiveFilePath!);
    expect(archiveStat.isFile()).toBe(true);
  });

  it("appends to existing archive file", async () => {
    const archiveDir = path.join(tmpDir, "memory");
    await fs.mkdir(archiveDir, { recursive: true });
    const dateStr = new Date().toISOString().slice(0, 10);
    const archivePath = path.join(archiveDir, `${dateStr}-archived.md`);
    await fs.writeFile(archivePath, "## Previous archive\n\nOld stuff\n", "utf-8");

    const content = "# Title\n\n## Old\n\n" + "b".repeat(200) + "\n";
    await fs.writeFile(memoryFile, content, "utf-8");

    const result = await pruneMemoryFile({
      filePath: memoryFile,
      keepChars: 12,
      warnChars: 50,
    });
    expect(result.pruned).toBe(true);

    const archiveContent = await fs.readFile(archivePath, "utf-8");
    expect(archiveContent).toContain("## Previous archive");
    expect(archiveContent).toContain("## Archived from MEMORY.md on");
  });

  it("handles missing file gracefully", async () => {
    const result = await pruneMemoryFile({
      filePath: path.join(tmpDir, "nonexistent.md"),
    });
    expect(result.pruned).toBe(false);
    expect(result.originalChars).toBe(0);
  });

  it("handles empty file gracefully", async () => {
    await fs.writeFile(memoryFile, "", "utf-8");
    const result = await pruneMemoryFile({ filePath: memoryFile });
    expect(result.pruned).toBe(false);
    expect(result.originalChars).toBe(0);
    expect(result.keptChars).toBe(0);
  });
});
