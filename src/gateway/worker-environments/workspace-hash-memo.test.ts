import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { importToolingTypeScript } from "../../../scripts/lib/import-tooling-typescript.mts";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { readActualWorkspaceManifestImpl } from "./workspace-actual-manifest.js";
import {
  MAX_WORKSPACE_HASH_MEMO_BYTES,
  MAX_WORKSPACE_HASH_MEMO_ENTRIES,
  pruneWorkspaceHashMemo,
  serializeRemoteWorkspaceHashMemo,
  withWorkspaceHashMemo,
  withWorkerWorkspaceHashMemo,
  workspaceStatIdentity,
  type WorkspaceHashMemo,
  type RemoteWorkspaceManifestEnvelope,
} from "./workspace-hash-memo.js";
import { prepareWorkspaceReconciliation } from "./workspace-manifest-comparison.js";
import { workspaceManifest } from "./workspace-manifest-fixtures.test-support.js";
import { preflightWorkspaceApply } from "./workspace-manifest-worker.js";

// Generate the wire script through the source runtime loader, which preserves
// function names. Vitest's own transform does not exercise that closure boundary.
const { REMOTE_WORKSPACE_MANIFEST_JS } = await importToolingTypeScript(
  new URL("./workspace-sync-scripts.ts", import.meta.url).href,
  import.meta.url,
);
if (typeof REMOTE_WORKSPACE_MANIFEST_JS !== "string") {
  throw new Error("Source workspace sync module did not export its manifest script");
}
const remoteWorkspaceManifestScript = REMOTE_WORKSPACE_MANIFEST_JS;

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it("rehashes recent files even when a same-size edit preserves the stat identity", async () => {
  const root = await fs.realpath(tempDirs.make("openclaw-recent-hash-memo-"));
  const target = path.join(root, "same-size.txt");
  await fs.writeFile(target, "alpha");
  const unchangedStat = await fs.stat(target, { bigint: true });
  vi.spyOn(Date, "now").mockReturnValue(Number(unchangedStat.ctimeNs / 1_000_000n));
  const lstat = fs.lstat.bind(fs);
  vi.spyOn(fs, "lstat").mockImplementation((...args) =>
    args[0] === target ? Promise.resolve(unchangedStat) : lstat(...args),
  );
  const open = fs.open.bind(fs);
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (args[0] === target) {
      vi.spyOn(handle, "stat").mockResolvedValue(unchangedStat);
    }
    return handle;
  });
  const memo: WorkspaceHashMemo = new Map();
  const metrics = hashMetrics();
  const capture = () =>
    withWorkspaceHashMemo(
      memo,
      () => readActualWorkspaceManifestImpl({ root, baseCommit: null }),
      metrics,
    );
  const first = await capture();
  await fs.writeFile(target, "bravo");
  const changed = await capture();
  expect(changed.manifestRef).not.toBe(first.manifestRef);
  expect(metrics).toEqual({ contentHashCount: 2, memoHitCount: 0 });
  expect(memo.size).toBe(0);
});

const hashMetrics = () => ({ contentHashCount: 0, memoHitCount: 0 });
function remoteCapture(workspace: string, home: string, script = remoteWorkspaceManifestScript) {
  return async (memo: [string, string][]): Promise<RemoteWorkspaceManifestEnvelope> => {
    const result = await runCommandWithTimeout(
      [process.execPath, "-e", script, workspace, "", "memo-v1"],
      { timeoutMs: 10_000, baseEnv: { ...process.env, HOME: home }, input: JSON.stringify(memo) },
    );
    expect(result).toMatchObject({ code: 0, stderr: "" });
    return JSON.parse(result.stdout) as RemoteWorkspaceManifestEnvelope;
  };
}
async function remoteFixture(script = remoteWorkspaceManifestScript) {
  const home = tempDirs.make("openclaw-remote-home-");
  const workspace = await fs.realpath(tempDirs.make("openclaw-remote-workspace-"));
  return {
    workspace,
    capture: remoteCapture(workspace, home, `Date.now = () => ${Date.now() + 60_000};\n${script}`),
  };
}

