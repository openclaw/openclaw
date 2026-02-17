import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readPartialText } from "./internal.js";

describe("readPartialText", () => {
  let tmpDir: string;
  let filePath: string;
  const lineCount = 100;
  const content = Array.from({ length: lineCount }, (_, i) => `Line ${i + 1}`).join("\n");

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-read-test-"));
    filePath = path.join(tmpDir, "test.md");
    await fs.writeFile(filePath, content, "utf-8");
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("reads full file when no range params given", async () => {
    const text = await readPartialText(filePath);
    expect(text).toBe(content);
  });

  it("reads from a specific start line to end", async () => {
    const text = await readPartialText(filePath, 5);
    const expected = content.split("\n").slice(4).join("\n");
    expect(text).toBe(expected);
  });

  it("reads a window of lines", async () => {
    const text = await readPartialText(filePath, 5, 10);
    const expected = content.split("\n").slice(4, 14).join("\n");
    expect(text).toBe(expected);
  });

  it("reads a single line", async () => {
    const text = await readPartialText(filePath, 100, 1);
    expect(text).toBe("Line 100");
  });

  it("returns empty string for out-of-bounds start", async () => {
    const text = await readPartialText(filePath, 200, 1);
    expect(text).toBe("");
  });

  it("clamps negative from to 1", async () => {
    const text = await readPartialText(filePath, -5, 2);
    const expected = content.split("\n").slice(0, 2).join("\n");
    expect(text).toBe(expected);
  });
});
