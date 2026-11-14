import { createHook } from "node:async_hooks";
import { createHash } from "node:crypto";
import { addAbortListener } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { observeSettlement } from "../../agents/promise-settlement.test-support.js";
import {
  readActualWorkspaceManifestImpl,
  readWorkspaceFileContentsWithLimit,
  readWorkspaceFileSnapshotWithLimit,
} from "./workspace-actual-manifest.js";
import { withWorkspaceHashMemo, workspaceStatIdentity } from "./workspace-hash-memo.js";
import { MAX_WORKSPACE_INVENTORY_TOTAL_BYTES } from "./workspace-inventory-limits.js";
import { sha256, workspaceFile } from "./workspace-manifest-fixtures.test-support.js";
import { writeWorkspaceFiles } from "./workspace-sync-scripts.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

type InventoryOptions = Parameters<typeof readActualWorkspaceManifestImpl>[0];

async function inventoryFixture(count = 0) {
  const root = await fs.realpath(tempDirs.make("workspace-inventory-"));
  const files = Array.from({ length: count }, (_, index) => `file-${index}.txt`);
  await Promise.all(files.map((file) => fs.writeFile(path.join(root, file), "inside")));
  const capture = (options: Omit<InventoryOptions, "root" | "baseCommit"> = {}) =>
    readActualWorkspaceManifestImpl({ root, baseCommit: null, ...options });
  return { root, files, capture };
}

