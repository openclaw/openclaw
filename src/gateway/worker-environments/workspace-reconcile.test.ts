import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import type { WorkerWorkspaceManifest } from "./workspace-manifest.js";
import {
  MAX_RECONCILIATION_ENTRIES,
  parseWorkerWorkspaceReconciliationPlan,
  serializeWorkerWorkspaceManifest,
} from "./workspace-manifest.js";
import {
  applyWorkspace,
  expectWorkspaceFiles,
  gitInit,
  manifestFor,
  writeWorkspaceFiles,
} from "./workspace-recovery.test-support.js";
import {
  localWorkspaceBaseRefreshRef,
  requireWorkerResultStorageRef,
} from "./workspace-result-inventory.js";
import {
  applyStagedWorkerWorkspaceResult,
  cleanupWorkerWorkspaceResultRef,
  deleteStagedWorkerWorkspaceResult,
  deleteWorkerWorkspaceResultCleanupRefs,
  hasWorkerWorkspaceResultRef,
  moveStagedWorkerWorkspaceResultToCleanup,
  preparedWorkerWorkspaceResultRef,
  workerWorkspaceResultStaging,
  workerWorkspaceResultRef,
} from "./workspace-result-staging.js";

const { prepareRequestedWorkerWorkspaceResult, stageWorkerWorkspaceResult } =
  workerWorkspaceResultStaging;

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let local: string;
let staged: string;
beforeEach(() => {
  local = tempDirs.make("workspace-local-");
  staged = tempDirs.make("workspace-staged-");
});

function encodeWorkspaceManifest(manifest: WorkerWorkspaceManifest) {
  const raw = serializeWorkerWorkspaceManifest(manifest);
  return { raw, ref: `sha256:${createHash("sha256").update(raw).digest("hex")}` };
}

function emptyJournal(commit = async (_manifestRef: string) => {}) {
  return { load: async () => undefined, begin: async () => {}, commit, abort: async () => {} };
}

const hasRef = (ref: string) => hasWorkerWorkspaceResultRef({ root: local, stagedResultRef: ref });
const readText = (relative: string) => fs.readFile(path.join(local, relative), "utf8");
const apply = (
  base: WorkerWorkspaceManifest,
  current: WorkerWorkspaceManifest,
  options: Pick<
    Parameters<typeof applyWorkspace>[0],
    "begin" | "commit" | "publishAcceptedManifest"
  > = {},
) => applyWorkspace({ root: local, stagingRoot: staged, base, current, ...options });
const replayResult = (
  ref: string,
  expectedBaseManifestRef: string,
  options: { journal?: ReturnType<typeof emptyJournal>; alreadyAccepted?: boolean } = {},
) =>
  applyStagedWorkerWorkspaceResult({
    root: local,
    stagedResultRef: ref,
    expectedBaseManifestRef,
    journal: options.journal ?? emptyJournal(),
    ...options,
  });

async function resultFixture(
  name: string,
  baseFiles: Record<string, string | Uint8Array> = { "result.txt": "base\n" },
  currentFiles: Record<string, string | Uint8Array> = { "result.txt": "worker\n" },
) {
  await writeWorkspaceFiles(local, baseFiles);
  await writeWorkspaceFiles(staged, currentFiles);
  const base = encodeWorkspaceManifest(await manifestFor(local));
  const current = encodeWorkspaceManifest(await manifestFor(staged));
  return { local, staged, base, current, ref: workerWorkspaceResultRef(`claim-${name}`) };
}

function stageResult({ ref, base, current }: Awaited<ReturnType<typeof resultFixture>>) {
  return stageWorkerWorkspaceResult({
    root: local,
    stagingRoot: staged,
    stagedResultRef: ref,
    baseManifestRef: base.ref,
    currentManifestRef: current.ref,
    baseManifestRaw: base.raw,
    currentManifestRaw: current.raw,
  });
}

