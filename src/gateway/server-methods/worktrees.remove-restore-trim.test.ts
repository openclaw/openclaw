import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { getRegistryWorktree } from "../../agents/worktrees/registry.test-support.js";
import { managedWorktrees, ManagedWorktreeService } from "../../agents/worktrees/service.js";
import { initializeManagedWorktreeTestRepository } from "../../agents/worktrees/service.test-support.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { worktreesHandlers } from "./worktrees.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
  clearRuntimeConfigSnapshot();
});

async function call(method: keyof typeof worktreesHandlers, params: Record<string, unknown>) {
  const respond = vi.fn();
  await worktreesHandlers[method]?.({ params, respond } as never);
  return respond.mock.calls[0];
}

describe("worktrees.remove/restore padded ids on live registry", () => {
  it("removes and restores through real Git + registry when ids are padded", async () => {
    setRuntimeConfigSnapshot({});
    const root = tempDirs.make("openclaw-worktrees-gateway-trim-");
    const repoRoot = await initializeManagedWorktreeTestRepository(root);
    const stateDir = path.join(root, "state");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const service = new ManagedWorktreeService({ env });
    vi.spyOn(managedWorktrees, "remove").mockImplementation(service.remove.bind(service));
    vi.spyOn(managedWorktrees, "restore").mockImplementation(service.restore.bind(service));

    const created = await service.create({
      repoRoot,
      name: "pad-remove",
      baseRef: "HEAD",
      ownerKind: "manual",
    });
    expect(getRegistryWorktree(env, created.id)?.removedAt).toBeUndefined();
    await fs.stat(created.path);

    // An id that names no record is refused before any change, and the response says so.
    const refusal = (message: string) => [
      false,
      undefined,
      {
        code: "UNAVAILABLE",
        message,
        retryable: false,
        details: { reason: "WORKTREE_NOT_FOUND", mutationAccepted: false },
      },
    ];
    for (const id of ["   ", "\t\n"]) {
      expect(await call("worktrees.remove", { id })).toEqual(
        refusal(`unknown active worktree: ${id}`),
      );
      expect(await call("worktrees.restore", { id })).toEqual(
        refusal(`worktree ${id} is not restorable`),
      );
    }

    await expect(
      service.remove({ id: ` ${created.id} `, reason: "manual-delete" }),
    ).rejects.toThrow(/unknown active worktree/);

    const removeResult = await call("worktrees.remove", {
      id: ` ${created.id} `,
    });
    expect(removeResult?.[0]).toBe(true);
    expect(removeResult?.[1]).toMatchObject({ removed: true });
    expect(getRegistryWorktree(env, created.id)?.removedAt).toEqual(expect.any(Number));
    await expect(fs.stat(created.path)).rejects.toMatchObject({ code: "ENOENT" });

    const restoreResult = await call("worktrees.restore", { id: ` ${created.id} ` });
    expect(restoreResult?.[0]).toBe(true);
    expect(restoreResult?.[1]).toMatchObject({ id: created.id, path: created.path });
    expect(getRegistryWorktree(env, created.id)?.removedAt).toBeUndefined();
    expect(await fs.readFile(path.join(created.path, "README.md"), "utf8")).toBe("base\n");
  });
});