it("reuses content hashes only within one reconcile stat identity", async () => {
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
  const root = await fs.realpath(tempDirs.make("openclaw-workspace-hash-memo-"));
  const target = path.join(root, "same-size.txt");
  await fs.writeFile(target, "alpha");
  const memo = new Map<string, string>();
  const metrics = hashMetrics();
  const capture = () => readActualWorkspaceManifestImpl({ root, baseCommit: null });
  const replacedManifestRef = await withWorkspaceHashMemo(
    memo,
    async () => {
      const first = await capture();
      const unchanged = await withWorkspaceHashMemo(memo, capture);
      expect(unchanged.manifestRef).toBe(first.manifestRef);
      expect(metrics).toMatchObject({ contentHashCount: 1, memoHitCount: 1 });

      await fs.writeFile(target, "bravo");
      await fs.utimes(target, new Date(), new Date(Date.now() + 1_000));
      const changed = await capture();
      expect(changed.manifestRef).not.toBe(first.manifestRef);
      expect(metrics.contentHashCount).toBe(2);

      const replacement = path.join(root, "replacement.txt");
      await fs.writeFile(replacement, "cider");
      await fs.rename(replacement, target);
      const replaced = await capture();
      expect(replaced.manifestRef).not.toBe(changed.manifestRef);
      expect(metrics.contentHashCount).toBe(3);
      return replaced.manifestRef;
    },
    metrics,
  );

  const nextReconcileMetrics = hashMetrics();
  const nextReconcile = await withWorkspaceHashMemo(new Map(), capture, nextReconcileMetrics);
  expect(nextReconcile.manifestRef).toBe(replacedManifestRef);
  expect(nextReconcileMetrics).toMatchObject({ contentHashCount: 1, memoHitCount: 0 });
});

it("reuses local workspace nodes within one preflight but not across fences", async () => {
  const root = await fs.realpath(tempDirs.make("openclaw-workspace-preflight-memo-"));
  await fs.writeFile(path.join(root, "parent"), "base");
  const base = { ...workspaceManifest({ parent: "base" }), directories: [] };
  const current = {
    ...workspaceManifest({ "parent/child.txt": "worker", "parent/sibling.txt": "worker" }),
    directories: ["parent"],
  };
  const metrics = hashMetrics();
  const prepared = prepareWorkspaceReconciliation(base, current).preflight;
  const preflight = () => preflightWorkspaceApply({ root, ...prepared });
  const first = await withWorkspaceHashMemo(new Map(), preflight, metrics);
  expect([...first.applyPaths].toSorted()).toEqual([
    "parent",
    "parent/child.txt",
    "parent/sibling.txt",
  ]);
  expect(metrics).toMatchObject({ contentHashCount: 1, memoHitCount: 0 });

  await withWorkspaceHashMemo(new Map(), preflight, metrics);
  expect(metrics).toMatchObject({ contentHashCount: 2, memoHitCount: 0 });

  await fs.writeFile(path.join(root, "parent"), "local replacement");
  const conflict = await withWorkspaceHashMemo(new Map(), preflight, metrics);
  expect([...conflict.applyPaths]).toEqual([]);
  expect(conflict.conflictPaths).toEqual(["parent"]);
});

it("bounds a maximum-entry memo envelope", () => {
  const uint64 = "18446744073709551615";
  const memo = new Map<string, string>();
  for (let index = 0; index < MAX_WORKSPACE_HASH_MEMO_ENTRIES; index += 1) {
    const inode = String(index).padStart(20, "0");
    memo.set(
      `worker:${uint64}:${inode}:${uint64}:${uint64}:${uint64}`,
      index.toString(16).padStart(64, "0"),
    );
  }
  const envelopeBytes = Buffer.byteLength(
    `${JSON.stringify({
      version: 1,
      manifestRef: `sha256:${"f".repeat(64)}`,
      memo: JSON.parse(serializeRemoteWorkspaceHashMemo(memo)),
      metrics: {
        contentHashCount: MAX_WORKSPACE_HASH_MEMO_ENTRIES,
        memoHitCount: MAX_WORKSPACE_HASH_MEMO_ENTRIES,
        memoTruncatedCount: MAX_WORKSPACE_HASH_MEMO_ENTRIES,
      },
    })}\n`,
  );
  expect(envelopeBytes).toBeLessThan(MAX_WORKSPACE_HASH_MEMO_BYTES);
  expect(MAX_WORKSPACE_HASH_MEMO_BYTES - envelopeBytes).toBeGreaterThan(3 * 1024 * 1024);
  const smallFile = "worker:0:0:1:0:0";
  memo.set(smallFile, "c".repeat(64));
  const bounded = JSON.parse(serializeRemoteWorkspaceHashMemo(memo)) as [string, string][];
  expect(bounded).toHaveLength(MAX_WORKSPACE_HASH_MEMO_ENTRIES);
  expect(bounded.some(([identity]) => identity === smallFile)).toBe(false);
});

