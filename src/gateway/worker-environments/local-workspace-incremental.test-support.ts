import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, vi } from "vitest";
import { stagedInputDirectory, STAGED_INPUT_GITIGNORE } from "../../media/staged-inputs.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { withLocalWorkspaceProjection } from "./local-workspace-projection.js";
import * as workspaceStore from "./local-workspace-store.js";
import { withLocalWorkspaceStore } from "./local-workspace-store.js";
import {
  observeLocalWorkspaceStoreSql,
  readLocalWorkspaceProjection,
} from "./local-workspace-store.test-support.js";
import type { LocalWorkspaceOwner } from "./local-workspace-types.js";
import { parseWorkerWorkspaceManifest } from "./workspace-manifest.js";

const prepare = (owner: LocalWorkspaceOwner) =>
  withLocalWorkspaceProjection(owner, (state) => state.prepare());
const synchronize = (owner: LocalWorkspaceOwner) =>
  withLocalWorkspaceProjection(owner, (state) => state.synchronize("canonical"));
const writeText = (directory: string, relative: string, data: string) =>
  fs.writeFile(path.join(directory, relative), data);
const expectText = async (directory: string, relative: string, expected: string) =>
  expect(await fs.readFile(path.join(directory, relative), "utf8")).toBe(expected);
const expectMissing = async (directory: string, relative: string) =>
  expect(fs.stat(path.join(directory, relative))).rejects.toMatchObject({ code: "ENOENT" });

export function observeAcknowledgedUpdate(
  observe: (row: workspaceStore.LocalWorkspaceProjection) => void,
) {
  const withStore = workspaceStore.withLocalWorkspaceStore;
  return vi.spyOn(workspaceStore, "withLocalWorkspaceStore").mockImplementation((params, run) =>
    withStore(params, (store) =>
      run({
        ...store,
        update: async (row, patch, authority, manifest) => {
          const acknowledged = await store.update(row, patch, authority, manifest);
          observe(acknowledged);
          return acknowledged;
        },
      }),
    ),
  );
}

export async function proveWorkerOwnedIncrementalWorkspace(owner: LocalWorkspaceOwner) {
  using cleanup = new DisposableStack();
  const sql = observeLocalWorkspaceStoreSql();
  cleanup.defer(sql.restore);
  sql.calibrate();
  const projection = await prepare(owner);
  await writeText(projection, "source.txt", "worker-persisted edit\n");
  await synchronize(owner);
  await expectText(owner.worktree.path, "source.txt", "worker-persisted edit\n");
  await withLocalWorkspaceStore({ worktreeId: owner.worktree.id }, async (store) => {
    expect(store.get()!.baseline_json).toBeNull();
    const baseline = await store.manifest(store.get()!, { kind: "materialize" });
    expect(baseline.kind).toBe("materialize");
    if (baseline.kind !== "materialize") {
      throw new Error("Expected complete baseline at the publication boundary");
    }
    const manifest = parseWorkerWorkspaceManifest(baseline.rawManifest, baseline.manifestRef);
    expect(manifest.entries.find((entry) => entry.path === "source.txt")).toMatchObject({
      type: "file",
      sha256: createHash("sha256").update("worker-persisted edit\n").digest("hex"),
    });
  });
  sql.expectIdle();
}

export async function proveIncrementalWorkspaceEdits(owner: LocalWorkspaceOwner) {
  const canonical = owner.worktree.path;
  const projection = await prepare(owner);
  await writeText(projection, "rename.txt", "rename me\n");
  await writeText(projection, "delete.txt", "delete me\n");
  await synchronize(owner);
  const previous = (await readLocalWorkspaceProjection(owner.worktree.id))!.baseline_ref;
  const before = await fs.stat(path.join(projection, "source.txt"));
  // Size and mtime are identical; ctime must invalidate the persisted hash.
  await writeText(projection, "source.txt", "modified\n");
  await fs.utimes(path.join(projection, "source.txt"), before.atime, before.mtime);
  await fs.rename(path.join(projection, "rename.txt"), path.join(projection, "renamed.txt"));
  await fs.chmod(path.join(projection, "renamed.txt"), 0o755);
  await fs.unlink(path.join(projection, "delete.txt"));
  await fs.symlink("source.txt", path.join(projection, "link"));
  await closeOpenClawStateDatabaseAsync();
  await synchronize(owner);
  await expectText(canonical, "source.txt", "modified\n");
  await expectText(canonical, "renamed.txt", "rename me\n");
  await expectMissing(canonical, "rename.txt");
  await expectMissing(canonical, "delete.txt");
  expect((await fs.stat(path.join(canonical, "renamed.txt"))).mode & 0o111).not.toBe(0);
  expect(await fs.readlink(path.join(canonical, "link"))).toBe("source.txt");
  expect(await readLocalWorkspaceProjection(owner.worktree.id)).toMatchObject({
    baseline_json: null,
    checkpoint_json: null,
    pending_ref: null,
  });
  expect((await readLocalWorkspaceProjection(owner.worktree.id))!.baseline_ref).not.toBe(previous);
  await prepare(owner);
  await expectText(projection, "source.txt", "modified\n");
}

export async function proveStagedInputCheckpointOwnership(owner: LocalWorkspaceOwner) {
  const projection = await prepare(owner);
  const directory = stagedInputDirectory(randomUUID());
  await fs.mkdir(path.join(projection, directory, "node_modules"), { recursive: true });
  await writeText(projection, `${directory}/.gitignore`, STAGED_INPUT_GITIGNORE);
  const input = `${directory}/node_modules/input.txt`;
  await writeText(projection, input, "first input\n");
  await synchronize(owner);
  await writeText(projection, input, "edited input\n");
  await synchronize(owner);
  await expectText(owner.worktree.path, input, "edited input\n");
  await prepare(owner);
  await expectText(projection, input, "edited input\n");
}
