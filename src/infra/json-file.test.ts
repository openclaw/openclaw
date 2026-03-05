import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadJsonFile, saveJsonFile } from "./json-file.js";

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "json-file-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("json-file", () => {
  it("reads existing JSON without an existsSync preflight", () => {
    const dir = createTempDir();
    const file = path.join(dir, "cache.json");
    fs.writeFileSync(file, '{"ok":true}\n', "utf8");

    const existsSpy = vi.spyOn(fs, "existsSync");
    expect(loadJsonFile(file)).toEqual({ ok: true });
    expect(existsSpy).not.toHaveBeenCalled();
  });

  it("returns undefined for missing files without an existsSync preflight", () => {
    const dir = createTempDir();
    const file = path.join(dir, "missing.json");

    const existsSpy = vi.spyOn(fs, "existsSync");
    expect(loadJsonFile(file)).toBeUndefined();
    expect(existsSpy).not.toHaveBeenCalled();
  });

  it("creates parent directories and writes JSON without existsSync", () => {
    const dir = createTempDir();
    const file = path.join(dir, "nested", "cache.json");

    const existsSpy = vi.spyOn(fs, "existsSync");
    saveJsonFile(file, { count: 1 });

    expect(existsSpy).not.toHaveBeenCalled();
    expect(loadJsonFile(file)).toEqual({ count: 1 });
  });
});
