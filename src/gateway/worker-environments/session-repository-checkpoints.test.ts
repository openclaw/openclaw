import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import * as processExec from "../../process/exec.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { StateDatabaseReadAdmissionInvalidatedError } from "../../state/openclaw-state-db-async-lifecycle.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { createSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import * as publicationSnapshot from "../github-repository-publication-snapshot.js";
import {
  forkSessionRepositoryWorkspace as forkWorkspace,
  readSessionRepositoryArtifacts as readArtifacts,
  recoverSessionRepositoryCheckpoint as recoverCheckpoint,
  stageSessionRepositoryCheckpoint as stageCheckpoint,
  withSessionRepositoryCheckpoint as withCheckpoint,
} from "./session-repository-checkpoints.js";
import * as workspaceManifestWorker from "./workspace-manifest-worker.js";
import { captureWorkspaceManifest } from "./workspace-manifest-worker.js";
import { serializeWorkerWorkspaceManifest } from "./workspace-manifest.js";
import * as workspaceResultGit from "./workspace-result-git.js";
import { requireWorkspaceResultGit as git } from "./workspace-result-git.js";
import {
  hasWorkerWorkspaceResultRef,
  readStagedWorkerWorkspaceResult,
  workerWorkspaceResultRef,
} from "./workspace-result-staging.js";

const roots: string[] = [];
const baseCommit = "a".repeat(40);
const assertCurrent = () => {};
const hash = (bytes: string) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const readText = (root: string, name: string) => fs.readFile(path.join(root, name), "utf8");
const listRefs = (root: string, prefix = "worker-result-candidates/") =>
  git(root, ["for-each-ref", "--format=%(refname)", `refs/openclaw/${prefix}`]);
const hasRef = (root: string, stagedResultRef: string) =>
  hasWorkerWorkspaceResultRef({ root, stagedResultRef });
async function candidateLocks(root: string, candidates: string[], locked: boolean) {
  for (const candidate of candidates) {
    const lock = path.join(root, `${candidate}.lock`);
    if (locked) {
      await fs.mkdir(path.dirname(lock), { recursive: true });
      await fs.writeFile(lock, "another Git writer\n", { flag: "wx" });
    } else {
      await fs.rm(lock);
    }
  }
}
function authority(message = "checkpoint authority closed") {
  const guard = {
    current: true,
    assertCurrent: () => {
      if (!guard.current) {
        throw new Error(message);
      }
    },
  };
  return guard;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    await closeOpenClawStateDatabaseByPathAsync(path.join(root, "openclaw.sqlite"));
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function fixture(editContent?: string) {
  // openclaw-temp-dir: allow database closure and artifact cleanup share this root.
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-repository-checkpoint-")),
  );
  roots.push(root);
  const database = openOpenClawStateDatabase({ path: path.join(root, "openclaw.sqlite") });
  const store = createSessionRepositoryWorkspaceStore({ path: database.path });
  const remote = path.join(root, "remote");
  await fs.mkdir(remote);
  await fs.writeFile(path.join(remote, "keep.txt"), "upstream\n");
  await fs.writeFile(path.join(remote, "remove.txt"), "remove me\n");
  const base = await captureWorkspaceManifest({ root: remote, baseCommit });
  const initial = await store.create({
    agentId: "main",
    sessionKey: "agent:main:repository",
    url: "https://github.com/example/project.git",
    assertCurrent,
  });
  const workspace = await store.bindBase({
    workspaceId: initial.workspaceId,
    expectedRevision: initial.revision,
    baseCommit,
    baseManifestHash: base.manifestRef,
    assertCurrent,
  });
  const owner = { store, workspaceId: workspace.workspaceId };
  const current = () => store.get(workspace.workspaceId);
  const edit = (content: string) => fs.writeFile(path.join(remote, "edit.txt"), content);
  if (editContent !== undefined) {
    await edit(editContent);
  }
  return {
    root,
    remote,
    database,
    store,
    workspace,
    artifact: store.artifactPath(workspace.workspaceId),
    current,
    edit,
    rebind: () =>
      store.bindBase({ ...owner, expectedRevision: workspace.revision, baseCommit, assertCurrent }),
    read: (checkpointRef?: string) => ({ ...owner, checkpointRef }),
    preview: (selectedStore = store) =>
      readArtifacts({
        ...owner,
        store: selectedStore,
        previewPath: "edit.txt",
        assertCurrent,
      }).then(({ preview }) => preview),
    stage: async (claim: string, extra: Partial<Parameters<typeof stageCheckpoint>[0]> = {}) => {
      const captured = await captureWorkspaceManifest({ root: remote, baseCommit });
      return await stageCheckpoint({
        ...owner,
        expectedRevision: (await current())!.revision,
        checkpointRef: workerWorkspaceResultRef(claim),
        stagingRoot: remote,
        baseManifestRaw: serializeWorkerWorkspaceManifest(base.manifest),
        currentManifestRaw: serializeWorkerWorkspaceManifest(captured.manifest),
        baseManifestRef: base.manifestRef,
        currentManifestRef: captured.manifestRef,
        assertCurrent,
        ...extra,
      });
    },
  };
}

async function publicationFixture(root: string, content = "working tree\n", blobSha?: string) {
  const normalized = Buffer.from(content);
  const sha =
    blobSha ??
    (await git(root, ["hash-object", "--stdin"], {
      input: normalized,
    }));
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

it.for([
  { boundary: "directory", closure: "authority", publication: false },
  { boundary: "metadata", closure: "authority", publication: true },
  { boundary: "queue", closure: "authority", publication: false },
  ...["preparation", "import", "final-input"].flatMap((boundary) =>
    ["authority", "revision"].map((closure) => ({ boundary, closure, publication: false })),
  ),
  ...["before-preparation", "preparation", "queue"].flatMap((boundary) =>
    ["authority", "revision"].map((closure) => ({ boundary, closure, publication: true })),
  ),
])(
  "fences publication=$publication at $boundary with $closure closure",
  async ({ boundary, closure, publication }, { signal }) => {
    const { root, artifact, current, stage, rebind } = await fixture("working tree\n");
    const { input } = await publicationFixture(root);
    if (boundary !== "directory") {
      await fs.mkdir(artifact, { recursive: true });
      await git(artifact, ["init", "--quiet", "--bare"]);
    }
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const resume = () => release.resolve();
    signal.addEventListener("abort", resume, { once: true });
    const pause = async () => {
      entered.resolve();
      await release.promise;
    };
    const guard = authority();
    let publicationPreparations = 0;
    let queueOwner: Promise<void> | undefined;
    const importRoots: string[] = [];
    const mkdir = fs.mkdir.bind(fs);
    vi.spyOn(fs, "mkdir").mockImplementation(async (...args) => {
      const result = await mkdir(...args);
      if (boundary === "directory" && String(args[0]) === artifact) {
        await pause();
      }
      return result;
    });
    const holdQueue = async () => {
      const common = await fs.realpath(artifact);
      const queueKey = process.platform === "win32" ? common.toLowerCase() : common;
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
    let finalPrepared: Awaited<ReturnType<typeof stage>> | undefined;
    let refInputHeld = false;
    const run = processExec.runCommandWithTimeout;
    vi.spyOn(processExec, "runCommandWithTimeout").mockImplementation(async (...args) => {
      if (
        finalPrepared &&
        !refInputHeld &&
        args[0].includes(artifact) &&
        args[0].includes("update-ref")
      ) {
        refInputHeld = true;
        await pause();
      }
      // Keep the real runner and its beforeInput authority check.
      return run(...args);
    });
    const pending = stage("publication-authority", {
      ...(publication ? input : {}),
      assertCurrent: guard.assertCurrent,
    })
      .then(async (prepared) => {
        if (boundary === "final-input") {
          finalPrepared = prepared;
          await prepared.publish();
        }
        return prepared;
      })
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    try {
      await Promise.race([
        entered.promise,
        pending.then((outcome) => {
          throw new Error("Checkpoint settled before boundary", { cause: outcome });
        }),
      ]);
      if (finalPrepared) {
        expect(await listRefs(artifact, "worker-results/")).toBe("");
      }
      const preparedInput = ["preparation", "queue", "import"].includes(boundary);
      expect(publicationPreparations).toBe(publication && preparedInput ? 1 : 0);
      if (preparedInput) {
        expect((await fs.stat(path.join(importRoots.at(-1)!, "fast-import"))).size).toBeGreaterThan(
          0,
        );
      }
      guard.current = closure !== "authority";
      if (closure === "revision") {
        await rebind();
      }
      const atRelease = await current();
      release.resolve();
      const outcome = await pending;
      await finalPrepared?.discard();
      if (outcome.ok) {
        await outcome.value.publish();
      }
      await queueOwner;
      expect(outcome).toMatchObject({
        ok: false,
        error: {
          message:
            closure === "authority"
              ? "checkpoint authority closed"
              : "Repository workspace revision changed",
        },
      });
      expect(await current()).toEqual(atRelease);
      expect(
        imports.mock.calls.filter(
          ([command, args]) => command === "git" && args.includes("fast-import"),
        ),
      ).toHaveLength(publication || ["import", "final-input"].includes(boundary) ? 1 : 0);
      for (const directory of importRoots) {
        await expect(fs.stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
      }
      if (boundary === "directory") {
        const head = path.join(artifact, "HEAD");
        await expect(fs.stat(head)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        expect(await listRefs(artifact, "")).toBe("");
      }
      expect(publicationPreparations).toBe(publication && preparedInput ? 1 : 0);
    } finally {
      resume();
      signal.removeEventListener("abort", resume);
      const outcome = await pending;
      await queueOwner;
      await finalPrepared?.discard();
      if (outcome.ok) {
        await outcome.value.discard();
      }
    }
  },
);

it("retains cumulative multi-turn files, deletions and executable modes in a bare artifact repo", async () => {
  const { remote, artifact, current, stage, read } = await fixture();
  await fs.writeFile(path.join(remote, "first.txt"), "first turn\n");
  const first = await stage("turn-first");
  expect((await current())?.checkpointRef).toBeNull();
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
  expect(await git(artifact, ["rev-parse", "--is-bare-repository"])).toBe("true");
  expect(await hasRef(artifact, first.checkpointRef)).toBe(true);
  await withCheckpoint(read(), async (snapshot) => {
    expect(await readText(snapshot.stagingRoot, "first.txt")).toBe("first turn\n");
    expect(await readText(snapshot.stagingRoot, "second.sh")).toContain("echo second");
    expect(snapshot.base.entries.some((entry) => entry.path === "remove.txt")).toBe(true);
    expect(snapshot.current.entries.some((entry) => entry.path === "remove.txt")).toBe(false);
    expect((await fs.stat(path.join(snapshot.stagingRoot, "second.sh"))).mode & 0o111).toBe(0o111);
    if (process.platform !== "win32") {
      expect(await fs.readlink(path.join(snapshot.stagingRoot, "current.txt"))).toBe("first.txt");
    }
    const unchanged = path.join(snapshot.stagingRoot, "keep.txt");
    await expect(fs.stat(unchanged)).rejects.toMatchObject({ code: "ENOENT" });
  });
  expect(accepted.checkpointRef).toBe(second.checkpointRef);
  await withCheckpoint(read(first.checkpointRef), async (snapshot) => {
    expect(snapshot.current.entries.some((entry) => entry.path === "second.sh")).toBe(false);
  });
});

it("recovers a published artifact after the acceptance transaction fails, without accepting a closed claim", async () => {
  const { database, store, workspace, current, stage, preview } = await fixture("recover me\n");
  const guard = authority("claim closed");
  const prepared = await stage("turn-recover", guard);
  guard.current = false;
  await expect(prepared.publish()).rejects.toThrow("claim closed");
  expect((await current())?.checkpointRef).toBeNull();
  guard.current = true;
  const acceptance = vi.spyOn(store, "acceptCheckpoint").mockImplementationOnce(() => {
    throw new Error("transaction interrupted");
  });
  await expect(prepared.publish()).rejects.toThrow("transaction interrupted");
  acceptance.mockRestore();
  await prepared.discard();
  await closeOpenClawStateDatabaseByPathAsync(database.path);
  const reopened = createSessionRepositoryWorkspaceStore({ path: database.path });
  const recovery = {
    store: reopened,
    workspaceId: workspace.workspaceId,
    checkpointRef: prepared.checkpointRef,
    assertCurrent,
  };
  const recovered = await recoverCheckpoint(recovery);
  expect(recovered.checkpointRef).toBe(prepared.checkpointRef);
  expect(await recoverCheckpoint(recovery)).toEqual(recovered);
  expect(await preview(reopened)).toEqual(new Uint8Array(Buffer.from("recover me\n")));
});

it("retries failed candidate cleanup and keeps completed cleanup independent of later Git locks", async () => {
  const { artifact, stage, preview } = await fixture("recover after cleanup\n");
  const prepared = await stage("turn-cleanup-retry");
  const candidate = await listRefs(artifact);
  expect(candidate).not.toBe("");
  await candidateLocks(artifact, [candidate], true);
  const attempts = await Promise.allSettled([prepared.discard(), prepared.discard()]);
  expect(attempts.map((attempt) => attempt.status)).toEqual(["rejected", "rejected"]);
  expect(await hasRef(artifact, candidate)).toBe(true);
  await candidateLocks(artifact, [candidate], false);
  await Promise.all([prepared.discard(), prepared.discard()]);
  expect(await hasRef(artifact, candidate)).toBe(false);

  await candidateLocks(artifact, [candidate], true);
  await Promise.all([prepared.discard(), prepared.discard()]);
  const accepted = await prepared.publish();
  expect(accepted.checkpointRef).toBe(prepared.checkpointRef);
  expect(await preview()).toEqual(new Uint8Array(Buffer.from("recover after cleanup\n")));
});

it.each(["caller", "database"] as const)(
  "keeps fork compensation bound to its original source after %s retirement",
  async (retired) => {
    const { store, workspace } = await fixture();
    const targetOwner = { agentId: "main", sessionKey: "agent:main:fork-compensation" };
    const create = store.create.bind(store);
    let created: Awaited<ReturnType<typeof store.create>> | undefined;
    const guard = authority("fork caller revoked");
    vi.spyOn(store, "create").mockImplementationOnce(async (input) => {
      created = await create(input);
      const artifact = store.artifactPath(created.workspaceId);
      await fs.mkdir(artifact, { recursive: true });
      await fs.writeFile(path.join(artifact, "retained-owner"), "accepted target");
      if (retired === "database") {
        await closeOpenClawStateDatabaseByPathAsync(store.path);
      } else {
        guard.current = false;
      }
      return created;
    });
    const fork = forkWorkspace({
      store,
      sourceWorkspaceId: workspace.workspaceId,
      ...targetOwner,
      assertCurrent: guard.assertCurrent,
    });
    await expect(fork).rejects.toThrow(
      retired === "database" ? StateDatabaseReadAdmissionInvalidatedError : "fork caller revoked",
    );
    if (!created) {
      throw new Error("Fork did not allocate its real target");
    }
    expect(await store.get(workspace.workspaceId)).toEqual(workspace);
    expect(await store.find(targetOwner)).toEqual(retired === "database" ? created : undefined);
    const retainedArtifact = path.join(store.artifactPath(created.workspaceId), "retained-owner");
    if (retired === "database") {
      expect(await fs.readFile(retainedArtifact, "utf8")).toBe("accepted target");
    } else {
      await expect(fs.stat(retainedArtifact)).rejects.toMatchObject({ code: "ENOENT" });
    }
  },
);

it.each(["healthy", "corrupt-companion", "invalid-blob"])(
  "retains independent raw recovery with %s publication",
  async (publication) => {
    const source = await fixture("working tree\r\n");
    const { root, artifact: sourceArtifact, store, workspace, stage } = source;
    const invalid = publication === "invalid-blob";
    const { sha, input } = await publicationFixture(
      root,
      invalid ? "wrong Git blob content\n" : undefined,
      invalid ? "b".repeat(40) : undefined,
    );
    const prepared = await stage("turn-publication", input);
    const candidates = (await listRefs(sourceArtifact)).split("\n");
    expect(candidates).toHaveLength(invalid ? 1 : 2);
    await prepared.verify();
    expect((await prepared.publish()).checkpointRef).toBe(prepared.checkpointRef);
    expect(await listRefs(sourceArtifact)).toBe("");
    await candidateLocks(sourceArtifact, candidates, true);
    await Promise.all([prepared.discard(), prepared.discard()]);
    await candidateLocks(sourceArtifact, candidates, false);
    let fork = workspace;
    if (!invalid) {
      fork = await forkWorkspace({
        store,
        sourceWorkspaceId: workspace.workspaceId,
        agentId: "main",
        sessionKey: "agent:main:fork",
        assertCurrent,
      });
      expect(fork.workspaceId).not.toBe(workspace.workspaceId);
      expect(fork.branch).not.toBe(workspace.branch);
      await store.delete({ workspaceId: workspace.workspaceId, assertCurrent });
    }
    if (publication === "corrupt-companion") {
      const artifact = store.artifactPath(fork.workspaceId);
      const companion = await listRefs(artifact, "worker-results/publication-*");
      expect(companion).not.toBe("");
      await git(artifact, ["update-ref", companion, fork.checkpointRef!]);
    }
    const forkSource = { store, workspaceId: fork.workspaceId };
    let reads = 0;
    await withCheckpoint(forkSource, async (snapshot) => {
      const { stagingRoot, publicationStagingRoot, publicationDigest } = snapshot;
      reads += 1;
      expect(await readText(stagingRoot, "edit.txt")).toBe("working tree\r\n");
      if (publication !== "healthy") {
        expect([publicationStagingRoot, publicationDigest]).toEqual([undefined, undefined]);
      } else {
        expect(publicationDigest).toBe(input.publicationDigest);
        expect(await readText(publicationStagingRoot!, `blobs/${sha}`)).toBe("working tree\n");
      }
    });
    expect(reads).toBe(1);
    await expect(
      withCheckpoint(forkSource, async () => {
        reads += 1;
        throw new Error("consumer failed after starting");
      }),
    ).rejects.toThrow("consumer failed after starting");
    expect(reads).toBe(2);
  },
);

it.each(["recovery", "publication"])(
  "verifies the peeled %s candidate and rejects its replacement or removal",
  async (target) => {
    const { root, artifact, current, stage } = await fixture("working tree\r\n");
    const { input } = await publicationFixture(root);
    const prepared = await stage("turn-verify", input);
    const refs = (await listRefs(artifact)).split("\n");
    const candidates = await Promise.all(
      refs.map(async (ref) => ({
        ref,
        objectId: await git(artifact, ["rev-parse", `${ref}^{commit}`]),
        snapshot: await readStagedWorkerWorkspaceResult(artifact, ref),
      })),
    );
    expect(candidates).toHaveLength(2);
    const candidate = candidates.find(
      (value) => (value.snapshot.base.baseCommit === baseCommit) === (target === "recovery"),
    )!;
    const other = candidates.find((value) => value !== candidate)!;
    const tag = await git(artifact, ["mktag"], {
      input: Buffer.from(
        `object ${candidate.objectId}\ntype commit\ntag checkpoint-peel\ntagger Checkpoint Test <checkpoint@example.invalid> 0 +0000\n\nsame candidate\n`,
      ),
    });
    await git(artifact, ["update-ref", candidate.ref, tag]);
    await prepared.verify();
    await git(artifact, ["update-ref", candidate.ref, other.objectId]);
    await expect(prepared.verify()).rejects.toThrow(
      target === "recovery"
        ? "Repository checkpoint preparation changed"
        : "Repository publication preparation changed",
    );
    await git(artifact, ["update-ref", "-d", candidate.ref]);
    await expect(prepared.verify()).rejects.toThrow();
    expect((await current())?.checkpointRef).toBeNull();
    await prepared.discard();
  },
);

it("rejects mismatched transferred bytes and cannot replace an immutable checkpoint identity", async () => {
  const { remote, edit, stage, preview } = await fixture("first\n");
  const initial = await stage("turn-immutable");
  await initial.publish();
  await edit("second\n");
  const collision = await stage("turn-immutable");
  await expect(collision.publish()).rejects.toThrow("different result");
  await collision.discard();
  expect(await preview()).toEqual(new Uint8Array(Buffer.from("first\n")));
  const expected = await captureWorkspaceManifest({ root: remote, baseCommit });
  await edit("tampered\n");
  await expect(
    stage("turn-tampered", {
      currentManifestRaw: serializeWorkerWorkspaceManifest(expected.manifest),
      currentManifestRef: expected.manifestRef,
    }),
  ).rejects.toThrow("payload is invalid");
});
