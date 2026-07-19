import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCommandWithTimeout } from "../../process/exec.js";
import type {
  WorkerWorkspaceManifest,
  WorkerWorkspaceManifestEntry,
} from "./workspace-manifest.js";
import { serializeWorkerWorkspaceManifest } from "./workspace-manifest.js";
import {
  applyStagedWorkerWorkspace,
  assertWorkspaceMatchesManifest,
  MAX_RECONCILIATION_FILE_BYTES,
  parseWorkerWorkspaceManifest,
  recoverWorkerWorkspaceReconciliation,
  type WorkerWorkspaceReconciliationJournal,
} from "./workspace-reconcile.js";
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
  workerWorkspaceTransferPaths,
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

async function gitInit(root: string): Promise<void> {
  const result = await runCommandWithTimeout(["git", "-C", root, "init", "--quiet"], {
    timeoutMs: 10_000,
  });
  expect(result.code).toBe(0);
}

async function manifestFor(root: string): Promise<WorkerWorkspaceManifest> {
  const entries: WorkerWorkspaceManifestEntry[] = [];
  const directories: string[] = [];
  const walk = async (relativeDirectory: string) => {
    for (const name of (await fs.readdir(path.join(root, relativeDirectory))).toSorted()) {
      if (!relativeDirectory && name === ".git") {
        continue;
      }
      const relative = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      const absolute = path.join(root, relative);
      const stats = await fs.lstat(absolute);
      if (stats.isDirectory() && !stats.isSymbolicLink()) {
        directories.push(relative);
        await walk(relative);
      } else if (stats.isSymbolicLink()) {
        entries.push({
          path: relative,
          type: "symlink",
          mode: 0o777,
          target: await fs.readlink(absolute),
        });
      } else {
        const content = await fs.readFile(absolute);
        entries.push({
          path: relative,
          type: "file",
          mode: (stats.mode & 0o111) === 0 ? 0o644 : 0o755,
          size: content.length,
          sha256: createHash("sha256").update(content).digest("hex"),
        });
      }
    }
  };
  await walk("");
  return { version: 1, baseCommit: null, entries, directories };
}

function encodeManifest(value: unknown) {
  const raw = JSON.stringify(value);
  return { raw, ref: `sha256:${createHash("sha256").update(raw).digest("hex")}` };
}

function encodeWorkspaceManifest(manifest: WorkerWorkspaceManifest) {
  const raw = serializeWorkerWorkspaceManifest(manifest);
  return { raw, ref: `sha256:${createHash("sha256").update(raw).digest("hex")}` };
}

async function applyWorkspace(params: {
  root: string;
  stagingRoot: string;
  base: WorkerWorkspaceManifest;
  current: WorkerWorkspaceManifest;
  begin?: (journal: WorkerWorkspaceReconciliationJournal) => void;
  commit?: (manifestRef: string) => void;
  abort?: () => void;
}) {
  let pending: WorkerWorkspaceReconciliationJournal | undefined;
  return await applyStagedWorkerWorkspace({
    ...params,
    baseManifestRef: `sha256:${"a".repeat(64)}`,
    currentManifestRef: `sha256:${"b".repeat(64)}`,
    journal: {
      load: () => pending,
      begin: (journal) => {
        pending = journal;
        params.begin?.(journal);
      },
      commit: (manifestRef) => {
        params.commit?.(manifestRef);
        pending = undefined;
      },
      abort: () => {
        params.abort?.();
        pending = undefined;
      },
    },
  });
}

