import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, vi } from "vitest";
import { getRegistryWorktree } from "../../agents/worktrees/registry.test-support.js";
import type { ManagedWorktreeService } from "../../agents/worktrees/service.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { withLocalWorkspaceProjection } from "./local-workspace-projection.js";
import { withLocalWorkspaceStore } from "./local-workspace-store.js";
import { readLocalWorkspaceProjection } from "./local-workspace-store.test-support.js";
import type { LocalWorkspaceOwner } from "./local-workspace-types.js";

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

export async function prepareLegacyArchiveRetention(params: {
  owner: LocalWorkspaceOwner;
  receipt: string;
  originalInput: string;
}) {
  const { owner, receipt, originalInput } = params;
  const repo = owner.worktree.repoRoot;
  const { readStagedWorkerWorkspaceResult } = await import("./workspace-result-staging.js");
  const { serializeWorkerWorkspaceManifest } = await import("./workspace-manifest.js");
  const { expireLocalWorkspaceProjection } = await import("./local-workspace-projection.js");
  const archived = await readStagedWorkerWorkspaceResult(repo, receipt, [originalInput]);
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
