import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildMultimodalChunkForIndexing,
  buildFileEntry,
  chunkMarkdown,
  isMemoryPath,
  listMemoryFiles,
  normalizeExtraMemoryPaths,
  remapChunkLines,
} from "./internal.js";
import {
  DEFAULT_MEMORY_MULTIMODAL_MAX_FILE_BYTES,
  type MemoryMultimodalSettings,
} from "./multimodal.js";

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

describe("isMemoryPath", () => {
  describe("without userId (isolation disabled)", () => {
    it("allows root MEMORY.md", () => {
      expect(isMemoryPath("MEMORY.md")).toBe(true);
      expect(isMemoryPath("memory.md")).toBe(true);
    });

    it("allows all memory/ subdirectories", () => {
      expect(isMemoryPath("memory/2024-01-01.md")).toBe(true);
      expect(isMemoryPath("memory/user123/2024-01-01.md")).toBe(true);
      expect(isMemoryPath("memory/any/subdir/file.md")).toBe(true);
    });
  });

  describe("with userId (isolation enabled)", () => {
    it("allows root MEMORY.md", () => {
      expect(isMemoryPath("MEMORY.md", "user1")).toBe(true);
      expect(isMemoryPath("memory.md", "user1")).toBe(true);
    });

    it("allows user's own memory directory", () => {
      expect(isMemoryPath("memory/user1/2024-01-01.md", "user1")).toBe(true);
      expect(isMemoryPath("memory/user1/subdir/notes.md", "user1")).toBe(true);
    });

    it("allows shared memory files at root level", () => {
      expect(isMemoryPath("memory/2024-01-01.md", "user1")).toBe(true);
      expect(isMemoryPath("memory/shared-notes.md", "user1")).toBe(true);
    });

    it("blocks other users' memory directories", () => {
      expect(isMemoryPath("memory/user2/2024-01-01.md", "user1")).toBe(false);
      expect(isMemoryPath("memory/other-user/file.md", "user1")).toBe(false);
    });

    it("blocks subdirectories under shared memory", () => {
      // When isolation is enabled, subdirectories under memory/ that are not the user's own
      // are considered potential user directories and are blocked
      expect(isMemoryPath("memory/subdir/file.md", "user1")).toBe(false);
    });
  });
});

describe("listMemoryFiles", () => {
  const getTmpDir = setupTempDirLifecycle("memory-test-");
  const multimodal: MemoryMultimodalSettings = {
    enabled: true,
    modalities: ["image", "audio"],
    maxFileBytes: DEFAULT_MEMORY_MULTIMODAL_MAX_FILE_BYTES,
  };

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

  it("includes image and audio files from extra paths when multimodal is enabled", async () => {
    const tmpDir = getTmpDir();
    const extraDir = path.join(tmpDir, "media");
    await fs.mkdir(extraDir, { recursive: true });
    await fs.writeFile(path.join(extraDir, "diagram.png"), Buffer.from("png"));
    await fs.writeFile(path.join(extraDir, "note.wav"), Buffer.from("wav"));
    await fs.writeFile(path.join(extraDir, "ignore.bin"), Buffer.from("bin"));

    const files = await listMemoryFiles(tmpDir, [extraDir], multimodal);
    expect(files.some((file) => file.endsWith("diagram.png"))).toBe(true);
    expect(files.some((file) => file.endsWith("note.wav"))).toBe(true);
    expect(files.some((file) => file.endsWith("ignore.bin"))).toBe(false);
  });

  describe("with userId (isolation enabled)", () => {
    const getTmpDir = setupTempDirLifecycle("memory-isolation-");

    it("includes user-specific memory files from memory/{userId}/", async () => {
      const tmpDir = getTmpDir();
      const userDir = path.join(tmpDir, "memory", "user1");
      await fs.mkdir(userDir, { recursive: true });
      await fs.writeFile(path.join(userDir, "2024-01-01.md"), "# User 1 note");
      await fs.writeFile(path.join(tmpDir, "MEMORY.md"), "# Default");

      const files = await listMemoryFiles(tmpDir, [], undefined, "user1");
      expect(files.some((f) => f.endsWith("MEMORY.md"))).toBe(true);
      expect(files.some((f) => f.endsWith("user1/2024-01-01.md"))).toBe(true);
    });

    it("includes shared memory files at root level", async () => {
      const tmpDir = getTmpDir();
      const memoryDir = path.join(tmpDir, "memory");
      await fs.mkdir(memoryDir, { recursive: true });
      await fs.writeFile(path.join(memoryDir, "shared.md"), "# Shared");
      await fs.writeFile(path.join(memoryDir, "2024-01-01.md"), "# Date note");
      await fs.writeFile(path.join(tmpDir, "MEMORY.md"), "# Default");

      const files = await listMemoryFiles(tmpDir, [], undefined, "user1");
      expect(files.some((f) => f.endsWith("MEMORY.md"))).toBe(true);
      expect(files.some((f) => f.endsWith("shared.md"))).toBe(true);
      expect(files.some((f) => f.endsWith("2024-01-01.md"))).toBe(true);
    });

    it("excludes other users' memory directories", async () => {
      const tmpDir = getTmpDir();
      const user1Dir = path.join(tmpDir, "memory", "user1");
      const user2Dir = path.join(tmpDir, "memory", "user2");
      await fs.mkdir(user1Dir, { recursive: true });
      await fs.mkdir(user2Dir, { recursive: true });
      await fs.writeFile(path.join(user1Dir, "note.md"), "# User 1");
      await fs.writeFile(path.join(user2Dir, "note.md"), "# User 2");
      await fs.writeFile(path.join(tmpDir, "MEMORY.md"), "# Default");

      const filesUser1 = await listMemoryFiles(tmpDir, [], undefined, "user1");
      expect(filesUser1.some((f) => f.endsWith("user1/note.md"))).toBe(true);
      expect(filesUser1.some((f) => f.endsWith("user2/note.md"))).toBe(false);

      const filesUser2 = await listMemoryFiles(tmpDir, [], undefined, "user2");
      expect(filesUser2.some((f) => f.endsWith("user2/note.md"))).toBe(true);
      expect(filesUser2.some((f) => f.endsWith("user1/note.md"))).toBe(false);
    });

    it("includes both user-specific and shared files together", async () => {
      const tmpDir = getTmpDir();
      const userDir = path.join(tmpDir, "memory", "user1");
      const memoryDir = path.join(tmpDir, "memory");
      await fs.mkdir(userDir, { recursive: true });
      await fs.writeFile(path.join(userDir, "private.md"), "# Private");
      await fs.writeFile(path.join(memoryDir, "shared.md"), "# Shared");
      await fs.writeFile(path.join(tmpDir, "MEMORY.md"), "# Default");

      const files = await listMemoryFiles(tmpDir, [], undefined, "user1");
      expect(files.some((f) => f.endsWith("MEMORY.md"))).toBe(true);
      expect(files.some((f) => f.endsWith("private.md"))).toBe(true);
      expect(files.some((f) => f.endsWith("shared.md"))).toBe(true);
    });

    it("handles missing user directory gracefully", async () => {
      const tmpDir = getTmpDir();
      const memoryDir = path.join(tmpDir, "memory");
      await fs.mkdir(memoryDir, { recursive: true });
      await fs.writeFile(path.join(memoryDir, "shared.md"), "# Shared");
      await fs.writeFile(path.join(tmpDir, "MEMORY.md"), "# Default");

      // User "nonexistent" has no directory
      const files = await listMemoryFiles(tmpDir, [], undefined, "nonexistent");
      expect(files.some((f) => f.endsWith("MEMORY.md"))).toBe(true);
      expect(files.some((f) => f.endsWith("shared.md"))).toBe(true);
      // Should not error, just skip user-specific files
    });
  });
});

