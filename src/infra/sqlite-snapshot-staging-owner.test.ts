import fs from "node:fs";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
import { removeTempDirectoryAsync } from "./sqlite-readonly-location-cleanup.js";
import type { SqliteReadOnlyWorkerLaunch } from "./sqlite-readonly-worker-session.js";
import { createSqliteSnapshotStagingDirectory } from "./sqlite-snapshot-staging.js";

const transport = vi.hoisted(() => ({
  compatible: vi.fn<(launch: SqliteReadOnlyWorkerLaunch) => boolean>(() => true),
  isRetired: vi.fn(() => false),
  run: vi.fn<(...args: unknown[]) => Promise<string>>(),
  close: vi.fn<() => Promise<void>>(),
}));
const factory = vi.hoisted(() => vi.fn());
const launch = vi.hoisted(() => ({ cwd: "/fixture", env: { FIXTURE: "captured" } }));
vi.mock("./sqlite-readonly-worker.js", () => ({
  captureSqliteReadOnlyWorkerLaunch: () => ({
    env: { ...launch.env },
    cwd: launch.cwd,
    transport: { kind: "native" },
  }),
  createScopedSqliteReadOnlyWorker: factory,
}));

import { allocateWorkerOwnedSqliteSnapshotDirectory } from "./sqlite-snapshot-staging-owner.js";

beforeEach(() => {
  launch.cwd = "/fixture";
  launch.env.FIXTURE = "captured";
  transport.compatible.mockReset().mockReturnValue(true);
  transport.run.mockReset().mockResolvedValue("/fixture/snapshot");
  transport.close.mockReset().mockResolvedValue(undefined);
  transport.isRetired.mockReset().mockReturnValue(false);
  factory.mockReset().mockReturnValue(transport);
});

it.each([
  Object.assign(new Error("spawn node EACCES"), { code: "EACCES" }),
  Object.assign(new Error("spawn node ENOENT"), { code: "ENOENT" }),
  new Error("SQLite snapshot staging owner launch context changed"),
])("preserves non-directory allocation failures: $message", async (failure) => {
  transport.run.mockRejectedValueOnce(failure);
  await expect(
    createSqliteSnapshotStagingDirectory("/fixture", false, undefined, true),
  ).rejects.toBe(failure);
  expect(transport.close).toHaveBeenCalledOnce();
});

it("acknowledges a lost session before reconciling retirement and accepting new allocations", async () => {
  const owned = await allocateWorkerOwnedSqliteSnapshotDirectory("/fixture", false);
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
  launch.cwd = "/changed-before-retirement";
  launch.env.FIXTURE = "changed-before-retirement";
  const retired = owned.retire();
  await vi.waitFor(() => expect(transport.close).toHaveBeenCalledOnce());
  expect(replacement.run).not.toHaveBeenCalled();
  launch.cwd = "/changed-after-close-started";
  launch.env.FIXTURE = "changed";
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
  const next = await allocateWorkerOwnedSqliteSnapshotDirectory("/fixture", false);
  await next.retire();
});

it("retries the same last session close before releasing snapshot custody", async () => {
  const owned = await allocateWorkerOwnedSqliteSnapshotDirectory("/fixture", false);
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
  await expect(allocateWorkerOwnedSqliteSnapshotDirectory("/fixture", false)).rejects.toMatchObject(
    {
      errors: [allocation, cleanup],
      cause: allocation,
    },
  );
  const owned = await allocateWorkerOwnedSqliteSnapshotDirectory("/fixture", false);
  expect(transport.close).toHaveBeenCalledTimes(2);
  await owned.retire();
  expect(transport.close).toHaveBeenCalledTimes(3);
});

