import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPersistentDedupe } from "./persistent-dedupe.js";

const tmpRoots: string[] = [];

async function makeTmpRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-dedupe-"));
  tmpRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    tmpRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("createPersistentDedupe", () => {
  it("deduplicates keys and persists across instances", async () => {
    const root = await makeTmpRoot();
    const resolveFilePath = (namespace: string) => path.join(root, `${namespace}.json`);

    const first = createPersistentDedupe({
      ttlMs: 24 * 60 * 60 * 1000,
      memoryMaxSize: 100,
      fileMaxEntries: 1000,
      resolveFilePath,
    });
    expect(await first.checkAndRecord("m1", { namespace: "a" })).toBe(true);
    expect(await first.checkAndRecord("m1", { namespace: "a" })).toBe(false);

    const second = createPersistentDedupe({
      ttlMs: 24 * 60 * 60 * 1000,
      memoryMaxSize: 100,
      fileMaxEntries: 1000,
      resolveFilePath,
    });
    expect(await second.checkAndRecord("m1", { namespace: "a" })).toBe(false);
    expect(await second.checkAndRecord("m1", { namespace: "b" })).toBe(true);
  });

  it("guards concurrent calls for the same key", async () => {
    const root = await makeTmpRoot();
    const dedupe = createPersistentDedupe({
      ttlMs: 10_000,
      memoryMaxSize: 100,
      fileMaxEntries: 1000,
      resolveFilePath: (namespace) => path.join(root, `${namespace}.json`),
    });

    const [first, second] = await Promise.all([
      dedupe.checkAndRecord("race-key", { namespace: "feishu" }),
      dedupe.checkAndRecord("race-key", { namespace: "feishu" }),
    ]);
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it("falls back to memory-only behavior on disk errors", async () => {
    const dedupe = createPersistentDedupe({
      ttlMs: 10_000,
      memoryMaxSize: 100,
      fileMaxEntries: 1000,
      resolveFilePath: () => path.join("/dev/null", "dedupe.json"),
    });

    expect(await dedupe.checkAndRecord("memory-only", { namespace: "x" })).toBe(true);
    expect(await dedupe.checkAndRecord("memory-only", { namespace: "x" })).toBe(false);
  });
});
