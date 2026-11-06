import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveZstdCodec } from "../../infra/zstd-codec.js";
import { prepareLocalWorkspaceFingerprints } from "./local-workspace-fingerprints.js";
import {
  createLocalWorkspaceManifestTree,
  type LocalWorkspaceManifestNode,
  type LocalWorkspaceManifestRecord,
} from "./local-workspace-manifest-tree.js";
import { scanActualWorkspaceManifest } from "./workspace-actual-manifest.js";
import { withWorkspaceHashMemo } from "./workspace-hash-memo.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

type Baseline = {
  records: Map<string, LocalWorkspaceManifestRecord>;
  treeRoot: string;
  blob: Buffer | null;
};

async function capture(root: string, baseline?: Baseline, blob = baseline?.blob) {
  const nodes: LocalWorkspaceManifestNode[] = [];
  const metrics = { contentHashCount: 0, memoHitCount: 0 };
  const scanStartedAtMs = Date.now();
  const previous = baseline?.records ?? createLocalWorkspaceManifestTree([]);
  const fingerprints = prepareLocalWorkspaceFingerprints(
    previous,
    baseline?.treeRoot ?? previous.get("")!.treeRef,
    blob ?? null,
    scanStartedAtMs,
  );
  // A new memo on every capture models the loss of all in-process stat identities on restart.
  await withWorkspaceHashMemo(
    new Map(),
    () =>
      scanActualWorkspaceManifest({
        root,
        baseCommit: null,
        reuseFile: fingerprints.reuseFile,
        onEntry(node, identity) {
          nodes.push(node);
          if (identity) {
            fingerprints.observe(node.path, identity);
          }
        },
      }),
    metrics,
  );
  const records = createLocalWorkspaceManifestTree(nodes);
  const treeRoot = records.get("")!.treeRef;
  return {
    records,
    treeRoot,
    blob: fingerprints.encode(records, treeRoot),
    metrics,
  };
}

function mockFileCtime(ctimeNs: bigint) {
  const lstat = fs.lstat.bind(fs);
  vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
    const stats = await lstat(...args);
    Reflect.set(stats, "ctimeNs", ctimeNs);
    return stats;
  });
  const open = fs.open.bind(fs);
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    const stat = handle.stat.bind(handle);
    vi.spyOn(handle, "stat").mockImplementation(async (...statArgs) => {
      const stats = await stat(...statArgs);
      Reflect.set(stats, "ctimeNs", ctimeNs);
      return stats;
    });
    return handle;
  });
}

async function fixture(ctimeNs = 1n) {
  // Old timestamps isolate reuse/invalidation from the recent-write safety margin.
  mockFileCtime(ctimeNs);
  const root = await fs.realpath(dirs.make("workspace-fingerprints-"));
  await fs.mkdir(path.join(root, "a"));
  await fs.mkdir(path.join(root, "b"));
  await fs.writeFile(path.join(root, "a/file.txt"), "AAAA");
  await fs.writeFile(path.join(root, "b/file.txt"), "BBBB");
  return { root, baseline: await capture(root) };
}

it("hashes and reports same-size files swapped by ancestor-directory renames after restart", async () => {
  // Equal old ctimes require the path-to-inode check to detect the directory swap.
  const { root, baseline } = await fixture();
  const before = await fs.stat(path.join(root, "a/file.txt"), { bigint: true });
  await fs.rename(path.join(root, "a"), path.join(root, "temporary"));
  await fs.rename(path.join(root, "b"), path.join(root, "a"));
  await fs.rename(path.join(root, "temporary"), path.join(root, "b"));
  const after = await fs.stat(path.join(root, "b/file.txt"), { bigint: true });
  expect(after.ctimeNs).toBe(before.ctimeNs);
  const current = await capture(root, baseline);
  expect(current.metrics.contentHashCount).toBe(2);
  expect(current.treeRoot).not.toBe(baseline.treeRoot);
  expect(current.records.get("a/file.txt")!.node).toMatchObject({ sha256: hash("BBBB") });
  expect(current.records.get("b/file.txt")!.node).toMatchObject({ sha256: hash("AAAA") });
});

it("reuses unchanged file hashes with old identical ctimes after restart", async () => {
  const { root, baseline } = await fixture();
  const compress = vi.spyOn(resolveZstdCodec(), "compress");
  const unchanged = await capture(root, baseline);
  expect(unchanged.metrics.contentHashCount).toBe(0);
  expect(unchanged.treeRoot).toBe(baseline.treeRoot);
  expect(compress).not.toHaveBeenCalled();
  expect(unchanged.blob).toBe(baseline.blob);
});

it("re-encodes an unchanged tree when a file identity changes", async () => {
  const { root, baseline } = await fixture();
  vi.restoreAllMocks();
  mockFileCtime(2n);
  const compress = vi.spyOn(resolveZstdCodec(), "compress");
  const current = await capture(root, baseline);
  expect(current.treeRoot).toBe(baseline.treeRoot);
  expect(current.metrics.contentHashCount).toBe(2);
  expect(compress).toHaveBeenCalledTimes(1);
  expect(current.blob).not.toEqual(baseline.blob);
});

