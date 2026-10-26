import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runGitWorkerOperation } from "../../infra/git-worker.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { drainGlobalSingletonLifecycleState } from "../../shared/global-singleton.js";
import {
  emptyJournal,
  workspaceManifest as makeManifest,
} from "./workspace-manifest-fixtures.test-support.js";
import {
  parseWorkerWorkspaceReconciliationPlan,
  serializeWorkerWorkspaceManifest,
  serializeWorkerWorkspaceReconciliationPlan,
  type WorkerWorkspaceManifest,
  type WorkerWorkspaceReconciliationJournal,
} from "./workspace-manifest.js";
import { recoverWorkerWorkspaceReconciliation } from "./workspace-reconcile.js";
import {
  applyStagedWorkerWorkspaceResult,
  readStagedWorkerWorkspaceResult,
  workerWorkspaceResultRef,
  workerWorkspaceResultStaging,
} from "./workspace-result-staging.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => drainGlobalSingletonLifecycleState());

const numberedPaths = (prefix: string, count: number, width = 5) =>
  Array.from({ length: count }, (_, index) => `${prefix}-${index.toString().padStart(width, "0")}`);
const writeFiles = (root: string, files: Record<string, string>) =>
  Promise.all(
    Object.entries(files).map(([name, content]) => fs.writeFile(path.join(root, name), content)),
  );
const changedFile = { path: "changed.txt", status: "modified", additions: 0, deletions: 0 };

function encodeManifest(value: WorkerWorkspaceManifest) {
  const raw = serializeWorkerWorkspaceManifest(value);
  return { manifest: value, raw, ref: `sha256:${createHash("sha256").update(raw).digest("hex")}` };
}

function fileManifest(paths: readonly string[], content: string): WorkerWorkspaceManifest {
  const value = makeManifest({ "template.txt": content });
  return {
    ...value,
    entries: paths.map((entryPath) => ({ ...value.entries[0]!, path: entryPath })),
  };
}
async function git(root: string, ...args: string[]) {
  const result = await runCommandWithTimeout(["git", "-C", root, ...args], { timeoutMs: 10_000 });
  expect(result.code, result.stderr).toBe(0);
  return result;
}
async function workspaceFixture(
  baseManifest: WorkerWorkspaceManifest,
  currentManifest: WorkerWorkspaceManifest,
  baseFiles: Record<string, string> = {},
  currentFiles: Record<string, string> = {},
) {
  const root = tempDirs.make("workspace-inventory-local-");
  const payload = tempDirs.make("workspace-inventory-payload-");
  await Promise.all([writeFiles(root, baseFiles), writeFiles(payload, currentFiles)]);
  const base = encodeManifest(baseManifest);
  const current = encodeManifest(currentManifest);
  const ref = workerWorkspaceResultRef("inventory");
  return {
    root,
    base,
    current,
    ref,
    stage: async (historical = false, nextBase = base, nextCurrent = current, nextRef = ref) => {
      if (historical) {
        await git(root, "init", "--quiet");
        return stageHistoricalV1Result(root, payload, nextRef, nextBase, nextCurrent);
      }
      return workerWorkspaceResultStaging.stageWorkerWorkspaceResult({
        root,
        stagingRoot: payload,
        stagedResultRef: nextRef,
        baseManifestRef: nextBase.ref,
        currentManifestRef: nextCurrent.ref,
        baseManifestRaw: nextBase.raw,
        currentManifestRaw: nextCurrent.raw,
      });
    },
    apply: (journal = emptyJournal(), expectedBaseManifestRef = base.ref, stagedResultRef = ref) =>
      applyStagedWorkerWorkspaceResult({ root, stagedResultRef, expectedBaseManifestRef, journal }),
    read: (name = "changed.txt") => fs.readFile(path.join(root, name), "utf8"),
    artifacts: () =>
      runGitWorkerOperation({
        type: "workspace.artifacts",
        input: { root, ref, previewPath: "changed.txt" },
      }),
  };
}

