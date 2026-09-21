import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runGitWorkerOperation } from "../../infra/git-worker.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { withWorkspaceHashMemo } from "./workspace-hash-memo.js";
import {
  captureWorkspaceSnapshot,
  parseWorkspaceManifestPair,
} from "./workspace-manifest-worker.js";
import { readActualWorkspaceManifest } from "./workspace-reconcile-core.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it("does not create or return an implicit hash memo for an uncached capture", async () => {
  const root = await fs.realpath(tempDirs.make("workspace-uncached-capture-"));
  await fs.writeFile(path.join(root, "input.txt"), "uncached");
  const payload = new TextEncoder().encode(JSON.stringify({ root, baseCommit: null }));
  const result = await runGitWorkerOperation(
    { type: "workspace.manifest.capture", input: { payload } },
    { inputBytes: payload.byteLength },
  );
  expect(result.value.manifest.entries).toHaveLength(1);
  expect(result.hashes).toEqual([]);
  expect(result.metrics).toEqual({
    contentHashCount: 0,
    contentHashDurationMs: 0,
    memoHitCount: 0,
  });
});

it("captures eligible files outside the Gateway thread and returns the canonical bytes once", async () => {
  const root = await fs.realpath(tempDirs.make("workspace-worker-capture-"));
  const content = "worker computation";
  await fs.writeFile(path.join(root, "input.txt"), content);
  await fs.mkdir(path.join(root, "preserved", "node_modules"), { recursive: true });
  const selection = {
    root,
    baseCommit: null,
    includePaths: new Set(["input.txt", "preserved"]),
    preserveDirectories: new Set(["preserved"]),
  };
  const lstat = fs.lstat.bind(fs);
  vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
    if (String(args[0]).startsWith(root + path.sep)) {
      throw new Error("Workspace metadata ran on the Gateway thread");
    }
    return await lstat(...args);
  });
  const memo = new Map<string, string>();
  const metrics = { contentHashCount: 0, contentHashDurationMs: 0, memoHitCount: 0 };
  const capture = () =>
    withWorkspaceHashMemo(memo, () => readActualWorkspaceManifest(selection), metrics);
  const first = await capture();
  expect(first.manifest.entries).toEqual([
    {
      path: "input.txt",
      type: "file",
      mode: 0o644,
      size: Buffer.byteLength(content),
      sha256: createHash("sha256").update(content).digest("hex"),
    },
  ]);
  expect(first.manifest.directories).toEqual(["preserved"]);
  expect(Object.hasOwn(first, "rawManifest")).toBe(false);
  const snapshot = await withWorkspaceHashMemo(
    memo,
    () => captureWorkspaceSnapshot(selection),
    metrics,
  );
  expect({ manifest: snapshot.manifest, manifestRef: snapshot.manifestRef }).toEqual(first);
  expect(snapshot.manifestRef).toBe(
    `sha256:${createHash("sha256").update(snapshot.rawManifest).digest("hex")}`,
  );
  const empty = await readActualWorkspaceManifest({
    ...selection,
    includePaths: new Set<string>(),
  });
  expect(empty.manifest).toMatchObject({ entries: [], directories: [] });
  expect(metrics).toMatchObject({ contentHashCount: 1, memoHitCount: 1 });
});

it("authenticates both manifests before selecting changed transfer payloads", async () => {
  const encode = (entries: unknown[]) => {
    const raw = JSON.stringify({ version: 1, baseCommit: null, entries });
    return { raw, ref: `sha256:${createHash("sha256").update(raw).digest("hex")}` };
  };
  const entry = { path: "input.txt", type: "file", mode: 0o644, size: 1, sha256: "a".repeat(64) };
  const base = encode([entry]);
  const current = encode([{ ...entry, sha256: "b".repeat(64) }]);
  const input = {
    baseRaw: base.raw,
    baseRef: base.ref,
    currentRaw: current.raw,
    currentRef: current.ref,
  };
  const compared = await parseWorkspaceManifestPair(input);
  expect(compared).toMatchObject({
    changed: true,
    paths: ["input.txt"],
    entries: [{ ...entry, sha256: "b".repeat(64) }],
  });
  await expect(
    parseWorkspaceManifestPair({ ...input, currentRaw: current.raw + " " }),
  ).rejects.toThrow("digest");
});