function prepareWorkspaceResult(params: {
  ref: string;
  base: ReturnType<typeof encodeWorkspaceManifest>;
  current: ReturnType<typeof encodeWorkspaceManifest>;
  record?: (ref: string) => void;
  journal?: ReturnType<typeof emptyJournal>;
}) {
  return prepareRequestedWorkerWorkspaceResult({
    request: {
      localPath: local,
      remoteWorkspaceDir: "/worker/workspace",
      baseManifestRef: params.base.ref,
      journal: params.journal ?? emptyJournal(),
      stagedResult: { ref: params.ref, record: params.record ?? (() => {}) },
    },
    stagingRoot: staged,
    currentManifestRef: params.current.ref,
    baseManifestRaw: params.base.raw,
    currentManifestRaw: params.current.raw,
  });
}

it("keeps local-only paths outside a Git workspace's accepted manifest", async () => {
  await fs.writeFile(path.join(local, "tracked.txt"), "tracked\n");
  const manifest = {
    ...(await manifestFor(local)),
    baseCommit: "a".repeat(40),
  };
  await fs.writeFile(path.join(local, "local-ignored-secret.txt"), "private\n");
  let published: WorkerWorkspaceManifest | undefined;

  const applied = await apply(manifest, manifest, {
    publishAcceptedManifest: async (accepted) => {
      published = accepted.manifest;
    },
  });

  expect(published?.entries.map((entry) => entry.path)).toEqual(["tracked.txt"]);
  expect(applied.manifest.entries.map((entry) => entry.path)).toEqual(["tracked.txt"]);
  await expect(readText("local-ignored-secret.txt")).resolves.toBe("private\n");
});

it("publishes the accepted manifest before advancing the journal", async () => {
  await fs.writeFile(path.join(local, "result.txt"), "accepted\n");
  const manifest = await manifestFor(local);
  const events: string[] = [];

  const applied = await apply(manifest, manifest, {
    publishAcceptedManifest: async (accepted) => {
      events.push(`publish:${accepted.manifestRef}`);
    },
    commit: (manifestRef) => {
      events.push(`commit:${manifestRef}`);
    },
  });

  expect(events).toEqual([`publish:${applied.manifestRef}`, `commit:${applied.manifestRef}`]);
});

it("rejects unsafe claim ids before constructing a staged result ref", () => {
  expect(workerWorkspaceResultRef("6f77e833-83d2-4db4-bdd4-2ad1d37edc28")).toBe(
    "refs/openclaw/worker-results/6f77e833-83d2-4db4-bdd4-2ad1d37edc28",
  );
  for (const claimId of ["", "claim.with-dot", "claim_with_underscore", "claim/with-slash"]) {
    expect(() => workerWorkspaceResultRef(claimId)).toThrow(
      "Cloud workspace result claim id is invalid",
    );
  }
  const refresh = localWorkspaceBaseRefreshRef("a".repeat(64));
  expect(refresh).toBe(`refs/openclaw/workspace-base-refresh/${"a".repeat(64)}`);
  expect(requireWorkerResultStorageRef(refresh)).toBe(refresh);
  expect(() => localWorkspaceBaseRefreshRef("claim-id")).toThrow("identity is invalid");
  expect(() => requireWorkerResultStorageRef(refresh + "/extra")).toThrow("reference is invalid");
  expect(() => preparedWorkerWorkspaceResultRef(refresh)).toThrow("reference is invalid");
  expect(() => cleanupWorkerWorkspaceResultRef(refresh)).toThrow("reference is invalid");
});

