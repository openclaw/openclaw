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

function createDedupe(root: string, overrides?: { ttlMs?: number }) {
  return createPersistentDedupe({
    ttlMs: overrides?.ttlMs ?? 24 * 60 * 60 * 1000,
    memoryMaxSize: 100,
    fileMaxEntries: 1000,
    resolveFilePath: (namespace) => path.join(root, `${namespace}.json`),
  });
}

afterEach(async () => {
  await Promise.all(
    tmpRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("createPersistentDedupe", () => {
  it("deduplicates keys and persists across instances", async () => {
    const root = await makeTmpRoot();
    const first = createDedupe(root);
    expect(await first.checkAndRecord("m1", { namespace: "a" })).toBe(true);
    expect(await first.checkAndRecord("m1", { namespace: "a" })).toBe(false);

    const second = createDedupe(root);
    expect(await second.checkAndRecord("m1", { namespace: "a" })).toBe(false);
    expect(await second.checkAndRecord("m1", { namespace: "b" })).toBe(true);
  });

  it("guards concurrent calls for the same key", async () => {
    const root = await makeTmpRoot();
    const dedupe = createDedupe(root, { ttlMs: 10_000 });

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

  it("warmup loads persisted entries into memory", async () => {
    const root = await makeTmpRoot();
    const writer = createDedupe(root);
    expect(await writer.checkAndRecord("msg-1", { namespace: "acct" })).toBe(true);
    expect(await writer.checkAndRecord("msg-2", { namespace: "acct" })).toBe(true);

    const reader = createDedupe(root);
    const loaded = await reader.warmup("acct");
    expect(loaded).toBe(2);
    expect(await reader.checkAndRecord("msg-1", { namespace: "acct" })).toBe(false);
    expect(await reader.checkAndRecord("msg-2", { namespace: "acct" })).toBe(false);
    expect(await reader.checkAndRecord("msg-3", { namespace: "acct" })).toBe(true);
  });

  it.each([
    {
      name: "returns 0 when no disk file exists",
      setup: async (root: string) => createDedupe(root, { ttlMs: 10_000 }),
      namespace: "nonexistent",
      expectedLoaded: 0,
      verify: async () => undefined,
    },
    {
      name: "skips expired entries",
      setup: async (root: string) => {
        const writer = createDedupe(root, { ttlMs: 1000 });
        const oldNow = Date.now() - 2000;
        expect(await writer.checkAndRecord("old-msg", { namespace: "acct", now: oldNow })).toBe(
          true,
        );
        expect(await writer.checkAndRecord("new-msg", { namespace: "acct" })).toBe(true);
        return createDedupe(root, { ttlMs: 1000 });
      },
      namespace: "acct",
      expectedLoaded: 1,
      verify: async (reader: ReturnType<typeof createDedupe>) => {
        expect(await reader.checkAndRecord("old-msg", { namespace: "acct" })).toBe(true);
        expect(await reader.checkAndRecord("new-msg", { namespace: "acct" })).toBe(false);
      },
    },
  ])("warmup $name", async ({ setup, namespace, expectedLoaded, verify }) => {
    const root = await makeTmpRoot();
    const reader = await setup(root);
    const loaded = await reader.warmup(namespace);
    expect(loaded).toBe(expectedLoaded);
    await verify(reader);
  });
});
