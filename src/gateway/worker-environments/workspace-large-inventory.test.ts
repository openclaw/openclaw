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

const temporaryDirectory = (name: string) => tempDirs.make(`openclaw-${name}-`);
const numberedPaths = (prefix: string, count: number, width = 5) =>
  Array.from({ length: count }, (_, index) => `${prefix}-${index.toString().padStart(width, "0")}`);

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
async function stage(
  root: string,
  stagingRoot: string,
  stagedResultRef: string,
  base: ReturnType<typeof encodeManifest>,
  current: ReturnType<typeof encodeManifest>,
) {
  await workerWorkspaceResultStaging.stageWorkerWorkspaceResult({
    root,
    stagingRoot,
    stagedResultRef,
    baseManifestRef: base.ref,
    currentManifestRef: current.ref,
    baseManifestRaw: base.raw,
    currentManifestRaw: current.raw,
  });
}
function apply(
  root: string,
  stagedResultRef: string,
  expectedBaseManifestRef: string,
  journal = emptyJournal(),
) {
  return applyStagedWorkerWorkspaceResult({
    root,
    stagedResultRef,
    expectedBaseManifestRef,
    journal,
  });
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
  const baseBytes = Buffer.from(base.raw);
  const currentBytes = Buffer.from(current.raw);
  const message = Buffer.concat([
    Buffer.from(
      `OpenClaw worker workspace result\nversion 1\nbase-ref ${base.ref}\ncurrent-ref ${current.ref}\nbase-bytes ${baseBytes.byteLength}\ncurrent-bytes ${currentBytes.byteLength}\n\n`,
    ),
    baseBytes,
    currentBytes,
  ]);
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
  const local = temporaryDirectory("workspace-staged-v1-local");
  const complete = temporaryDirectory("workspace-staged-v1-complete");
  const baseContents = { "changed.txt": "base\n", "keep.txt": "keep\n" };
  const currentContents = { ...baseContents, "changed.txt": "worker\n" };
  for (const [name, contents] of Object.entries(baseContents)) {
    await fs.writeFile(path.join(local, name), contents);
  }
  for (const [name, contents] of Object.entries(currentContents)) {
    await fs.writeFile(path.join(complete, name), contents);
  }
  const base = encodeManifest(makeManifest(baseContents));
  const current = encodeManifest(makeManifest(currentContents));
  const ref = workerWorkspaceResultRef("claim-historical-v1");
  await git(local, "init", "--quiet");
  await stageHistoricalV1Result(local, complete, ref, base, current);
  await fs.writeFile(path.join(local, "keep.txt"), "local edit\n");

  const artifacts = await runGitWorkerOperation({
    type: "workspace.artifacts",
    input: { root: local, ref, previewPath: "changed.txt" },
  });
  expect(artifacts.changes).toEqual([
    { path: "changed.txt", status: "modified", additions: 0, deletions: 0 },
  ]);
  expect(Buffer.from(artifacts.preview!).toString()).toBe("worker\n");

  const result = await apply(local, ref, base.ref);
  expect(result.changed).toBe(true);
  await expect(fs.readFile(path.join(local, "changed.txt"), "utf8")).resolves.toBe("worker\n");
  await expect(fs.readFile(path.join(local, "keep.txt"), "utf8")).resolves.toBe("local edit\n");
});

it("recovers a converged shipped v1 deletion above the historical 25,000-record limit", async () => {
  const local = temporaryDirectory("workspace-staged-v1-converged-local");
  const baseManifest = fileManifest(
    numberedPaths("deleted", 25_001).map((name) => `${name}.txt`),
    "a",
  );
  const base = encodeManifest(baseManifest);
  const current = encodeManifest(makeManifest({}));
  const ref = workerWorkspaceResultRef("claim-historical-v1-converged");
  await git(local, "init", "--quiet");
  await stageHistoricalV1Result(local, local, ref, base, current);
  const begin = vi.fn(async () => {});

  const result = await apply(local, ref, base.ref, emptyJournal({ begin }));
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
  const local = temporaryDirectory("workspace-directory-entry-limit-local");
  const payload = temporaryDirectory("workspace-directory-entry-limit-payload");
  const directoryCount = 13_000;
  const manifest = (prefix: string) =>
    encodeManifest({
      ...makeManifest({}),
      directories: numberedPaths(prefix, directoryCount),
    });
  const base = manifest("base");
  const current = manifest("current");

  const stagedResultRef = workerWorkspaceResultRef("claim-directory-entry-limit");
  await stage(local, payload, stagedResultRef, base, current);
  const staged = await readStagedWorkerWorkspaceResult(local, stagedResultRef);
  expect(staged).toMatchObject({ changed: true, changedEntries: [] });
  expect(staged.base.directories).toHaveLength(directoryCount);
  expect(staged.current.directories).toHaveLength(directoryCount);
});