it("hashes a same-size edit with a recent identical ctime after restart", async () => {
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const { root, baseline } = await fixture(BigInt(now) * 1_000_000n);
  await fs.writeFile(path.join(root, "a/file.txt"), "CCCC");
  const modified = await capture(root, baseline);
  expect(modified.metrics.contentHashCount).toBe(2);
  expect(modified.records.get("a/file.txt")!.node).toMatchObject({ sha256: hash("CCCC") });
  expect(modified.treeRoot).not.toBe(baseline.treeRoot);

  now += 3_000;
  const compress = vi.spyOn(resolveZstdCodec(), "compress");
  const settled = await capture(root, modified);
  expect(settled.metrics.contentHashCount).toBe(2);
  expect(settled.treeRoot).toBe(modified.treeRoot);
  expect(compress).toHaveBeenCalledTimes(1);
  expect(settled.blob).not.toEqual(modified.blob);
  const reusable = await capture(root, settled);
  expect(reusable.metrics.contentHashCount).toBe(0);
  expect(reusable.treeRoot).toBe(modified.treeRoot);
});

it("ignores an older valid blob entirely after the baseline root changes", async () => {
  const { root, baseline } = await fixture();
  await fs.writeFile(path.join(root, "a/file.txt"), "CCCC");
  const current = await capture(root);
  expect(current.treeRoot).not.toBe(baseline.treeRoot);
  const restarted = await capture(root, current, baseline.blob);
  expect(restarted.metrics.contentHashCount).toBe(2);
  expect(restarted.treeRoot).toBe(current.treeRoot);
});

it.each(["wrong count", "truncated", "unsupported version", "different device"] as const)(
  "hashes every file when a fingerprint blob has a %s",
  async (defect) => {
    const { root, baseline } = await fixture();
    expect(baseline.blob).not.toBeNull();
    const codec = resolveZstdCodec();
    let bytes = codec.decompress(baseline.blob!);
    if (defect === "wrong count") {
      bytes.writeUInt32LE(1, 41);
    }
    if (defect === "truncated") {
      bytes = bytes.subarray(0, -1);
    }
    if (defect === "unsupported version") {
      bytes[0] = 2;
    }
    if (defect === "different device") {
      bytes.writeBigUInt64LE(bytes.readBigUInt64LE(1) + 1n, 1);
    }
    const current = await capture(root, baseline, codec.compress(bytes));
    expect(current.metrics.contentHashCount).toBe(2);
    expect(current.treeRoot).toBe(baseline.treeRoot);
  },
);

it("hashes every file for undecodable fingerprints", async () => {
  const { root, baseline } = await fixture();
  const current = await capture(root, baseline, Buffer.from("invalid zstd"));
  expect(current.metrics.contentHashCount).toBe(2);
  expect(current.treeRoot).toBe(baseline.treeRoot);
});

it("preserves v1 slots and exact u64 identities when file paths are added and removed", () => {
  const file = (entryPath: string): LocalWorkspaceManifestNode => ({
    path: entryPath,
    type: "file",
    mode: 0o644,
    size: 4,
    sha256: hash("AAAA"),
  });
  const baseline = createLocalWorkspaceManifestTree([file("b.txt"), file("d.txt")]);
  const treeRoot = baseline.get("")!.treeRef;
  const bytes = Buffer.alloc(77);
  bytes.writeUInt8(1, 0);
  bytes.writeBigUInt64LE(18446744073709551615n, 1);
  Buffer.from(treeRoot.slice(7), "hex").copy(bytes, 9);
  bytes.writeUInt32LE(2, 41);
  bytes.writeBigUInt64LE(9007199254740993n, 45);
  bytes.writeBigInt64LE(1n, 53);
  bytes.writeBigUInt64LE(9007199254740995n, 61);
  bytes.writeBigInt64LE(2n, 69);
  const codec = resolveZstdCodec();
  const scan = prepareLocalWorkspaceFingerprints(
    baseline,
    treeRoot,
    codec.compress(bytes),
    Date.now(),
  );
  const identity = "gateway:18446744073709551615:9007199254740993:4:0:1";
  expect(
    scan.reuseFile("b.txt", identity, {
      dev: 18446744073709551615n,
      ino: 9007199254740993n,
      size: 4n,
      ctimeNs: 1n,
    }),
  ).toBe(baseline.get("b.txt")!.node);
  scan.observe("b.txt", identity);
  scan.observe("a.txt", "gateway:18446744073709551615:9007199254740997:4:0:3");
  const current = createLocalWorkspaceManifestTree([file("b.txt"), file("a.txt")]);
  const currentRoot = current.get("")!.treeRef;
  Buffer.from(currentRoot.slice(7), "hex").copy(bytes, 9);
  bytes.writeBigUInt64LE(9007199254740997n, 45);
  bytes.writeBigInt64LE(3n, 53);
  bytes.writeBigUInt64LE(9007199254740993n, 61);
  bytes.writeBigInt64LE(1n, 69);
  expect(codec.decompress(scan.encode(current, currentRoot)!)).toEqual(bytes);
});
