import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { saveJsonFile } from "./json-file.js";

const isWindows = process.platform === "win32";

describe("saveJsonFile", () => {
  const tmpFiles: string[] = [];

  function tmpPath(name: string): string {
    const p = path.join(os.tmpdir(), `openclaw-json-test-${Date.now()}-${name}.json`);
    tmpFiles.push(p);
    return p;
  }

  afterEach(() => {
    for (const f of tmpFiles) {
      try {
        fs.unlinkSync(f);
      } catch {
        // ignore
      }
    }
    tmpFiles.length = 0;
  });

  it.skipIf(isWindows)("creates file with 0o600 permissions", () => {
    const filePath = tmpPath("perms");
    saveJsonFile(filePath, { key: "secret" });

    const stat = fs.statSync(filePath);
    // mode & 0o777 gives the permission bits
    const perms = stat.mode & 0o777;
    expect(perms).toBe(0o600);
  });

  it("writes valid JSON content", () => {
    const filePath = tmpPath("content");
    const data = { hello: "world", nested: { a: 1 } };
    saveJsonFile(filePath, data);

    const raw = fs.readFileSync(filePath, "utf8");
    expect(JSON.parse(raw)).toEqual(data);
  });

  it.skipIf(isWindows)("overwrites existing file and keeps 0o600 permissions", () => {
    const filePath = tmpPath("overwrite");

    // Create file with wider permissions first
    fs.writeFileSync(filePath, "{}", { mode: 0o644 });
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o644);

    // saveJsonFile should fix permissions
    saveJsonFile(filePath, { updated: true });
    const perms = fs.statSync(filePath).mode & 0o777;
    expect(perms).toBe(0o600);
  });

  it.skipIf(isWindows)("creates parent directories with 0o700 permissions", () => {
    const dir = path.join(os.tmpdir(), `openclaw-json-test-${Date.now()}-nested`);
    const filePath = path.join(dir, "deep", "file.json");
    tmpFiles.push(filePath);

    saveJsonFile(filePath, { ok: true });

    expect(fs.existsSync(filePath)).toBe(true);
    const dirStat = fs.statSync(path.join(dir, "deep"));
    expect(dirStat.mode & 0o777).toBe(0o700);

    // cleanup nested dirs
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
