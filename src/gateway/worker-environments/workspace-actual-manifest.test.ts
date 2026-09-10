import { createHook } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createNodeWorkspaceTransferService } from "./node-workspace-transfer-service.js";
import { prepareNodeWorkspaceTransferSnapshot } from "./node-workspace-transfer-snapshot.js";
import {
  readActualWorkspaceManifestImpl,
  readWorkspaceFileSnapshotWithLimit,
} from "./workspace-actual-manifest.js";
import { withWorkspaceHashMemo, workspaceStatIdentity } from "./workspace-hash-memo.js";
import { MAX_WORKSPACE_INVENTORY_TOTAL_BYTES } from "./workspace-inventory-limits.js";
import { readActualWorkspaceManifest } from "./workspace-reconcile-core.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it.each(["before traversal", "during traversal", "root resolution", "safe-root setup"] as const)(
  "rejects an empty inventory aborted %s",
  async (phase) => {
    const root = await fs.realpath(tempDirs.make("workspace-inventory-empty-abort-"));
    const controller = new AbortController();
    const reason = new Error("empty inventory aborted");
    const entered = createDeferred();
    const gate = createDeferred();
    const setupFailure = phase === "root resolution" || phase === "safe-root setup";
    if (setupFailure) {
      const realpath = fs.realpath.bind(fs);
      vi.spyOn(fs, "realpath").mockImplementation(async (...args) => {
        if (String(args[0]) !== root) {
          return await realpath(...args);
        }
        const resolved = phase === "safe-root setup" ? await realpath(...args) : undefined;
        entered.resolve();
        await gate.promise;
        return resolved ?? (await realpath(...args));
      });
    }
    const opendir = fs.opendir.bind(fs);
    const opened = vi.spyOn(fs, "opendir").mockImplementation(async (...args) => {
      const directory = await opendir(...args);
      entered.resolve();
      await gate.promise;
      return directory;
    });
    if (phase === "before traversal") {
      controller.abort(reason);
      gate.resolve();
    }
    const params = {
      root,
      baseCommit: null,
      signal: controller.signal,
      ...(phase === "before traversal" ? { includePaths: new Set<string>() } : {}),
    };
    const scan = readActualWorkspaceManifest(params);
    const rejected = expect(scan).rejects.toBe(reason);
    try {
      if (phase !== "before traversal") {
        await entered.promise;
        controller.abort(reason);
        if (setupFailure) {
          await fs.rmdir(root);
        }
        gate.resolve();
      }
      await rejected;
      expect(opened).toHaveBeenCalledTimes(phase === "during traversal" ? 1 : 0);
    } finally {
      gate.resolve();
      await Promise.allSettled([scan, rejected]);
    }
  },
);

it.each(["metadata", "files"] as const)(
  "bounds pending promise resources while %s operations are blocked",
  async (phase) => {
    const root = await fs.realpath(tempDirs.make("workspace-inventory-pending-"));
    const files = Array.from({ length: 512 }, (_, index) => `file-${index}.txt`);
    await Promise.all(files.map((file) => fs.writeFile(path.join(root, file), "inside")));
    const gate = createDeferred();
    let started = 0;
    const pause = async (target: unknown) => {
      if (String(target).startsWith(root + path.sep)) {
        started++;
        await gate.promise;
      }
    };
    if (phase === "metadata") {
      const lstat = fs.lstat.bind(fs);
      vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
        await pause(args[0]);
        return await lstat(...args);
      });
    } else {
      const open = fs.open.bind(fs);
      vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        await pause(args[0]);
        return await open(...args);
      });
    }
    const pendingPromises = new Set<number>();
    const hook = createHook({
      init(id, type) {
        if (type === "PROMISE") {
          pendingPromises.add(id);
        }
      },
      promiseResolve(id) {
        pendingPromises.delete(id);
      },
    }).enable();
    const scan = readActualWorkspaceManifestImpl({
      root,
      baseCommit: null,
      includePaths: new Set(files),
    });
    try {
      await vi.waitFor(() => expect(started).toBe(4));
      // Observe queued resources, not limiter internals: idle paths must not
      // each retain a promise graph while the active I/O is blocked.
      expect(pendingPromises.size).toBeLessThan(files.length);
    } finally {
      hook.disable();
      gate.resolve();
      await Promise.allSettled([scan]);
    }
    expect((await scan).manifest.entries).toHaveLength(files.length);
  },
);

