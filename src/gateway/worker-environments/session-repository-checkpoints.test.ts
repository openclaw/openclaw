import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseByPath } from "../../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { createSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import {
  forkSessionRepositoryWorkspace,
  readSessionRepositoryArtifacts,
  recoverSessionRepositoryCheckpoint,
  stageSessionRepositoryCheckpoint,
  withSessionRepositoryCheckpoint,
} from "./session-repository-checkpoints.js";
import { serializeWorkerWorkspaceManifest } from "./workspace-manifest.js";
import { readActualWorkspaceManifest } from "./workspace-reconcile-core.js";
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-repository-checkpoint-"));
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
