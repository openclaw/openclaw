import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { chunkMarkdown, listMemoryFiles } from "./internal.js";

describe("listMemoryFiles", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("includes files from additional paths (directory)", async () => {
    // Create default memory file
    await fs.writeFile(path.join(tmpDir, "MEMORY.md"), "# Default memory");

    // Create additional directory with files
    const extraDir = path.join(tmpDir, "extra-notes");
    await fs.mkdir(extraDir, { recursive: true });
    await fs.writeFile(path.join(extraDir, "note1.md"), "# Note 1");
    await fs.writeFile(path.join(extraDir, "note2.md"), "# Note 2");
    await fs.writeFile(path.join(extraDir, "ignore.txt"), "Not a markdown file");

    const files = await listMemoryFiles(tmpDir, [extraDir]);
    expect(files).toHaveLength(3); // MEMORY.md + 2 notes
    expect(files.some((f) => f.endsWith("MEMORY.md"))).toBe(true);
    expect(files.some((f) => f.endsWith("note1.md"))).toBe(true);
    expect(files.some((f) => f.endsWith("note2.md"))).toBe(true);
    expect(files.some((f) => f.endsWith("ignore.txt"))).toBe(false);
  });

  it("includes files from additional paths (single file)", async () => {
    await fs.writeFile(path.join(tmpDir, "MEMORY.md"), "# Default memory");
    const singleFile = path.join(tmpDir, "standalone.md");
    await fs.writeFile(singleFile, "# Standalone");

    const files = await listMemoryFiles(tmpDir, [singleFile]);
    expect(files).toHaveLength(2);
    expect(files.some((f) => f.endsWith("standalone.md"))).toBe(true);
  });

  it("handles relative paths in additional paths", async () => {
    await fs.writeFile(path.join(tmpDir, "MEMORY.md"), "# Default memory");
    const extraDir = path.join(tmpDir, "subdir");
    await fs.mkdir(extraDir, { recursive: true });
    await fs.writeFile(path.join(extraDir, "nested.md"), "# Nested");

    // Use relative path
    const files = await listMemoryFiles(tmpDir, ["subdir"]);
    expect(files).toHaveLength(2);
    expect(files.some((f) => f.endsWith("nested.md"))).toBe(true);
  });

  it("ignores non-existent additional paths", async () => {
    await fs.writeFile(path.join(tmpDir, "MEMORY.md"), "# Default memory");

    const files = await listMemoryFiles(tmpDir, ["/does/not/exist"]);
    expect(files).toHaveLength(1);
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