type EncodedManifest = ReturnType<typeof encodeManifest>;
async function stageHistoricalV1Result(
  root: string,
  resultRoot: string,
  ref: string,
  base: EncodedManifest,
  current: EncodedManifest,
): Promise<void> {
  const blobs = await Promise.all(
    current.manifest.entries.map(async (entry, index) => ({
      entry,
      mark: index + 1,
      content: await fs.readFile(path.join(resultRoot, entry.path)),
    })),
  );
  const message = Buffer.from(
    `OpenClaw worker workspace result\nversion 1\nbase-ref ${base.ref}\ncurrent-ref ${current.ref}\nbase-bytes ${Buffer.byteLength(base.raw)}\ncurrent-bytes ${Buffer.byteLength(current.raw)}\n\n${base.raw}${current.raw}`,
  );
  const chunks: Uint8Array[] = blobs.flatMap((blob) => [
    Buffer.from(`blob\nmark :${blob.mark}\ndata ${blob.content.byteLength}\n`),
    blob.content,
    Buffer.from("\n"),
  ]);
  chunks.push(
    Buffer.from(
      `commit ${ref}\nauthor OpenClaw <openclaw@localhost> 0 +0000\ncommitter OpenClaw <openclaw@localhost> 0 +0000\ndata ${message.byteLength}\n`,
    ),
    message,
    Buffer.from("\ndeleteall\n"),
    ...blobs.map((blob) => Buffer.from(`M 100644 :${blob.mark} ${blob.entry.path}\n`)),
    Buffer.from("done\n"),
  );
  const result = await runCommandWithTimeout(["git", "-C", root, "fast-import", "--quiet"], {
    timeoutMs: 10_000,
    input: Buffer.concat(chunks),
  });
  expect(result.code, result.stderr).toBe(0);
}

it("recovers the shipped v1 full tree while applying only changed entries", async () => {
  const baseContents = { "changed.txt": "base\n", "keep.txt": "keep\n" };
  const currentContents = { ...baseContents, "changed.txt": "worker\n" };
  const fixture = await workspaceFixture(
    makeManifest(baseContents),
    makeManifest(currentContents),
    baseContents,
    currentContents,
  );
  await fixture.stage(true);
  await fs.writeFile(path.join(fixture.root, "keep.txt"), "local edit\n");

  const resultArtifacts = await fixture.artifacts();
  expect(resultArtifacts.changes).toEqual([changedFile]);
  expect(Buffer.from(resultArtifacts.preview!).toString()).toBe("worker\n");

  const result = await fixture.apply();
  expect(result.changed).toBe(true);
  await expect(fixture.read()).resolves.toBe("worker\n");
  await expect(fixture.read("keep.txt")).resolves.toBe("local edit\n");
});

it("recovers a converged shipped v1 deletion above the historical 25,000-record limit", async () => {
  const fixture = await workspaceFixture(
    fileManifest(
      numberedPaths("deleted", 25_001).map((name) => `${name}.txt`),
      "a",
    ),
    makeManifest({}),
  );
  await fixture.stage(true);
  const begin = vi.fn(async () => {});

  const result = await fixture.apply(emptyJournal({ begin }));
  expect(result).toMatchObject({ changed: true, manifest: { entries: [] } });
  expect(begin).toHaveBeenCalledWith(
    expect.objectContaining({
      baseEntries: [],
      appliedEntries: [],
      baseDirectories: [],
      appliedDirectories: [],
    }),
  );
}, 30_000);

it("stages a directory-only v2 result above 25,000 reconciliation records", async () => {
  const directoryCount = 13_000;
  const manifest = (prefix: string) => ({
    ...makeManifest({}),
    directories: numberedPaths(prefix, directoryCount),
  });
  const fixture = await workspaceFixture(manifest("base"), manifest("current"));
  await fixture.stage();
  const staged = await readStagedWorkerWorkspaceResult(fixture.root, fixture.ref);
  expect(staged).toMatchObject({ changed: true, changedEntries: [] });
  expect(staged.base.directories).toHaveLength(directoryCount);
  expect(staged.current.directories).toHaveLength(directoryCount);
});