describe("buildFileEntry", () => {
  const getTmpDir = setupTempDirLifecycle("memory-build-entry-");
  const multimodal: MemoryMultimodalSettings = {
    enabled: true,
    modalities: ["image", "audio"],
    maxFileBytes: DEFAULT_MEMORY_MULTIMODAL_MAX_FILE_BYTES,
  };

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

  it("returns multimodal metadata for eligible image files", async () => {
    const tmpDir = getTmpDir();
    const target = path.join(tmpDir, "diagram.png");
    await fs.writeFile(target, Buffer.from("png"));

    const entry = await buildFileEntry(target, tmpDir, multimodal);

    expect(entry).toMatchObject({
      path: "diagram.png",
      kind: "multimodal",
      modality: "image",
      mimeType: "image/png",
      contentText: "Image file: diagram.png",
    });
  });

  it("builds a multimodal chunk lazily for indexing", async () => {
    const tmpDir = getTmpDir();
    const target = path.join(tmpDir, "diagram.png");
    await fs.writeFile(target, Buffer.from("png"));

    const entry = await buildFileEntry(target, tmpDir, multimodal);
    const built = await buildMultimodalChunkForIndexing(entry!);

    expect(built?.chunk.embeddingInput?.parts).toEqual([
      { type: "text", text: "Image file: diagram.png" },
      expect.objectContaining({ type: "inline-data", mimeType: "image/png" }),
    ]);
    expect(built?.structuredInputBytes).toBeGreaterThan(0);
  });

  it("skips lazy multimodal indexing when the file grows after discovery", async () => {
    const tmpDir = getTmpDir();
    const target = path.join(tmpDir, "diagram.png");
    await fs.writeFile(target, Buffer.from("png"));

    const entry = await buildFileEntry(target, tmpDir, multimodal);
    await fs.writeFile(target, Buffer.alloc(entry!.size + 32, 1));

    await expect(buildMultimodalChunkForIndexing(entry!)).resolves.toBeNull();
  });

  it("skips lazy multimodal indexing when file bytes change after discovery", async () => {
    const tmpDir = getTmpDir();
    const target = path.join(tmpDir, "diagram.png");
    await fs.writeFile(target, Buffer.from("png"));

    const entry = await buildFileEntry(target, tmpDir, multimodal);
    await fs.writeFile(target, Buffer.from("gif"));

    await expect(buildMultimodalChunkForIndexing(entry!)).resolves.toBeNull();
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
