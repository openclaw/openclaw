import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readJsonFile, writeJsonAtomic } from "./json-files.js";

describe("json-files", () => {
  let fixtureRoot: string;

  afterEach(async () => {
    if (fixtureRoot) {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  describe("writeJsonAtomic", () => {
    it("writes JSON and reads it back", async () => {
      fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-json-files-"));
      const filePath = path.join(fixtureRoot, "test.json");
      const data = { foo: "bar", n: 42 };

      await writeJsonAtomic(filePath, data);

      const result = await readJsonFile<typeof data>(filePath);
      expect(result).toEqual(data);
    });

    it("creates parent directories", async () => {
      fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-json-files-"));
      const filePath = path.join(fixtureRoot, "nested", "deep", "test.json");

      await writeJsonAtomic(filePath, { ok: true });

      const result = await readJsonFile<{ ok: boolean }>(filePath);
      expect(result).toEqual({ ok: true });
    });

    it.skipIf(process.platform === "win32")("sets file mode from options", async () => {
      fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-json-files-"));
      const filePath = path.join(fixtureRoot, "secure.json");

      await writeJsonAtomic(filePath, { secret: true }, { mode: 0o600 });

      const stat = await fs.stat(filePath);
      // eslint-disable-next-line no-bitwise
      expect(stat.mode & 0o777).toBe(0o600);
    });

    it.skipIf(process.platform === "win32")("applies dirMode to created directories", async () => {
      fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-json-files-"));
      const nested = path.join(fixtureRoot, "restricted-dir");
      const filePath = path.join(nested, "data.json");

      await writeJsonAtomic(filePath, { v: 1 }, { dirMode: 0o700 });

      const dirStat = await fs.stat(nested);
      // eslint-disable-next-line no-bitwise
      expect(dirStat.mode & 0o777).toBe(0o700);
    });

    it("overwrites existing file atomically", async () => {
      fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-json-files-"));
      const filePath = path.join(fixtureRoot, "overwrite.json");

      await writeJsonAtomic(filePath, { version: 1 });
      await writeJsonAtomic(filePath, { version: 2 });

      const result = await readJsonFile<{ version: number }>(filePath);
      expect(result).toEqual({ version: 2 });
    });

    it("leaves no temp files after successful write", async () => {
      fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-json-files-"));
      const filePath = path.join(fixtureRoot, "clean.json");

      await writeJsonAtomic(filePath, { ok: true });

      const files = await fs.readdir(fixtureRoot);
      expect(files).toEqual(["clean.json"]);
    });
  });

  describe("readJsonFile", () => {
    it("returns null for missing files", async () => {
      const result = await readJsonFile("/tmp/does-not-exist-ever.json");
      expect(result).toBeNull();
    });

    it("returns null for invalid JSON", async () => {
      fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-json-files-"));
      const filePath = path.join(fixtureRoot, "bad.json");
      await fs.writeFile(filePath, "not json {{{", "utf-8");

      const result = await readJsonFile(filePath);
      expect(result).toBeNull();
    });
  });
});