it("reuses hashes only for matching stat identities in one remote reconcile", async () => {
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
  const { workspace, capture } = await remoteFixture();
  const target = path.join(workspace, "same-size.txt");
  await fs.writeFile(target, "alpha");

  const first = await capture([]);
  expect(first.metrics).toMatchObject({ contentHashCount: 1, memoHitCount: 0 });
  const nodeMemo: WorkspaceHashMemo = new Map();
  await withWorkerWorkspaceHashMemo(nodeMemo, () =>
    readActualWorkspaceManifestImpl({ root: workspace, baseCommit: null }),
  );
  const nodeValidated = await capture([...nodeMemo]);
  expect(nodeValidated.manifestRef).toBe(first.manifestRef);
  expect(nodeValidated.metrics).toMatchObject({ contentHashCount: 0, memoHitCount: 1 });
  const unchanged = await capture(first.memo);
  expect(unchanged.manifestRef).toBe(first.manifestRef);
  expect(unchanged.metrics).toMatchObject({ contentHashCount: 0, memoHitCount: 1 });

  await fs.writeFile(target, "bravo");
  await fs.utimes(target, new Date(), new Date(Date.now() + 1_000));
  const changed = await capture(unchanged.memo);
  expect(changed.manifestRef).not.toBe(first.manifestRef);
  expect(changed.metrics).toMatchObject({ contentHashCount: 1, memoHitCount: 0 });

  const replacement = path.join(workspace, "replacement.txt");
  await fs.writeFile(replacement, "cider");
  await fs.rename(replacement, target);
  const replaced = await capture(changed.memo);
  expect(replaced.manifestRef).not.toBe(changed.manifestRef);
  expect(replaced.metrics).toMatchObject({ contentHashCount: 1, memoHitCount: 0 });

  const nextReconcile = await capture([]);
  expect(nextReconcile.manifestRef).toBe(replaced.manifestRef);
  expect(nextReconcile.metrics).toMatchObject({ contentHashCount: 1, memoHitCount: 0 });

  await fs.chmod(target, 0o755);
  const executable = await capture(replaced.memo);
  if (process.platform !== "win32") {
    expect(executable.manifestRef).not.toBe(replaced.manifestRef);
  }
  await fs.unlink(target);
  await fs.symlink("other.txt", target);
  const symlink = await capture(executable.memo);
  expect(symlink.manifestRef).not.toBe(executable.manifestRef);
  expect(symlink.metrics).toMatchObject({ contentHashCount: 0, memoHitCount: 0 });
});

it("does not import or return recent hashes in the standalone worker memo", async () => {
  const home = tempDirs.make("openclaw-remote-home-");
  const workspace = await fs.realpath(tempDirs.make("openclaw-remote-workspace-"));
  const target = path.join(workspace, "recent.txt");
  await fs.writeFile(target, "alpha");
  const stats = await fs.stat(target, { bigint: true });
  const capture = remoteCapture(
    workspace,
    home,
    `Date.now = () => ${Number(stats.ctimeNs / 1_000_000n)};\n${remoteWorkspaceManifestScript}`,
  );
  const response = await capture([[workspaceStatIdentity("worker", stats), "a".repeat(64)]]);
  expect(response.metrics).toMatchObject({ contentHashCount: 1, memoHitCount: 0 });
  expect(response.memo).toEqual([]);
});

it("bounds the remote memo to the largest files and reports truncation", async () => {
  const limitedScript = REMOTE_WORKSPACE_MANIFEST_JS.replace(
    `const MAX_WORKSPACE_HASH_MEMO_ENTRIES = ${MAX_WORKSPACE_HASH_MEMO_ENTRIES};`,
    "const MAX_WORKSPACE_HASH_MEMO_ENTRIES = 2;",
  );
  expect(limitedScript).not.toBe(REMOTE_WORKSPACE_MANIFEST_JS);
  const { workspace, capture } = await remoteFixture(limitedScript);
  await Promise.all([
    fs.writeFile(path.join(workspace, "small.txt"), "1"),
    fs.writeFile(path.join(workspace, "medium.txt"), "22"),
    fs.writeFile(path.join(workspace, "large.txt"), "333"),
  ]);

  const first = await capture([]);
  expect(
    first.memo
      .map(([identity]) => Number(identity.split(":")[3]))
      .toSorted((left, right) => left - right),
  ).toEqual([2, 3]);
  expect(first.metrics).toMatchObject({
    contentHashCount: 3,
    memoHitCount: 0,
    memoTruncatedCount: 1,
  });

  const unchanged = await capture(first.memo);
  expect(unchanged.manifestRef).toBe(first.manifestRef);
  expect(unchanged.memo).toEqual(first.memo);
  expect(unchanged.metrics).toMatchObject({
    contentHashCount: 1,
    memoHitCount: 2,
    memoTruncatedCount: 1,
  });
});
it("keeps a placement memo under the byte cap and clears one that exceeds it", () => {
  const retained: WorkspaceHashMemo = new Map([
    ["worker:1:2:3:4:5", "a".repeat(64)],
    ["gateway:1:2:3:4:5", "b".repeat(64)],
  ]);
  pruneWorkspaceHashMemo(retained);
  expect(retained.size).toBe(2);

  const digest = "c".repeat(64);
  const oversized: WorkspaceHashMemo = new Map();
  let bytes = 0;
  for (let index = 0; bytes <= MAX_WORKSPACE_HASH_MEMO_BYTES; index += 1) {
    const identity = `gateway:${index}:0:0:0:0`;
    oversized.set(identity, digest);
    bytes += identity.length + digest.length;
  }
  pruneWorkspaceHashMemo(oversized);
  expect(oversized.size).toBe(0);
});
