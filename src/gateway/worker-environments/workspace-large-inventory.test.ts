import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { EMPTY_WORKTREE_INITIAL_COMMIT_ID } from "../../agents/worktrees/empty-source-identity.js";
import { runGitWorkerOperation } from "../../infra/git-worker.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { drainGlobalSingletonLifecycleState } from "../../shared/global-singleton.js";
import { resolveGitHubPublicationFailure } from "../github-publication-failure.js";
import {
  emptyJournal,
  workspaceManifest as makeManifest,
} from "./workspace-manifest-fixtures.test-support.js";
import {
  computeWorkspaceManifest,
  loadStagedWorkspaceManifest,
  parseWorkspaceManifestPair,
} from "./workspace-manifest-worker.js";
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
  withStagedWorkerWorkspaceManifest,
  workerWorkspaceResultRef,
  workerWorkspaceResultStaging,
  workerWorkspaceTransferPaths,
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
        return stageHistoricalResult(root, payload, nextRef, nextBase, nextCurrent);
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

it("does not treat an ordinary worker result as an initial source import", async () => {
  const fixture = await workspaceFixture(
    { ...makeManifest({}), baseCommit: EMPTY_WORKTREE_INITIAL_COMMIT_ID },
    {
      ...makeManifest({}),
      baseCommit: "a".repeat(40),
      directories: numberedPaths("added", 50_001),
    },
  );
  await expect(fixture.stage()).rejects.toMatchObject({ code: "WORKSPACE_RESULT_LIMIT" });
});

async function stageHistoricalResult(
  root: string,
  resultRoot: string,
  ref: string,
  base: EncodedManifest,
  current: EncodedManifest,
  version: 1 | 2 | 3 = 1,
): Promise<void> {
  const blobs = await Promise.all(
    current.manifest.entries.map(async (entry, index) => ({
      entry,
      mark: index + 1,
      content: await fs.readFile(path.join(resultRoot, entry.path)),
    })),
  );
  const history =
    version === 3
      ? `\ngit-history ${JSON.stringify({ baseCommit: base.manifest.baseCommit, headCommit: base.manifest.baseCommit, descendsFromBase: false, unavailableReason: "Historical checkpoint without a Git export" })}`
      : "";
  const message = Buffer.from(
    `OpenClaw worker workspace result\nversion ${version}\nbase-ref ${base.ref}\ncurrent-ref ${current.ref}\nbase-bytes ${Buffer.byteLength(base.raw)}\ncurrent-bytes ${Buffer.byteLength(current.raw)}${history}\n\n${base.raw}${current.raw}`,
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

it.each([2, 3] as const)(
  "restores a previously accepted v%i checkpoint above the new admission limit",
  async (version) => {
    const root = tempDirs.make("workspace-accepted-large-");
    const payload = tempDirs.make("workspace-accepted-payload-");
    const baseCommit = "a".repeat(40);
    const base = encodeManifest({
      ...fileManifest(numberedPaths("deleted", 50_000), "a"),
      baseCommit,
    });
    const current = encodeManifest({
      ...makeManifest({ "saved.txt": "retained guest work\n" }),
      baseCommit,
    });
    const ref = workerWorkspaceResultRef("previously-accepted");
    await fs.writeFile(path.join(payload, "saved.txt"), "retained guest work\n");
    const source = {
      root,
      stagingRoot: payload,
      stagedResultRef: ref,
      baseManifestRaw: base.raw,
      baseManifestRef: base.ref,
      currentManifestRaw: current.raw,
      currentManifestRef: current.ref,
    };
    const failure: unknown = await workerWorkspaceResultStaging
      .stageWorkerWorkspaceResult(source)
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failure).toMatchObject({
      code: "WORKSPACE_RESULT_LIMIT",
      message: expect.stringContaining("50001"),
    });
    expect(resolveGitHubPublicationFailure(failure)).toMatchObject({
      code: "workspace_changed",
      nextAction: expect.stringContaining(".gitignore"),
    });
    await stageHistoricalResult(root, payload, ref, base, current, version);
    await withStagedWorkerWorkspaceManifest({ root, stagedResultRef: ref }, async (snapshot) => {
      expect(await fs.readFile(path.join(snapshot.stagingRoot, "saved.txt"), "utf8")).toBe(
        "retained guest work\n",
      );
      expect(workerWorkspaceTransferPaths(snapshot.current, snapshot.base)).toEqual(["saved.txt"]);
    });
    await expect(
      computeWorkspaceManifest({
        type: "workspace.manifest.result",
        input: { root, ref, verifyContents: true },
      }),
    ).resolves.toMatchObject({
      changed: true,
      changedEntryCount: 1,
      currentManifestRef: current.ref,
    });
    const artifacts = await runGitWorkerOperation({
      type: "workspace.artifacts",
      input: { root, ref, previewPath: "saved.txt" },
    });
    expect(artifacts.changes).toHaveLength(50_001);
    expect(Buffer.from(artifacts.preview!).toString()).toBe("retained guest work\n");
    await expect(
      parseWorkspaceManifestPair({
        baseRaw: base.raw,
        baseRef: base.ref,
        currentRaw: current.raw,
        currentRef: current.ref,
      }),
    ).resolves.toMatchObject({ changed: true, paths: ["saved.txt"] });
  },
  30_000,
);

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

it("rejects an unapplied 65k-path historical result but can settle its accepted receipt", async () => {
  const fixture = await workspaceFixture(
    fileManifest(
      numberedPaths("deleted", 65_000).map((name) => `${name}.txt`),
      "a",
    ),
    makeManifest({}),
  );
  await fixture.stage(true);
  const begin = vi.fn(async () => {});

  await expect(fixture.apply(emptyJournal({ begin }))).rejects.toMatchObject({
    code: "WORKSPACE_RESULT_LIMIT",
    message: expect.stringMatching(/65000.*50000.*\.gitignore/s),
  });
  expect(begin).not.toHaveBeenCalled();
  const result = await applyStagedWorkerWorkspaceResult({
    root: fixture.root,
    stagedResultRef: fixture.ref,
    expectedBaseManifestRef: fixture.base.ref,
    journal: emptyJournal({ begin }),
    alreadyAccepted: true,
  });
  expect(result).toMatchObject({ changed: true, manifest: { entries: [] } });
  expect(begin).not.toHaveBeenCalled();
}, 30_000);

it("stages a directory-only v2 result above 25,000 reconciliation records", async () => {
  const directoryCount = 13_000;
  const manifest = (prefix: string) => ({
    ...makeManifest({}),
    directories: numberedPaths(prefix, directoryCount),
  });
  const fixture = await workspaceFixture(manifest("base"), manifest("current"));
  await fixture.stage();
  const staged = await loadStagedWorkspaceManifest(fixture.root, fixture.ref);
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
