import { describe, expect, it, vi } from "vitest";
import type { ManagedWorktreeRecord } from "../../agents/worktrees/types.js";
import { createWorktreesHandlers } from "./worktrees.js";

const record: ManagedWorktreeRecord = {
  id: "worktree-id",
  name: "task-one",
  repoFingerprint: "0123456789abcdef",
  repoRoot: "/repo",
  path: "/state/worktrees/0123456789abcdef/task-one",
  branch: "openclaw/task-one",
  baseRef: "HEAD",
  ownerKind: "manual",
  createdAt: 1,
  lastActiveAt: 2,
};

async function call(
  handlers: ReturnType<typeof createWorktreesHandlers>,
  method: keyof ReturnType<typeof createWorktreesHandlers>,
  params: Record<string, unknown>,
) {
  const respond = vi.fn();
  await handlers[method]?.({ params, respond } as never);
  return respond.mock.calls[0];
}

describe("worktrees gateway methods", () => {
  it("routes every operation through the managed worktree service", async () => {
    const service = {
      list: vi.fn(async () => [record]),
      create: vi.fn(async () => record),
      remove: vi.fn(async () => ({ removed: true, snapshotRef: "refs/snapshot" })),
      restore: vi.fn(async () => ({ ...record, snapshotRef: "refs/snapshot" })),
      gc: vi.fn(async () => ({ removed: [record.id], orphansDeleted: 1, snapshotsPruned: 2 })),
    };
    const handlers = createWorktreesHandlers(service as never);

    expect(await call(handlers, "worktrees.list", {})).toEqual([
      true,
      { worktrees: [record] },
      undefined,
    ]);
    expect(
      await call(handlers, "worktrees.create", {
        repoRoot: "/repo",
        name: "task-one",
        baseRef: "main",
      }),
    ).toEqual([true, record, undefined]);
    expect(await call(handlers, "worktrees.remove", { id: record.id, force: true })).toEqual([
      true,
      { removed: true, snapshotRef: "refs/snapshot" },
      undefined,
    ]);
    expect((await call(handlers, "worktrees.restore", { id: record.id }))[0]).toBe(true);
    expect(await call(handlers, "worktrees.gc", {})).toEqual([
      true,
      { removed: [record.id], orphansDeleted: 1, snapshotsPruned: 2 },
      undefined,
    ]);

    expect(service.create).toHaveBeenCalledWith({
      repoRoot: "/repo",
      name: "task-one",
      baseRef: "main",
      ownerKind: "manual",
    });
    expect(service.remove).toHaveBeenCalledWith({
      id: record.id,
      reason: "manual-delete",
      force: true,
    });
  });

  it("rejects invalid parameters", async () => {
    const handlers = createWorktreesHandlers({} as never);
    const response = await call(handlers, "worktrees.create", { repoRoot: "" });

    expect(response?.[0]).toBe(false);
  });
});
