import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, vi } from "vitest";
import { requireGit } from "../../agents/worktrees/git.js";
import { getRegistryWorktree } from "../../agents/worktrees/registry.test-support.js";
import type { ManagedWorktreeService } from "../../agents/worktrees/service.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import {
  observeAcknowledgedUpdate,
  prepareLocalWorkspaceArchiveFixture,
} from "./local-workspace-incremental.test-support.js";
import { withLocalWorkspaceProjection } from "./local-workspace-projection.js";
import { withLocalWorkspaceStore } from "./local-workspace-store.js";
import {
  observeLocalWorkspaceStoreSql,
  readLocalWorkspaceProjection,
} from "./local-workspace-store.test-support.js";
import type { LocalWorkspaceOwner } from "./local-workspace-types.js";
import { resolveWorkspaceResultStorage } from "./workspace-result-storage.js";

const prepare = (owner: LocalWorkspaceOwner) =>
  withLocalWorkspaceProjection(owner, (state) => state.prepare());
const synchronize = (owner: LocalWorkspaceOwner) =>
  withLocalWorkspaceProjection(owner, (state) => state.synchronize("canonical"));
const writeText = (directory: string, relative: string, data: string) =>
  fs.writeFile(path.join(directory, relative), data);
async function expectText(directory: string, relative: string, expected: string) {
  expect(await fs.readFile(path.join(directory, relative), "utf8")).toBe(expected);
}
async function expectMissing(directory: string, ...parts: string[]) {
  await expect(fs.stat(path.join(directory, ...parts))).rejects.toMatchObject({ code: "ENOENT" });
}

export async function proveLastFileDirectoryRetention(owner: LocalWorkspaceOwner) {
  const canonical = owner.worktree.path;
  const projection = await prepare(owner);
  await fs.mkdir(path.join(projection, "retained/nested"), { recursive: true });
  await writeText(projection, "retained/nested/old.txt", "old content\n");
  await synchronize(owner);

  await fs.unlink(path.join(projection, "retained/nested/old.txt"));
  await synchronize(owner);
  expect((await fs.stat(path.join(canonical, "retained/nested"))).isDirectory()).toBe(true);
  await expectMissing(canonical, "retained/nested/old.txt");

  await writeText(projection, "retained/nested/new.txt", "new content\n");
  await synchronize(owner);
  await prepare(owner);
  await expectText(canonical, "retained/nested/new.txt", "new content\n");
  await expectText(projection, "retained/nested/new.txt", "new content\n");
  expect((await readLocalWorkspaceProjection(owner.worktree.id))?.pending_ref).toBeNull();
}

export async function proveAcceptedDirectoryRetention(
  owner: LocalWorkspaceOwner,
  service: ManagedWorktreeService,
  mode: "archive" | "interrupted eviction",
) {
  const canonical = owner.worktree.path;
  const repo = owner.worktree.repoRoot;
  const projection = await prepare(owner);
  const retained = ["accepted-ds", "accepted-py", "accepted-host", "still-empty"];
  for (const directory of [...retained, "authored", "explicit-delete"]) {
    await fs.mkdir(path.join(projection, directory));
  }
  await writeText(projection, "authored/.env.local", "authored ignored bytes\n");
  await synchronize(owner);
  for (const directory of retained) {
    expect((await fs.stat(path.join(canonical, directory))).isDirectory()).toBe(true);
  }

  await writeText(projection, "accepted-ds/.DS_Store", "derived metadata");
  for (const directory of ["accepted-py", "authored", "never-accepted-cache"]) {
    await fs.mkdir(path.join(projection, directory, "__pycache__"), { recursive: true });
    await writeText(projection, `${directory}/__pycache__/module.pyc`, "derived bytecode");
  }
  await fs.rmdir(path.join(projection, "explicit-delete"));
  await synchronize(owner);
  // Exercise canonical-to-projection classification too, without enrolling host cache bytes.
  await writeText(canonical, "accepted-host/.DS_Store", "host metadata");
  await prepare(owner);
  for (const directory of retained) {
    expect((await fs.stat(path.join(canonical, directory))).isDirectory()).toBe(true);
  }
  await expectMissing(canonical, "never-accepted-cache");
  await expectMissing(canonical, "explicit-delete");
  await expectMissing(canonical, "accepted-ds/.DS_Store");
  await expectMissing(projection, "accepted-host/.DS_Store");

  let source = "original\n";
  if (mode === "interrupted eviction") {
    const { withWorktreeAllocationLease } = await import("../../agents/worktrees/allocation.js");
    const { evictManagedWorktree } = await import("../../agents/worktrees/eviction.js");
    const { hasWorkerWorkspaceResultRef, workerWorkspaceResultStaging } =
      await import("./workspace-result-staging.js");
    const staging = vi
      .spyOn(workerWorkspaceResultStaging, "stageWorkerWorkspaceResult")
      .mockRejectedValueOnce(new Error("archive staging interrupted"));
    try {
      await expect(
        withWorktreeAllocationLease({ env: process.env }, (guard) =>
          evictManagedWorktree({
            env: process.env,
            record: owner.worktree,
            guard,
            reason: "idle-age",
            getConfig: () => ({}),
          }),
        ),
      ).resolves.toBe("dirty-purged");
    } finally {
      staging.mockRestore();
    }
    const pending = (await readLocalWorkspaceProjection(owner.worktree.id))!;
    expect(pending.pending_ref).toBeTruthy();
    expect(
      await hasWorkerWorkspaceResultRef({ root: repo, stagedResultRef: pending.pending_ref! }),
    ).toBe(false);
    source = "newer projection bytes after interrupted staging\n";
    await writeText(projection, "source.txt", source);
  } else {
    const removed = await service.remove({
      id: owner.worktree.id,
      reason: "directory-retention",
    });
    expect(removed.removed).toBe(true);
  }
  await expectMissing(canonical);
  await closeOpenClawStateDatabaseAsync();
  await service.restore({ id: owner.worktree.id });
  await prepare(owner);
  for (const workspace of [canonical, projection]) {
    for (const directory of retained) {
      expect((await fs.stat(path.join(workspace, directory))).isDirectory()).toBe(true);
    }
    await expectText(workspace, "authored/.env.local", "authored ignored bytes\n");
    await expectText(workspace, "source.txt", source);
    await expectMissing(workspace, "explicit-delete");
  }
  await expectMissing(canonical, "never-accepted-cache");
  expect((await readLocalWorkspaceProjection(owner.worktree.id))?.pending_ref).toBeNull();
}

