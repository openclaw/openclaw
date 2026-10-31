import fs from "node:fs/promises";
import path from "node:path";
import { expect, vi } from "vitest";
import { requireGit } from "../../agents/worktrees/git.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { prepareSandboxCheckpointFixture } from "./local-workspace-incremental.test-support.js";
import { withLocalWorkspaceProjection } from "./local-workspace-projection.js";
import { readLocalWorkspaceProjection } from "./local-workspace-store.test-support.js";
import type { LocalWorkspaceOwner } from "./local-workspace-types.js";

const writeText = (directory: string, relative: string, data: string) =>
  fs.writeFile(path.join(directory, relative), data);
const expectText = async (directory: string, relative: string, expected: string) =>
  expect(await fs.readFile(path.join(directory, relative), "utf8")).toBe(expected);
const expectMissing = async (directory: string, relative: string) =>
  expect(fs.stat(path.join(directory, relative))).rejects.toMatchObject({ code: "ENOENT" });

export async function proveWarmWorkspaceReuse(owner: LocalWorkspaceOwner) {
  const canonical = owner.worktree.path;
  const quiescence = await import("../../agents/sandbox/local-workspace-quiescence.js");
  using first = await prepareSandboxCheckpointFixture(owner);
  const quiesce = vi.spyOn(quiescence, "quiesceLocalWorkspace");
  using unchanged = await prepareSandboxCheckpointFixture(owner);
  expect(unchanged.workspaceDir).toBe(first.workspaceDir);
  expect(quiesce).not.toHaveBeenCalled();

  const source = path.join(first.workspaceDir, "source.txt");
  const before = await fs.stat(source);
  await writeText(first.workspaceDir, "source.txt", "modified\n");
  await fs.utimes(source, before.atime, before.mtime);
  using guestEdit = await prepareSandboxCheckpointFixture(owner);
  expect(quiesce).toHaveBeenCalledTimes(1);
  await expectText(canonical, "source.txt", "modified\n");
  await expectText(guestEdit.workspaceDir, "source.txt", "modified\n");

  await writeText(canonical, "source.txt", "host edit\n");
  using hostEdit = await prepareSandboxCheckpointFixture(owner);
  expect(quiesce).toHaveBeenCalledTimes(2);
  await expectText(hostEdit.workspaceDir, "source.txt", "host edit\n");
  await writeText(canonical, "added.txt", "admitted host file\n");
  await requireGit(canonical, ["add", "added.txt"]);
  using admitted = await prepareSandboxCheckpointFixture(owner);
  await expectText(admitted.workspaceDir, "added.txt", "admitted host file\n");
  await fs.rm(path.join(admitted.workspaceDir, "added.txt"));
  using deleted = await prepareSandboxCheckpointFixture(owner);
  await expectMissing(canonical, "added.txt");
  await expectMissing(deleted.workspaceDir, "added.txt");
  expect((await readLocalWorkspaceProjection(owner.worktree.id))?.pending_ref).toBeNull();
}

export async function proveWarmWorkspaceReuseFailure(
  owner: LocalWorkspaceOwner,
  failure: "read" | "authority" | "observation" | "cancel",
  revoke: () => void,
) {
  using first = await prepareSandboxCheckpointFixture(owner);
  const stores = await import("./local-workspace-store.js");
  const quiescence = await import("../../agents/sandbox/local-workspace-quiescence.js");
  const quiesce = vi.spyOn(quiescence, "quiesceLocalWorkspace");
  const withStore = stores.withLocalWorkspaceStore;
  const cancellation = new AbortController();
  let failed = false;
  vi.spyOn(stores, "withLocalWorkspaceStore").mockImplementation((params, run) =>
    withStore(params, (store) =>
      run({
        ...store,
        manifest: async (row, action) => {
          if (action.kind === "probe" && !failed && failure !== "observation") {
            failed = true;
            if (failure === "authority") {
              revoke();
            }
            if (failure === "cancel") {
              cancellation.abort(new Error("reuse cancelled"));
            }
            throw new Error("probe read failed");
          }
          return store.manifest(row, action);
        },
        accept: async (prepared, authority) => {
          if (failure === "observation") {
            failed = true;
            throw new Error("observation acceptance failed");
          }
          return store.accept(prepared, authority);
        },
      }),
    ),
  );
  if (failure === "read") {
    using recovered = await prepareSandboxCheckpointFixture(owner);
    expect(recovered.workspaceDir).toBe(first.workspaceDir);
    expect(quiesce).toHaveBeenCalledOnce();
  } else if (failure === "cancel") {
    await expect(
      prepareSandboxCheckpointFixture(owner, undefined, cancellation.signal),
    ).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_ABORTED" });
    expect(quiesce).not.toHaveBeenCalled();
  } else {
    await expect(prepareSandboxCheckpointFixture(owner)).rejects.toThrow(
      failure === "authority" ? "revoked" : "observation acceptance failed",
    );
    expect(quiesce).not.toHaveBeenCalled();
  }
  expect(failed).toBe(true);
  await expectText(owner.worktree.path, "source.txt", "original\n");
  await expectText(first.workspaceDir, "source.txt", "original\n");
}

export async function proveWarmWorkspaceConflictRecovery(owner: LocalWorkspaceOwner) {
  const canonical = owner.worktree.path;
  using first = await prepareSandboxCheckpointFixture(owner);
  const projection = first.workspaceDir;
  await writeText(projection, "source.txt", "guest conflict\n");
  await writeText(canonical, "source.txt", "human conflict\n");
  await expect(
    withLocalWorkspaceProjection(owner, (state) => state.synchronize("canonical")),
  ).rejects.toThrow("conflict");
  await expect(withLocalWorkspaceProjection(owner, (state) => state.prepare())).rejects.toThrow(
    "conflict",
  );
  expect((await readLocalWorkspaceProjection(owner.worktree.id))?.pending_ref).toBeTruthy();
  await expectText(projection, "source.txt", "guest conflict\n");
  await expectText(canonical, "source.txt", "human conflict\n");
  await closeOpenClawStateDatabaseAsync();
  await expect(prepareSandboxCheckpointFixture(owner)).rejects.toThrow("conflict");
  await expectText(projection, "source.txt", "guest conflict\n");
  await expectText(canonical, "source.txt", "human conflict\n");
  await writeText(canonical, "source.txt", "original\n");
  using recovered = await prepareSandboxCheckpointFixture(owner);
  expect(recovered.workspaceDir).toBe(projection);
  await expectText(canonical, "source.txt", "guest conflict\n");
  expect((await readLocalWorkspaceProjection(owner.worktree.id))?.pending_ref).toBeNull();
}