const fileFailures = ["symlink replacement", "snapshot abort", "attachment abort"] as const;
it.each(fileFailures)("drains admitted file reads after %s", async (failure) => {
  const root = await fs.realpath(tempDirs.make("workspace-inventory-readers-"));
  const outside = await fs.realpath(tempDirs.make("workspace-inventory-outside-"));
  const files = Array.from({ length: 9 }, (_, index) => `file-${index}.txt`);
  await Promise.all(files.map((file) => fs.writeFile(path.join(root, file), "inside")));
  await fs.writeFile(path.join(outside, "target.txt"), "outside");
  const controller = new AbortController();
  const reason = new Error("manifest scan aborted");
  const service =
    failure === "attachment abort"
      ? createNodeWorkspaceTransferService({
          temporaryRoot: tempDirs.make("workspace-inventory-transfers-"),
          getOwner: () => ({
            credential: { ownerEpoch: 1, sessionId: "session" },
            environment: {
              ownerEpoch: 1,
              attachedSessionIds: ["session"],
              destroyRequestedAtMs: null,
              state: "attached",
            },
          }),
        })
      : undefined;
  if (service) {
    await service.prepareSync({
      environmentId: "environment",
      ownerEpoch: 1,
      sessionId: "session",
      generation: 1,
      localPath: tempDirs.make("workspace-inventory-empty-source-"),
      isAuthorized: () => true,
    });
  }
  const open = fs.open.bind(fs);
  const gates: Array<ReturnType<typeof createDeferred<void>>> = [];
  const gatedPaths: string[] = [];
  const firstClosed = createDeferred();
  let closed = 0;
  let releasing = false;
  const opened = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (!String(args[0]).startsWith(root + path.sep)) {
      return handle;
    }
    const close = handle.close.bind(handle);
    vi.spyOn(handle, "close").mockImplementation(async () => {
      await close();
      closed++;
      firstClosed.resolve();
    });
    if (!releasing) {
      const gate = createDeferred();
      gates.push(gate);
      gatedPaths.push(String(args[0]));
      await gate.promise;
    }
    return handle;
  });
  const scan = service
    ? service.prepareAttachments({
        environmentId: "environment",
        localPath: root,
        isAuthorized: () => true,
        signal: controller.signal,
      })
    : failure === "snapshot abort"
      ? prepareNodeWorkspaceTransferSnapshot({
          localPath: root,
          temporaryRoot: tempDirs.make("workspace-inventory-snapshot-"),
          signal: controller.signal,
        })
      : readActualWorkspaceManifest({ root, baseCommit: null, includePaths: new Set(files) });
  let settled = false;
  void scan.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  try {
    await vi.waitFor(() => expect(gates).toHaveLength(4));
    if (failure === "symlink replacement") {
      await fs.rename(gatedPaths[0]!, path.join(outside, "moved.txt"));
      await fs.symlink(path.join(outside, "target.txt"), gatedPaths[0]!);
    } else {
      controller.abort(reason);
    }
    gates[0]!.resolve();
    await firstClosed.promise;
    expect(settled).toBe(false);
    expect(opened).toHaveBeenCalledTimes(4);
  } finally {
    releasing = true;
    for (const gate of gates) {
      gate.resolve();
    }
    await Promise.allSettled([scan]);
    await service?.closeAll();
  }
  if (failure === "symlink replacement") {
    await expect(scan).rejects.toThrow();
  } else {
    await expect(scan).rejects.toBe(reason);
  }
  expect(opened).toHaveBeenCalledTimes(4);
  expect(closed).toBe(4);
});

const metadataFailures = [
  "metadata error",
  "caller abort",
  "abort before metadata error",
  "walk abort before metadata error",
] as const;
it.each(metadataFailures)("settles metadata after %s", async (failure) => {
  const walk = failure === "walk abort before metadata error";
  const admitted = walk ? 1 : 4;
  const root = await fs.realpath(tempDirs.make("workspace-inventory-metadata-"));
  const files = Array.from({ length: 9 }, (_, index) => `file-${index}.txt`);
  await Promise.all(files.map((file) => fs.writeFile(path.join(root, file), "inside")));
  const lstat = fs.lstat.bind(fs);
  const gates: Array<ReturnType<typeof createDeferred<void>>> = [];
  const failed = createDeferred();
  const error = new Error("inventory metadata unavailable");
  const controller = new AbortController();
  const abortError = new Error("manifest scan aborted");
  let releasing = false;
  let started = 0;
  vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
    if (String(args[0]).startsWith(root + path.sep)) {
      const first = started++ === 0;
      if (!releasing) {
        const gate = createDeferred();
        gates.push(gate);
        await gate.promise;
      }
      if (first) {
        failed.resolve();
        if (failure !== "caller abort") {
          throw error;
        }
      }
    }
    return await lstat(...args);
  });
  const opened = vi.spyOn(fs, "open");
  const params = {
    root,
    baseCommit: null,
    ...(walk ? {} : { includePaths: new Set(files) }),
    signal: controller.signal,
  };
  const scan = readActualWorkspaceManifest(params);
  let settled = false;
  void scan.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  try {
    await vi.waitFor(() => expect(gates).toHaveLength(admitted));
    if (failure !== "metadata error") {
      controller.abort(abortError);
    }
    gates[0]!.resolve();
    await failed.promise;
    expect(settled).toBe(false);
    expect(started).toBe(admitted);
    if (failure === "metadata error") {
      // Let the rejected operation reach the scan owner before the later cancellation.
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      controller.abort(abortError);
    }
  } finally {
    releasing = true;
    for (const gate of gates) {
      gate.resolve();
    }
    await Promise.allSettled([scan]);
  }
  await expect(scan).rejects.toBe(failure === "metadata error" ? error : abortError);
  expect(started).toBe(admitted);
  expect(opened).not.toHaveBeenCalled();
});

