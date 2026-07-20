// Tests for capability CLI media input/output helpers.
import { execFileSync } from "node:child_process";
import { createWriteStream } from "node:fs";
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

  it("reads from a POSIX FIFO whose stat size is zero", async () => {
    // Windows does not support named pipes via mkfifo.
    if (process.platform === "win32") {
      return;
    }
    const fifoPath = path.join(tmpDir, "input.fifo");
    execFileSync("mkfifo", [fifoPath]);

    const content = Buffer.from("fifo-content");
    // A FIFO writer blocks until a reader opens the descriptor. Use a stream
    // so the reader can open concurrently without deadlocking the test.
    const writer = createWriteStream(fifoPath);
    writer.write(content);
    writer.end();

    const result = await readInputFiles([fifoPath]);

    expect(result).toHaveLength(1);
    expect(result[0]?.path).toBe(fifoPath);
    expect(result[0]?.buffer).toEqual(content);
  });
});