it("admits a large rebase against its original synchronization manifest", async () => {
  const entries = (prefix: string, count: number, hash: string) =>
    Array.from({ length: count }, (_, index) => ({
      path: `${prefix}-${index}.ts`,
      type: "file" as const,
      mode: 0o644,
      size: 16 * 1024,
      sha256: hash.repeat(64),
    }));
  const encode = (values: ReturnType<typeof entries>) => {
    const raw = JSON.stringify({
      version: 1,
      baseCommit: "a".repeat(40),
      entries: values.toSorted((left, right) => (left.path < right.path ? -1 : 1)),
    });
    return { raw, ref: `sha256:${createHash("sha256").update(raw).digest("hex")}` };
  };
  // A rebase can leave Git clean while changing the full dispatched workspace.
  const base = encode([...entries("modified", 18_407, "a"), ...entries("deleted", 3_103, "a")]);
  const current = encode([...entries("modified", 18_407, "b"), ...entries("added", 17_395, "b")]);
  const result = await parseWorkspaceManifestPair({
    baseRaw: base.raw,
    baseRef: base.ref,
    currentRaw: current.raw,
    currentRef: current.ref,
  });
  expect(result.changed).toBe(true);
  expect(result.paths).toHaveLength(35_802);
  expect(
    result.entries.reduce((bytes, entry) => bytes + (entry.type === "file" ? entry.size : 0), 0),
  ).toBe(586_579_968);
});

it("admits a pair of manifests at the exact supported byte limit", async () => {
  // Keep this legal 128 MiB request outside the shared Vitest heap.
  const adapterUrl = new URL("./workspace-manifest-worker.ts", import.meta.url).href;
  const limitsUrl = new URL("./workspace-inventory-limits.ts", import.meta.url).href;
  const result = await runCommandWithTimeout(
    [
      process.execPath,
      "--import",
      "tsx/esm",
      "--input-type=module",
      "--eval",
      `
      import { createHash } from "node:crypto";
      import { parseWorkspaceManifestPair } from ${JSON.stringify(adapterUrl)};
      import { MAX_WORKSPACE_MANIFEST_BYTES } from ${JSON.stringify(limitsUrl)};
      const body = JSON.stringify({ version: 1, baseCommit: null, entries: [] });
      const raw = body + " ".repeat(MAX_WORKSPACE_MANIFEST_BYTES - Buffer.byteLength(body));
      const ref = "sha256:" + createHash("sha256").update(raw).digest("hex");
      const result = await parseWorkspaceManifestPair({ baseRaw: raw, baseRef: ref, currentRaw: raw, currentRef: ref });
      process.stdout.write(JSON.stringify({ changed: result.changed, paths: result.paths, entries: result.entries }));
    `,
    ],
    { timeoutMs: 60_000, maxOutputBytes: 64 * 1024, killProcessTree: true },
  );
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ changed: false, paths: [], entries: [] });
}, 60_000);

