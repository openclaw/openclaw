import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildFileEntry,
  chunkMarkdown,
  listMemoryFiles,
  normalizeExtraMemoryPaths,
  remapChunkLines,
} from "./internal.js";

function setupTempDirLifecycle(prefix: string): () => string {
  let tmpDir = "";
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
  return () => tmpDir;
}

describe("normalizeExtraMemoryPaths", () => {
  it("trims, resolves, and dedupes paths", () => {
    const workspaceDir = path.join(os.tmpdir(), "memory-test-workspace");
    const absPath = path.resolve(path.sep, "shared-notes");
    const result = normalizeExtraMemoryPaths(workspaceDir, [
      " notes ",
      "./notes",
      absPath,
      absPath,
      "",
    ]);
    expect(result).toEqual([path.resolve(workspaceDir, "notes"), absPath]);
  });
});

describe("listMemoryFiles", () => {
  const getTmpDir = setupTempDirLifecycle("memory-test-");

  it("includes files from additional paths (directory)", async () => {
    const tmpDir = getTmpDir();
    await fs.writeFile(path.join(tmpDir, "MEMORY.md"), "# Default memory");
    const extraDir = path.join(tmpDir, "extra-notes");
    await fs.mkdir(extraDir, { recursive: true });
    await fs.writeFile(path.join(extraDir, "note1.md"), "# Note 1");
    await fs.writeFile(path.join(extraDir, "note2.md"), "# Note 2");
    await fs.writeFile(path.join(extraDir, "ignore.txt"), "Not a markdown file");

    const files = await listMemoryFiles(tmpDir, [extraDir]);
    expect(files).toHaveLength(3);
    expect(files.some((file) => file.endsWith("MEMORY.md"))).toBe(true);
    expect(files.some((file) => file.endsWith("note1.md"))).toBe(true);
    expect(files.some((file) => file.endsWith("note2.md"))).toBe(true);
    expect(files.some((file) => file.endsWith("ignore.txt"))).toBe(false);
  });

  it("includes files from additional paths (single file)", async () => {
    const tmpDir = getTmpDir();
    await fs.writeFile(path.join(tmpDir, "MEMORY.md"), "# Default memory");
    const singleFile = path.join(tmpDir, "standalone.md");
    await fs.writeFile(singleFile, "# Standalone");

    const files = await listMemoryFiles(tmpDir, [singleFile]);
    expect(files).toHaveLength(2);
    expect(files.some((file) => file.endsWith("standalone.md"))).toBe(true);
  });

  it("handles relative paths in additional paths", async () => {
    const tmpDir = getTmpDir();
    await fs.writeFile(path.join(tmpDir, "MEMORY.md"), "# Default memory");
    const extraDir = path.join(tmpDir, "subdir");
    await fs.mkdir(extraDir, { recursive: true });
    await fs.writeFile(path.join(extraDir, "nested.md"), "# Nested");

    const files = await listMemoryFiles(tmpDir, ["subdir"]);
    expect(files).toHaveLength(2);
    expect(files.some((file) => file.endsWith("nested.md"))).toBe(true);
  });

  it("ignores non-existent additional paths", async () => {
    const tmpDir = getTmpDir();
    await fs.writeFile(path.join(tmpDir, "MEMORY.md"), "# Default memory");

    const files = await listMemoryFiles(tmpDir, ["/does/not/exist"]);
    expect(files).toHaveLength(1);
  });

  it("ignores symlinked files and directories", async () => {
    const tmpDir = getTmpDir();
    await fs.writeFile(path.join(tmpDir, "MEMORY.md"), "# Default memory");
    const extraDir = path.join(tmpDir, "extra");
    await fs.mkdir(extraDir, { recursive: true });
    await fs.writeFile(path.join(extraDir, "note.md"), "# Note");

    const targetFile = path.join(tmpDir, "target.md");
    await fs.writeFile(targetFile, "# Target");
    const linkFile = path.join(extraDir, "linked.md");

    const targetDir = path.join(tmpDir, "target-dir");
    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(path.join(targetDir, "nested.md"), "# Nested");
    const linkDir = path.join(tmpDir, "linked-dir");

    let symlinksOk = true;
    try {
      await fs.symlink(targetFile, linkFile, "file");
      await fs.symlink(targetDir, linkDir, "dir");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") {
        symlinksOk = false;
      } else {
        throw err;
      }
    }

    const files = await listMemoryFiles(tmpDir, [extraDir, linkDir]);
    expect(files.some((file) => file.endsWith("note.md"))).toBe(true);
    if (symlinksOk) {
      expect(files.some((file) => file.endsWith("linked.md"))).toBe(false);
      expect(files.some((file) => file.endsWith("nested.md"))).toBe(false);
    }
  });

  it("dedupes overlapping extra paths that resolve to the same file", async () => {
    const tmpDir = getTmpDir();
    await fs.writeFile(path.join(tmpDir, "MEMORY.md"), "# Default memory");
    const files = await listMemoryFiles(tmpDir, [tmpDir, ".", path.join(tmpDir, "MEMORY.md")]);
    const memoryMatches = files.filter((file) => file.endsWith("MEMORY.md"));
    expect(memoryMatches).toHaveLength(1);
  });
});