async function prepareLegacyArchiveRetention(params: {
  owner: LocalWorkspaceOwner;
  receipt: string;
  originalInput: string;
}) {
  const { owner, receipt, originalInput } = params;
  const repo = owner.worktree.repoRoot;
  const { loadStagedWorkspaceManifest } = await import("./workspace-manifest-worker.js");
  const { serializeWorkerWorkspaceManifest } = await import("./workspace-manifest.js");
  const { expireLocalWorkspaceProjection } = await import("./local-workspace-projection.js");
  const archived = await loadStagedWorkspaceManifest(repo, receipt, undefined, [originalInput]);
  const replaceBaseline = async (rawManifest: string) => {
    await withLocalWorkspaceStore({ worktreeId: owner.worktree.id }, async (store) => {
      await store.update(store.get()!, {}, undefined, {
        rawManifest,
        manifestRef: `sha256:${createHash("sha256").update(rawManifest).digest("hex")}`,
        buildCacheInputs: archived.current.buildCacheInputs ?? [],
      });
    });
  };
  // Neither side of this authentic receipt owns an unrelated accepted baseline.
  await replaceBaseline(
    serializeWorkerWorkspaceManifest({
      ...archived.current,
      entries: archived.current.entries.filter((entry) => entry.path !== "source.txt"),
    }),
  );
  const retireSnapshot = vi.fn();
  await expect(
    expireLocalWorkspaceProjection({
      worktree: getRegistryWorktree(process.env, owner.worktree.id)!,
      env: process.env,
      assertCurrent: () => {},
      retireSnapshot,
    }),
  ).rejects.toThrow("Archive retention receipt changed");
  expect(retireSnapshot).not.toHaveBeenCalled();
  // Earlier writers reserved archive receipts against their reduced Git base.
  await replaceBaseline(archived.baseManifestRaw);
}

