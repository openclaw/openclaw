import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { importToolingTypeScript } from "../../../scripts/lib/import-tooling-typescript.mts";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import {
  MAX_WORKSPACE_HASH_MEMO_BYTES,
  MAX_WORKSPACE_HASH_MEMO_ENTRIES,
  pruneWorkspaceHashMemo,
  serializeRemoteWorkspaceHashMemo,
  withWorkspaceHashMemo,
  withWorkerWorkspaceHashMemo,
  type WorkspaceHashMemo,
  type RemoteWorkspaceManifestEnvelope,
} from "./workspace-hash-memo.js";
import { prepareWorkspaceReconciliation } from "./workspace-manifest-comparison.js";
import { workspaceManifest } from "./workspace-manifest-fixtures.test-support.js";
import { captureWorkspaceManifest, preflightWorkspaceApply } from "./workspace-manifest-worker.js";

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

const hashMetrics = () => ({ contentHashCount: 0, memoHitCount: 0 });
async function remoteFixture(script = remoteWorkspaceManifestScript) {
  const home = tempDirs.make("openclaw-remote-home-");
  const workspace = await fs.realpath(tempDirs.make("openclaw-remote-workspace-"));
  const capture = async (memo: [string, string][]): Promise<RemoteWorkspaceManifestEnvelope> => {
    const result = await runCommandWithTimeout(
      [process.execPath, "-e", script, workspace, "", "memo-v1"],
      { timeoutMs: 10_000, baseEnv: { ...process.env, HOME: home }, input: JSON.stringify(memo) },
    );
    expect(result).toMatchObject({ code: 0, stderr: "" });
    return JSON.parse(result.stdout) as RemoteWorkspaceManifestEnvelope;
  };
  return { workspace, capture };
}
async function rewrite(target: string) {
  await fs.writeFile(target, "bravo");
  await fs.utimes(target, new Date(), new Date(Date.now() + 1_000));
}
async function replace(target: string) {
  const replacement = `${target}.replacement`;
  await fs.writeFile(replacement, "cider");
  await fs.rename(replacement, target);
}

it("reuses local preflight hashes only within matching stat identities and fences", async () => {
  const root = await fs.realpath(tempDirs.make("openclaw-workspace-preflight-memo-"));
  const target = path.join(root, "parent");
  await fs.writeFile(target, "alpha");
  const base = { ...workspaceManifest({ parent: "alpha" }), directories: [] };
  const current = {
    ...workspaceManifest({ "parent/child.txt": "worker", "parent/sibling.txt": "worker" }),
    directories: ["parent"],
  };
  const metrics = hashMetrics();
  const prepared = prepareWorkspaceReconciliation(base, current).preflight;
  const preflight = () => preflightWorkspaceApply({ root, ...prepared });
  const memo = new Map<string, string>();
  await withWorkspaceHashMemo(
    memo,
    async () => {
      const first = await preflight();
      expect([...first.applyPaths].toSorted()).toEqual([
        "parent",
        "parent/child.txt",
        "parent/sibling.txt",
      ]);
      expect(metrics).toMatchObject({ contentHashCount: 1, memoHitCount: 0 });
      expect(await withWorkspaceHashMemo(memo, preflight)).toEqual(first);
      expect(metrics).toMatchObject({ contentHashCount: 1, memoHitCount: 1 });
      for (const [index, mutate] of [rewrite, replace].entries()) {
        await mutate(target);
        const conflict = await preflight();
        expect([...conflict.applyPaths]).toEqual([]);
        expect(conflict.conflictPaths).toEqual(["parent"]);
        expect(metrics.contentHashCount).toBe(index + 2);
      }
    },
    metrics,
  );
  const nextMetrics = hashMetrics();
  const next = await withWorkspaceHashMemo(new Map(), preflight, nextMetrics);
  expect(next.conflictPaths).toEqual(["parent"]);
  expect(nextMetrics).toMatchObject({ contentHashCount: 1, memoHitCount: 0 });
});

it("bounds a maximum-entry memo envelope", () => {
  const uint64 = "18446744073709551615";
  const memo = new Map(
    Array.from({ length: MAX_WORKSPACE_HASH_MEMO_ENTRIES }, (_, index): [string, string] => [
      `worker:${uint64}:${String(index).padStart(20, "0")}:${uint64}:${uint64}:${uint64}`,
      index.toString(16).padStart(64, "0"),
    ]),
  );
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
  expect(MAX_WORKSPACE_HASH_MEMO_BYTES - envelopeBytes).toBeGreaterThan(3 * 1024 * 1024);
  const smallFile = "worker:0:0:1:0:0";
  memo.set(smallFile, "c".repeat(64));
  const bounded = JSON.parse(serializeRemoteWorkspaceHashMemo(memo)) as [string, string][];
  expect(bounded).toHaveLength(MAX_WORKSPACE_HASH_MEMO_ENTRIES);
  expect(bounded.some(([identity]) => identity === smallFile)).toBe(false);
});

it("reuses hashes only for matching stat identities in one remote reconcile", async () => {
  const { workspace, capture } = await remoteFixture();
  const target = path.join(workspace, "same-size.txt");
  await fs.writeFile(target, "alpha");

  const first = await capture([]);
  expect(first.metrics).toMatchObject({ contentHashCount: 1, memoHitCount: 0 });
  const nodeMemo: WorkspaceHashMemo = new Map();
  await withWorkerWorkspaceHashMemo(nodeMemo, () =>
    captureWorkspaceManifest({ root: workspace, baseCommit: null }),
  );
  const nodeValidated = await capture([...nodeMemo]);
  expect(nodeValidated.manifestRef).toBe(first.manifestRef);
  expect(nodeValidated.metrics).toMatchObject({ contentHashCount: 0, memoHitCount: 1 });
  const unchanged = await capture(first.memo);
  expect(unchanged.manifestRef).toBe(first.manifestRef);
  expect(unchanged.metrics).toMatchObject({ contentHashCount: 0, memoHitCount: 1 });
  let replaced = unchanged;
  for (const mutate of [rewrite, replace]) {
    await mutate(target);
    const changed = await capture(replaced.memo);
    expect(changed.manifestRef).not.toBe(replaced.manifestRef);
    expect(changed.metrics).toMatchObject({ contentHashCount: 1, memoHitCount: 0 });
    replaced = changed;
  }

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

it("bounds the remote memo to the largest files and reports truncation", async () => {
  const limitedScript = REMOTE_WORKSPACE_MANIFEST_JS.replace(
    `const MAX_WORKSPACE_HASH_MEMO_ENTRIES = ${MAX_WORKSPACE_HASH_MEMO_ENTRIES};`,
    "const MAX_WORKSPACE_HASH_MEMO_ENTRIES = 2;",
  );
  expect(limitedScript).not.toBe(REMOTE_WORKSPACE_MANIFEST_JS);
  const { workspace, capture } = await remoteFixture(limitedScript);
  await Promise.all(
    ["1", "22", "333"].map((content, index) =>
      fs.writeFile(path.join(workspace, `${index}.txt`), content),
    ),
  );

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