it("stages, applies, and recovers modified files across Git tree batches", async () => {
  // Cross writeRawWorkspaceTree's 256-entry batches with the smallest physical fixture.
  const paths = numberedPaths("changed", 257, 3).map((name) => `${name}.txt`);
  const baseManifest = fileManifest(paths, "base\n");
  const currentManifest = fileManifest(paths, "worker\n");
  const fixture = await workspaceFixture(
    baseManifest,
    currentManifest,
    Object.fromEntries(paths.map((name) => [name, "base\n"])),
    Object.fromEntries(paths.map((name) => [name, "worker\n"])),
  );
  await fixture.stage();
  let journal: WorkerWorkspaceReconciliationJournal | undefined;
  const committed = vi.fn(async () => {});
  const result = await fixture.apply(
    emptyJournal({
      begin: async (plan) => {
        journal = {
          ...parseWorkerWorkspaceReconciliationPlan(
            serializeWorkerWorkspaceReconciliationPlan(plan),
          ),
          basePack: Uint8Array.from(plan.basePack),
        };
      },
      commit: committed,
    }),
  );
  expect(result.conflictPaths).toEqual([]);
  expect(result.manifest.entries).toEqual(currentManifest.entries);
  expect(committed).toHaveBeenCalledWith(fixture.current.ref);
  expect(journal?.baseEntries).toEqual(baseManifest.entries);
  expect(journal?.appliedEntries).toEqual(currentManifest.entries);

  await recoverWorkerWorkspaceReconciliation({ root: fixture.root, journal: journal! });

  const contents = await Promise.all(paths.map((entryPath) => fixture.read(entryPath)));
  expect(contents).toEqual(paths.map(() => "base\n"));
});

it("stages only a one-file delta for a 31,274-entry Git baseline", async () => {
  const currentContent = Buffer.from("worker\n");
  const unchangedEntries = fileManifest(
    numberedPaths("file", 31_273).map((name) => `${name}.txt`),
    "unchanged",
  ).entries;
  const baseManifest = makeManifest({ "changed.txt": "base\n" }, "a".repeat(40));
  baseManifest.entries.push(...unchangedEntries);
  const currentManifest: WorkerWorkspaceManifest = {
    ...baseManifest,
    entries: [...makeManifest({ "changed.txt": "worker\n" }).entries, ...unchangedEntries],
  };
  const fixture = await workspaceFixture(
    baseManifest,
    currentManifest,
    { "changed.txt": "base\n" },
    { "changed.txt": "worker\n" },
  );
  const { root: local, base, current, ref } = fixture;
  await git(local, "init", "--quiet");
  await fixture.stage();

  expect(await fixture.artifacts()).toEqual({
    baseManifestRef: base.ref,
    currentManifestRef: current.ref,
    base: { baseCommit: baseManifest.baseCommit },
    current: { baseCommit: currentManifest.baseCommit },
    changedEntries: [currentManifest.entries[0]],
    changes: [changedFile],
    preview: new Uint8Array(currentContent),
  });

  expect((await git(local, "ls-tree", "-r", "--name-only", ref)).stdout).toBe("changed.txt\n");
  const message = await git(local, "show", "-s", "--format=%B", ref);
  expect(message.stdout).toContain("version 2\n");
  const committed = vi.fn(async () => {});
  await fixture.apply(emptyJournal({ commit: committed }));
  expect(committed).toHaveBeenCalledOnce();
  await expect(fixture.read()).resolves.toBe("worker\n");

  const unchangedRef = workerWorkspaceResultRef("claim-large-baseline-unchanged");
  await fixture.stage(false, current, current, unchangedRef);
  expect((await git(local, "ls-tree", "-r", "--name-only", unchangedRef)).stdout).toBe("");
  const unchanged = await fixture.apply(emptyJournal(), current.ref, unchangedRef);
  expect(unchanged.changed).toBe(false);
});