it("applies the candidate before publishing its recovery ref", async () => {
  const complete = tempDirs.make("workspace-staged-ref-complete-");
  await writeWorkspaceFiles(local, { "changed.txt": "base\n", "unchanged.txt": "keep\n" });
  const base = encodeWorkspaceManifest(await manifestFor(local));
  const changedFiles = {
    "changed.txt": "worker\n",
    "added.txt": "added\n",
    "odd\nname.txt": "quoted path\n",
  };
  await writeWorkspaceFiles(staged, changedFiles);
  await writeWorkspaceFiles(complete, { ...changedFiles, "unchanged.txt": "keep\n" });
  const current = encodeWorkspaceManifest(await manifestFor(complete));
  const ref = workerWorkspaceResultRef("claim-stage-order");
  let recordedRef: string | undefined;
  const commit = vi.fn(async (_manifestRef: string) => {
    expect(recordedRef).toBeUndefined();
  });
  const prepared = await prepareWorkspaceResult({
    ref,
    base,
    current,
    journal: emptyJournal(commit),
    record: (resultRef) => {
      recordedRef = resultRef;
    },
  });

  const probe = (targetRef: string) =>
    runCommandWithTimeout(["git", "-C", local, "show-ref", "--verify", targetRef], {
      timeoutMs: 10_000,
    });
  const expectRefs = async () => {
    expect(await probe(preparedWorkerWorkspaceResultRef(ref))).toMatchObject({ code: 0 });
    expect((await probe(ref)).code).not.toBe(0);
  };
  await expectRefs();
  expect(recordedRef).toBeUndefined();
  await expect(readText("changed.txt")).resolves.toBe("base\n");
  await prepared.applyPreparedStagedResult();

  expect(recordedRef).toBeUndefined();
  expect(commit).toHaveBeenLastCalledWith(current.ref);
  await expectRefs();
  await prepared.publishStagedResult();

  expect(recordedRef).toBe(ref);
  expect(commit).toHaveBeenLastCalledWith(current.ref);
  await expectWorkspaceFiles(local, { ...changedFiles, "unchanged.txt": "keep\n" });
  const replayCommit = vi.fn(async () => {});
  await replayResult(ref, current.ref, { journal: emptyJournal(replayCommit) });
  expect(replayCommit).not.toHaveBeenCalled();
  await deleteStagedWorkerWorkspaceResult({ root: local, stagedResultRef: ref });
  expect((await probe(ref)).code).not.toBe(0);
});

it("rejects a persisted journal above the combined inventory record budget", () => {
  const journal = {
    version: 1,
    temporaryNonce: "a".repeat(32),
    baseManifestRef: `sha256:${"a".repeat(64)}`,
    currentManifestRef: `sha256:${"b".repeat(64)}`,
    baseEntries: [],
    appliedEntries: [],
    appliedDirectories: [],
    baseDirectories: Array.from(
      { length: MAX_RECONCILIATION_ENTRIES + 1 },
      (_, index) => `directory-${index}`,
    ),
    baseTree: "b".repeat(40),
    basePackSha256: "c".repeat(64),
  };
  expect(() => parseWorkerWorkspaceReconciliationPlan(JSON.stringify(journal))).toThrow(
    "unsupported shape",
  );
});

it("preserves the published result when its fence-row update fails", async () => {
  const fixture = await resultFixture("record-failure");
  const { ref } = fixture;
  const prepared = await prepareWorkspaceResult({
    ...fixture,
    record: () => {
      throw new Error("state database unavailable");
    },
  });

  await prepared.applyPreparedStagedResult();
  await expect(prepared.publishStagedResult()).rejects.toThrow("state database unavailable");
  await expect(hasRef(ref)).resolves.toBe(true);
  await expect(readText("result.txt")).resolves.toBe("worker\n");
  await expect(hasRef(preparedWorkerWorkspaceResultRef(ref))).resolves.toBe(false);
});

it.each([false, true])(
  "preserves accepted FIFO conflicts (unchanged base: %s)",
  async (unchangedBase) => {
    const fixture = await resultFixture(
      "accepted-fifo",
      unchangedBase ? {} : { "result.pipe": "base\n" },
      unchangedBase ? { "result.pipe": "worker file\n" } : {},
    );
    const { base, current, ref } = fixture;
    const fifoPath = path.join(local, "result.pipe");
    // Deletion is prepared before the local FIFO; an addition sees the FIFO at admission.
    let prepared = unchangedBase ? undefined : await prepareWorkspaceResult(fixture);
    await fs.rm(fifoPath, { force: true });
    const mkfifo = await runCommandWithTimeout(["mkfifo", fifoPath], { timeoutMs: 10_000 });
    expect(mkfifo.code).toBe(0);
    prepared ??= await prepareWorkspaceResult(fixture);
    await prepared.applyPreparedStagedResult();
    expect(prepared.getAppliedWorkspaceResult()?.conflictPaths).toEqual(["result.pipe"]);
    await prepared.publishStagedResult();
    if (unchangedBase) {
      await fs.rm(fifoPath);
    }
    const committed = vi.fn(async () => {});
    const replay = await replayResult(ref, unchangedBase ? base.ref : current.ref, {
      alreadyAccepted: unchangedBase,
      journal: emptyJournal(committed),
    });
    expect(replay.conflictPaths).toEqual(["result.pipe"]);
    expect(committed).not.toHaveBeenCalled();
    if (unchangedBase) {
      await expect(fs.lstat(fifoPath)).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      expect((await fs.lstat(fifoPath)).isFIFO()).toBe(true);
    }
  },
);

