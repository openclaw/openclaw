import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadJsonFile, saveJsonFile } from "./json-file.js";

describe("saveJsonFile", () => {
  it("writes valid JSON that can be loaded back", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "json-file-test-"));
    try {
      const filePath = path.join(dir, "test.json");
      const data = { version: 1, profiles: { "openai:default": { type: "api_key", key: "sk-test" } } };
      saveJsonFile(filePath, data);
      const loaded = loadJsonFile(filePath);
      expect(loaded).toEqual(data);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates parent directories if they do not exist", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "json-file-test-"));
    try {
      const filePath = path.join(dir, "nested", "deep", "test.json");
      saveJsonFile(filePath, { ok: true });
      expect(fs.existsSync(filePath)).toBe(true);
      const loaded = loadJsonFile(filePath);
      expect(loaded).toEqual({ ok: true });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not leave a .tmp file after successful write", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "json-file-test-"));
    try {
      const filePath = path.join(dir, "test.json");
      saveJsonFile(filePath, { hello: "world" });
      expect(fs.existsSync(`${filePath}.tmp`)).toBe(false);
      expect(fs.existsSync(filePath)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("atomically replaces existing file content", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "json-file-test-"));
    try {
      const filePath = path.join(dir, "test.json");
      saveJsonFile(filePath, { version: 1 });
      saveJsonFile(filePath, { version: 2 });
      const loaded = loadJsonFile(filePath);
      expect(loaded).toEqual({ version: 2 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("file is never empty or partial during overwrite", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "json-file-test-"));
    try {
      const filePath = path.join(dir, "test.json");
      const data = { key: "a".repeat(10_000) };
      saveJsonFile(filePath, data);

      // Overwrite with new data — the file should always be valid JSON
      const newData = { key: "b".repeat(10_000) };
      saveJsonFile(filePath, newData);

      const raw = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw);
      expect(parsed).toEqual(newData);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cleans up temp file if write fails", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "json-file-test-"));
    try {
      // Circular reference causes JSON.stringify to throw
      const circular: Record<string, unknown> = {};
      circular.self = circular;

      const filePath = path.join(dir, "test.json");
      expect(() => saveJsonFile(filePath, circular)).toThrow();
      expect(fs.existsSync(`${filePath}.tmp`)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves original file if write to temp fails", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "json-file-test-"));
    try {
      const filePath = path.join(dir, "test.json");
      const original = { preserved: true };
      saveJsonFile(filePath, original);

      // Circular reference causes JSON.stringify to throw
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      expect(() => saveJsonFile(filePath, circular)).toThrow();

      // Original file should be intact
      const loaded = loadJsonFile(filePath);
      expect(loaded).toEqual(original);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sets restrictive file permissions (0o600)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "json-file-test-"));
    try {
      const filePath = path.join(dir, "test.json");
      saveJsonFile(filePath, { secret: true });
      const stat = fs.statSync(filePath);
      // eslint-disable-next-line no-bitwise
      expect(stat.mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