it.each(["before traversal", "during traversal", "root resolution", "safe-root setup"] as const)(
  "rejects an empty inventory aborted %s",
  async (phase) => {
    const { root, capture } = await inventoryFixture();
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
    const scan = capture({
      signal: controller.signal,
      ...(phase === "before traversal" ? { includePaths: new Set<string>() } : {}),
    });
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

it.for(["metadata", "walk metadata", "files"] as const)(
  "bounds pending promise resources while %s operations are blocked",
  async (phase, { signal }) => {
    const { root, files, capture } = await inventoryFixture(512);
    const gate = createDeferred();
    const allStarted = createDeferred();
    let started = 0;
    const pause = async (target: unknown) => {
      if (String(target).startsWith(root + path.sep)) {
        started++;
        if (started === 4) {
          allStarted.resolve();
        }
        await gate.promise;
      }
    };
    if (phase !== "files") {
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
    const scan = capture(phase === "walk metadata" ? {} : { includePaths: new Set(files) });
    const cancelWait = addAbortListener(signal, () => allStarted.reject(signal.reason));
    try {
      await Promise.race([allStarted.promise, scan]);
      expect(started).toBe(4);
      // Observe queued resources, not limiter internals: idle paths must not
      // each retain a promise graph while the active I/O is blocked.
      expect(pendingPromises.size).toBeLessThan(files.length);
    } finally {
      cancelWait[Symbol.dispose]();
      hook.disable();
      gate.resolve();
      await Promise.allSettled([scan]);
    }
    expect((await scan).manifest.entries).toHaveLength(files.length);
  },
);

const fileFailures = ["symlink replacement", "caller abort"] as const;
it.each(fileFailures)("drains admitted file reads after %s", async (failure) => {
  const { root, files, capture } = await inventoryFixture(9);
  const outside = await fs.realpath(tempDirs.make("workspace-inventory-outside-"));
  await fs.writeFile(path.join(outside, "target.txt"), "outside");
  const controller = new AbortController();
  const reason = new Error("manifest scan aborted");
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
  const scan = capture({ includePaths: new Set(files), signal: controller.signal });
  const settled = observeSettlement(scan);
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
    expect(settled()).toBe(false);
    expect(opened).toHaveBeenCalledTimes(4);
  } finally {
    releasing = true;
    for (const gate of gates) {
      gate.resolve();
    }
    await Promise.allSettled([scan]);
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
  "walk metadata error",
  "walk abort before metadata error",
] as const;
it.each(metadataFailures)("settles metadata after %s", async (failure) => {
  const walk = failure.startsWith("walk ");
  const metadataError = failure === "metadata error" || failure === "walk metadata error";
  const { root, files, capture } = await inventoryFixture(9);
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
  const scan = capture({
    ...(walk ? {} : { includePaths: new Set(files) }),
    signal: controller.signal,
  });
  const settled = observeSettlement(scan);
  try {
    await vi.waitFor(() => expect(gates).toHaveLength(4));
    if (!metadataError) {
      controller.abort(abortError);
    }
    gates[0]!.resolve();
    await failed.promise;
    expect(settled()).toBe(false);
    expect(started).toBe(4);
    if (metadataError) {
      // Let the rejected operation reach the scan owner before the later cancellation.
      await setImmediate();
      controller.abort(abortError);
    }
  } finally {
    releasing = true;
    for (const gate of gates) {
      gate.resolve();
    }
    await Promise.allSettled([scan]);
  }
  await expect(scan).rejects.toBe(metadataError ? error : abortError);
  expect(started).toBe(4);
  expect(opened).not.toHaveBeenCalled();
});

it("stops an admitted directory enumeration on caller cancellation", async () => {
  const { root, capture } = await inventoryFixture();
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
  const scan = capture({
    includePaths: new Set(["directory"]),
    signal: controller.signal,
  });
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
  const files = [
    "cache/nested/node_modules/pkg/file.js",
    "mixed/child/keep.txt",
    "mixed/node_modules/pkg/file.js",
    "Zebra.txt",
    "älg.txt",
  ];
  await writeWorkspaceFiles(root, Object.fromEntries(files.map((file) => [file, file])));
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
  const opened = vi.spyOn(fs, "opendir");
  const first = await capture(included);
  const reversed = await capture(included.toReversed());
  expect(first.manifest.directories).toEqual(["mixed", "mixed/child", "preserved"]);
  expect(first.manifest.entries.map((entry) => entry.path).toSorted()).toEqual([
    "Zebra.txt",
    "mixed/child/keep.txt",
    "älg.txt",
  ]);
  expect(reversed).toEqual(first);
  expect(opened.mock.calls.map(([directory]) => path.relative(root, String(directory)))).toEqual([
    "cache/nested",
    "cache",
    "cache/nested",
    "cache",
  ]);
});

it("reserves aggregate inventory bytes even when every file hits the hash memo", async () => {
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
  const { root, capture } = await inventoryFixture();
  const memo = new Map<string, string>();
  const metrics = { contentHashCount: 0, memoHitCount: 0 };
  for (const file of ["first.bin", "second.bin"]) {
    const target = path.join(root, file);
    await fs.writeFile(target, "");
    await fs.truncate(target, MAX_WORKSPACE_INVENTORY_TOTAL_BYTES / 2 + 1);
    memo.set(
      workspaceStatIdentity("gateway", await fs.stat(target, { bigint: true })),
      "a".repeat(64),
    );
  }
  await expect(withWorkspaceHashMemo(memo, () => capture(), metrics)).rejects.toThrow(
    "eligible byte limit",
  );
  expect(metrics).toMatchObject({ contentHashCount: 0, memoHitCount: 1 });
});

it("opens only changed file content while retaining fresh edits and deletions", async () => {
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
  const { root, files, capture } = await inventoryFixture(3);
  const memo = new Map<string, string>();
  const read = () => withWorkspaceHashMemo(memo, () => capture());
  const first = await read();
  const changed = path.join(root, files[1]!);
  const before = await fs.stat(changed);
  await fs.writeFile(changed, "edited");
  // Size and mtime alone cannot identify a file's contents.
  await fs.utimes(changed, before.atime, before.mtime);
  await fs.unlink(path.join(root, files[2]!));
  const opened = vi.spyOn(fs, "open");
  const next = await read();
  expect(next.manifestRef).not.toBe(first.manifestRef);
  expect(next.manifest.entries.map((entry) => entry.path)).toEqual(files.slice(0, 2));
  expect(next.manifest.entries[1]).toMatchObject({
    sha256: createHash("sha256").update("edited").digest("hex"),
  });
  expect(opened.mock.calls.some(([file]) => file === path.join(root, files[0]!))).toBe(false);
  expect(opened.mock.calls.some(([file]) => file === changed)).toBe(true);
});

it("bounds active fallback scratch across inventories and skips reads on memo hits", async () => {
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
  vi.stubEnv("FS_SAFE_NATIVE_MODE", "off");
  const fixtures = await Promise.all(
    [0, 1].map(async (owner) => {
      const { root, capture } = await inventoryFixture();
      const entries = await Promise.all(
        Array.from({ length: 32 }, async (_, index) => {
          const file = `file-${index}.bin`;
          const bytes = Buffer.alloc(
            index % 7 === 0 ? 270_001 + index : 17 + index,
            owner * 32 + index,
          );
          await fs.writeFile(path.join(root, file), bytes);
          return workspaceFile(file, bytes);
        }),
      );
      const memo = new Map<string, string>();
      return { root, entries, capture: () => withWorkspaceHashMemo(memo, () => capture()) };
    }),
  );
  const activeBuffers = new Set<Buffer>();
  let readCount = 0;
  const open = fs.open.bind(fs);
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    const fixture = fixtures.find(({ root }) => String(args[0]).startsWith(root + path.sep));
    if (fixture) {
      const read = handle.read.bind(handle);
      vi.spyOn(handle, "read").mockImplementation(async (...readArgs) => {
        const buffer = readArgs[0];
        if (!Buffer.isBuffer(buffer)) {
          throw new Error("Expected a caller-owned inventory buffer");
        }
        expect(
          [...activeBuffers].every(
            (active) =>
              active.buffer !== buffer.buffer ||
              active.byteOffset + active.byteLength <= buffer.byteOffset ||
              buffer.byteOffset + buffer.byteLength <= active.byteOffset,
          ),
        ).toBe(true);
        activeBuffers.add(buffer);
        expect(
          [...activeBuffers].reduce((bytes, active) => bytes + active.byteLength, 0),
        ).toBeLessThanOrEqual(2 * 1024 * 1024);
        readCount++;
        try {
          return await read(...readArgs);
        } finally {
          activeBuffers.delete(buffer);
        }
      });
    }
    return handle;
  });
  const capture = () => Promise.all(fixtures.map((fixture) => fixture.capture()));
  const manifests = await capture();
  for (const [index, fixture] of fixtures.entries()) {
    expect(manifests[index]!.manifest.entries).toEqual(
      fixture.entries.toSorted((left, right) => left.path.localeCompare(right.path)),
    );
  }
  const coldReadCount = readCount;
  expect(coldReadCount).toBeGreaterThan(0);
  expect(await capture()).toEqual(manifests);
  expect(readCount).toBe(coldReadCount);
});

it.each(["", "\u0000binary\u00ff"])(
  "returns independently owned captured bytes for %j",
  async (content) => {
    const root = tempDirs.make("workspace-captured-bytes-");
    const target = path.join(root, "content.bin");
    const expected = Buffer.from(content);
    await fs.writeFile(target, expected);
    const [first, second] = await Promise.all([
      readWorkspaceFileContentsWithLimit(target, expected.length),
      readWorkspaceFileContentsWithLimit(target, expected.length),
    ]);
    expect(first).toMatchObject({
      type: "file",
      size: expected.length,
      sha256: sha256(expected),
    });
    expect(second).toEqual(first);
    if (first.type !== "file" || second.type !== "file") {
      throw new Error("Supported file did not return its captured contents");
    }
    expect(first.content).toEqual(expected);
    first.content.fill(0x58);
    expect(second.content).toEqual(expected);
  },
);

it.each(["inventory", "fixed limit", "captured contents"] as const)(
  "preserves the %s diagnosis when a file grows after its opened size is captured",
  async (mode) => {
    const { root, capture } = await inventoryFixture();
    const target = path.join(root, "growing.txt");
    await fs.writeFile(target, "a");
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (String(args[0]) === target) {
        const stat = handle.stat.bind(handle);
        vi.spyOn(handle, "stat").mockImplementationOnce(async (...statArgs) => {
          const opened = await stat(...statArgs);
          await fs.appendFile(target, "b");
          return opened;
        });
      }
      return handle;
    });
    if (mode === "inventory") {
      await expect(capture()).rejects.toThrow("file changed while it was being read");
    } else {
      const snapshot =
        mode === "captured contents"
          ? readWorkspaceFileContentsWithLimit(target, 1)
          : readWorkspaceFileSnapshotWithLimit(target, 1, root);
      await expect(snapshot).resolves.toEqual({
        type: "unsupported",
      });
    }
  },
);