export async function proveArchivedInputRetention(
  owner: LocalWorkspaceOwner,
  service: ManagedWorktreeService,
) {
  const canonical = owner.worktree.path;
  const gitOwner = await import("../../agents/worktrees/git.js");
  const projection = await prepare(owner);
  const originalAdmission = (await readLocalWorkspaceProjection(owner.worktree.id))!
    .source_paths_json;
  const input = ".artifacts/build-cache-inputs/node_modules/late-original.json";
  expect(JSON.parse(originalAdmission)).not.toContain(input);
  await writeText(canonical, ".gitignore", ".env.local\n.artifacts/\n");
  await fs.mkdir(path.dirname(path.join(canonical, input)), { recursive: true });
  await writeText(canonical, input, "host-admitted input\n");
  await gitOwner.requireGit(canonical, ["add", "--force", "--", input]);
  await prepare(owner);
  await expectText(projection, input, "host-admitted input\n");
  const removed = await service.remove({ id: owner.worktree.id, reason: "legacy-admission-probe" });
  expect(removed.removed).toBe(true);
  expect(
    await gitOwner.requireGit(owner.worktree.repoRoot, [
      "ls-tree",
      "-r",
      "--name-only",
      removed.snapshotRef!,
    ]),
  ).toContain(input);
  // Before this policy, host-index admission did not update source_paths_json.
  await withLocalWorkspaceStore({ worktreeId: owner.worktree.id }, async (store) => {
    await store.update(store.get()!, { source_paths_json: originalAdmission });
  });
  await closeOpenClawStateDatabaseAsync();
  owner.worktree = await service.restore({ id: owner.worktree.id });
  expect(owner.worktree.snapshotRef).toBeTruthy();
  await prepare(owner);
  await expectText(projection, input, "host-admitted input\n");
  expect(await gitOwner.requireGit(canonical, ["ls-files"])).not.toContain(input);
  const generated = ".artifacts/build-cache-inputs/generated-after-restore.json";
  await writeText(projection, generated, "new disposable cache\n");
  if (process.platform !== "win32" && process.getuid?.() !== 0) {
    await fs.chmod(path.join(projection, generated), 0);
  }
  await writeText(projection, input, "restored authored edit\n");
  const inventory = vi.spyOn(gitOwner, "requireGitBuffer");
  await synchronize(owner);
  expect(
    inventory.mock.calls.filter(([, args]) => ["ls-files", "ls-tree"].includes(args[0]!)),
  ).toEqual([]);
  inventory.mockRestore();
  await expectText(canonical, input, "restored authored edit\n");
  await expectMissing(canonical, generated);
}