it("does not sweep cleanup refs retained by another pending result", async () => {
  const fixture = await resultFixture("retained-cleanup", {}, { "result.txt": "worker\n" });
  const stagedResultRef = fixture.ref;
  await gitInit(local);
  await stageResult(fixture);
  const cleanupRef = await moveStagedWorkerWorkspaceResultToCleanup({
    root: local,
    stagedResultRef,
  });

  expect(cleanupRef).toBe(cleanupWorkerWorkspaceResultRef(stagedResultRef));
  const retainedRefs = new Set<string>();
  const cleanup = deleteWorkerWorkspaceResultCleanupRefs({
    root: local,
    retainedRefs: () => retainedRefs,
  });
  retainedRefs.add(cleanupRef);
  await cleanup;
  await expect(hasRef(cleanupRef)).resolves.toBe(true);

  await deleteWorkerWorkspaceResultCleanupRefs({ root: local });
  await expect(hasRef(cleanupRef)).resolves.toBe(false);
});

it("resnapshots an offline local edit after the staged manifest committed", async () => {
  const fixture = await resultFixture(
    "committed-local-advance",
    { "result.txt": "base\n", "conflict.txt": "base\n" },
    { "result.txt": "worker\n", "conflict.txt": "worker\n" },
  );
  const { ref, current } = fixture;
  const prepared = await prepareWorkspaceResult(fixture);
  await fs.writeFile(path.join(local, "conflict.txt"), "first local\n");
  await prepared.applyPreparedStagedResult();
  const committed = prepared.getAppliedWorkspaceResult();
  expect(committed?.conflictPaths).toEqual(["conflict.txt"]);
  expect(committed?.manifestRef).not.toBe(current.ref);
  await prepared.publishStagedResult();
  await fs.writeFile(path.join(local, "result.txt"), "later local\n");
  const replayCommit = vi.fn(async () => {});

  const replay = await replayResult(ref, committed!.manifestRef, {
    journal: emptyJournal(replayCommit),
  });

  expect(replay.conflictPaths).toEqual(["conflict.txt", "result.txt"]);
  expect(replay.manifestRef).not.toBe(current.ref);
  expect(replayCommit).not.toHaveBeenCalled();
  await expect(readText("result.txt")).resolves.toBe("later local\n");
});

it("does not treat a Git probe failure as an absent staged result", async () => {
  await fs.writeFile(path.join(local, ".git"), "gitdir: /missing/openclaw-repository\n");

  await expect(
    hasWorkerWorkspaceResultRef({
      root: local,
      stagedResultRef: workerWorkspaceResultRef("claim-probe-failure"),
    }),
  ).rejects.toThrow();
});

it("disables workspace repository hooks while publishing result refs", async () => {
  const fixture = await resultFixture("disabled-hooks");
  await gitInit(local);
  const hook = path.join(local, ".git", "hooks", "reference-transaction");
  await fs.writeFile(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });

  await stageResult(fixture);
  await expect(hasRef(fixture.ref)).resolves.toBe(true);
});