it("admits maximum legal path sets with a populated caller-owned hash memo", async () => {
  const root = tempDirs.make("workspace-path-boundary-");
  const adapterUrl = new URL("./workspace-manifest-worker.ts", import.meta.url).href;
  const memoUrl = new URL("./workspace-hash-memo.ts", import.meta.url).href;
  const limitsUrl = new URL("./workspace-inventory-limits.ts", import.meta.url).href;
  const result = await runCommandWithTimeout(
    [
      process.execPath,
      "--import",
      "tsx/esm",
      "--input-type=module",
      "--eval",
      `
      import { createHash } from "node:crypto";
      import { captureWorkspaceSnapshot } from ${JSON.stringify(adapterUrl)};
      import { withWorkspaceHashMemo, MAX_WORKSPACE_HASH_MEMO_BYTES } from ${JSON.stringify(memoUrl)};
      import { MAX_WORKSPACE_INVENTORY_ENTRIES, MAX_WORKSPACE_MANIFEST_BYTES } from ${JSON.stringify(limitsUrl)};
      const root = ${JSON.stringify(root)};
        const paths = Array.from({ length: MAX_WORKSPACE_INVENTORY_ENTRIES }, (_, index) => String(index).padStart(6, "0").padEnd(224, "x") + "Ā");
        const jsonBytes = Buffer.byteLength(JSON.stringify({ version: 1, baseCommit: null, entries: paths.map(path => ({ path, type: "directory", mode: 0o700 })) }));
        if (jsonBytes > MAX_WORKSPACE_MANIFEST_BYTES) throw new Error("fixture paths exceed the supported manifest size");
        const digest = createHash("sha256").update("").digest("hex");
        const seeds = Array.from({ length: 60_000 }, (_, index) => ["gateway:123456789:" + (1000000000 + index) + ":0:1780000000000000000:1780000000000000000", digest]);
        const memoBytes = seeds.reduce((total, [identity, value]) => total + identity.length + value.length, 0);
        if (memoBytes > MAX_WORKSPACE_HASH_MEMO_BYTES) throw new Error("fixture memo exceeds its supported size");
        const memo = new Map(seeds);
        const snapshot = await withWorkspaceHashMemo(memo, () => captureWorkspaceSnapshot({ root, baseCommit: null, includePaths: new Set(paths), preserveDirectories: new Set(paths) }));
        const unchanged = memo.size === seeds.length && seeds.every(([identity, value]) => memo.get(identity) === value);
        const canonical = snapshot.manifestRef === "sha256:" + createHash("sha256").update(snapshot.rawManifest).digest("hex");
        process.stdout.write(JSON.stringify({ entries: snapshot.manifest.entries.length, directories: snapshot.manifest.directories.length, unchanged, canonical, jsonBytes, memoBytes }));
    `,
    ],
    { timeoutMs: 120_000, maxOutputBytes: 64 * 1024, killProcessTree: true },
  );
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    entries: 0,
    directories: 0,
    unchanged: true,
    canonical: true,
    jsonBytes: 67_000_043,
    memoBytes: 8_040_000,
  });
}, 120_000);

it.each(["comparison", "overlay"] as const)(
  "admits maximum-entry decoded manifests for %s without an estimated-size rejection",
  async (operation) => {
    const adapterUrl = new URL("./workspace-manifest-worker.ts", import.meta.url).href;
    const limitsUrl = new URL("./workspace-inventory-limits.ts", import.meta.url).href;
    const stagingUrl = new URL("./workspace-result-staging.ts", import.meta.url).href;
    const result = await runCommandWithTimeout(
      [
        process.execPath,
        "--import",
        "tsx/esm",
        "--input-type=module",
        "--eval",
        `
        import { createHash } from "node:crypto";
        import { overlayWorkspaceManifest } from ${JSON.stringify(adapterUrl)};
        import { workerWorkspaceTransferPaths } from ${JSON.stringify(stagingUrl)};
        import { MAX_WORKSPACE_INVENTORY_ENTRIES, MAX_WORKSPACE_MANIFEST_BYTES } from ${JSON.stringify(limitsUrl)};
        const digest = createHash("sha256").update("").digest("hex");
        const base = { version: 1, baseCommit: null, entries: Array.from({ length: MAX_WORKSPACE_INVENTORY_ENTRIES }, (_, index) => ({
          path: String(index).padStart(6, "0").padEnd(140, "x") + "Ā", type: "file", mode: 0o644, size: 0, sha256: digest,
        })) };
        const jsonBytes = Buffer.byteLength(JSON.stringify(base));
        if (jsonBytes > MAX_WORKSPACE_MANIFEST_BYTES) throw new Error("fixture is not a supported manifest");
        const copy = () => ({ ...base, entries: base.entries.map(entry => ({ ...entry })) });
        const current = copy();
        current.entries.at(-1).mode = 0o755;
        const paths = ${JSON.stringify(operation)} === "comparison" ? workerWorkspaceTransferPaths(current, base) : [];
        const output = ${JSON.stringify(operation)} === "comparison"
          ? { changed: paths.length > 0, count: paths.length, mode: current.entries.find(entry => entry.path === paths[0])?.mode }
          : await overlayWorkspaceManifest(base, copy(), current).then(result => ({ changed: true, count: result.manifest.entries.length, mode: result.manifest.entries.at(-1)?.mode }));
        process.stdout.write(JSON.stringify({ ...output, jsonBytes }));
      `,
      ],
      { timeoutMs: 60_000, maxOutputBytes: 64 * 1024, killProcessTree: true },
    );
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      changed: true,
      count: operation === "comparison" ? 1 : 250_000,
      mode: 0o755,
      jsonBytes: 66_000_043,
    });
  },
  60_000,
);