it("stages, applies, and recovers modified files across Git tree batches", async () => {
  const local = temporaryDirectory("workspace-modification-local");
  const payload = temporaryDirectory("workspace-modification-payload");
  // Cross writeRawWorkspaceTree's 256-entry batches with the smallest physical fixture.
  const paths = numberedPaths("changed", 257, 3).map((name) => `${name}.txt`);
  await Promise.all(
    paths.flatMap((entryPath) => [
      fs.writeFile(path.join(local, entryPath), "base\n"),
      fs.writeFile(path.join(payload, entryPath), "worker\n"),
    ]),
  );
  const baseManifest = fileManifest(paths, "base\n");
  const currentManifest = fileManifest(paths, "worker\n");
  const base = encodeManifest(baseManifest);
  const current = encodeManifest(currentManifest);
  const stagedResultRef = workerWorkspaceResultRef("claim-modification");
  await stage(local, payload, stagedResultRef, base, current);
  let serializedJournal: string | undefined;
  let basePack: Uint8Array | undefined;
  const committed = vi.fn(async () => {});
  const result = await apply(
    local,
    stagedResultRef,
    base.ref,
    emptyJournal({
      begin: async (journal) => {
        serializedJournal = serializeWorkerWorkspaceReconciliationPlan(journal);
        basePack = Uint8Array.from(journal.basePack);
      },
      commit: committed,
    }),
  );
  expect(result.conflictPaths).toEqual([]);
  expect(result.manifest.entries).toEqual(currentManifest.entries);
  expect(committed).toHaveBeenCalledWith(current.ref);
  expect(serializedJournal).toBeDefined();
  expect(basePack).toBeDefined();
  const journal: WorkerWorkspaceReconciliationJournal = {
    ...parseWorkerWorkspaceReconciliationPlan(serializedJournal!),
    basePack: basePack!,
  };
  expect(journal.baseEntries).toEqual(baseManifest.entries);
  expect(journal.appliedEntries).toEqual(currentManifest.entries);

  await recoverWorkerWorkspaceReconciliation({ root: local, journal });

  const contents = await Promise.all(
    paths.map((entryPath) => fs.readFile(path.join(local, entryPath), "utf8")),
  );
  expect(contents).toEqual(paths.map(() => "base\n"));
});

it("stages only a one-file delta for a 31,274-entry Git baseline", async () => {
  const local = temporaryDirectory("workspace-large-baseline-local");
  const payload = temporaryDirectory("workspace-large-baseline-payload");
  await git(local, "init", "--quiet");
  const baseContent = Buffer.from("base\n");
  const currentContent = Buffer.from("worker\n");
  await Promise.all([
    fs.writeFile(path.join(local, "changed.txt"), baseContent),
    fs.writeFile(path.join(payload, "changed.txt"), currentContent),
  ]);
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
  const base = encodeManifest(baseManifest);
  const current = encodeManifest(currentManifest);
  const ref = workerWorkspaceResultRef("claim-large-baseline");

  await stage(local, payload, ref, base, current);

  const artifacts = await runGitWorkerOperation({
    type: "workspace.artifacts",
    input: { root: local, ref, previewPath: "changed.txt" },
  });
  expect(artifacts).toEqual({
    baseManifestRef: base.ref,
    currentManifestRef: current.ref,
    base: { baseCommit: baseManifest.baseCommit },
    current: { baseCommit: currentManifest.baseCommit },
    changedEntries: [currentManifest.entries[0]],
    changes: [{ path: "changed.txt", status: "modified", additions: 0, deletions: 0 }],
    preview: new Uint8Array(currentContent),
  });

  const tree = await git(local, "ls-tree", "-r", "--name-only", ref);
  expect(tree).toMatchObject({ code: 0, stdout: "changed.txt\n" });
  const message = await git(local, "show", "-s", "--format=%B", ref);
  expect(message.stdout).toContain("version 2\n");
  const committed = vi.fn(async () => {});
  await apply(local, ref, base.ref, emptyJournal({ commit: committed }));
  expect(committed).toHaveBeenCalledOnce();
  await expect(fs.readFile(path.join(local, "changed.txt"), "utf8")).resolves.toBe("worker\n");

  const unchangedRef = workerWorkspaceResultRef("claim-large-baseline-unchanged");
  await stage(local, payload, unchangedRef, current, current);
  const unchangedTree = await git(local, "ls-tree", "-r", "--name-only", unchangedRef);
  expect(unchangedTree).toMatchObject({ code: 0, stdout: "" });
  const unchanged = await apply(local, unchangedRef, current.ref);
  expect(unchanged.changed).toBe(false);
});
