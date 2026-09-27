import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import type { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import * as processExec from "../../process/exec.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { closeOpenClawStateDatabaseByPath } from "../../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { createSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import * as publicationSnapshot from "../github-repository-publication-snapshot.js";
import {
  forkSessionRepositoryWorkspace,
  readSessionRepositoryArtifacts,
  recoverSessionRepositoryCheckpoint,
  stageSessionRepositoryCheckpoint,
  withSessionRepositoryCheckpoint,
} from "./session-repository-checkpoints.js";
import * as workspaceManifestWorker from "./workspace-manifest-worker.js";
import { serializeWorkerWorkspaceManifest } from "./workspace-manifest.js";
import { readActualWorkspaceManifest } from "./workspace-reconcile-core.js";
import * as workspaceResultGit from "./workspace-result-git.js";
import { requireWorkspaceResultGit } from "./workspace-result-git.js";
import {
  hasWorkerWorkspaceResultRef,
  readStagedWorkerWorkspaceResult,
  workerWorkspaceResultRef,
} from "./workspace-result-staging.js";

const roots: string[] = [];
const baseCommit = "a".repeat(40);
const assertCurrent = () => {};
const hash = (bytes: string) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    closeOpenClawStateDatabaseByPath(path.join(root, "openclaw.sqlite"));
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  // openclaw-temp-dir: allow database closure and artifact cleanup share this root.
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-repository-checkpoint-")),
  );
  roots.push(root);
  const database = openOpenClawStateDatabase({ path: path.join(root, "openclaw.sqlite") });
  const store = createSessionRepositoryWorkspaceStore({ database });
  const remote = path.join(root, "remote");
  await fs.mkdir(remote);
  await fs.writeFile(path.join(remote, "keep.txt"), "upstream\n");
  await fs.writeFile(path.join(remote, "remove.txt"), "remove me\n");
  const base = await readActualWorkspaceManifest({ root: remote, baseCommit });
  const baseManifestRaw = serializeWorkerWorkspaceManifest(base.manifest);
  const initial = store.create({
    agentId: "main",
    sessionKey: "agent:main:repository",
    url: "https://github.com/example/project.git",
    assertCurrent,
  });
  const workspace = store.bindBase({
    workspaceId: initial.workspaceId,
    expectedRevision: initial.revision,
    baseCommit,
    baseManifestHash: base.manifestRef,
    assertCurrent,
  });
  const stage = async (
    claim: string,
    extra: Partial<Parameters<typeof stageSessionRepositoryCheckpoint>[0]> = {},
  ) => {
    const current = await readActualWorkspaceManifest({ root: remote, baseCommit });
    return await stageSessionRepositoryCheckpoint({
      store,
      workspaceId: workspace.workspaceId,
      expectedRevision: store.get(workspace.workspaceId)!.revision,
      checkpointRef: workerWorkspaceResultRef(claim),
      stagingRoot: remote,
      baseManifestRaw,
      currentManifestRaw: serializeWorkerWorkspaceManifest(current.manifest),
      baseManifestRef: base.manifestRef,
      currentManifestRef: current.manifestRef,
      assertCurrent,
      ...extra,
    });
  };
  return { root, remote, database, store, workspace, stage };
}

async function publicationFixture(root: string, content = "working tree\n") {
  const normalized = Buffer.from(content);
  const sha = await requireWorkspaceResultGit(root, ["hash-object", "--stdin"], {
    input: normalized,
  });
  const publicationStagingRoot = path.join(root, "publication");
  await fs.mkdir(path.join(publicationStagingRoot, "blobs"), { recursive: true });
  await fs.writeFile(path.join(publicationStagingRoot, "blobs", sha), normalized);
  const metadata = JSON.stringify({
    version: 1,
    baseCommit,
    baseTree: "b".repeat(40),
    workspaceTree: "c".repeat(40),
    entries: [{ path: "edit.txt", mode: "100644", sha }],
  });
  await fs.writeFile(path.join(publicationStagingRoot, "snapshot.json"), metadata);
  return { sha, input: { publicationStagingRoot, publicationDigest: hash(metadata) } };
}