export async function proveArchivedOverlayRetention(
  owner: LocalWorkspaceOwner,
  mode: "legacy decoder" | "failed restore retry" | "retention" | "legacy retention",
) {
  const canonical = owner.worktree.path;
  const repo = owner.worktree.repoRoot;
  const git = (cwd: string, ...args: string[]) => requireGit(cwd, args);
  const treePaths = (tree: string) => git(repo, "ls-tree", "-r", "--name-only", tree);
  const readProjection = () => readLocalWorkspaceProjection(owner.worktree.id);
  const { restoreProvisionedFiles } = await import("../../agents/worktrees/provisioned-files.js");
  const { service, registry, retentionMs } = await prepareLocalWorkspaceArchiveFixture(owner, [
    ".env.allowed",
  ]);
  const originalInput = ".artifacts/build-cache-inputs/node_modules/archived.json";
  await fs.mkdir(path.dirname(path.join(canonical, originalInput)), { recursive: true });
  await writeText(canonical, originalInput, "original archived input\n");
  await git(canonical, "add", "--force", "--", originalInput);
  await writeText(canonical, ".env.allowed", "original provisioned bytes");
  await fs.chmod(path.join(canonical, ".env.allowed"), 0o600);
  await writeText(canonical, ".gitignore", ".env.local\n.env.allowed\nguest-ignored/\n");
  await fs.mkdir(path.join(canonical, "guest-ignored"));
  await writeText(canonical, "guest-ignored/host-secret", "not guest custody");
  const projection = await prepare(owner);
  await fs.mkdir(path.join(projection, "guest-ignored/empty"), { recursive: true });
  const bytes = Buffer.from("guest-owned ignored bytes\0\n");
  await fs.writeFile(path.join(projection, "guest-ignored/data"), bytes);
  if (process.platform !== "win32") {
    await fs.symlink("../source.txt", path.join(projection, "guest-ignored/link"));
  }
  await synchronize(owner);
  expect(await fs.readFile(path.join(canonical, "guest-ignored/data"))).toEqual(bytes);
  const removed = await service.remove({
    id: owner.worktree.id,
    reason: "accepted-ignored-archive",
  });
  expect(removed.removed).toBe(true);
  expect(await treePaths(removed.snapshotRef!)).not.toContain("guest-ignored");
  const receipt = (await readProjection())!.pending_ref!;
  expect(receipt).toBeTruthy();
  const receiptStorage = await resolveWorkspaceResultStorage(repo, receipt);
  expect(receiptStorage.isolated).toBe(true);
  const legacyState = (await registry.getRegistryWorktreeProvisionedState(
    process.env,
    owner.worktree.id,
  ))!;
  expect(legacyState).toEqual([{ path: ".env.allowed", mode: expect.any(Number), chunks: 1 }]);
  await closeOpenClawStateDatabaseAsync();
  if (mode === "retention" || mode === "legacy retention") {
    await registry.updateRegistryWorktree(process.env, owner.worktree.id, {
      removedAt: Date.now() - retentionMs - 1,
    });
    if (mode === "legacy retention") {
      await prepareLegacyArchiveRetention({ owner, receipt, originalInput });
    }
    await writeText(projection, "guest-ignored/data", "unaccepted newer bytes");
    expect((await service.gc()).snapshotsPruned).toBe(0);
    expect(await git(repo, "rev-parse", "--verify", removed.snapshotRef!)).toMatch(/^[a-f0-9]+$/u);
    await fs.writeFile(path.join(projection, "guest-ignored/data"), bytes);
    const sql = observeLocalWorkspaceStoreSql();
    try {
      sql.calibrate();
      expect((await service.gc()).snapshotsPruned).toBe(1);
      sql.expectIdle();
    } finally {
      sql.restore();
    }
    expect(await readProjection()).toBeUndefined();
    expect(getRegistryWorktree(process.env, owner.worktree.id)).toBeUndefined();
    expect(
      await git(repo, "for-each-ref", "--format=%(refname)", receipt, removed.snapshotRef!),
    ).toBe("");
    await expect(fs.stat(receiptStorage.root)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(projection)).rejects.toMatchObject({ code: "ENOENT" });
    return;
  }
  if (mode === "legacy decoder") {
    // Execute the pre-feature restore sequence and unchanged old decoder, not
    // just its schema preflight. The ledger contains only original regular files.
    const snapshot = await git(repo, "rev-parse", removed.snapshotRef!);
    const parent = await git(repo, "rev-parse", snapshot + "^");
    await git(
      repo,
      "worktree",
      "add",
      "--no-checkout",
      "-b",
      owner.worktree.branch,
      canonical,
      parent,
    );
    await git(canonical, "read-tree", "--reset", "--no-recurse-submodules", "-u", snapshot);
    await git(canonical, "reset", "--quiet", parent);
    await restoreProvisionedFiles(process.env, owner.worktree.id, canonical, legacyState);
    await expectText(canonical, ".env.allowed", "original provisioned bytes");
    expect(existsSync(path.join(canonical, "guest-ignored/data"))).toBe(false);
    await registry.updateRegistryWorktree(process.env, owner.worktree.id, {
      removedAt: undefined,
      lastActiveAt: Date.now(),
      provisionedPaths: legacyState.map((entry) => entry.path),
    });
    await closeOpenClawStateDatabaseAsync();
  } else {
    let injected = false;
    const acknowledgement = observeAcknowledgedUpdate((row) => {
      if (
        row.pending_ref &&
        row.pending_target === null &&
        existsSync(path.join(canonical, "guest-ignored/data"))
      ) {
        injected = true;
      }
    });
    await expect(
      service.restore({
        id: owner.worktree.id,
        commitGuard: () => {
          if (injected) {
            throw new Error("restore interrupted after overlay acceptance");
          }
        },
      }),
    ).rejects.toThrow("restore interrupted after overlay acceptance");
    acknowledgement.mockRestore();
    expect(injected).toBe(true);
    expect(existsSync(canonical)).toBe(false);
    expect((await readProjection())?.pending_ref).toBe(receipt);
    expect(getRegistryWorktree(process.env, owner.worktree.id)?.removedAt).toBeDefined();
    await service.restore({ id: owner.worktree.id });
  }
  await prepare(owner);
  for (const workspace of [canonical, projection]) {
    await expectText(workspace, originalInput, "original archived input\n");
    expect(await fs.readFile(path.join(workspace, "guest-ignored/data"))).toEqual(bytes);
    expect((await fs.stat(path.join(workspace, "guest-ignored/empty"))).isDirectory()).toBe(true);
    if (process.platform !== "win32") {
      expect(await fs.readlink(path.join(workspace, "guest-ignored/link"))).toBe("../source.txt");
    }
    await expectMissing(workspace, "guest-ignored/host-secret");
    await expectMissing(workspace, ".env.local");
  }
  await expectText(canonical, ".env.allowed", "original provisioned bytes");
  await expectMissing(projection, ".env.allowed");
  expect((await readProjection())?.pending_ref).toBeNull();
  await expect(fs.stat(receiptStorage.root)).rejects.toMatchObject({ code: "ENOENT" });
  await git(repo, "config", "--unset-all", "credential.helper");
  const { captureGitHubPublicationWorkspaceSnapshot } =
    await import("../github-publication-git-transport.js");
  const published = await captureGitHubPublicationWorkspaceSnapshot({ cwd: canonical });
  expect(await treePaths(published.workspaceTree)).not.toContain("guest-ignored");
}
