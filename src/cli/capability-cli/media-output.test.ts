// Tests for capability CLI media input/output helpers.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readInputFiles } from "./media-output.js";

describe("readInputFiles", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-media-input-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("reads a single input file into a buffer", async () => {
    const filePath = path.join(tmpDir, "input.png");
    const content = Buffer.from("fake-png-bytes");
    await fs.writeFile(filePath, content);

    const result = await readInputFiles([filePath]);

    expect(result).toHaveLength(1);
    expect(result[0]?.path).toBe(filePath);
    expect(result[0]?.buffer).toEqual(content);
  });

  it("reads multiple input files concurrently", async () => {
    const fileA = path.join(tmpDir, "a.png");
    const fileB = path.join(tmpDir, "b.png");
    await fs.writeFile(fileA, Buffer.from("file-a"));
    await fs.writeFile(fileB, Buffer.from("file-b"));

    const result = await readInputFiles([fileA, fileB]);

    expect(result).toHaveLength(2);
    const byPath = new Map(result.map((entry) => [entry.path, entry.buffer]));
    expect(byPath.get(fileA)).toEqual(Buffer.from("file-a"));
    expect(byPath.get(fileB)).toEqual(Buffer.from("file-b"));
  });

  it("rejects when the file cannot be opened", async () => {
    const missingPath = path.join(tmpDir, "missing.png");

    await expect(readInputFiles([missingPath])).rejects.toThrow();
  });
});
