import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function temporaryDirectory(name: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `openclaw-${name}-`));
  roots.push(root);
  return root;
}

function encodeWorkspaceManifest(manifest: WorkerWorkspaceManifest) {
  const raw = serializeWorkerWorkspaceManifest(manifest);
  return { raw, ref: `sha256:${createHash("sha256").update(raw).digest("hex")}` };
}

function emptyJournal(commit = async (_manifestRef: string) => {}) {
  return { load: async () => undefined, begin: async () => {}, commit, abort: async () => {} };
}

async function resultFixture(
  name: string,
  baseFiles: Record<string, string | Uint8Array> = { "result.txt": "base\n" },
  currentFiles: Record<string, string | Uint8Array> = { "result.txt": "worker\n" },
) {
  const local = await temporaryDirectory(`${name}-local`);
  const payload = await temporaryDirectory(`${name}-payload`);
  await writeWorkspaceFiles(local, baseFiles);
  await writeWorkspaceFiles(payload, currentFiles);
  const base = encodeWorkspaceManifest(await manifestFor(local));
  const current = encodeWorkspaceManifest(await manifestFor(payload));
  return { local, payload, base, current, ref: workerWorkspaceResultRef(`claim-${name}`) };
}

function prepareWorkspaceResult(params: {
  local: string;
  payload: string;
  ref: string;
  base: ReturnType<typeof encodeWorkspaceManifest>;
  current: ReturnType<typeof encodeWorkspaceManifest>;
  record?: () => void;
}) {
  return prepareRequestedWorkerWorkspaceResult({
    request: {
      localPath: params.local,
      remoteWorkspaceDir: "/worker/workspace",
      baseManifestRef: params.base.ref,
      journal: emptyJournal(),
      stagedResult: { ref: params.ref, record: params.record ?? (() => {}) },
    },
    stagingRoot: params.payload,
    currentManifestRef: params.current.ref,
    baseManifestRaw: params.base.raw,
    currentManifestRaw: params.current.raw,
  });
}