it("stops an admitted directory enumeration on caller cancellation", async () => {
  const root = await fs.realpath(tempDirs.make("workspace-inventory-directory-abort-"));
  const target = path.join(root, "directory");
  await fs.mkdir(target);
  await Promise.all(
    ["a.txt", "b.txt"].map((file) => fs.writeFile(path.join(target, file), "inside")),
  );
  const controller = new AbortController();
  const reason = new Error("directory scan aborted");
  const entered = createDeferred();
  const gate = createDeferred();
  const opendir = fs.opendir.bind(fs);
  let visited = 0;
  let closed = false;
  vi.spyOn(fs, "opendir").mockImplementation(async (...args) => {
    const directory = await opendir(...args);
    if (String(args[0]) === target) {
      const iterate = directory[Symbol.asyncIterator].bind(directory);
      vi.spyOn(directory, Symbol.asyncIterator).mockImplementation(async function* () {
        try {
          for await (const entry of iterate()) {
            visited++;
            entered.resolve();
            await gate.promise;
            yield entry;
          }
        } finally {
          closed = true;
        }
        return undefined;
      });
    }
    return directory;
  });
  const params = {
    root,
    baseCommit: null,
    includePaths: new Set(["directory"]),
    signal: controller.signal,
  };
  const scan = readActualWorkspaceManifest(params);
  const rejected = expect(scan).rejects.toBe(reason);
  try {
    await entered.promise;
    controller.abort(reason);
    gate.resolve();
    await rejected;
    expect(visited).toBe(1);
    expect(closed).toBe(true);
  } finally {
    gate.resolve();
    await Promise.allSettled([scan, rejected]);
  }
});

it("preserves bottom-up directory membership and canonical output across input orders", async () => {
  const root = await fs.realpath(tempDirs.make("workspace-inventory-membership-"));
  for (const file of [
    "cache/nested/node_modules/pkg/file.js",
    "mixed/child/keep.txt",
    "mixed/node_modules/pkg/file.js",
    "Zebra.txt",
    "älg.txt",
  ]) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), file);
  }
  await fs.mkdir(path.join(root, "preserved/node_modules"), { recursive: true });
  await fs.symlink("../outside", path.join(root, "escaping"));
  const included = [
    "cache",
    "cache/nested",
    "cache/nested/node_modules",
    "mixed",
    "mixed/child",
    "mixed/child/keep.txt",
    "mixed/node_modules",
    "preserved",
    "preserved/node_modules",
    "Zebra.txt",
    "älg.txt",
    "escaping",
    "absent",
  ];
  const capture = (paths: string[]) =>
    readActualWorkspaceManifestImpl({
      root,
      baseCommit: null,
      includePaths: new Set(paths),
      preserveDirectories: new Set(["preserved"]),
    });
  const first = await capture(included);
  const reversed = await capture(included.toReversed());
  expect(first.manifest.directories).toEqual(["mixed", "mixed/child", "preserved"]);
  expect(first.manifest.entries.map((entry) => entry.path).toSorted()).toEqual([
    "Zebra.txt",
    "mixed/child/keep.txt",
    "älg.txt",
  ]);
  expect(reversed).toEqual(first);
});

it("reserves aggregate inventory bytes even when every file hits the hash memo", async () => {
  const root = await fs.realpath(tempDirs.make("workspace-inventory-byte-budget-"));
  const memo = new Map<string, string>();
  const metrics = { contentHashCount: 0, contentHashDurationMs: 0, memoHitCount: 0 };
  for (const file of ["first.bin", "second.bin"]) {
    const target = path.join(root, file);
    await fs.writeFile(target, "");
    await fs.truncate(target, MAX_WORKSPACE_INVENTORY_TOTAL_BYTES / 2 + 1);
    memo.set(
      workspaceStatIdentity("gateway", await fs.stat(target, { bigint: true })),
      "a".repeat(64),
    );
  }
  await expect(
    withWorkspaceHashMemo(
      memo,
      () => readActualWorkspaceManifestImpl({ root, baseCommit: null }),
      metrics,
    ),
  ).rejects.toThrow("eligible byte limit");
  expect(metrics).toMatchObject({ contentHashCount: 0, memoHitCount: 1 });
});

it.each(["inventory", "fixed limit"] as const)(
  "preserves the %s diagnosis when a file grows during its read",
  async (mode) => {
    const root = await fs.realpath(tempDirs.make("workspace-inventory-growing-file-"));
    const target = path.join(root, "growing.txt");
    await fs.writeFile(target, "a");
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (String(args[0]) === target) {
        const read = handle.read.bind(handle);
        vi.spyOn(handle, "read").mockImplementationOnce(async (...readArgs) => {
          await fs.appendFile(target, "b");
          return await read(...readArgs);
        });
      }
      return handle;
    });
    if (mode === "inventory") {
      await expect(readActualWorkspaceManifestImpl({ root, baseCommit: null })).rejects.toThrow(
        "file changed while it was being read",
      );
    } else {
      await expect(readWorkspaceFileSnapshotWithLimit(target, 1, root)).resolves.toEqual({
        type: "unsupported",
      });
    }
  },
);