it("applies changed, added, executable, binary, and symlink results", async () => {
  const addedName = process.platform === "win32" ? "added.txt" : "added\u0001-é.txt";
  await gitInit(local);
  await writeWorkspaceFiles(local, {
    "keep.bin": Buffer.from([0, 1, 2]),
    "src/script.sh": "before",
  });
  const base = await manifestFor(local);

  const files = {
    "keep.bin": Buffer.from([0, 9, 2]),
    [addedName]: "new",
    "src/script.sh": "after",
  };
  await writeWorkspaceFiles(staged, files);
  await fs.chmod(path.join(staged, "src", "script.sh"), 0o755);
  await fs.symlink(addedName, path.join(staged, "link.txt"));
  const current = await manifestFor(staged);

  await apply(base, current);

  await expectWorkspaceFiles(local, files);
  await expect(fs.readlink(path.join(local, "link.txt"))).resolves.toBe(addedName);
  expect((await fs.stat(path.join(local, "src", "script.sh"))).mode & 0o111).not.toBe(0);
});

it("preserves raw bytes when workspace attributes declare an encoding", async () => {
  const attributes = "encoded.txt working-tree-encoding=UTF-16LE\n";
  const baseBytes = Buffer.from("b\0a\0s\0e\0");
  const currentBytes = Buffer.from("r\0e\0m\0o\0t\0e\0");
  await gitInit(local);
  await fs.writeFile(path.join(local, ".gitattributes"), attributes);
  await fs.writeFile(path.join(local, "encoded.txt"), baseBytes);
  const base = await manifestFor(local);

  await fs.writeFile(path.join(staged, ".gitattributes"), attributes);
  await fs.writeFile(path.join(staged, "encoded.txt"), currentBytes);
  const current = await manifestFor(staged);

  await apply(base, current);

  await expect(fs.readFile(path.join(local, "encoded.txt"))).resolves.toEqual(currentBytes);
});

