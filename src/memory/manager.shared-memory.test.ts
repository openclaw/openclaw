import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listMemoryFiles } from "./internal.js";

describe("shared memory: listMemoryFiles excludePaths", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "shared-mem-test-"));
    await fs.mkdir(path.join(tmpDir, "memory"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "MEMORY.md"), "# Memory");
    await fs.writeFile(path.join(tmpDir, "memory", "note1.md"), "note 1");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns all files when no excludePaths", async () => {
    const files = await listMemoryFiles(tmpDir);
    expect(files.length).toBeGreaterThanOrEqual(1);
  });

  it("excludes files under excludePaths directories", async () => {
    const sharedDir = path.join(tmpDir, "shared-docs");
    await fs.mkdir(sharedDir, { recursive: true });
    await fs.writeFile(path.join(sharedDir, "shared.md"), "shared note");

    const allFiles = await listMemoryFiles(tmpDir, [sharedDir]);
    expect(allFiles.some((f) => f.includes("shared.md"))).toBe(true);

    const filtered = await listMemoryFiles(tmpDir, [sharedDir], undefined, [sharedDir]);
    expect(filtered.some((f) => f.includes("shared.md"))).toBe(false);
  });

  it("excludes exact file match in excludePaths", async () => {
    const sharedFile = path.join(tmpDir, "memory", "note1.md");
    const allFiles = await listMemoryFiles(tmpDir);
    expect(allFiles.some((f) => f === sharedFile)).toBe(true);

    const filtered = await listMemoryFiles(tmpDir, undefined, undefined, [
      path.join(tmpDir, "memory"),
    ]);
    expect(filtered.some((f) => f === sharedFile)).toBe(false);
  });
});
