import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createAsyncLock, readJsonFile, writeJsonAtomic, writeTextAtomic } from "./json-files.js";

describe("json file helpers", () => {
  it("reads valid json and returns null for missing or invalid files", async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-json-files-"));
    const validPath = path.join(base, "valid.json");
    const invalidPath = path.join(base, "invalid.json");

    await fs.writeFile(validPath, '{"ok":true}', "utf8");
    await fs.writeFile(invalidPath, "{not-json}", "utf8");

    await expect(readJsonFile<{ ok: boolean }>(validPath)).resolves.toEqual({ ok: true });
    await expect(readJsonFile(invalidPath)).resolves.toBeNull();
    await expect(readJsonFile(path.join(base, "missing.json"))).resolves.toBeNull();
  });

  it("writes json atomically with pretty formatting and optional trailing newline", async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-json-files-"));
    const filePath = path.join(base, "nested", "config.json");

    await writeJsonAtomic(
      filePath,
      { ok: true, nested: { value: 1 } },
      { trailingNewline: true, ensureDirMode: 0o755 },
    );

    await expect(fs.readFile(filePath, "utf8")).resolves.toBe(
      '{\n  "ok": true,\n  "nested": {\n    "value": 1\n  }\n}\n',
    );
  });

  it("writes text atomically and avoids duplicate trailing newlines", async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-json-files-"));
    const filePath = path.join(base, "nested", "note.txt");

    await writeTextAtomic(filePath, "hello", { appendTrailingNewline: true });
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("hello\n");

    await writeTextAtomic(filePath, "hello\n", { appendTrailingNewline: true });
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("hello\n");
  });

  it("serializes async lock callers even across rejections", async () => {
    const withLock = createAsyncLock();
    const events: string[] = [];

    const first = withLock(async () => {
      events.push("first:start");
      await new Promise((resolve) => setTimeout(resolve, 20));
      events.push("first:end");
      throw new Error("boom");
    });

    const second = withLock(async () => {
      events.push("second:start");
      events.push("second:end");
      return "ok";
    });

    await expect(first).rejects.toThrow("boom");
    await expect(second).resolves.toBe("ok");
    expect(events).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });

  it("releases the async lock after synchronous throws", async () => {
    const withLock = createAsyncLock();
    const events: string[] = [];

    const first = withLock(async () => {
      events.push("first:start");
      throw new Error("sync boom");
    });

    const second = withLock(async () => {
      events.push("second:start");
      events.push("second:end");
      return "ok";
    });

    await expect(first).rejects.toThrow("sync boom");
    await expect(second).resolves.toBe("ok");
    expect(events).toEqual(["first:start", "second:start", "second:end"]);
  });
});