describe("worker workspace reconciliation", () => {
  it("keeps local-only paths outside a Git workspace's accepted manifest", async () => {
    const local = await temporaryDirectory("workspace-accepted-git-eligibility");
    const staging = await temporaryDirectory("workspace-accepted-git-eligibility-staging");
    await fs.writeFile(path.join(local, "tracked.txt"), "tracked\n");
    const manifest = {
      ...(await manifestFor(local)),
      baseCommit: "a".repeat(40),
    };
    await fs.writeFile(path.join(local, "local-ignored-secret.txt"), "private\n");
    let published: WorkerWorkspaceManifest | undefined;

    const applied = await applyWorkspace({
      root: local,
      stagingRoot: staging,
      base: manifest,
      current: manifest,
      publishAcceptedManifest: async (accepted) => {
        published = accepted.manifest;
      },
    });

    expect(published?.entries.map((entry) => entry.path)).toEqual(["tracked.txt"]);
    expect(applied.manifest.entries.map((entry) => entry.path)).toEqual(["tracked.txt"]);
    await expect(fs.readFile(path.join(local, "local-ignored-secret.txt"), "utf8")).resolves.toBe(
      "private\n",
    );
  });

  it("publishes the accepted manifest before advancing the journal", async () => {
    const local = await temporaryDirectory("workspace-publish-before-commit");
    const staging = await temporaryDirectory("workspace-publish-before-commit-staging");
    await fs.writeFile(path.join(local, "result.txt"), "accepted\n");
    const manifest = await manifestFor(local);
    const events: string[] = [];

    const applied = await applyWorkspace({
      root: local,
      stagingRoot: staging,
      base: manifest,
      current: manifest,
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
    const local = await temporaryDirectory("workspace-staged-ref-local");
    const payload = await temporaryDirectory("workspace-staged-ref-payload");
    const complete = await temporaryDirectory("workspace-staged-ref-complete");
    await writeWorkspaceFiles(local, { "changed.txt": "base\n", "unchanged.txt": "keep\n" });
    const base = encodeWorkspaceManifest(await manifestFor(local));
    const changedFiles = {
      "changed.txt": "worker\n",
      "added.txt": "added\n",
      "odd\nname.txt": "quoted path\n",
    };
    await writeWorkspaceFiles(payload, changedFiles);
    await writeWorkspaceFiles(complete, { ...changedFiles, "unchanged.txt": "keep\n" });
    const current = encodeWorkspaceManifest(await manifestFor(complete));
    const ref = workerWorkspaceResultRef("claim-stage-order");
    let recordedRef: string | undefined;
    let acceptedManifestRef: string | undefined;
    const prepared = await prepareRequestedWorkerWorkspaceResult({
      request: {
        localPath: local,
        remoteWorkspaceDir: "/worker/workspace",
        baseManifestRef: base.ref,
        journal: emptyJournal(async (manifestRef) => {
          expect(recordedRef).toBeUndefined();
          acceptedManifestRef = manifestRef;
        }),
        stagedResult: {
          ref,
          record: (stagedResultRef) => {
            recordedRef = stagedResultRef;
          },
        },
      },
      stagingRoot: payload,
      currentManifestRef: current.ref,
      baseManifestRaw: base.raw,
      currentManifestRaw: current.raw,
    });

    const expectRefs = async () => {
      const probe = (targetRef: string) =>
        runCommandWithTimeout(["git", "-C", local, "show-ref", "--verify", targetRef], {
          timeoutMs: 10_000,
        });
      expect(await probe(preparedWorkerWorkspaceResultRef(ref))).toMatchObject({ code: 0 });
      expect((await probe(ref)).code).not.toBe(0);
    };
    await expectRefs();
    expect(recordedRef).toBeUndefined();
    await expect(fs.readFile(path.join(local, "changed.txt"), "utf8")).resolves.toBe("base\n");
    await prepared.applyPreparedStagedResult();

    expect(recordedRef).toBeUndefined();
    expect(acceptedManifestRef).toBe(current.ref);
    await expectRefs();
    await prepared.publishStagedResult();

    expect(recordedRef).toBe(ref);
    expect(acceptedManifestRef).toBe(current.ref);
    await expectWorkspaceFiles(local, { ...changedFiles, "unchanged.txt": "keep\n" });
    const replayCommit = vi.fn(async () => {});
    await applyStagedWorkerWorkspaceResult({
      root: local,
      stagedResultRef: ref,
      expectedBaseManifestRef: current.ref,
      journal: emptyJournal(replayCommit),
    });
    expect(replayCommit).not.toHaveBeenCalled();
    await deleteStagedWorkerWorkspaceResult({ root: local, stagedResultRef: ref });
    expect(
      (
        await runCommandWithTimeout(["git", "-C", local, "show-ref", "--verify", ref], {
          timeoutMs: 10_000,
        })
      ).code,
    ).not.toBe(0);
  });

  it("rejects a persisted journal above the combined inventory record budget", () => {
    expect(() =>
      parseWorkerWorkspaceReconciliationPlan(
        JSON.stringify({
          version: 1,
          temporaryNonce: "a".repeat(32),
          baseManifestRef: `sha256:${"a".repeat(64)}`,
          currentManifestRef: `sha256:${"b".repeat(64)}`,
          baseEntries: [],
          appliedEntries: [],
          baseDirectories: Array.from(
            { length: MAX_RECONCILIATION_ENTRIES + 1 },
            (_, index) => `directory-${index}`,
          ),
          appliedDirectories: [],
          baseTree: "b".repeat(40),
          basePackSha256: "c".repeat(64),
        }),
      ),
    ).toThrow("unsupported shape");
  });

  it("preserves the published result when its fence-row update fails", async () => {
    const fixture = await resultFixture("record-failure");
    const { local, ref } = fixture;
    const prepared = await prepareWorkspaceResult({
      ...fixture,
      record: () => {
        throw new Error("state database unavailable");
      },
    });

    await prepared.applyPreparedStagedResult();
    await expect(prepared.publishStagedResult()).rejects.toThrow("state database unavailable");
    await expect(hasWorkerWorkspaceResultRef({ root: local, stagedResultRef: ref })).resolves.toBe(
      true,
    );
    await expect(fs.readFile(path.join(local, "result.txt"), "utf8")).resolves.toBe("worker\n");
    await expect(
      hasWorkerWorkspaceResultRef({
        root: local,
        stagedResultRef: preparedWorkerWorkspaceResultRef(ref),
      }),
    ).resolves.toBe(false);
  });

  it("preserves an unrepresentable local conflict when replaying an accepted manifest", async () => {
    const local = await temporaryDirectory("workspace-accepted-fifo-replay-local");
    const payload = await temporaryDirectory("workspace-accepted-fifo-replay-payload");
    const fifoPath = path.join(local, "result.pipe");
    await fs.writeFile(fifoPath, "base\n");
    const base = encodeWorkspaceManifest(await manifestFor(local));
    const current = encodeWorkspaceManifest(await manifestFor(payload));
    const ref = workerWorkspaceResultRef("claim-accepted-fifo-replay");
    const prepared = await prepareWorkspaceResult({ local, payload, ref, base, current });
    await fs.rm(fifoPath);
    const mkfifo = await runCommandWithTimeout(["mkfifo", fifoPath], { timeoutMs: 10_000 });
    expect(mkfifo.code).toBe(0);

    await prepared.applyPreparedStagedResult();
    expect(prepared.getAppliedWorkspaceResult()?.conflictPaths).toEqual(["result.pipe"]);
    await prepared.publishStagedResult();

    const replay = await applyStagedWorkerWorkspaceResult({
      root: local,
      stagedResultRef: ref,
      expectedBaseManifestRef: current.ref,
      journal: emptyJournal(),
    });

    expect(replay.conflictPaths).toEqual(["result.pipe"]);
    expect((await fs.lstat(fifoPath)).isFIFO()).toBe(true);
  });

  it("does not sweep cleanup refs retained by another pending result", async () => {
    const {
      local,
      payload,
      base,
      current,
      ref: stagedResultRef,
    } = await resultFixture("retained-cleanup", {}, { "result.txt": "worker\n" });
    await gitInit(local);
    await stageWorkerWorkspaceResult({
      root: local,
      stagingRoot: payload,
      stagedResultRef,
      baseManifestRef: base.ref,
      currentManifestRef: current.ref,
      baseManifestRaw: base.raw,
      currentManifestRaw: current.raw,
    });
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
    await expect(
      hasWorkerWorkspaceResultRef({ root: local, stagedResultRef: cleanupRef }),
    ).resolves.toBe(true);

    await deleteWorkerWorkspaceResultCleanupRefs({ root: local });
    await expect(
      hasWorkerWorkspaceResultRef({ root: local, stagedResultRef: cleanupRef }),
    ).resolves.toBe(false);
  });

  it("never replays an accepted result when omitted local state kept the base ref unchanged", async () => {
    const fixture = await resultFixture(
      "accepted-unchanged-ref",
      {},
      { "result.pipe": "worker file\n" },
    );
    const { local, ref, base } = fixture;
    const fifoPath = path.join(local, "result.pipe");
    const mkfifo = await runCommandWithTimeout(["mkfifo", fifoPath], { timeoutMs: 10_000 });
    expect(mkfifo.code).toBe(0);
    const prepared = await prepareWorkspaceResult(fixture);

    await prepared.applyPreparedStagedResult();
    expect(prepared.getAppliedWorkspaceResult()?.conflictPaths).toEqual(["result.pipe"]);
    await prepared.publishStagedResult();
    await fs.rm(fifoPath);

    const committed: string[] = [];
    const replay = await applyStagedWorkerWorkspaceResult({
      root: local,
      stagedResultRef: ref,
      expectedBaseManifestRef: base.ref,
      alreadyAccepted: true,
      journal: emptyJournal(async (manifestRef) => {
        committed.push(manifestRef);
      }),
    });

    expect(replay.conflictPaths).toEqual(["result.pipe"]);
    expect(committed).toEqual([]);
    await expect(fs.lstat(fifoPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("resnapshots an offline local edit after the staged manifest committed", async () => {
    const fixture = await resultFixture(
      "committed-local-advance",
      { "result.txt": "base\n", "conflict.txt": "base\n" },
      { "result.txt": "worker\n", "conflict.txt": "worker\n" },
    );
    const { local, ref, current } = fixture;
    const prepared = await prepareWorkspaceResult(fixture);
    await fs.writeFile(path.join(local, "conflict.txt"), "first local\n");
    await prepared.applyPreparedStagedResult();
    const committed = prepared.getAppliedWorkspaceResult();
    expect(committed?.conflictPaths).toEqual(["conflict.txt"]);
    expect(committed?.manifestRef).not.toBe(current.ref);
    await prepared.publishStagedResult();
    await fs.writeFile(path.join(local, "result.txt"), "later local\n");
    const replayCommit = vi.fn(async () => {});

    const replay = await applyStagedWorkerWorkspaceResult({
      root: local,
      stagedResultRef: ref,
      expectedBaseManifestRef: committed!.manifestRef,
      journal: emptyJournal(replayCommit),
    });

    expect(replay.conflictPaths).toEqual(["conflict.txt", "result.txt"]);
    expect(replay.manifestRef).not.toBe(current.ref);
    expect(replayCommit).not.toHaveBeenCalled();
    await expect(fs.readFile(path.join(local, "result.txt"), "utf8")).resolves.toBe(
      "later local\n",
    );
  });

  it("does not treat a Git probe failure as an absent staged result", async () => {
    const local = await temporaryDirectory("workspace-staged-probe-failure");
    await fs.writeFile(path.join(local, ".git"), "gitdir: /missing/openclaw-repository\n");

    await expect(
      hasWorkerWorkspaceResultRef({
        root: local,
        stagedResultRef: workerWorkspaceResultRef("claim-probe-failure"),
      }),
    ).rejects.toThrow();
  });

  it("disables workspace repository hooks while publishing result refs", async () => {
    const { local, payload, base, current, ref } = await resultFixture("disabled-hooks");
    await gitInit(local);
    const hook = path.join(local, ".git", "hooks", "reference-transaction");
    await fs.writeFile(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });

    await stageWorkerWorkspaceResult({
      root: local,
      stagingRoot: payload,
      stagedResultRef: ref,
      baseManifestRef: base.ref,
      currentManifestRef: current.ref,
      baseManifestRaw: base.raw,
      currentManifestRaw: current.raw,
    });

    await expect(hasWorkerWorkspaceResultRef({ root: local, stagedResultRef: ref })).resolves.toBe(
      true,
    );
  });

  it("applies changed, added, deleted, executable, binary, and symlink results", async () => {
    const local = await temporaryDirectory("workspace-local");
    const staged = await temporaryDirectory("workspace-staged");
    const addedName = process.platform === "win32" ? "added.txt" : "added\u0001-é.txt";
    await gitInit(local);
    await writeWorkspaceFiles(local, {
      "keep.bin": Buffer.from([0, 1, 2]),
      "delete.txt": "remove",
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

    await applyWorkspace({ root: local, stagingRoot: staged, base, current });

    await expectWorkspaceFiles(local, files);
    await expect(fs.access(path.join(local, "delete.txt"))).rejects.toThrow();
    await expect(fs.readlink(path.join(local, "link.txt"))).resolves.toBe(addedName);
    expect((await fs.stat(path.join(local, "src", "script.sh"))).mode & 0o111).not.toBe(0);
  });

  it("preserves raw bytes when workspace attributes declare an encoding", async () => {
    const local = await temporaryDirectory("workspace-attributes");
    const staged = await temporaryDirectory("workspace-attributes-staged");
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

    await applyWorkspace({ root: local, stagingRoot: staged, base, current });

    await expect(fs.readFile(path.join(local, "encoded.txt"))).resolves.toEqual(currentBytes);
  });

  it("applies the three-way matrix while keeping local conflicts", async () => {
    const local = await temporaryDirectory("workspace-three-way-local");
    const staged = await temporaryDirectory("workspace-three-way-staged");
    await gitInit(local);
    for (const entryPath of [
      "apply.txt",
      "noop.txt",
      "conflict.txt",
      "deleted-apply.txt",
      "deleted-noop.txt",
      "deleted-conflict.txt",
      "worker-unchanged-local.txt",
    ]) {
      await fs.writeFile(path.join(local, entryPath), "base");
      await fs.writeFile(path.join(staged, entryPath), "base");
    }
    await Promise.all([
      fs.symlink("base-target", path.join(local, "link")),
      fs.symlink("base-target", path.join(staged, "link")),
      fs.mkdir(path.join(local, "removed-dir")),
      fs.mkdir(path.join(staged, "removed-dir")),
    ]);
    await writeWorkspaceFiles(local, { "removed-dir/base.txt": "base" });
    await writeWorkspaceFiles(staged, { "removed-dir/base.txt": "base" });
    const base = await manifestFor(local);

    await writeWorkspaceFiles(staged, {
      "apply.txt": "worker",
      "noop.txt": "worker",
      "conflict.txt": "worker",
    });
    await Promise.all([
      fs.rm(path.join(staged, "deleted-apply.txt")),
      fs.rm(path.join(staged, "deleted-noop.txt")),
      fs.rm(path.join(staged, "deleted-conflict.txt")),
      fs.rm(path.join(staged, "link")),
      fs.rm(path.join(staged, "removed-dir"), { recursive: true }),
    ]);
    await fs.symlink("worker-target", path.join(staged, "link"));
    await writeWorkspaceFiles(staged, {
      "added-identical.txt": "worker",
      "collision.txt": "worker",
      "tree/file.txt": "worker",
    });
    const current = await manifestFor(staged);

    await writeWorkspaceFiles(local, {
      "noop.txt": "worker",
      "conflict.txt": "local",
      "deleted-conflict.txt": "local",
    });
    await Promise.all([
      fs.rm(path.join(local, "deleted-noop.txt")),
      fs.rm(path.join(local, "link")),
    ]);
    await fs.symlink("local-target", path.join(local, "link"));
    await writeWorkspaceFiles(local, {
      "added-identical.txt": "worker",
      "collision.txt": "local",
      tree: "local ancestor",
      "removed-dir/local.txt": "local addition",
      "worker-unchanged-local.txt": "local only change",
    });

    let acceptedManifestRef: string | undefined;
    const result = await applyWorkspace({
      root: local,
      stagingRoot: staged,
      base,
      current,
      commit: (manifestRef) => {
        acceptedManifestRef = manifestRef;
      },
    });

    expect(result.conflictPaths).toEqual([
      "collision.txt",
      "conflict.txt",
      "deleted-conflict.txt",
      "link",
      "removed-dir/local.txt",
      "tree",
    ]);
    expect(acceptedManifestRef).toBe(result.manifestRef);
    await expectWorkspaceFiles(local, {
      "apply.txt": "worker",
      "noop.txt": "worker",
      "added-identical.txt": "worker",
      "conflict.txt": "local",
      "deleted-conflict.txt": "local",
      "removed-dir/local.txt": "local addition",
      tree: "local ancestor",
      "worker-unchanged-local.txt": "local only change",
    });
    for (const file of ["deleted-apply.txt", "deleted-noop.txt", "removed-dir/base.txt"]) {
      await expect(fs.lstat(path.join(local, file))).rejects.toMatchObject({ code: "ENOENT" });
    }
    await expect(fs.readlink(path.join(local, "link"))).resolves.toBe("local-target");
    expect(result.manifest).toEqual(await manifestFor(local));
    await result.verifyLocalStable();
  });

  it("allows a remote file to replace an unchanged base directory", async () => {
    const local = await temporaryDirectory("workspace-directory-replacement");
    const staged = await temporaryDirectory("workspace-directory-replacement-staged");
    await gitInit(local);
    await fs.mkdir(path.join(local, "src"));
    await fs.writeFile(path.join(local, "src", "old.txt"), "base");
    const base = await manifestFor(local);
    await fs.mkdir(path.join(local, "src", "__pycache__"));
    await fs.writeFile(path.join(local, "src", "__pycache__", "old.pyc"), "local cache");
    await fs.writeFile(path.join(staged, "src"), "replacement");
    const current = await manifestFor(staged);

    await applyWorkspace({ root: local, stagingRoot: staged, base, current });

    await expect(fs.readFile(path.join(local, "src"), "utf8")).resolves.toBe("replacement");
  });

  it("accepts a worker-added directory that gains only derived residue", async () => {
    const local = await temporaryDirectory("workspace-added-directory-derived-residue");
    const staged = await temporaryDirectory("workspace-added-directory-derived-residue-staged");
    const base = await manifestFor(local);
    await fs.mkdir(path.join(staged, "cache-holder"));
    await fs.chmod(path.join(staged, "cache-holder"), 0o755);

    const applied = await applyWorkspace({
      root: local,
      stagingRoot: staged,
      base,
      current: await manifestFor(staged),
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
    const local = await temporaryDirectory("workspace-directory-delete-derived");
    const staged = await temporaryDirectory("workspace-directory-delete-derived-staged");
    await fs.mkdir(path.join(local, "removed", "nested"), { recursive: true });
    await fs.writeFile(path.join(local, "removed", "nested", "base.txt"), "base");
    const base = { ...(await manifestFor(local)), baseCommit: "a".repeat(40) };
    await fs.mkdir(path.join(local, "removed", "nested", "__pycache__"));
    await fs.writeFile(
      path.join(local, "removed", "nested", "__pycache__", "cache.pyc"),
      "derived",
    );

    const applied = await applyWorkspace({
      root: local,
      stagingRoot: staged,
      base,
      current: { ...(await manifestFor(staged)), baseCommit: "a".repeat(40) },
    });

    expect(applied.conflictPaths).toEqual([]);
    await expect(
      fs.readFile(path.join(local, "removed", "nested", "__pycache__", "cache.pyc"), "utf8"),
    ).resolves.toBe("derived");
    expect(applied.manifest.directories).not.toContain("removed");
  });

  it("keeps a local-only empty directory beneath a cloud-deleted directory", async () => {
    const local = await temporaryDirectory("workspace-directory-delete-local-empty");
    const staged = await temporaryDirectory("workspace-directory-delete-local-empty-staged");
    await fs.mkdir(path.join(local, "removed", "base"), { recursive: true });
    const base = await manifestFor(local);
    await fs.mkdir(path.join(local, "removed", "local-empty"));

    const applied = await applyWorkspace({
      root: local,
      stagingRoot: staged,
      base,
      current: await manifestFor(staged),
    });

    expect(applied.conflictPaths).toEqual(["removed/local-empty"]);
    await expect(fs.stat(path.join(local, "removed", "local-empty"))).resolves.toMatchObject({});
  });

  it("rolls back empty directory additions and removals when acceptance fails", async () => {
    const addedLocal = await temporaryDirectory("workspace-empty-directory-add-rollback");
    const addedStaged = await temporaryDirectory("workspace-empty-directory-add-rollback-staged");
    const addedBase = await manifestFor(addedLocal);
    await fs.mkdir(path.join(addedStaged, "empty"));

    await expect(
      applyWorkspace({
        root: addedLocal,
        stagingRoot: addedStaged,
        base: addedBase,
        current: await manifestFor(addedStaged),
        commit: () => {
          throw new Error("acceptance failed");
        },
      }),
    ).rejects.toThrow("acceptance failed");
    await expect(fs.stat(path.join(addedLocal, "empty"))).rejects.toMatchObject({ code: "ENOENT" });

    const removedLocal = await temporaryDirectory("workspace-empty-directory-remove-rollback");
    const removedStaged = await temporaryDirectory(
      "workspace-empty-directory-remove-rollback-staged",
    );
    await fs.mkdir(path.join(removedLocal, "empty"));
    await fs.chmod(path.join(removedLocal, "empty"), 0o1755);
    const removedBase = await manifestFor(removedLocal);

    await expect(
      applyWorkspace({
        root: removedLocal,
        stagingRoot: removedStaged,
        base: removedBase,
        current: await manifestFor(removedStaged),
        commit: () => {
          throw new Error("acceptance failed");
        },
      }),
    ).rejects.toThrow("acceptance failed");
    const restoredDirectory = await fs.stat(path.join(removedLocal, "empty"));
    expect(restoredDirectory.isDirectory()).toBe(true);
  });
});