describe("buildFileEntry", () => {
  const getTmpDir = setupTempDirLifecycle("memory-build-entry-");

  it("returns null when the file disappears before reading", async () => {
    const tmpDir = getTmpDir();
    const target = path.join(tmpDir, "ghost.md");
    await fs.writeFile(target, "ghost", "utf-8");
    await fs.rm(target);
    const entry = await buildFileEntry(target, tmpDir);
    expect(entry).toBeNull();
  });

  it("returns metadata when the file exists", async () => {
    const tmpDir = getTmpDir();
    const target = path.join(tmpDir, "note.md");
    await fs.writeFile(target, "hello", "utf-8");
    const entry = await buildFileEntry(target, tmpDir);
    expect(entry).not.toBeNull();
    expect(entry?.path).toBe("note.md");
    expect(entry?.size).toBeGreaterThan(0);
  });
});

describe("chunkMarkdown", () => {
  it("splits overly long lines into max-sized chunks", () => {
    const chunkTokens = 400;
    const maxChars = chunkTokens * 4;
    const content = "a".repeat(maxChars * 3 + 25);
    const chunks = chunkMarkdown(content, { tokens: chunkTokens, overlap: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(maxChars);
    }
  });
});

describe("remapChunkLines", () => {
  it("remaps chunk line numbers using a lineMap", () => {
    // Simulate 5 content lines that came from JSONL lines [4, 6, 7, 10, 13] (1-indexed)
    const lineMap = [4, 6, 7, 10, 13];

    // Create chunks from content that has 5 lines
    const content = "User: Hello\nAssistant: Hi\nUser: Question\nAssistant: Answer\nUser: Thanks";
    const chunks = chunkMarkdown(content, { tokens: 400, overlap: 0 });
    expect(chunks.length).toBeGreaterThan(0);

    // Before remapping, startLine/endLine reference content line numbers (1-indexed)
    expect(chunks[0].startLine).toBe(1);

    // Remap
    remapChunkLines(chunks, lineMap);

    // After remapping, line numbers should reference original JSONL lines
    // Content line 1 → JSONL line 4, content line 5 → JSONL line 13
    expect(chunks[0].startLine).toBe(4);
    const lastChunk = chunks[chunks.length - 1];
    expect(lastChunk.endLine).toBe(13);
  });

  it("preserves original line numbers when lineMap is undefined", () => {
    const content = "Line one\nLine two\nLine three";
    const chunks = chunkMarkdown(content, { tokens: 400, overlap: 0 });
    const originalStart = chunks[0].startLine;
    const originalEnd = chunks[chunks.length - 1].endLine;

    remapChunkLines(chunks, undefined);

    expect(chunks[0].startLine).toBe(originalStart);
    expect(chunks[chunks.length - 1].endLine).toBe(originalEnd);
  });

  it("handles multi-chunk content with correct remapping", () => {
    // Use small chunk size to force multiple chunks
    // lineMap: 10 content lines from JSONL lines [2, 5, 8, 11, 14, 17, 20, 23, 26, 29]
    const lineMap = [2, 5, 8, 11, 14, 17, 20, 23, 26, 29];
    const contentLines = lineMap.map((_, i) =>
      i % 2 === 0 ? `User: Message ${i}` : `Assistant: Reply ${i}`,
    );
    const content = contentLines.join("\n");

    // Use very small chunk size to force splitting
    const chunks = chunkMarkdown(content, { tokens: 10, overlap: 0 });
    expect(chunks.length).toBeGreaterThan(1);

    remapChunkLines(chunks, lineMap);

    // First chunk should start at JSONL line 2
    expect(chunks[0].startLine).toBe(2);
    // Last chunk should end at JSONL line 29
    expect(chunks[chunks.length - 1].endLine).toBe(29);

    // Each chunk's startLine should be ≤ its endLine
    for (const chunk of chunks) {
      expect(chunk.startLine).toBeLessThanOrEqual(chunk.endLine);
    }
  });
});