const directories = useAutoCleanupTempDirTracker(afterEach);
it.each(["queued", "accepted"] as const)(
  "settles %s allocation cancellation without retiring a sibling token",
  async (phase) => {
    const root = directories.make("staging-cancel-custody-");
    const entered = createDeferredCore();
    const proceed = createDeferredCore();
    const controller = new AbortController();
    const reason = new Error("snapshot caller canceled");
    let created = 0;
    transport.run.mockImplementation(async (pathname, options) => {
      if (typeof pathname !== "string" || !isRecord(options)) {
        throw new Error("Expected a staging request");
      }
      if (options.mode === "staging-reconcile") {
        transport.isRetired.mockReturnValue(false);
      }
      if (options.mode !== "staging-create") {
        return pathname;
      }
      const ordinal = ++created;
      if (ordinal === (phase === "queued" ? 1 : 2)) {
        entered.resolve();
        const signal = options.signal;
        let abort: (() => void) | undefined;
        try {
          await (signal instanceof AbortSignal
            ? Promise.race([
                proceed.promise,
                new Promise<never>((_resolve, reject) => {
                  abort = () => {
                    transport.isRetired.mockReturnValue(true);
                    reject(reason);
                  };
                  signal.addEventListener("abort", abort, { once: true });
                }),
              ])
            : proceed.promise);
        } finally {
          if (signal instanceof AbortSignal && abort) {
            signal.removeEventListener("abort", abort);
          }
        }
      }
      const directory = path.join(root, `snapshot-${ordinal}`);
      fs.mkdirSync(directory, { mode: 0o700 });
      return directory;
    });
    const first = createSqliteSnapshotStagingDirectory(root, false, undefined, true);
    let second: Promise<string> | undefined;
    try {
      if (phase === "queued") {
        await entered.promise;
      } else {
        await first;
      }
      second = createSqliteSnapshotStagingDirectory(root, false, controller.signal, true);
      const rejected = expect(second).rejects.toBe(reason);
      if (phase === "accepted") {
        await entered.promise;
      } else {
        await nextTurn();
      }
      controller.abort(reason);
      await nextTurn();
      expect(transport.isRetired()).toBe(false);
      expect(transport.close).not.toHaveBeenCalled();
      proceed.resolve();
      const sibling = await first;
      await rejected;
      expect(created).toBe(phase === "queued" ? 1 : 2);
      expect(fs.existsSync(sibling)).toBe(true);
      expect(transport.close).not.toHaveBeenCalled();
    } finally {
      proceed.resolve();
      const settled = await Promise.allSettled([first, second]);
      for (const result of settled) {
        if (result.status === "fulfilled" && result.value) {
          expect(await removeTempDirectoryAsync(result.value)).toBe(true);
        }
      }
    }
  },
);

it("preserves allocation launch facts while waiting behind another token command", async () => {
  const entered = createDeferredCore();
  const proceed = createDeferredCore();
  transport.compatible.mockImplementation(
    ({ cwd, env }) => cwd === "/fixture" && env.FIXTURE === "captured",
  );
  transport.run.mockImplementationOnce(async () => {
    entered.resolve();
    await proceed.promise;
    return "/fixture/first";
  });
  const first = allocateWorkerOwnedSqliteSnapshotDirectory("/fixture", false);
  let second: ReturnType<typeof allocateWorkerOwnedSqliteSnapshotDirectory> | undefined;
  try {
    await entered.promise;
    second = allocateWorkerOwnedSqliteSnapshotDirectory("/fixture", false);
    const outcome = second.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    launch.cwd = "/changed-while-queued";
    launch.env.FIXTURE = "changed-while-queued";
    proceed.resolve();
    await first;
    expect(await outcome).not.toHaveProperty("error");
  } finally {
    launch.cwd = "/fixture";
    launch.env.FIXTURE = "captured";
    proceed.resolve();
    for (const result of await Promise.allSettled([first, second])) {
      if (result.status === "fulfilled" && result.value) {
        await result.value.retire();
      }
    }
  }
});

it("refuses a changed launch after session retirement until its original tokens close", async () => {
  const original = await allocateWorkerOwnedSqliteSnapshotDirectory("/fixture", false);
  transport.isRetired.mockReturnValue(true);
  const replacement = {
    compatible: () => true,
    isRetired: () => false,
    run: vi.fn().mockResolvedValue("/fixture/replacement"),
    close: vi.fn().mockResolvedValue(undefined),
  };
  factory.mockReturnValue(replacement);
  launch.cwd = "/changed-generation";
  launch.env.FIXTURE = "changed-generation";
  const outcome = await allocateWorkerOwnedSqliteSnapshotDirectory("/fixture", false).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  let next: Awaited<ReturnType<typeof allocateWorkerOwnedSqliteSnapshotDirectory>> | undefined;
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
    next = await allocateWorkerOwnedSqliteSnapshotDirectory("/fixture", false);
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