it("applies the three-way matrix while keeping local conflicts", async () => {
  await gitInit(local);
  // path, dispatch base, worker result, later local state, accepted state
  const files = [
    ["apply.txt", "base", "worker", "base", "worker"],
    ["noop.txt", "base", "worker", "worker", "worker"],
    ["conflict.txt", "base", "worker", "local", "local"],
    ["deleted-apply.txt", "base", null, "base", null],
    ["deleted-noop.txt", "base", null, null, null],
    ["deleted-conflict.txt", "base", null, "local", "local"],
    ["unchanged-local.txt", "base", "base", "local", "local"],
    ["added-identical.txt", null, "worker", "worker", "worker"],
    ["collision.txt", null, "worker", "local", "local"],
  ] as const;
  const writeColumn = async (root: string, column: 1 | 2 | 3) => {
    for (const row of files) {
      const target = path.join(root, row[0]);
      const content = row[column];
      if (content === null) {
        await fs.rm(target, { force: true });
      } else {
        await fs.writeFile(target, content);
      }
    }
  };
  await writeColumn(local, 1);
  await writeColumn(staged, 1);
  await Promise.all([
    fs.symlink("base-target", path.join(local, "link")),
    fs.symlink("base-target", path.join(staged, "link")),
    fs.mkdir(path.join(local, "removed-dir")),
    fs.mkdir(path.join(staged, "removed-dir")),
  ]);
  await writeWorkspaceFiles(local, { "removed-dir/base.txt": "base" });
  await writeWorkspaceFiles(staged, { "removed-dir/base.txt": "base" });
  const base = await manifestFor(local);

  await writeColumn(staged, 2);
  await Promise.all([
    fs.rm(path.join(staged, "link")),
    fs.rm(path.join(staged, "removed-dir"), { recursive: true }),
  ]);
  await fs.symlink("worker-target", path.join(staged, "link"));
  await writeWorkspaceFiles(staged, { "tree/file.txt": "worker" });
  const current = await manifestFor(staged);

  await writeColumn(local, 3);
  await fs.rm(path.join(local, "link"));
  await fs.symlink("local-target", path.join(local, "link"));
  await writeWorkspaceFiles(local, {
    tree: "local ancestor",
    "removed-dir/local.txt": "local addition",
  });

  const commit = vi.fn<(manifestRef: string) => void>();
  const result = await apply(base, current, { commit });

  expect(result.conflictPaths).toEqual([
    "collision.txt",
    "conflict.txt",
    "deleted-conflict.txt",
    "link",
    "removed-dir/local.txt",
    "tree",
  ]);
  expect(commit).toHaveBeenLastCalledWith(result.manifestRef);
  for (const row of files) {
    const [entryPath] = row;
    const expected = row[4];
    if (expected === null) {
      await expect(fs.lstat(path.join(local, entryPath))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } else {
      await expect(readText(entryPath)).resolves.toBe(expected);
    }
  }
  await expectWorkspaceFiles(local, {
    "removed-dir/local.txt": "local addition",
    tree: "local ancestor",
  });
  await expect(fs.lstat(path.join(local, "removed-dir/base.txt"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(fs.readlink(path.join(local, "link"))).resolves.toBe("local-target");
  expect(result.manifest).toEqual(await manifestFor(local));
  await result.verifyLocalStable();
});

it("allows a remote file to replace an unchanged base directory", async () => {
  await gitInit(local);
  await writeWorkspaceFiles(local, { "src/old.txt": "base" });
  const base = await manifestFor(local);
  await writeWorkspaceFiles(local, { "src/__pycache__/old.pyc": "local cache" });
  await fs.writeFile(path.join(staged, "src"), "replacement");
  const current = await manifestFor(staged);

  await apply(base, current);

  await expect(readText("src")).resolves.toBe("replacement");
});

it("accepts a worker-added directory that gains only derived residue", async () => {
  const base = await manifestFor(local);
  await fs.mkdir(path.join(staged, "cache-holder"));
  await fs.chmod(path.join(staged, "cache-holder"), 0o755);

  const applied = await apply(base, await manifestFor(staged), {
    begin: () => {
      mkdirSync(path.join(local, "cache-holder", "__pycache__"), { recursive: true });
      chmodSync(path.join(local, "cache-holder"), 0o755);
      writeFileSync(path.join(local, "cache-holder", "__pycache__", "module.pyc"), "derived");
    },
  });

  expect(applied.conflictPaths).toEqual([]);
  expect(applied.manifest.directories).toContain("cache-holder");
  await expect(
    fs.readFile(path.join(local, "cache-holder", "__pycache__", "module.pyc"), "utf8"),
  ).resolves.toBe("derived");
});

it("treats derived residue as absent after a cloud directory deletion", async () => {
  await writeWorkspaceFiles(local, { "removed/nested/base.txt": "base" });
  const base = { ...(await manifestFor(local)), baseCommit: "a".repeat(40) };
  const residue = "removed/nested/__pycache__/cache.pyc";
  await writeWorkspaceFiles(local, { [residue]: "derived" });

  const applied = await apply(base, {
    ...(await manifestFor(staged)),
    baseCommit: "a".repeat(40),
  });

  expect(applied.conflictPaths).toEqual([]);
  await expectWorkspaceFiles(local, { [residue]: "derived" });
  expect(applied.manifest.directories).not.toContain("removed");
});

it("keeps a local-only empty directory beneath a cloud-deleted directory", async () => {
  await fs.mkdir(path.join(local, "removed", "base"), { recursive: true });
  const base = await manifestFor(local);
  await fs.mkdir(path.join(local, "removed", "local-empty"));

  const applied = await apply(base, await manifestFor(staged));

  expect(applied.conflictPaths).toEqual(["removed/local-empty"]);
  await expect(fs.stat(path.join(local, "removed", "local-empty"))).resolves.toMatchObject({});
});

it.each(["addition", "removal"])(
  "rolls back an empty directory %s when acceptance fails",
  async (operation) => {
    if (operation === "removal") {
      await fs.mkdir(path.join(local, "empty"));
      await fs.chmod(path.join(local, "empty"), 0o1755);
    } else {
      await fs.mkdir(path.join(staged, "empty"));
    }
    const base = await manifestFor(local);
    await expect(
      apply(base, await manifestFor(staged), {
        commit: () => {
          throw new Error("acceptance failed");
        },
      }),
    ).rejects.toThrow("acceptance failed");
    const restored = fs.stat(path.join(local, "empty"));
    if (operation === "removal") {
      expect((await restored).isDirectory()).toBe(true);
    } else {
      await expect(restored).rejects.toMatchObject({ code: "ENOENT" });
    }
  },
);
