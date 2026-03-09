import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadJsonFile, saveJsonFile } from "./json-file.js";

describe("saveJsonFile", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "json-file-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes valid JSON that loadJsonFile can read back", () => {
    const filePath = path.join(tmpDir, "test.json");
    const data = { version: 1, profiles: { "openai:default": { type: "api_key", key: "sk-test" } } };
    saveJsonFile(filePath, data);
    const loaded = loadJsonFile(filePath);
    expect(loaded).toEqual(data);
  });

  it("creates parent directories when they do not exist", () => {
    const filePath = path.join(tmpDir, "a", "b", "test.json");
    saveJsonFile(filePath, { ok: true });
    expect(loadJsonFile(filePath)).toEqual({ ok: true });
  });

  it("overwrites existing file atomically", () => {
    const filePath = path.join(tmpDir, "test.json");
    saveJsonFile(filePath, { version: 1 });
    saveJsonFile(filePath, { version: 2 });
    expect(loadJsonFile(filePath)).toEqual({ version: 2 });
  });

  it("does not leave temp files on success", () => {
    const filePath = path.join(tmpDir, "test.json");
    saveJsonFile(filePath, { ok: true });
    const files = fs.readdirSync(tmpDir);
    expect(files).toEqual(["test.json"]);
  });

  it("cleans up temp file and re-throws when writeFileSync fails", () => {
    const filePath = path.join(tmpDir, "test.json");
    // Make the directory read-only after mkdir to cause writeFileSync to fail
    // on the temp file.
    const spy = vi.spyOn(fs, "writeFileSync").mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    expect(() => saveJsonFile(filePath, { ok: true })).toThrow("disk full");
    spy.mockRestore();
    // No temp files should remain.
    const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".tmp"));
    expect(files).toHaveLength(0);
  });

  it("sets file permissions to 0o600", () => {
    const filePath = path.join(tmpDir, "test.json");
    saveJsonFile(filePath, { secure: true });
    const stat = fs.statSync(filePath);
    // Mask with 0o777 to ignore sticky/setuid bits.
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("produces parseable JSON after many rapid sequential writes", () => {
    const filePath = path.join(tmpDir, "rapid.json");
    for (let i = 0; i < 50; i++) {
      saveJsonFile(filePath, { iteration: i, data: "x".repeat(200) });
    }
    const result = loadJsonFile(filePath) as { iteration: number };
    expect(result.iteration).toBe(49);
    // Verify the file is valid JSON by reading raw content.
    const raw = fs.readFileSync(filePath, "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});

describe("loadJsonFile", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "json-file-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns undefined for non-existent file", () => {
    expect(loadJsonFile(path.join(tmpDir, "nope.json"))).toBeUndefined();
  });

  it("returns undefined for invalid JSON", () => {
    const filePath = path.join(tmpDir, "bad.json");
    fs.writeFileSync(filePath, "not json {{{");
    expect(loadJsonFile(filePath)).toBeUndefined();
  });
});
