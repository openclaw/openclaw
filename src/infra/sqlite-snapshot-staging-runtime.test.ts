import { beforeEach, expect, it, vi } from "vitest";
import type { SqliteReadOnlyWorkerLaunch } from "./sqlite-readonly-worker-session.js";
import type { SqliteSnapshotStagingLaunch } from "./sqlite-snapshot-staging.types.js";

const transport = vi.hoisted(() => ({
  compatible: vi.fn<(launch: SqliteReadOnlyWorkerLaunch) => boolean>(() => true),
  isRetired: vi.fn(() => false),
  run: vi.fn<(...args: unknown[]) => Promise<string>>(),
  close: vi.fn<() => Promise<void>>(),
}));
const factory = vi.hoisted(() => vi.fn());

import { createSqliteSnapshotStagingRuntime } from "./sqlite-snapshot-staging-runtime.js";

let runtime: ReturnType<typeof createSqliteSnapshotStagingRuntime>;
let launch: SqliteSnapshotStagingLaunch;
beforeEach(() => {
  launch = { cwd: "/fixture", env: { FIXTURE: "captured" }, transport: { kind: "native" } };
  transport.compatible.mockReset().mockReturnValue(true);
  transport.run.mockReset().mockResolvedValue("/fixture/snapshot");
  transport.close.mockReset().mockResolvedValue(undefined);
  transport.isRetired.mockReset().mockReturnValue(false);
  factory.mockReset().mockReturnValue(transport);
  runtime = createSqliteSnapshotStagingRuntime(factory);
});

it.each([
  Object.assign(new Error("spawn node EACCES"), { code: "EACCES" }),
  Object.assign(new Error("spawn node ENOENT"), { code: "ENOENT" }),
  new Error("SQLite snapshot staging owner launch context changed"),
])("preserves non-directory allocation failures: $message", async (failure) => {
  transport.run.mockRejectedValueOnce(failure);
  await expect(runtime.allocate("/fixture", false, launch, 1)).rejects.toBe(failure);
  expect(transport.close).toHaveBeenCalledOnce();
});

it("acknowledges a lost session before reconciling retirement and accepting new allocations", async () => {
  const owned = await runtime.allocate("/fixture", false, launch, 1);
  let acknowledge!: () => void;
  transport.isRetired.mockReturnValue(true);
  transport.close.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      acknowledge = resolve;
    }),
  );
  const replacement = {
    compatible: () => true,
    isRetired: () => false,
    run: vi.fn().mockResolvedValue("/fixture/replacement"),
    close: vi.fn().mockResolvedValue(undefined),
  };
  factory.mockReturnValue(replacement);
  launch = {
    cwd: "/changed-before-retirement",
    env: { FIXTURE: "changed-before-retirement" },
    transport: { kind: "native" },
  };
  const retired = owned.retire();
  await vi.waitFor(() => expect(transport.close).toHaveBeenCalledOnce());
  expect(replacement.run).not.toHaveBeenCalled();
  launch = {
    cwd: "/changed-after-close-started",
    env: { FIXTURE: "changed" },
    transport: { kind: "native" },
  };
  acknowledge();
  await retired;
  expect(factory).toHaveBeenLastCalledWith({
    env: { FIXTURE: "captured" },
    cwd: "/fixture",
    transport: { kind: "native" },
    retainLifetime: false,
    retainOnOperationError: true,
  });
  expect(replacement.run).toHaveBeenCalledWith("/fixture/snapshot", { mode: "staging-reconcile" });
  expect(replacement.close).toHaveBeenCalledOnce();
  const next = await runtime.allocate("/fixture", false, launch, 1);
  await next.retire();
});

it("retries the same last session close before releasing snapshot custody", async () => {
  const owned = await runtime.allocate("/fixture", false, launch, 1);
  const failure = new Error("session close unacknowledged");
  transport.close.mockRejectedValueOnce(failure);
  await expect(owned.retire()).rejects.toBe(failure);
  await expect(owned.retire()).resolves.toBeUndefined();
  expect(transport.close).toHaveBeenCalledTimes(2);
  expect(transport.run).toHaveBeenCalledTimes(2);
  await owned.retire();
  expect(transport.close).toHaveBeenCalledTimes(2);
});

it("preserves allocation and close failures and joins retained close before new allocation", async () => {
  const allocation = new Error("allocation failed");
  const cleanup = new Error("close failed");
  transport.run.mockRejectedValueOnce(allocation);
  transport.close.mockRejectedValueOnce(cleanup);
  await expect(runtime.allocate("/fixture", false, launch, 1)).rejects.toMatchObject({
    errors: [allocation, cleanup],
    cause: allocation,
  });
  const owned = await runtime.allocate("/fixture", false, launch, 1);
  expect(transport.close).toHaveBeenCalledTimes(2);
  await owned.retire();
  expect(transport.close).toHaveBeenCalledTimes(3);
});

it("refuses a changed launch after session retirement until its original tokens close", async () => {
  const original = await runtime.allocate("/fixture", false, launch, 1);
  transport.isRetired.mockReturnValue(true);
  const replacement = {
    compatible: () => true,
    isRetired: () => false,
    run: vi.fn().mockResolvedValue("/fixture/replacement"),
    close: vi.fn().mockResolvedValue(undefined),
  };
  factory.mockReturnValue(replacement);
  launch = {
    cwd: "/changed-generation",
    env: { FIXTURE: "changed-generation" },
    transport: { kind: "native" },
  };
  const outcome = await runtime.allocate("/fixture", false, launch, 1).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  let next: Awaited<ReturnType<typeof runtime.allocate>> | undefined;
  try {
    expect(outcome).toMatchObject({
      error: expect.objectContaining({
        message: expect.stringContaining("launch context changed"),
      }),
    });
    expect(factory).toHaveBeenCalledOnce();
    await original.retire();
    expect(factory).toHaveBeenLastCalledWith(
      expect.objectContaining({
        env: { FIXTURE: "captured" },
        cwd: "/fixture",
        transport: { kind: "native" },
      }),
    );
    expect(replacement.run).toHaveBeenCalledWith("/fixture/snapshot", {
      mode: "staging-reconcile",
    });
    expect(replacement.close).toHaveBeenCalledOnce();
    next = await runtime.allocate("/fixture", false, launch, 1);
    expect(factory).toHaveBeenLastCalledWith(
      expect.objectContaining({
        env: { FIXTURE: "changed-generation" },
        cwd: "/changed-generation",
      }),
    );
  } finally {
    if ("value" in outcome) {
      await outcome.value.retire();
    }
    await original.retire();
    await next?.retire();
  }
});