it("keeps publication staging workspace-row reads independent of distinct blob count", async () => {
  const measure = async (blobCount: number) => {
    const { root, remote, database, store, workspace, stage } = await fixture();
    const files: Array<{ path: string; content: string; sha: string }> = [];
    for (let index = 0; index < blobCount; index++) {
      const content = `publication blob ${index}\n`;
      // Ask Git for its object identity; this is not a configuration/security digest.
      const sha = await requireWorkspaceResultGit(root, ["hash-object", "--stdin"], {
        input: Buffer.from(content),
      });
      files.push({ path: `edit-${index}.txt`, content, sha });
    }
    const publicationStagingRoot = path.join(root, "publication");
    await fs.mkdir(path.join(publicationStagingRoot, "blobs"), { recursive: true });
    for (const file of files) {
      await fs.writeFile(path.join(remote, file.path), file.content.replace("\n", "\r\n"));
      await fs.writeFile(path.join(publicationStagingRoot, "blobs", file.sha), file.content);
    }
    const metadata = JSON.stringify({
      version: 1,
      baseCommit,
      baseTree: "b".repeat(40),
      workspaceTree: "c".repeat(40),
      entries: files.map(({ path: entryPath, sha }) => ({ path: entryPath, mode: "100644", sha })),
    });
    await fs.writeFile(path.join(publicationStagingRoot, "snapshot.json"), metadata);
    const counter = trackSqliteStatementExecutions(database.db, ["workspaceRows"], (sql) =>
      /^\s*select\b/iu.test(sql) && /\bfrom\s+["`[]?session_repository_workspaces\b/iu.test(sql)
        ? "workspaceRows"
        : null,
    );
    // Measure staging only; preparation uses the real store revision predicate.
    const prepared = await stage(`publication-query-cost-${blobCount}`, {
      publicationStagingRoot,
      publicationDigest: hash(metadata),
    }).finally(counter.restore);
    try {
      const artifact = store.artifactPath(workspace.workspaceId);
      const refs = (
        await requireWorkspaceResultGit(artifact, [
          "for-each-ref",
          "--format=%(refname)",
          "refs/openclaw/worker-result-candidates/",
        ])
      )
        .split("\n")
        .filter(Boolean);
      const candidates = await Promise.all(
        refs.map((ref) => readStagedWorkerWorkspaceResult(artifact, ref)),
      );
      const recovery = candidates.find((candidate) => candidate.base.baseCommit === baseCommit);
      const companion = candidates.find((candidate) => candidate.base.baseCommit === null);
      const payload = new Map<string, string>();
      if (companion) {
        for await (const { entry, content } of companion.readEntries()) {
          if (content) {
            payload.set(entry.path, Buffer.from(content).toString("utf8"));
          }
        }
      }
      let recoveryFilesMatching = 0;
      if (recovery) {
        for await (const { entry, content } of recovery.readEntries()) {
          const file = files.find((candidateFile) => candidateFile.path === entry.path);
          if (
            file &&
            content &&
            Buffer.from(content).toString("utf8") === file.content.replace("\n", "\r\n")
          ) {
            recoveryFilesMatching += 1;
          }
        }
      }
      return {
        blobCount,
        distinctBlobs: new Set(files.map((file) => file.sha)).size,
        workspaceRowReads: counter.counts.workspaceRows,
        workspaceRowsReturned: counter.rowCounts.workspaceRows,
        candidateCount: candidates.length,
        companionFileCount: payload.size,
        companionBlobsMatching: files.filter(
          (file) => payload.get(`blobs/${file.sha}`) === file.content,
        ).length,
        metadataMatches: payload.get("snapshot.json") === metadata,
        bindingMatches:
          payload.get("binding.json") ===
          JSON.stringify({
            currentManifestRef: recovery?.currentManifestRef,
            publicationDigest: hash(metadata),
          }),
        recoveryFilesMatching,
      };
    } finally {
      await prepared.discard();
    }
  };
  const samples = [await measure(1), await measure(8)];
  // Emit both real execution counts and imported-content facts before the red assertion.
  console.info("publication-staging-workspace-reads", JSON.stringify(samples));
  for (const sample of samples) {
    expect(sample).toMatchObject({
      distinctBlobs: sample.blobCount,
      candidateCount: 2,
      companionFileCount: sample.blobCount + 2,
      companionBlobsMatching: sample.blobCount,
      metadataMatches: true,
      bindingMatches: true,
      recoveryFilesMatching: sample.blobCount,
    });
    expect(sample.workspaceRowReads).toBeGreaterThan(0);
    expect(sample.workspaceRowsReturned).toBe(sample.workspaceRowReads);
  }
  expect(samples[1]!.workspaceRowReads).toBe(samples[0]!.workspaceRowReads);
});

it.each([false, true])(
  "fences Git initialization after checkpoint directory creation (revoked=%s)",
  async (revoke) => {
    const { store, workspace, stage } = await fixture();
    const artifact = store.artifactPath(workspace.workspaceId);
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const mkdir = fs.mkdir.bind(fs);
    let current = true;
    let held = false;
    vi.spyOn(fs, "mkdir").mockImplementation(async (...args) => {
      const result = await mkdir(...args);
      if (!held && String(args[0]) === artifact) {
        held = true;
        entered.resolve();
        await release.promise;
      }
      return result;
    });
    const pending = stage("directory-authority", {
      assertCurrent: () => {
        if (!current) {
          throw new Error("checkpoint authority closed");
        }
      },
    }).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await Promise.race([
      entered.promise,
      pending.then((outcome) => {
        throw new Error("Checkpoint settled before directory creation", { cause: outcome });
      }),
    ]);
    current = !revoke;
    release.resolve();
    const outcome = await pending;
    if (outcome.ok) {
      await outcome.value.discard();
    }
    expect(outcome.ok).toBe(!revoke);
    if (revoke) {
      await expect(fs.stat(path.join(artifact, "HEAD"))).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      await expect(fs.stat(path.join(artifact, "HEAD"))).resolves.toBeDefined();
    }
  },
);

it.for([
  { boundary: "metadata", closure: "authority", publication: true },
  { boundary: "queue", closure: "authority", publication: false },
  ...["preparation", "import"].flatMap((boundary) =>
    ["none", "authority", "revision"].map((closure) => ({ boundary, closure, publication: false })),
  ),
  ...["before-preparation", "preparation", "queue"].flatMap((boundary) =>
    ["none", "authority", "revision"].map((closure) => ({ boundary, closure, publication: true })),
  ),
])(
  "fences publication=$publication at $boundary with $closure closure",
  async ({ boundary, closure, publication }, { signal }) => {
    const { root, remote, store, workspace, stage } = await fixture();
    await fs.writeFile(path.join(remote, "edit.txt"), "working tree\n");
    const { input } = await publicationFixture(root);
    const artifact = store.artifactPath(workspace.workspaceId);
    await fs.mkdir(artifact, { recursive: true });
    await requireWorkspaceResultGit(artifact, ["init", "--quiet", "--bare"]);
    const common = await fs.realpath(artifact);
    const queueKey = process.platform === "win32" ? common.toLowerCase() : common;
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const unblock = () => release.resolve();
    signal.addEventListener("abort", unblock, { once: true });
    const pause = async () => {
      entered.resolve();
      await release.promise;
    };
    let current = true;
    let publicationPreparations = 0;
    let queueOwner: Promise<void> | undefined;
    const importRoots: string[] = [];
    const holdQueue = async () => {
      const held = createDeferredCore();
      queueOwner = workspaceResultGit.withWorkspaceResultRefMutation(artifact, async () => {
        held.resolve();
        await release.promise;
      });
      await Promise.race([held.promise, queueOwner]);
      const queue = resolveGlobalSingleton<KeyedAsyncQueue>(
        Symbol.for("openclaw.gitRefMutations"),
        () => {
          throw new Error("Git ref queue not initialized");
        },
      );
      const enqueue = queue.enqueue.bind(queue);
      vi.spyOn(queue, "enqueue").mockImplementation((key, task, hooks) => {
        const queued = enqueue(key, task, hooks);
        if (key === queueKey) {
          entered.resolve();
        }
        return queued;
      });
    };
    const metadata = publicationSnapshot.readGitHubRepositoryPublicationMetadata;
    vi.spyOn(publicationSnapshot, "readGitHubRepositoryPublicationMetadata").mockImplementation(
      async (...args) => {
        const result = await metadata(...args);
        if (boundary === "metadata") {
          await pause();
        }
        return result;
      },
    );
    const mkdtemp = fs.mkdtemp.bind(fs);
    vi.spyOn(fs, "mkdtemp").mockImplementation(async (...args) => {
      const result = await mkdtemp(...args);
      if (path.basename(args[0]).startsWith("openclaw-workspace-import-")) {
        importRoots.push(result);
        if (boundary === "before-preparation" && importRoots.length === 2) {
          await pause();
        }
      }
      return result;
    });
    const prepare = workspaceManifestWorker.prepareWorkspaceStageInput;
    vi.spyOn(workspaceManifestWorker, "prepareWorkspaceStageInput").mockImplementation(
      async (params) => {
        if ("publication" in params) {
          publicationPreparations++;
        }
        const result = await prepare(params);
        if ("publication" in params === publication) {
          // A real admitted worker completes its private input; closure does not cancel it instantly.
          if (boundary === "preparation") {
            await pause();
          }
          if (boundary === "queue") {
            await holdQueue();
          }
        }
        return result;
      },
    );
    const runExec = processExec.runExec;
    const imports = vi.spyOn(processExec, "runExec").mockImplementation(async (...args) => {
      const result = await runExec(...args);
      if (boundary === "import" && args[0] === "git" && args[1].includes("fast-import")) {
        await pause();
      }
      return result;
    });
    const pending = stage("publication-authority", {
      ...(publication ? input : {}),
      assertCurrent: () => {
        if (!current) {
          throw new Error("checkpoint authority closed");
        }
      },
    }).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    try {
      await Promise.race([
        entered.promise,
        pending.then((outcome) => {
          throw new Error("Checkpoint settled before publication boundary", { cause: outcome });
        }),
      ]);
      const preparedInput = ["preparation", "queue", "import"].includes(boundary);
      expect(publicationPreparations).toBe(publication && preparedInput ? 1 : 0);
      if (preparedInput) {
        expect((await fs.stat(path.join(importRoots.at(-1)!, "fast-import"))).size).toBeGreaterThan(
          0,
        );
      }
      current = closure !== "authority";
      if (closure === "revision") {
        store.bindBase({
          workspaceId: workspace.workspaceId,
          expectedRevision: workspace.revision,
          baseCommit,
          assertCurrent,
        });
      }
      const atRelease = store.get(workspace.workspaceId);
      release.resolve();
      const outcome = await pending;
      if (outcome.ok) {
        await outcome.value.publish();
        await outcome.value.discard();
      }
      await queueOwner;
      expect(outcome.ok).toBe(closure === "none");
      if (!outcome.ok) {
        expect(outcome.error).toMatchObject({
          message:
            closure === "authority"
              ? "checkpoint authority closed"
              : "Repository workspace revision changed",
        });
        expect(store.get(workspace.workspaceId)).toEqual(atRelease);
      }
      expect(
        imports.mock.calls.filter(
          ([command, args]) => command === "git" && args.includes("fast-import"),
        ),
      ).toHaveLength(
        closure === "none" ? (publication ? 2 : 1) : publication || boundary === "import" ? 1 : 0,
      );
      for (const directory of importRoots) {
        await expect(fs.stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
      }
      const refs = await requireWorkspaceResultGit(artifact, [
        "for-each-ref",
        "--format=%(refname)",
        "refs/openclaw/",
      ]);
      expect(refs.split("\n").filter(Boolean)).toHaveLength(
        closure === "none" ? (publication ? 2 : 1) : 0,
      );
      expect(refs).not.toContain("worker-result-candidates");
      expect(publicationPreparations).toBe(
        publication && (closure === "none" || preparedInput) ? 1 : 0,
      );
    } finally {
      release.resolve();
      const outcome = await pending;
      await queueOwner;
      if (outcome.ok) {
        await outcome.value.discard();
      }
      signal.removeEventListener("abort", unblock);
    }
  },
);

it.for(["none", "authority", "revision"] as const)(
  "fences final checkpoint ref input with %s closure",
  async (closure, { signal }) => {
    const { remote, store, workspace, stage } = await fixture();
    await fs.writeFile(path.join(remote, "edit.txt"), "final input admission\n");
    let current = true;
    const prepared = await stage("final-input-authority", {
      assertCurrent: () => {
        if (!current) {
          throw new Error("checkpoint authority closed");
        }
      },
    });
    const artifact = store.artifactPath(workspace.workspaceId);
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const unblock = () => release.resolve();
    signal.addEventListener("abort", unblock, { once: true });
    const run = processExec.runCommandWithTimeout;
    let held = false;
    vi.spyOn(processExec, "runCommandWithTimeout").mockImplementation(async (...args) => {
      if (!held && args[0].includes(artifact) && args[0].includes("update-ref")) {
        held = true;
        entered.resolve();
        await release.promise;
      }
      // Preserve real spawn, nonempty ref input, and the runner-owned beforeInput call.
      return await run(...args);
    });
    const pending = prepared.publish().then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    try {
      await Promise.race([
        entered.promise,
        pending.then((outcome) => {
          throw new Error("Checkpoint settled before final ref input", { cause: outcome });
        }),
      ]);
      const refs = () =>
        requireWorkspaceResultGit(artifact, [
          "for-each-ref",
          "--format=%(refname)",
          "refs/openclaw/worker-results/",
        ]);
      expect(await refs()).toBe("");
      current = closure !== "authority";
      if (closure === "revision") {
        store.bindBase({
          workspaceId: workspace.workspaceId,
          expectedRevision: workspace.revision,
          baseCommit,
          assertCurrent,
        });
      }
      const atRelease = store.get(workspace.workspaceId)!;
      release.resolve();
      const outcome = await pending;
      await prepared.discard();
      const publishedRefs = await refs();
      const after = store.get(workspace.workspaceId)!;
      const candidateRefs = await requireWorkspaceResultGit(artifact, [
        "for-each-ref",
        "--format=%(refname)",
        "refs/openclaw/worker-result-candidates/",
      ]);
      expect({ ok: outcome.ok, publishedRefs, candidateRefs }).toEqual({
        ok: closure === "none",
        publishedRefs: closure === "none" ? prepared.checkpointRef : "",
        candidateRefs: "",
      });
      if (outcome.ok) {
        expect(after.checkpointRef).toBe(prepared.checkpointRef);
        const saved = await readSessionRepositoryArtifacts({
          store,
          workspaceId: workspace.workspaceId,
          previewPath: "edit.txt",
          assertCurrent,
        });
        expect(saved.preview).toEqual(new Uint8Array(Buffer.from("final input admission\n")));
      } else {
        expect(after).toEqual(atRelease);
        expect(outcome.error).toMatchObject({
          message:
            closure === "authority"
              ? "checkpoint authority closed"
              : "Repository workspace revision changed",
        });
      }
    } finally {
      release.resolve();
      await pending;
      await prepared.discard();
      signal.removeEventListener("abort", unblock);
    }
  },
);

it("retains cumulative multi-turn files, deletions and executable modes in a bare artifact repo", async () => {
  const { remote, store, workspace, stage } = await fixture();
  await fs.writeFile(path.join(remote, "first.txt"), "first turn\n");
  const first = await stage("turn-first");
  expect(store.get(workspace.workspaceId)?.checkpointRef).toBeNull();
  await first.verify();
  await first.publish();
  await fs.rm(path.join(remote, "remove.txt"));
  await fs.writeFile(path.join(remote, "second.sh"), "#!/bin/sh\necho second\n", { mode: 0o755 });
  await fs.chmod(path.join(remote, "second.sh"), 0o755);
  if (process.platform !== "win32") {
    await fs.symlink("first.txt", path.join(remote, "current.txt"));
  }
  const second = await stage("turn-second");
  const accepted = await second.publish();
  const artifact = store.artifactPath(workspace.workspaceId);
  expect(await requireWorkspaceResultGit(artifact, ["rev-parse", "--is-bare-repository"])).toBe(
    "true",
  );
  expect(
    await hasWorkerWorkspaceResultRef({ root: artifact, stagedResultRef: first.checkpointRef }),
  ).toBe(true);
  await withSessionRepositoryCheckpoint(
    { store, workspaceId: workspace.workspaceId },
    async (snapshot) => {
      expect(await fs.readFile(path.join(snapshot.stagingRoot, "first.txt"), "utf8")).toBe(
        "first turn\n",
      );
      expect(await fs.readFile(path.join(snapshot.stagingRoot, "second.sh"), "utf8")).toContain(
        "echo second",
      );
      expect(snapshot.base.entries.some((entry) => entry.path === "remove.txt")).toBe(true);
      expect(snapshot.current.entries.some((entry) => entry.path === "remove.txt")).toBe(false);
      expect((await fs.stat(path.join(snapshot.stagingRoot, "second.sh"))).mode & 0o111).toBe(
        0o111,
      );
      if (process.platform !== "win32") {
        expect(await fs.readlink(path.join(snapshot.stagingRoot, "current.txt"))).toBe("first.txt");
      }
      await expect(fs.stat(path.join(snapshot.stagingRoot, "keep.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );
  expect(accepted.checkpointRef).toBe(second.checkpointRef);
  await withSessionRepositoryCheckpoint(
    { store, workspaceId: workspace.workspaceId, checkpointRef: first.checkpointRef },
    async (snapshot) => {
      expect(snapshot.current.entries.some((entry) => entry.path === "second.sh")).toBe(false);
    },
  );
});

it("recovers a published artifact after the acceptance transaction fails, without accepting a closed claim", async () => {
  const { remote, database, store, workspace, stage } = await fixture();
  await fs.writeFile(path.join(remote, "edit.txt"), "recover me\n");
  let live = true;
  const prepared = await stage("turn-recover", {
    assertCurrent: () => {
      if (!live) {
        throw new Error("claim closed");
      }
    },
  });
  live = false;
  await expect(prepared.publish()).rejects.toThrow("claim closed");
  expect(store.get(workspace.workspaceId)?.checkpointRef).toBeNull();
  live = true;
  const acceptance = vi.spyOn(store, "acceptCheckpoint").mockImplementationOnce(() => {
    throw new Error("transaction interrupted");
  });
  await expect(prepared.publish()).rejects.toThrow("transaction interrupted");
  acceptance.mockRestore();
  await prepared.discard();
  closeOpenClawStateDatabaseByPath(database.path);
  const reopened = createSessionRepositoryWorkspaceStore({
    database: openOpenClawStateDatabase({ path: database.path }),
  });
  const recovered = await recoverSessionRepositoryCheckpoint({
    store: reopened,
    workspaceId: workspace.workspaceId,
    checkpointRef: prepared.checkpointRef,
    assertCurrent,
  });
  expect(recovered.checkpointRef).toBe(prepared.checkpointRef);
  expect(
    await recoverSessionRepositoryCheckpoint({
      store: reopened,
      workspaceId: workspace.workspaceId,
      checkpointRef: prepared.checkpointRef,
      assertCurrent,
    }),
  ).toEqual(recovered);
  const snapshot = await readSessionRepositoryArtifacts({
    store: reopened,
    workspaceId: workspace.workspaceId,
    previewPath: "edit.txt",
    assertCurrent,
  });
  expect(snapshot.preview).toEqual(new Uint8Array(Buffer.from("recover me\n")));
});

it("retries failed candidate cleanup and keeps completed cleanup independent of later Git locks", async () => {
  const { remote, store, workspace, stage } = await fixture();
  await fs.writeFile(path.join(remote, "edit.txt"), "recover after cleanup\n");
  const prepared = await stage("turn-cleanup-retry");
  const artifact = store.artifactPath(workspace.workspaceId);
  const candidate = await requireWorkspaceResultGit(artifact, [
    "for-each-ref",
    "--format=%(refname)",
    "refs/openclaw/worker-result-candidates/",
  ]);
  expect(candidate).not.toBe("");
  const lockPath = path.join(artifact, `${candidate}.lock`);
  await fs.writeFile(lockPath, "another Git writer\n", { flag: "wx" });
  const attempts = await Promise.allSettled([prepared.discard(), prepared.discard()]);
  expect(attempts.map((attempt) => attempt.status)).toEqual(["rejected", "rejected"]);
  expect(await hasWorkerWorkspaceResultRef({ root: artifact, stagedResultRef: candidate })).toBe(
    true,
  );
  await fs.rm(lockPath);
  await Promise.all([prepared.discard(), prepared.discard()]);
  expect(await hasWorkerWorkspaceResultRef({ root: artifact, stagedResultRef: candidate })).toBe(
    false,
  );

  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  await fs.writeFile(lockPath, "another Git writer\n", { flag: "wx" });
  await Promise.all([prepared.discard(), prepared.discard()]);
  const accepted = await prepared.publish();
  expect(accepted.checkpointRef).toBe(prepared.checkpointRef);
  const snapshot = await readSessionRepositoryArtifacts({
    store,
    workspaceId: workspace.workspaceId,
    previewPath: "edit.txt",
    assertCurrent,
  });
  expect(snapshot.preview).toEqual(new Uint8Array(Buffer.from("recover after cleanup\n")));
});

it.each([false, true])(
  "retains independent raw recovery when the forked publication companion is corrupt: %s",
  async (corrupt) => {
    const { root, remote, store, workspace, stage } = await fixture();
    await fs.writeFile(path.join(remote, "edit.txt"), "working tree\r\n");
    const { sha, input } = await publicationFixture(root);
    const prepared = await stage("turn-publication", input);
    const sourceArtifact = store.artifactPath(workspace.workspaceId);
    const candidates = (
      await requireWorkspaceResultGit(sourceArtifact, [
        "for-each-ref",
        "--format=%(refname)",
        "refs/openclaw/worker-result-candidates/",
      ])
    ).split("\n");
    expect(candidates).toHaveLength(2);
    await prepared.publish();
    for (const candidate of candidates) {
      await fs.mkdir(path.dirname(path.join(sourceArtifact, candidate)), { recursive: true });
      await fs.writeFile(path.join(sourceArtifact, `${candidate}.lock`), "another Git writer\n", {
        flag: "wx",
      });
    }
    await Promise.all([prepared.discard(), prepared.discard()]);
    for (const candidate of candidates) {
      await fs.rm(path.join(sourceArtifact, `${candidate}.lock`));
    }
    const fork = await forkSessionRepositoryWorkspace({
      store,
      sourceWorkspaceId: workspace.workspaceId,
      agentId: "main",
      sessionKey: "agent:main:fork",
      assertCurrent,
    });
    expect(fork.workspaceId).not.toBe(workspace.workspaceId);
    expect(fork.branch).not.toBe(workspace.branch);
    await store.delete({ workspaceId: workspace.workspaceId, assertCurrent });
    if (corrupt) {
      const artifact = store.artifactPath(fork.workspaceId);
      const companion = await requireWorkspaceResultGit(artifact, [
        "for-each-ref",
        "--format=%(refname)",
        "refs/openclaw/worker-results/publication-*",
      ]);
      expect(companion).not.toBe("");
      await requireWorkspaceResultGit(artifact, ["update-ref", companion, fork.checkpointRef!]);
    }
    let reads = 0;
    await withSessionRepositoryCheckpoint(
      { store, workspaceId: fork.workspaceId, includePublication: true },
      async (snapshot) => {
        reads += 1;
        expect(await fs.readFile(path.join(snapshot.stagingRoot, "edit.txt"), "utf8")).toBe(
          "working tree\r\n",
        );
        if (corrupt) {
          expect(snapshot.publicationStagingRoot).toBeUndefined();
          expect(snapshot.publicationDigest).toBeUndefined();
        } else {
          expect(snapshot.publicationDigest).toBe(input.publicationDigest);
          expect(
            await fs.readFile(path.join(snapshot.publicationStagingRoot!, "blobs", sha), "utf8"),
          ).toBe("working tree\n");
        }
      },
    );
    expect(reads).toBe(1);
    await expect(
      withSessionRepositoryCheckpoint(
        { store, workspaceId: fork.workspaceId, includePublication: true },
        async () => {
          reads += 1;
          throw new Error("consumer failed after starting");
        },
      ),
    ).rejects.toThrow("consumer failed after starting");
    expect(reads).toBe(2);
  },
);

it.each(["recovery", "publication"])(
  "verifies the peeled %s candidate and rejects its replacement or removal",
  async (target) => {
    const { root, remote, store, workspace, stage } = await fixture();
    await fs.writeFile(path.join(remote, "edit.txt"), "working tree\r\n");
    const { input } = await publicationFixture(root);
    const prepared = await stage("turn-verify", input);
    const artifact = store.artifactPath(workspace.workspaceId);
    const refs = (
      await requireWorkspaceResultGit(artifact, [
        "for-each-ref",
        "--format=%(refname)",
        "refs/openclaw/worker-result-candidates/",
      ])
    ).split("\n");
    const candidates = await Promise.all(
      refs.map(async (ref) => ({
        ref,
        objectId: await requireWorkspaceResultGit(artifact, ["rev-parse", `${ref}^{commit}`]),
        snapshot: await readStagedWorkerWorkspaceResult(artifact, ref),
      })),
    );
    expect(candidates).toHaveLength(2);
    const candidate = candidates.find(
      (value) => (value.snapshot.base.baseCommit === baseCommit) === (target === "recovery"),
    )!;
    const other = candidates.find((value) => value !== candidate)!;
    const tag = await requireWorkspaceResultGit(artifact, ["mktag"], {
      input: Buffer.from(
        `object ${candidate.objectId}\ntype commit\ntag checkpoint-peel\ntagger Checkpoint Test <checkpoint@example.invalid> 0 +0000\n\nsame candidate\n`,
      ),
    });
    await requireWorkspaceResultGit(artifact, ["update-ref", candidate.ref, tag]);
    await prepared.verify();
    await requireWorkspaceResultGit(artifact, ["update-ref", candidate.ref, other.objectId]);
    await expect(prepared.verify()).rejects.toThrow(
      target === "recovery"
        ? "Repository checkpoint preparation changed"
        : "Repository publication preparation changed",
    );
    await requireWorkspaceResultGit(artifact, ["update-ref", "-d", candidate.ref]);
    await expect(prepared.verify()).rejects.toThrow();
    expect(store.get(workspace.workspaceId)?.checkpointRef).toBeNull();
    await prepared.discard();
  },
);

it("cannot replace an immutable publication companion when recovery bytes are unchanged", async () => {
  const { root, remote, store, workspace, stage } = await fixture();
  await fs.writeFile(path.join(remote, "edit.txt"), "working tree\r\n");
  const original = await publicationFixture(root);
  const initial = await stage("turn-immutable-publication", original.input);
  await initial.publish();
  const replacement = await publicationFixture(root, "different publication\n");
  const collision = await stage("turn-immutable-publication", replacement.input);
  await expect(collision.publish()).rejects.toThrow("different result");
  await collision.discard();
  await withSessionRepositoryCheckpoint(
    { store, workspaceId: workspace.workspaceId, includePublication: true },
    async (snapshot) => {
      expect(snapshot.publicationDigest).toBe(original.input.publicationDigest);
      expect(await fs.readFile(path.join(snapshot.stagingRoot, "edit.txt"), "utf8")).toBe(
        "working tree\r\n",
      );
    },
  );
});

it("accepts raw recovery files when a publication blob fails validation", async () => {
  const { root, remote, store, workspace, stage } = await fixture();
  await fs.writeFile(path.join(remote, "edit.txt"), "recoverable change\n");
  const publicationStagingRoot = path.join(root, "rejected-publication");
  await fs.mkdir(path.join(publicationStagingRoot, "blobs"), { recursive: true });
  const sha = "b".repeat(40);
  await fs.writeFile(path.join(publicationStagingRoot, "blobs", sha), "wrong Git blob content\n");
  const metadata = JSON.stringify({
    version: 1,
    baseCommit,
    baseTree: "c".repeat(40),
    workspaceTree: "d".repeat(40),
    entries: [{ path: "edit.txt", mode: "100644", sha }],
  });
  await fs.writeFile(path.join(publicationStagingRoot, "snapshot.json"), metadata);
  const prepared = await stage("turn-rejected-publication", {
    publicationStagingRoot,
    publicationDigest: hash(metadata),
  });
  await prepared.verify();
  const accepted = await prepared.publish();
  expect(accepted.checkpointRef).toBe(prepared.checkpointRef);
  await withSessionRepositoryCheckpoint(
    { store, workspaceId: workspace.workspaceId, includePublication: true },
    async (snapshot) => {
      expect(await fs.readFile(path.join(snapshot.stagingRoot, "edit.txt"), "utf8")).toBe(
        "recoverable change\n",
      );
      expect(snapshot.publicationStagingRoot).toBeUndefined();
      expect(snapshot.publicationDigest).toBeUndefined();
    },
  );
  expect(
    await requireWorkspaceResultGit(store.artifactPath(workspace.workspaceId), [
      "for-each-ref",
      "--format=%(refname)",
      "refs/openclaw/worker-result-candidates/",
    ]),
  ).toBe("");
});

it("rejects mismatched transferred bytes and cannot replace an immutable checkpoint identity", async () => {
  const { remote, store, workspace, stage } = await fixture();
  await fs.writeFile(path.join(remote, "edit.txt"), "first\n");
  const initial = await stage("turn-immutable");
  await initial.publish();
  await fs.writeFile(path.join(remote, "edit.txt"), "second\n");
  const collision = await stage("turn-immutable");
  await expect(collision.publish()).rejects.toThrow("different result");
  await collision.discard();
  const snapshot = await readSessionRepositoryArtifacts({
    store,
    workspaceId: workspace.workspaceId,
    previewPath: "edit.txt",
    assertCurrent,
  });
  expect(snapshot.preview).toEqual(new Uint8Array(Buffer.from("first\n")));
  const expected = await readActualWorkspaceManifest({ root: remote, baseCommit });
  await fs.writeFile(path.join(remote, "edit.txt"), "tampered\n");
  await expect(
    stage("turn-tampered", {
      currentManifestRaw: serializeWorkerWorkspaceManifest(expected.manifest),
      currentManifestRef: expected.manifestRef,
    }),
  ).rejects.toThrow("payload is invalid");
});