describe("worker workspace reconciliation", () => {
  it("rejects unsafe claim ids before constructing a staged result ref", () => {
    expect(workerWorkspaceResultRef("6f77e833-83d2-4db4-bdd4-2ad1d37edc28")).toBe(
      "refs/openclaw/worker-results/6f77e833-83d2-4db4-bdd4-2ad1d37edc28",
    );
    for (const claimId of ["", "claim.with-dot", "claim_with_underscore", "claim/with-slash"]) {
      expect(() => workerWorkspaceResultRef(claimId)).toThrow(
        "Cloud workspace result claim id is invalid",
      );
    }
  });

  it("applies the complete candidate before publishing its recovery ref", async () => {
    const local = await temporaryDirectory("workspace-staged-ref-local");
    const payload = await temporaryDirectory("workspace-staged-ref-payload");
    const complete = await temporaryDirectory("workspace-staged-ref-complete");
    await Promise.all([
      fs.writeFile(path.join(local, "changed.txt"), "base\n"),
      fs.writeFile(path.join(local, "unchanged.txt"), "keep\n"),
    ]);
    const base = encodeWorkspaceManifest(await manifestFor(local));
    await Promise.all([
      fs.writeFile(path.join(payload, "changed.txt"), "worker\n"),
      fs.writeFile(path.join(complete, "changed.txt"), "worker\n"),
      fs.writeFile(path.join(complete, "unchanged.txt"), "keep\n"),
      fs.writeFile(path.join(complete, "added.txt"), "added\n"),
      fs.writeFile(path.join(payload, "added.txt"), "added\n"),
      fs.writeFile(path.join(complete, "odd\nname.txt"), "quoted path\n"),
      fs.writeFile(path.join(payload, "odd\nname.txt"), "quoted path\n"),
    ]);
    const current = encodeWorkspaceManifest(await manifestFor(complete));
    const ref = workerWorkspaceResultRef("claim-stage-order");
    let recordedRef: string | undefined;
    let acceptedManifestRef: string | undefined;
    const prepared = await prepareRequestedWorkerWorkspaceResult({
      request: {
        localPath: local,
        remoteWorkspaceDir: "/worker/workspace",
        baseManifestRef: base.ref,
        journal: {
          load: () => undefined,
          begin: () => {},
          commit: (manifestRef) => {
            expect(recordedRef).toBeUndefined();
            acceptedManifestRef = manifestRef;
          },
          abort: () => {},
        },
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

    expect(
      await runCommandWithTimeout(
        ["git", "-C", local, "show-ref", "--verify", preparedWorkerWorkspaceResultRef(ref)],
        { timeoutMs: 10_000 },
      ),
    ).toMatchObject({ code: 0 });
    expect(
      (
        await runCommandWithTimeout(["git", "-C", local, "show-ref", "--verify", ref], {
          timeoutMs: 10_000,
        })
      ).code,
    ).not.toBe(0);
    expect(recordedRef).toBeUndefined();
    await expect(fs.readFile(path.join(local, "changed.txt"), "utf8")).resolves.toBe("base\n");
    await prepared.applyPreparedStagedResult();

    expect(recordedRef).toBeUndefined();
    expect(acceptedManifestRef).toBe(current.ref);
    expect(
      await runCommandWithTimeout(
        ["git", "-C", local, "show-ref", "--verify", preparedWorkerWorkspaceResultRef(ref)],
        { timeoutMs: 10_000 },
      ),
    ).toMatchObject({ code: 0 });
    expect(
      (
        await runCommandWithTimeout(["git", "-C", local, "show-ref", "--verify", ref], {
          timeoutMs: 10_000,
        })
      ).code,
    ).not.toBe(0);
    await prepared.publishStagedResult();

    expect(recordedRef).toBe(ref);
    expect(acceptedManifestRef).toBe(current.ref);
    await expect(fs.readFile(path.join(local, "changed.txt"), "utf8")).resolves.toBe("worker\n");
    await expect(fs.readFile(path.join(local, "unchanged.txt"), "utf8")).resolves.toBe("keep\n");
    await expect(fs.readFile(path.join(local, "added.txt"), "utf8")).resolves.toBe("added\n");
    await expect(fs.readFile(path.join(local, "odd\nname.txt"), "utf8")).resolves.toBe(
      "quoted path\n",
    );
    const replayCommit = vi.fn();
    await applyStagedWorkerWorkspaceResult({
      root: local,
      stagedResultRef: ref,
      expectedBaseManifestRef: current.ref,
      journal: {
        load: () => undefined,
        begin: () => {},
        commit: replayCommit,
        abort: () => {},
      },
    });
    expect(replayCommit).toHaveBeenCalledWith(current.ref);
    await deleteStagedWorkerWorkspaceResult({ root: local, stagedResultRef: ref });
    expect(
      (
        await runCommandWithTimeout(["git", "-C", local, "show-ref", "--verify", ref], {
          timeoutMs: 10_000,
        })
      ).code,
    ).not.toBe(0);
  });

  it("preserves the published result when its fence-row update fails", async () => {
    const local = await temporaryDirectory("workspace-staged-record-failure-local");
    const payload = await temporaryDirectory("workspace-staged-record-failure-payload");
    await fs.writeFile(path.join(local, "result.txt"), "base\n");
    await fs.writeFile(path.join(payload, "result.txt"), "worker\n");
    const base = encodeWorkspaceManifest(await manifestFor(local));
    const current = encodeWorkspaceManifest(await manifestFor(payload));
    const ref = workerWorkspaceResultRef("claim-record-failure");
    const prepared = await prepareRequestedWorkerWorkspaceResult({
      request: {
        localPath: local,
        remoteWorkspaceDir: "/worker/workspace",
        baseManifestRef: base.ref,
        journal: {
          load: () => undefined,
          begin: () => {},
          commit: () => {},
          abort: () => {},
        },
        stagedResult: {
          ref,
          record: () => {
            throw new Error("state database unavailable");
          },
        },
      },
      stagingRoot: payload,
      currentManifestRef: current.ref,
      baseManifestRaw: base.raw,
      currentManifestRaw: current.raw,
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
    const prepared = await prepareRequestedWorkerWorkspaceResult({
      request: {
        localPath: local,
        remoteWorkspaceDir: "/worker/workspace",
        baseManifestRef: base.ref,
        journal: {
          load: () => undefined,
          begin: () => {},
          commit: () => {},
          abort: () => {},
        },
        stagedResult: { ref, record: () => {} },
      },
      stagingRoot: payload,
      currentManifestRef: current.ref,
      baseManifestRaw: base.raw,
      currentManifestRaw: current.raw,
    });
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
      journal: {
        load: () => undefined,
        begin: () => {},
        commit: () => {},
        abort: () => {},
      },
    });

    expect(replay.conflictPaths).toEqual(["result.pipe"]);
    expect((await fs.lstat(fifoPath)).isFIFO()).toBe(true);
  });

  it("does not sweep cleanup refs retained by another pending result", async () => {
    const local = await temporaryDirectory("workspace-retained-cleanup-ref");
    const payload = await temporaryDirectory("workspace-retained-cleanup-payload");
    await gitInit(local);
    await fs.writeFile(path.join(payload, "result.txt"), "worker\n");
    const base = encodeWorkspaceManifest(await manifestFor(local));
    const current = encodeWorkspaceManifest(await manifestFor(payload));
    const stagedResultRef = workerWorkspaceResultRef("claim-retained-cleanup");
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
    await deleteWorkerWorkspaceResultCleanupRefs({
      root: local,
      retainedRefs: new Set([cleanupRef]),
    });
    await expect(
      hasWorkerWorkspaceResultRef({ root: local, stagedResultRef: cleanupRef }),
    ).resolves.toBe(true);

    await deleteWorkerWorkspaceResultCleanupRefs({ root: local });
    await expect(
      hasWorkerWorkspaceResultRef({ root: local, stagedResultRef: cleanupRef }),
    ).resolves.toBe(false);
  });

  it("never replays an accepted result when omitted local state kept the base ref unchanged", async () => {
    const local = await temporaryDirectory("workspace-accepted-unchanged-ref-local");
    const payload = await temporaryDirectory("workspace-accepted-unchanged-ref-payload");
    await fs.writeFile(path.join(payload, "result.pipe"), "worker file\n");
    const base = encodeWorkspaceManifest(await manifestFor(local));
    const current = encodeWorkspaceManifest(await manifestFor(payload));
    const fifoPath = path.join(local, "result.pipe");
    const mkfifo = await runCommandWithTimeout(["mkfifo", fifoPath], { timeoutMs: 10_000 });
    expect(mkfifo.code).toBe(0);
    const ref = workerWorkspaceResultRef("claim-accepted-unchanged-ref");
    const prepared = await prepareRequestedWorkerWorkspaceResult({
      request: {
        localPath: local,
        remoteWorkspaceDir: "/worker/workspace",
        baseManifestRef: base.ref,
        journal: {
          load: () => undefined,
          begin: () => {},
          commit: () => {},
          abort: () => {},
        },
        stagedResult: { ref, record: () => {} },
      },
      stagingRoot: payload,
      currentManifestRef: current.ref,
      baseManifestRaw: base.raw,
      currentManifestRaw: current.raw,
    });

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
      journal: {
        load: () => undefined,
        begin: () => {},
        commit: (manifestRef) => committed.push(manifestRef),
        abort: () => {},
      },
    });

    expect(replay.conflictPaths).toEqual(["result.pipe"]);
    expect(committed).toEqual([base.ref]);
    await expect(fs.lstat(fifoPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("resnapshots an offline local edit after the staged manifest committed", async () => {
    const local = await temporaryDirectory("workspace-committed-local-advance");
    const payload = await temporaryDirectory("workspace-committed-local-advance-payload");
    await fs.writeFile(path.join(local, "result.txt"), "base\n");
    await fs.writeFile(path.join(local, "conflict.txt"), "base\n");
    await fs.writeFile(path.join(payload, "result.txt"), "worker\n");
    await fs.writeFile(path.join(payload, "conflict.txt"), "worker\n");
    const base = encodeWorkspaceManifest(await manifestFor(local));
    const current = encodeWorkspaceManifest(await manifestFor(payload));
    const ref = workerWorkspaceResultRef("claim-committed-local-advance");
    const prepared = await prepareRequestedWorkerWorkspaceResult({
      request: {
        localPath: local,
        remoteWorkspaceDir: "/worker/workspace",
        baseManifestRef: base.ref,
        journal: {
          load: () => undefined,
          begin: () => {},
          commit: () => {},
          abort: () => {},
        },
        stagedResult: { ref, record: () => {} },
      },
      stagingRoot: payload,
      currentManifestRef: current.ref,
      baseManifestRaw: base.raw,
      currentManifestRaw: current.raw,
    });
    await fs.writeFile(path.join(local, "conflict.txt"), "first local\n");
    await prepared.applyPreparedStagedResult();
    const committed = prepared.getAppliedWorkspaceResult();
    expect(committed?.conflictPaths).toEqual(["conflict.txt"]);
    expect(committed?.manifestRef).not.toBe(current.ref);
    await prepared.publishStagedResult();
    await fs.writeFile(path.join(local, "result.txt"), "later local\n");
    const replayCommit = vi.fn();

    const replay = await applyStagedWorkerWorkspaceResult({
      root: local,
      stagedResultRef: ref,
      expectedBaseManifestRef: committed!.manifestRef,
      journal: {
        load: () => undefined,
        begin: () => {},
        commit: replayCommit,
        abort: () => {},
      },
    });

    expect(replay.conflictPaths).toEqual(["conflict.txt", "result.txt"]);
    expect(replay.manifestRef).not.toBe(current.ref);
    expect(replayCommit).toHaveBeenCalledWith(replay.manifestRef);
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
    const local = await temporaryDirectory("workspace-staged-hooks-local");
    const payload = await temporaryDirectory("workspace-staged-hooks-payload");
    await gitInit(local);
    const hook = path.join(local, ".git", "hooks", "reference-transaction");
    await fs.writeFile(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    await fs.writeFile(path.join(local, "result.txt"), "base\n");
    await fs.writeFile(path.join(payload, "result.txt"), "worker\n");
    const base = encodeWorkspaceManifest(await manifestFor(local));
    const current = encodeWorkspaceManifest(await manifestFor(payload));
    const ref = workerWorkspaceResultRef("claim-disabled-hooks");

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
    await gitInit(local);
    await fs.mkdir(path.join(local, "src"));
    await fs.writeFile(path.join(local, "keep.bin"), Buffer.from([0, 1, 2]));
    await fs.writeFile(path.join(local, "delete.txt"), "remove");
    await fs.writeFile(path.join(local, "src", "script.sh"), "before");
    const base = await manifestFor(local);

    await fs.mkdir(path.join(staged, "src"));
    await fs.writeFile(path.join(staged, "keep.bin"), Buffer.from([0, 9, 2]));
    await fs.writeFile(path.join(staged, "added.txt"), "new");
    await fs.writeFile(path.join(staged, "src", "script.sh"), "after");
    await fs.chmod(path.join(staged, "src", "script.sh"), 0o755);
    await fs.symlink("added.txt", path.join(staged, "link.txt"));
    const current = await manifestFor(staged);

    await applyWorkspace({ root: local, stagingRoot: staged, base, current });

    await expect(fs.readFile(path.join(local, "keep.bin"))).resolves.toEqual(
      Buffer.from([0, 9, 2]),
    );
    await expect(fs.readFile(path.join(local, "added.txt"), "utf8")).resolves.toBe("new");
    await expect(fs.access(path.join(local, "delete.txt"))).rejects.toThrow();
    await expect(fs.readlink(path.join(local, "link.txt"))).resolves.toBe("added.txt");
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

  it("preserves an exact local-only path and reports conflicting content", async () => {
    const local = await temporaryDirectory("workspace-local-only");
    const staged = await temporaryDirectory("workspace-local-only-staged");
    await gitInit(local);
    await fs.writeFile(path.join(local, "same.txt"), "same");
    const base = { version: 1, baseCommit: null, entries: [] } satisfies WorkerWorkspaceManifest;
    await fs.writeFile(path.join(staged, "same.txt"), "same");
    const current = await manifestFor(staged);
    await applyWorkspace({ root: local, stagingRoot: staged, base, current });
    await expect(fs.readFile(path.join(local, "same.txt"), "utf8")).resolves.toBe("same");

    await fs.writeFile(path.join(local, "same.txt"), "local");
    const result = await applyWorkspace({ root: local, stagingRoot: staged, base, current });
    expect(result.conflictPaths).toEqual(["same.txt"]);
    await expect(fs.readFile(path.join(local, "same.txt"), "utf8")).resolves.toBe("local");
  });

  it("ignores local divergence on worker-unchanged paths", async () => {
    const local = await temporaryDirectory("workspace-derived-local");
    const staged = await temporaryDirectory("workspace-derived-staged");
    await gitInit(local);
    await Promise.all([
      fs.mkdir(path.join(local, "__pycache__")),
      fs.mkdir(path.join(staged, "__pycache__")),
    ]);
    await Promise.all([
      fs.writeFile(path.join(local, "real.txt"), "base"),
      fs.writeFile(path.join(local, "__pycache__/fizzbuzz.pyc"), "base cache"),
      fs.writeFile(path.join(staged, "real.txt"), "base"),
      fs.writeFile(path.join(staged, "__pycache__/fizzbuzz.pyc"), "worker cache"),
    ]);
    const base = await manifestFor(local);
    const current = await manifestFor(staged);
    await fs.writeFile(path.join(local, "__pycache__/fizzbuzz.pyc"), "local cache");

    await applyWorkspace({ root: local, stagingRoot: staged, base, current });
    await expect(fs.readFile(path.join(local, "__pycache__/fizzbuzz.pyc"), "utf8")).resolves.toBe(
      "local cache",
    );

    await fs.writeFile(path.join(local, "real.txt"), "local divergence");
    const result = await applyWorkspace({ root: local, stagingRoot: staged, base, current });
    expect(result.conflictPaths).toEqual([]);
    await expect(fs.readFile(path.join(local, "real.txt"), "utf8")).resolves.toBe(
      "local divergence",
    );
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
    await Promise.all([
      fs.writeFile(path.join(local, "removed-dir", "base.txt"), "base"),
      fs.writeFile(path.join(staged, "removed-dir", "base.txt"), "base"),
    ]);
    const base = await manifestFor(local);

    await Promise.all([
      fs.writeFile(path.join(staged, "apply.txt"), "worker"),
      fs.writeFile(path.join(staged, "noop.txt"), "worker"),
      fs.writeFile(path.join(staged, "conflict.txt"), "worker"),
      fs.rm(path.join(staged, "deleted-apply.txt")),
      fs.rm(path.join(staged, "deleted-noop.txt")),
      fs.rm(path.join(staged, "deleted-conflict.txt")),
      fs.rm(path.join(staged, "link")),
      fs.rm(path.join(staged, "removed-dir"), { recursive: true }),
    ]);
    await fs.symlink("worker-target", path.join(staged, "link"));
    await Promise.all([
      fs.writeFile(path.join(staged, "added-identical.txt"), "worker"),
      fs.writeFile(path.join(staged, "collision.txt"), "worker"),
      fs.mkdir(path.join(staged, "tree")),
    ]);
    await fs.writeFile(path.join(staged, "tree", "file.txt"), "worker");
    const current = await manifestFor(staged);

    await Promise.all([
      fs.writeFile(path.join(local, "noop.txt"), "worker"),
      fs.writeFile(path.join(local, "conflict.txt"), "local"),
      fs.rm(path.join(local, "deleted-noop.txt")),
      fs.writeFile(path.join(local, "deleted-conflict.txt"), "local"),
      fs.rm(path.join(local, "link")),
    ]);
    await fs.symlink("local-target", path.join(local, "link"));
    await Promise.all([
      fs.writeFile(path.join(local, "added-identical.txt"), "worker"),
      fs.writeFile(path.join(local, "collision.txt"), "local"),
      fs.writeFile(path.join(local, "tree"), "local ancestor"),
      fs.writeFile(path.join(local, "removed-dir", "local.txt"), "local addition"),
      fs.writeFile(path.join(local, "worker-unchanged-local.txt"), "local only change"),
    ]);

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
    await expect(fs.readFile(path.join(local, "apply.txt"), "utf8")).resolves.toBe("worker");
    await expect(fs.readFile(path.join(local, "noop.txt"), "utf8")).resolves.toBe("worker");
    await expect(fs.readFile(path.join(local, "conflict.txt"), "utf8")).resolves.toBe("local");
    await expect(fs.lstat(path.join(local, "deleted-apply.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.lstat(path.join(local, "deleted-noop.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.readFile(path.join(local, "deleted-conflict.txt"), "utf8")).resolves.toBe(
      "local",
    );
    await expect(fs.readlink(path.join(local, "link"))).resolves.toBe("local-target");
    await expect(fs.readFile(path.join(local, "removed-dir", "local.txt"), "utf8")).resolves.toBe(
      "local addition",
    );
    await expect(fs.lstat(path.join(local, "removed-dir", "base.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.readFile(path.join(local, "tree"), "utf8")).resolves.toBe("local ancestor");
    await expect(fs.readFile(path.join(local, "worker-unchanged-local.txt"), "utf8")).resolves.toBe(
      "local only change",
    );
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

  it("applies and removes empty worker directories", async () => {
    const local = await temporaryDirectory("workspace-empty-directories");
    const staged = await temporaryDirectory("workspace-empty-directories-staged");
    const base = await manifestFor(local);
    await fs.mkdir(path.join(staged, "empty", "nested"), { recursive: true });
    const added = await manifestFor(staged);

    const addition = await applyWorkspace({
      root: local,
      stagingRoot: staged,
      base,
      current: added,
    });

    await expect(fs.stat(path.join(local, "empty", "nested"))).resolves.toMatchObject({});
    expect(addition.conflictPaths).toEqual([]);

    await fs.rm(path.join(staged, "empty"), { recursive: true });
    const removed = await manifestFor(staged);
    const deletion = await applyWorkspace({
      root: local,
      stagingRoot: staged,
      base: addition.manifest,
      current: removed,
    });

    await expect(fs.stat(path.join(local, "empty"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(deletion.conflictPaths).toEqual([]);
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

  it("applies an independent cloud child beneath a locally chmodded directory", async () => {
    const local = await temporaryDirectory("workspace-directory-mode-independent-child");
    const staged = await temporaryDirectory("workspace-directory-mode-independent-child-staged");
    await fs.mkdir(path.join(local, "src"));
    await fs.chmod(path.join(local, "src"), 0o700);
    const base = await manifestFor(local);
    await fs.mkdir(path.join(staged, "src"));
    await fs.chmod(path.join(staged, "src"), 0o700);
    await fs.writeFile(path.join(staged, "src", "cloud.txt"), "worker");
    await fs.chmod(path.join(local, "src"), 0o750);

    const applied = await applyWorkspace({
      root: local,
      stagingRoot: staged,
      base,
      current: await manifestFor(staged),
    });

    expect(applied.conflictPaths).toEqual([]);
    await expect(fs.readFile(path.join(local, "src", "cloud.txt"), "utf8")).resolves.toBe("worker");
    expect((await fs.stat(path.join(local, "src"))).mode & 0o777).toBe(0o750);
  });

  it("treats derived residue as absent after a cloud directory deletion", async () => {
    const local = await temporaryDirectory("workspace-directory-delete-derived");
    const staged = await temporaryDirectory("workspace-directory-delete-derived-staged");
    await fs.mkdir(path.join(local, "removed", "nested"), { recursive: true });
    await fs.writeFile(path.join(local, "removed", "nested", "base.txt"), "base");
    const base = await manifestFor(local);
    await fs.mkdir(path.join(local, "removed", "nested", "__pycache__"));
    await fs.writeFile(
      path.join(local, "removed", "nested", "__pycache__", "cache.pyc"),
      "derived",
    );

    const applied = await applyWorkspace({
      root: local,
      stagingRoot: staged,
      base,
      current: await manifestFor(staged),
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

  it("treats a cloud deletion as converged when local removed its unchanged parent", async () => {
    const local = await temporaryDirectory("workspace-deleted-parent-convergence");
    const staged = await temporaryDirectory("workspace-deleted-parent-convergence-staged");
    await fs.mkdir(path.join(local, "docs"));
    await fs.writeFile(path.join(local, "docs", "old.txt"), "base\n");
    await fs.mkdir(path.join(staged, "docs"));
    const base = await manifestFor(local);
    const current = await manifestFor(staged);
    await fs.rm(path.join(local, "docs"), { recursive: true });

    const applied = await applyWorkspace({ root: local, stagingRoot: staged, base, current });

    expect(applied.conflictPaths).toEqual([]);
    await expect(fs.stat(path.join(local, "docs"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("treats an identical local empty directory as already applied", async () => {
    const local = await temporaryDirectory("workspace-empty-directory-noop");
    const staged = await temporaryDirectory("workspace-empty-directory-noop-staged");
    const base = await manifestFor(local);
    await fs.mkdir(path.join(local, "same"));
    await fs.mkdir(path.join(staged, "same"));
    const current = await manifestFor(staged);
    const begin = vi.fn();

    const applied = await applyWorkspace({
      root: local,
      stagingRoot: staged,
      base,
      current,
      begin,
    });

    // A durable no-op journal distinguishes this applied result from one that
    // still needs replay if the process exits before fence acceptance.
    expect(begin).toHaveBeenCalledOnce();
    expect(applied.conflictPaths).toEqual([]);
    expect(applied.manifest.directories).toContain("same");
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

  it("does not follow a symlinked ancestor while recovering journal directories", async () => {
    const local = await temporaryDirectory("workspace-directory-recovery-symlink");
    const staged = await temporaryDirectory("workspace-directory-recovery-symlink-staged");
    const outside = await temporaryDirectory("workspace-directory-recovery-symlink-outside");
    await fs.mkdir(path.join(local, "parent", "nested"), { recursive: true });
    const base = await manifestFor(local);
    let journal: WorkerWorkspaceReconciliationJournal | undefined;
    await applyWorkspace({
      root: local,
      stagingRoot: staged,
      base,
      current: await manifestFor(staged),
      begin: (value) => {
        journal = value;
      },
    });
    await fs.symlink(outside, path.join(local, "parent"));

    await expect(
      recoverWorkerWorkspaceReconciliation({ root: local, journal: journal! }),
    ).rejects.toThrow("workspace changed while cloud recovery was pending: parent");
    await expect(fs.readdir(outside)).resolves.toEqual([]);
  });

  it("keeps an unsupported local node as a conflict", async () => {
    const local = await temporaryDirectory("workspace-unsupported-node-conflict");
    const staged = await temporaryDirectory("workspace-unsupported-node-conflict-staged");
    const base = await manifestFor(local);
    const fifoPath = path.join(local, "result.pipe");
    const mkfifo = await runCommandWithTimeout(["mkfifo", fifoPath], { timeoutMs: 10_000 });
    expect(mkfifo.code).toBe(0);
    await fs.writeFile(path.join(staged, "result.pipe"), "worker file");

    const applied = await applyWorkspace({
      root: local,
      stagingRoot: staged,
      base,
      current: await manifestFor(staged),
    });

    expect(applied.conflictPaths).toEqual(["result.pipe"]);
    expect((await fs.lstat(fifoPath)).isFIFO()).toBe(true);
    expect(applied.manifest.entries).toEqual([]);
  });

  it("does not block when an expected file is replaced by a FIFO", async () => {
    const local = await temporaryDirectory("workspace-expected-file-fifo");
    const expected = await temporaryDirectory("workspace-expected-file-fifo-manifest");
    await fs.writeFile(path.join(expected, "result.pipe"), "expected");
    const manifest = await manifestFor(expected);
    const fifoPath = path.join(local, "result.pipe");
    const mkfifo = await runCommandWithTimeout(["mkfifo", fifoPath], { timeoutMs: 10_000 });
    expect(mkfifo.code).toBe(0);

    await expect(assertWorkspaceMatchesManifest({ root: local, manifest })).rejects.toThrow(
      "Gateway workspace changed after cloud dispatch: result.pipe",
    );
  });

  it("keeps an oversized local version as a conflict", async () => {
    const local = await temporaryDirectory("workspace-oversized-node-conflict");
    const staged = await temporaryDirectory("workspace-oversized-node-conflict-staged");
    const base = await manifestFor(local);
    const oversizedPath = path.join(local, "result.bin");
    await fs.writeFile(path.join(staged, "result.bin"), "worker file");
    await fs.writeFile(oversizedPath, "");
    await fs.truncate(oversizedPath, MAX_RECONCILIATION_FILE_BYTES + 1);

    const applied = await applyWorkspace({
      root: local,
      stagingRoot: staged,
      base,
      current: await manifestFor(staged),
    });

    expect(applied.conflictPaths).toEqual(["result.bin"]);
    await expect(fs.stat(oversizedPath)).resolves.toMatchObject({
      size: MAX_RECONCILIATION_FILE_BYTES + 1,
    });
    expect(applied.manifest.entries).toEqual([]);
  });

  it("omits an unrelated oversized local file while applying other worker changes", async () => {
    const local = await temporaryDirectory("workspace-oversized-local-only");
    const staged = await temporaryDirectory("workspace-oversized-local-only-staged");
    await fs.writeFile(path.join(local, "result.txt"), "base\n");
    await fs.writeFile(path.join(staged, "result.txt"), "worker\n");
    const base = await manifestFor(local);
    const oversizedPath = path.join(local, "local-only.bin");
    await fs.writeFile(oversizedPath, "");
    await fs.truncate(oversizedPath, MAX_RECONCILIATION_FILE_BYTES + 1);

    const applied = await applyWorkspace({
      root: local,
      stagingRoot: staged,
      base,
      current: await manifestFor(staged),
    });

    expect(applied.conflictPaths).toEqual([]);
    await expect(fs.readFile(path.join(local, "result.txt"), "utf8")).resolves.toBe("worker\n");
    await expect(fs.stat(oversizedPath)).resolves.toMatchObject({
      size: MAX_RECONCILIATION_FILE_BYTES + 1,
    });
    expect(applied.manifest.entries.map((entry) => entry.path)).toEqual(["result.txt"]);
  });

  it("allows a remote file to replace a base directory containing only derived entries", async () => {
    const local = await temporaryDirectory("workspace-derived-directory-replacement");
    const staged = await temporaryDirectory("workspace-derived-directory-replacement-staged");
    await gitInit(local);
    await fs.mkdir(path.join(local, "src", "pkg", "__pycache__"), { recursive: true });
    await fs.mkdir(path.join(local, "src", "empty"));
    await fs.writeFile(path.join(local, "src", "pkg", "__pycache__", "old.pyc"), "local cache");
    const rawBase = await manifestFor(local);
    const encodedBase = encodeManifest({
      version: rawBase.version,
      baseCommit: rawBase.baseCommit,
      entries: [
        ...(rawBase.directories ?? []).map((entryPath) => ({
          path: entryPath,
          type: "directory",
          mode: 0o700,
        })),
        ...rawBase.entries,
      ].toSorted((left, right) => left.path.localeCompare(right.path)),
    });
    const base = parseWorkerWorkspaceManifest(encodedBase.raw, encodedBase.ref);
    await fs.writeFile(path.join(staged, "src"), "replacement");
    const current = await manifestFor(staged);

    await applyWorkspace({ root: local, stagingRoot: staged, base, current });

    await expect(fs.readFile(path.join(local, "src"), "utf8")).resolves.toBe("replacement");
  });

  it("keeps a current empty directory represented when it gains derived residue", async () => {
    const local = await temporaryDirectory("workspace-current-directory-derived-residue");
    const staged = await temporaryDirectory("workspace-current-directory-derived-residue-staged");
    await fs.mkdir(path.join(local, "cache-holder"));
    await fs.mkdir(path.join(staged, "cache-holder"));
    await fs.writeFile(path.join(local, "result.txt"), "base\n");
    await fs.writeFile(path.join(staged, "result.txt"), "worker\n");
    const base = await manifestFor(local);
    const current = await manifestFor(staged);
    await fs.mkdir(path.join(local, "cache-holder", "__pycache__"));
    await fs.writeFile(path.join(local, "cache-holder", "__pycache__", "module.pyc"), "derived");

    const applied = await applyWorkspace({ root: local, stagingRoot: staged, base, current });

    expect(applied.conflictPaths).toEqual([]);
    expect(applied.manifest.directories).toContain("cache-holder");
    await expect(
      fs.readFile(path.join(local, "cache-holder", "__pycache__", "module.pyc"), "utf8"),
    ).resolves.toBe("derived");
  });

  it("allows a remote file to replace a base directory with a new cache-only subtree", async () => {
    const local = await temporaryDirectory("workspace-new-derived-subtree-replacement");
    const staged = await temporaryDirectory("workspace-new-derived-subtree-replacement-staged");
    await gitInit(local);
    await fs.mkdir(path.join(local, "src"));
    await fs.writeFile(path.join(local, "src", "old.txt"), "base");
    const base = await manifestFor(local);
    await fs.mkdir(path.join(local, "src", "tmp", "__pycache__"), { recursive: true });
    await fs.writeFile(path.join(local, "src", "tmp", "__pycache__", "old.pyc"), "local cache");
    await fs.writeFile(path.join(staged, "src"), "replacement");
    const current = await manifestFor(staged);

    await applyWorkspace({ root: local, stagingRoot: staged, base, current });

    await expect(fs.readFile(path.join(local, "src"), "utf8")).resolves.toBe("replacement");
  });

  it("allows a remote file to replace a new cache-only directory", async () => {
    const local = await temporaryDirectory("workspace-new-derived-directory-replacement");
    const staged = await temporaryDirectory("workspace-new-derived-directory-replacement-staged");
    await gitInit(local);
    const base = await manifestFor(local);
    await fs.mkdir(path.join(local, "src", "tmp", "__pycache__"), { recursive: true });
    await fs.writeFile(path.join(local, "src", "tmp", "__pycache__", "old.pyc"), "local cache");
    await fs.writeFile(path.join(staged, "src"), "replacement");
    const current = await manifestFor(staged);

    await applyWorkspace({ root: local, stagingRoot: staged, base, current });

    await expect(fs.readFile(path.join(local, "src"), "utf8")).resolves.toBe("replacement");
  });

  it("rolls back a remote file that replaced a base directory", async () => {
    const local = await temporaryDirectory("workspace-directory-rollback");
    const staged = await temporaryDirectory("workspace-directory-rollback-staged");
    await gitInit(local);
    await fs.mkdir(path.join(local, "src"));
    await fs.writeFile(path.join(local, "src", "old.txt"), "base");
    const base = await manifestFor(local);
    await fs.writeFile(path.join(staged, "src"), "replacement");
    const current = await manifestFor(staged);

    await expect(
      applyWorkspace({
        root: local,
        stagingRoot: staged,
        base,
        current,
        commit: () => {
          throw new Error("placement write failed");
        },
      }),
    ).rejects.toThrow("placement write failed");

    await expect(fs.readFile(path.join(local, "src", "old.txt"), "utf8")).resolves.toBe("base");
  });

  it("restores a file over a directory containing only derived descendants", async () => {
    const local = await temporaryDirectory("workspace-directory-recovery-cache");
    const staged = await temporaryDirectory("workspace-directory-recovery-cache-staged");
    await gitInit(local);
    await fs.writeFile(path.join(local, "src"), "base");
    const base = await manifestFor(local);
    await fs.mkdir(path.join(staged, "src"));
    const current = await manifestFor(staged);
    let journal: WorkerWorkspaceReconciliationJournal | undefined;
    await applyWorkspace({
      root: local,
      stagingRoot: staged,
      base,
      current,
      begin: (value) => {
        journal = value;
      },
    });
    await fs.mkdir(path.join(local, "src", "pkg", "__pycache__"), { recursive: true });
    await fs.writeFile(path.join(local, "src", "pkg", "__pycache__", "remote.pyc"), "local cache");

    await recoverWorkerWorkspaceReconciliation({ root: local, journal: journal! });

    await expect(fs.readFile(path.join(local, "src"), "utf8")).resolves.toBe("base");
  });

  it("does not follow a base symlink while replacing it with a directory", async () => {
    const local = await temporaryDirectory("workspace-symlink-replacement");
    const staged = await temporaryDirectory("workspace-symlink-replacement-staged");
    await gitInit(local);
    await fs.mkdir(path.join(local, "target"));
    await fs.mkdir(path.join(local, "target", "nested", "__pycache__"), { recursive: true });
    await fs.writeFile(path.join(local, "target", "file.txt"), "base target");
    await fs.writeFile(
      path.join(local, "target", "nested", "__pycache__", "cache.pyc"),
      "outside cache",
    );
    await fs.symlink("target", path.join(local, "entry"));
    const base = await manifestFor(local);

    await fs.mkdir(path.join(staged, "target"));
    await fs.writeFile(path.join(staged, "target", "file.txt"), "base target");
    await fs.mkdir(path.join(staged, "entry"));
    await fs.writeFile(path.join(staged, "entry", "nested"), "remote directory");
    const current = await manifestFor(staged);

    await applyWorkspace({ root: local, stagingRoot: staged, base, current });

    expect((await fs.lstat(path.join(local, "entry"))).isDirectory()).toBe(true);
    await expect(fs.readFile(path.join(local, "entry", "nested"), "utf8")).resolves.toBe(
      "remote directory",
    );
    await expect(fs.readFile(path.join(local, "target", "file.txt"), "utf8")).resolves.toBe(
      "base target",
    );
    await expect(
      fs.readFile(path.join(local, "target", "nested", "__pycache__", "cache.pyc"), "utf8"),
    ).resolves.toBe("outside cache");
  });

  it("materializes descendants when replacing a base file with a directory", async () => {
    const local = await temporaryDirectory("workspace-file-directory-replacement");
    const staged = await temporaryDirectory("workspace-file-directory-replacement-staged");
    await gitInit(local);
    await fs.writeFile(path.join(local, "entry"), "base file");
    const base = await manifestFor(local);
    await fs.mkdir(path.join(staged, "entry"));
    await fs.writeFile(path.join(staged, "entry", "nested.txt"), "worker");
    const current = await manifestFor(staged);

    const result = await applyWorkspace({ root: local, stagingRoot: staged, base, current });

    expect(result.conflictPaths).toEqual([]);
    expect((await fs.lstat(path.join(local, "entry"))).isDirectory()).toBe(true);
    await expect(fs.readFile(path.join(local, "entry", "nested.txt"), "utf8")).resolves.toBe(
      "worker",
    );
  });

  it("does not follow a local-only symlink ancestor omitted from older manifests", async () => {
    const local = await temporaryDirectory("workspace-local-only-symlink-ancestor");
    const staged = await temporaryDirectory("workspace-local-only-symlink-ancestor-staged");
    const outside = await temporaryDirectory("workspace-local-only-symlink-ancestor-outside");
    await fs.writeFile(path.join(outside, "worker.txt"), "outside local");
    await fs.symlink(outside, path.join(local, "link"));
    await fs.mkdir(path.join(staged, "link"));
    await fs.writeFile(path.join(staged, "link", "worker.txt"), "worker result");
    const current = await manifestFor(staged);
    current.directories = [];

    const result = await applyWorkspace({
      root: local,
      stagingRoot: staged,
      base: { version: 1, baseCommit: null, entries: [], directories: [] },
      current,
    });

    expect(result.conflictPaths).toEqual(["link"]);
    expect((await fs.lstat(path.join(local, "link"))).isSymbolicLink()).toBe(true);
    await expect(fs.readFile(path.join(outside, "worker.txt"), "utf8")).resolves.toBe(
      "outside local",
    );
  });

  it("keeps a local descendant when both sides replace a base file with a directory", async () => {
    const local = await temporaryDirectory("workspace-file-to-directory-conflict");
    const staged = await temporaryDirectory("workspace-file-to-directory-conflict-staged");
    await gitInit(local);
    await fs.writeFile(path.join(local, "entry"), "base file");
    const base = await manifestFor(local);
    await fs.mkdir(path.join(staged, "entry"));
    await fs.writeFile(path.join(staged, "entry", "nested.txt"), "worker");
    const current = await manifestFor(staged);
    await fs.rm(path.join(local, "entry"));
    await fs.mkdir(path.join(local, "entry"));
    await fs.writeFile(path.join(local, "entry", "nested.txt"), "local");

    const result = await applyWorkspace({ root: local, stagingRoot: staged, base, current });

    expect(result.conflictPaths).toEqual(["entry/nested.txt"]);
    await expect(fs.readFile(path.join(local, "entry", "nested.txt"), "utf8")).resolves.toBe(
      "local",
    );
  });

  it("accepts a convergent directory-to-file replacement without reading old descendants", async () => {
    const local = await temporaryDirectory("workspace-directory-to-file-noop");
    const staged = await temporaryDirectory("workspace-directory-to-file-noop-staged");
    await gitInit(local);
    await fs.mkdir(path.join(local, "entry"));
    await fs.writeFile(path.join(local, "entry", "nested.txt"), "base");
    const base = await manifestFor(local);
    await fs.writeFile(path.join(staged, "entry"), "same replacement");
    const current = await manifestFor(staged);
    await fs.rm(path.join(local, "entry"), { recursive: true });
    await fs.writeFile(path.join(local, "entry"), "same replacement");

    const result = await applyWorkspace({ root: local, stagingRoot: staged, base, current });

    expect(result.conflictPaths).toEqual([]);
    await expect(fs.readFile(path.join(local, "entry"), "utf8")).resolves.toBe("same replacement");
  });

  it("keeps a locally replaced unchanged ancestor when the worker adds a child", async () => {
    const local = await temporaryDirectory("workspace-unchanged-ancestor-conflict");
    const staged = await temporaryDirectory("workspace-unchanged-ancestor-conflict-staged");
    await gitInit(local);
    await Promise.all([fs.mkdir(path.join(local, "entry")), fs.mkdir(path.join(staged, "entry"))]);
    const base = await manifestFor(local);
    await fs.writeFile(path.join(staged, "entry", "new.txt"), "worker");
    const current = await manifestFor(staged);
    await fs.rm(path.join(local, "entry"), { recursive: true });
    await fs.writeFile(path.join(local, "entry"), "local replacement");

    const result = await applyWorkspace({ root: local, stagingRoot: staged, base, current });

    expect(result.conflictPaths).toEqual(["entry"]);
    await expect(fs.readFile(path.join(local, "entry"), "utf8")).resolves.toBe("local replacement");
  });

  it("merges independent children added under the same new directory", async () => {
    const local = await temporaryDirectory("workspace-independent-directory-additions");
    const staged = await temporaryDirectory("workspace-independent-directory-additions-staged");
    await gitInit(local);
    const base = await manifestFor(local);
    await fs.mkdir(path.join(staged, "entry"));
    await fs.writeFile(path.join(staged, "entry", "cloud.txt"), "worker");
    const current = await manifestFor(staged);
    await fs.mkdir(path.join(local, "entry"));
    await fs.writeFile(path.join(local, "entry", "local.txt"), "local");

    const result = await applyWorkspace({ root: local, stagingRoot: staged, base, current });

    expect(result.conflictPaths).toEqual([]);
    await expect(fs.readFile(path.join(local, "entry", "cloud.txt"), "utf8")).resolves.toBe(
      "worker",
    );
    await expect(fs.readFile(path.join(local, "entry", "local.txt"), "utf8")).resolves.toBe(
      "local",
    );
  });

  it("rolls back atomically when durable manifest acceptance fails", async () => {
    const local = await temporaryDirectory("workspace-rollback");
    const staged = await temporaryDirectory("workspace-rollback-staged");
    await gitInit(local);
    await fs.writeFile(path.join(local, "file.txt"), "base");
    const base = await manifestFor(local);
    await fs.writeFile(path.join(staged, "file.txt"), "remote");
    await fs.writeFile(path.join(staged, "added.txt"), "remote");
    const current = await manifestFor(staged);
    let aborted = false;

    await expect(
      applyWorkspace({
        root: local,
        stagingRoot: staged,
        base,
        current,
        commit: () => {
          throw new Error("placement write failed");
        },
        abort: () => {
          aborted = true;
        },
      }),
    ).rejects.toThrow("placement write failed");
    expect(aborted).toBe(true);
    await expect(fs.readFile(path.join(local, "file.txt"), "utf8")).resolves.toBe("base");
    await expect(fs.access(path.join(local, "added.txt"))).rejects.toThrow();
  });

  it("refuses to roll back a file-to-directory replacement over a later local child", async () => {
    const local = await temporaryDirectory("workspace-file-directory-recovery-local-child");
    const staged = await temporaryDirectory("workspace-file-directory-recovery-local-child-staged");
    await fs.writeFile(path.join(local, "entry"), "base");
    const base = await manifestFor(local);
    await fs.mkdir(path.join(staged, "entry"));
    await fs.writeFile(path.join(staged, "entry", "cloud.txt"), "worker");
    let journal: WorkerWorkspaceReconciliationJournal | undefined;
    await applyWorkspace({
      root: local,
      stagingRoot: staged,
      base,
      current: await manifestFor(staged),
      begin: (value) => {
        journal = value;
      },
    });
    await fs.writeFile(path.join(local, "entry", "local.txt"), "later local");

    await expect(
      recoverWorkerWorkspaceReconciliation({ root: local, journal: journal! }),
    ).rejects.toThrow("entry");
    await expect(fs.readFile(path.join(local, "entry", "local.txt"), "utf8")).resolves.toBe(
      "later local",
    );
  });

  it("recovers SHA-1 journals under SHA-256 defaults before and after partial apply", async () => {
    vi.stubEnv("GIT_DEFAULT_HASH", "sha256");
    const local = await temporaryDirectory("workspace-crash-recovery");
    const staged = await temporaryDirectory("workspace-crash-recovery-staged");
    await gitInit(local);
    await fs.writeFile(path.join(local, "file.txt"), "base");
    const base = await manifestFor(local);
    await fs.writeFile(path.join(staged, "file.txt"), "remote");
    await fs.writeFile(path.join(staged, "added.txt"), "remote");
    const current = await manifestFor(staged);
    let journal: WorkerWorkspaceReconciliationJournal | undefined;
    await applyWorkspace({
      root: local,
      stagingRoot: staged,
      base,
      current,
      begin: (value) => {
        journal = value;
      },
    });
    expect(journal).toBeDefined();
    expect(journal?.baseTree).toMatch(/^[a-f0-9]{40}$/u);
    // Simulate interruption after the addition but before the modification.
    await fs.writeFile(path.join(local, "file.txt"), "base");
    await recoverWorkerWorkspaceReconciliation({ root: local, journal: journal! });
    await expect(fs.readFile(path.join(local, "file.txt"), "utf8")).resolves.toBe("base");
    await expect(fs.access(path.join(local, "added.txt"))).rejects.toThrow();
    await recoverWorkerWorkspaceReconciliation({ root: local, journal: journal! });

    await fs.rm(path.join(local, "file.txt"));
    await expect(
      recoverWorkerWorkspaceReconciliation({ root: local, journal: journal! }),
    ).rejects.toThrow("workspace changed while cloud recovery was pending");
    await expect(fs.access(path.join(local, "file.txt"))).rejects.toThrow();
  });

  it("ignores derived paths in a journal created before the exclusion", async () => {
    const local = await temporaryDirectory("workspace-derived-recovery");
    const staged = await temporaryDirectory("workspace-derived-recovery-staged");
    await gitInit(local);
    await Promise.all([
      fs.writeFile(path.join(local, "file.txt"), "base"),
      fs.writeFile(path.join(local, ":literal.ts"), "base literal"),
    ]);
    const base = await manifestFor(local);
    await Promise.all([
      fs.writeFile(path.join(staged, "file.txt"), "remote"),
      fs.writeFile(path.join(staged, ":literal.ts"), "remote literal"),
    ]);
    const current = await manifestFor(staged);
    let journal: WorkerWorkspaceReconciliationJournal | undefined;
    await applyWorkspace({
      root: local,
      stagingRoot: staged,
      base,
      current,
      begin: (value) => {
        journal = value;
      },
    });
    expect(journal).toBeDefined();
    expect(journal!.baseEntries.map((entry) => entry.path)).toContain(":literal.ts");
    expect(await fs.readFile(path.join(local, ":literal.ts"), "utf8")).toBe("remote literal");
    const withLegacyDerivedPath = (entry: WorkerWorkspaceManifestEntry) => {
      if (entry.path !== "file.txt") {
        return entry;
      }
      const legacyEntry = structuredClone(entry);
      legacyEntry.path = "__pycache__/file.pyc";
      return legacyEntry;
    };
    const legacyJournal = {
      ...journal!,
      baseEntries: journal!.baseEntries.map(withLegacyDerivedPath),
      appliedEntries: journal!.appliedEntries.map(withLegacyDerivedPath),
    } satisfies WorkerWorkspaceReconciliationJournal;
    await fs.mkdir(path.join(local, "__pycache__"));
    await fs.writeFile(path.join(local, "__pycache__/file.pyc"), "local cache");

    await recoverWorkerWorkspaceReconciliation({ root: local, journal: legacyJournal });

    expect(await fs.readFile(path.join(local, "file.txt"), "utf8")).toBe("remote");
    expect(await fs.readFile(path.join(local, ":literal.ts"), "utf8")).toBe("base literal");
    await expect(fs.readFile(path.join(local, "__pycache__/file.pyc"), "utf8")).resolves.toBe(
      "local cache",
    );
  });

  it("does not follow a symlink-raced ancestor during Git patch application", async () => {
    const local = await temporaryDirectory("workspace-symlink-race");
    const staged = await temporaryDirectory("workspace-symlink-race-staged");
    const outside = await temporaryDirectory("workspace-symlink-race-outside");
    await gitInit(local);
    await fs.mkdir(path.join(local, "src"));
    await fs.writeFile(path.join(local, "src", "file.txt"), "base");
    await fs.mkdir(path.join(staged, "src"));
    await fs.writeFile(path.join(staged, "src", "file.txt"), "remote");
    await fs.writeFile(path.join(outside, "file.txt"), "outside");
    const base = await manifestFor(local);
    const current = await manifestFor(staged);

    await expect(
      applyWorkspace({
        root: local,
        stagingRoot: staged,
        base,
        current,
        begin: () => {
          renameSync(path.join(local, "src"), path.join(local, "original-src"));
          symlinkSync(outside, path.join(local, "src"));
        },
      }),
    ).rejects.toThrow();
    await expect(fs.readFile(path.join(outside, "file.txt"), "utf8")).resolves.toBe("outside");
  });

  it("authenticates manifests, normalizes Git modes, and rejects escaping symlinks", () => {
    const value = {
      version: 1,
      baseCommit: null,
      entries: [
        { path: "dir", type: "directory", mode: 0o700 },
        { path: "dir/file", type: "file", mode: 0o600, size: 1, sha256: "a".repeat(64) },
      ],
    };
    const encoded = encodeManifest(value);
    expect(parseWorkerWorkspaceManifest(encoded.raw, encoded.ref).entries).toEqual([
      { path: "dir/file", type: "file", mode: 0o644, size: 1, sha256: "a".repeat(64) },
    ]);
    const legacyDerived = encodeManifest({
      version: 1,
      baseCommit: null,
      entries: [
        { path: "__pycache__", type: "directory", mode: 0o700 },
        {
          path: "__pycache__/fizzbuzz.pyc",
          type: "file",
          mode: 0o600,
          size: 1,
          sha256: "b".repeat(64),
        },
      ],
    });
    expect(parseWorkerWorkspaceManifest(legacyDerived.raw, legacyDerived.ref)).toMatchObject({
      entries: [],
      directories: [],
    });
    expect(() => parseWorkerWorkspaceManifest(`${encoded.raw} `, encoded.ref)).toThrow("digest");
    for (const target of ["../outside", "..\\outside", "C:/outside"]) {
      const invalid = encodeManifest({
        version: 1,
        baseCommit: null,
        entries: [{ path: "link", type: "symlink", mode: 0o777, target }],
      });
      expect(() => parseWorkerWorkspaceManifest(invalid.raw, invalid.ref)).toThrow("symlink");
    }
  });

  it("returns only changed current payload paths", () => {
    const file = (
      entryPath: string,
      hash: string,
    ): Extract<WorkerWorkspaceManifestEntry, { type: "file" }> => ({
      path: entryPath,
      type: "file",
      mode: 0o644,
      size: 1,
      sha256: hash.repeat(64),
    });
    const base = {
      version: 1,
      baseCommit: null,
      entries: [file("a", "a"), file("b", "b")],
    } satisfies WorkerWorkspaceManifest;
    const current = {
      version: 1,
      baseCommit: null,
      entries: [file("a", "c"), file("c", "d")],
    } satisfies WorkerWorkspaceManifest;
    expect(workerWorkspaceTransferPaths(current, base)).toEqual(["a", "c"]);

    const oversized = file("large", "e");
    oversized.size = MAX_RECONCILIATION_FILE_BYTES + 1;
    expect(() =>
      workerWorkspaceTransferPaths(
        { version: 1, baseCommit: null, entries: [oversized] },
        { version: 1, baseCommit: null, entries: [] },
      ),
    ).toThrow("too large");
  });
});
