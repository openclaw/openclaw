import fs from "node:fs";
import path from "node:path";
import { createRetainedOperation } from "@openclaw/worker-runtime/lifecycle";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  registerSignalExitBarrier,
  waitForSignalExitBarriers,
} from "../cli/signal-exit-barrier.js";
import {
  adoptPreparedLocation,
  registerRetainedSnapshotTempDirectory,
  retainSnapshotTempDirectory,
  cleanupSnapshotOperations,
} from "./sqlite-readonly-location-cleanup.js";
import { createReadBarrier, observeSettlement } from "./sqlite-readonly.test-support.js";
import { prepareSingleFlightSqliteSnapshot } from "./sqlite-snapshot-single-flight.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });
});

function fixture(strict = false, onCleanupFailure?: () => void) {
  const parent = tempDirs.make("sqlite-cleanup-owner-");
  const ownedRoot = path.join(parent, "owned");
  const child = path.join(ownedRoot, "snapshot-child");
  fs.mkdirSync(child, { recursive: true });
  const location = path.join(child, "database.sqlite");
  const sibling = path.join(parent, "retained.txt");
  fs.writeFileSync(location, "private synthetic snapshot");
  fs.writeFileSync(sibling, "not owned by snapshot");
  return {
    ownedRoot,
    sibling,
    location,
    prepared: adoptPreparedLocation(location, ownedRoot, strict, onCleanupFailure),
  };
}

const busyError = () => Object.assign(new Error("snapshot busy"), { code: "EBUSY" });

it("retains bytes after a serviced cleanup failure and retries the same directory owner", () => {
  const { ownedRoot: directory, location, prepared } = fixture();
  const retirements: ReturnType<typeof createRetainedOperation<void>>[] = [];
  registerRetainedSnapshotTempDirectory(directory, () => {
    const retirement = createRetainedOperation<void>(() => {});
    retirements.push(retirement);
    return retirement.operation;
  });
  const first = prepared.startCleanup();
  expect(first.read()).toEqual({ status: "pending" });
  expect(fs.readFileSync(location, "utf8")).toBe("private synthetic snapshot");
  retirements[0]!.reject(new Error("native retirement not acknowledged"));
  first.service();
  expect(first.read()).toEqual({ status: "fulfilled", value: false });
  expect(fs.existsSync(location)).toBe(true);
  expect(() => retainSnapshotTempDirectory(directory)).toThrow("retirement has started");

  const second = prepared.startCleanup();
  expect(second.read()).toEqual({ status: "pending" });
  fs.rmSync(directory, { recursive: true });
  retirements[1]!.resolve(undefined);
  second.service();
  expect(second.read()).toEqual({ status: "fulfilled", value: true });
  expect(fs.existsSync(directory)).toBe(false);
});

it.each([false, true])(
  "removes symlink cycles without enumerating host files (async: %s)",
  async (asynchronous) => {
    const { ownedRoot, prepared } = fixture();
    const host = tempDirs.make("sqlite-snapshot-linked-host-");
    const sentinel = path.join(host, "host-package.txt");
    const modules = path.join(ownedRoot, "plugin-captures", "generation", "node_modules");
    fs.mkdirSync(modules, { recursive: true });
    fs.writeFileSync(path.join(ownedRoot, "owner.sqlite"), "");
    fs.writeFileSync(sentinel, "host bytes");
    fs.symlinkSync(host, path.join(modules, "openclaw"), "junction");
    fs.symlinkSync(ownedRoot, path.join(host, "captures"), "junction");
    const reads = vi.spyOn(fs, "readdirSync");

    expect(asynchronous ? await prepared.cleanupAsync() : prepared.cleanup()).toBe(true);
    expect(fs.existsSync(ownedRoot)).toBe(false);
    expect(fs.readFileSync(sentinel, "utf8")).toBe("host bytes");
    const enumeratedNames = reads.mock.results.flatMap((result) =>
      result.type === "return" ? result.value.map((entry) => entry.name.toString()) : [],
    );
    expect(enumeratedNames).not.toContain("host-package.txt");
  },
);

it.each([false, true])(
  "retains cancelled orphan cleanup for retry (strict: %s)",
  async (strict) => {
    const { ownedRoot, sibling, prepared } = fixture(strict);
    const { resume, hold } = createReadBarrier();
    const tracked: Promise<unknown>[] = [];
    const controller = new AbortController();
    const pending = prepareSingleFlightSqliteSnapshot(
      path.join(ownedRoot, "source.sqlite"),
      "orphan-retry",
      () => hold(prepared),
      controller.signal,
      { trackProducer: (producer) => tracked.push(producer) },
    );
    controller.abort(new Error("cancelled before publication"));
    await expect(pending).rejects.toThrow("cancelled before publication");
    const remove = fs.promises.rm;
    try {
      using _ = vi.spyOn(fs.promises, "rm").mockImplementation(async (target, options) => {
        if (String(target) === ownedRoot) {
          throw busyError();
        }
        return remove(target, options);
      });
      resume.resolve();
      await expect(tracked[0]).rejects.toThrow(/cleanup/);
      expect(fs.existsSync(prepared.location)).toBe(true);
    } finally {
      await cleanupSnapshotOperations();
    }
    expect(fs.existsSync(ownedRoot)).toBe(false);
    expect(fs.readFileSync(sibling, "utf8")).toBe("not owned by snapshot");
  },
);
it("keeps a best-effort lease read successful when shared removal stays busy", async () => {
  const report = vi.fn();
  const { ownedRoot, prepared } = fixture(false, report);
  const snapshot = await prepareSingleFlightSqliteSnapshot(
    path.join(ownedRoot, "source.sqlite"),
    "best-effort-lease",
    async () => prepared,
  );
  {
    using _ = vi.spyOn(fs.promises, "rm").mockRejectedValueOnce(busyError());
    expect(await snapshot.cleanupAsync()).toBe(false);
    expect(snapshot.cleanup()).toBe(false);
    expect(report).toHaveBeenCalledOnce();
    expect(fs.existsSync(prepared.location)).toBe(true);
  }
  await cleanupSnapshotOperations();
  expect(fs.existsSync(ownedRoot)).toBe(false);
});

it.each([false, true])(
  "retains all snapshot tokens when data removal fails (async: %s)",
  async (asynchronous) => {
    const { ownedRoot, location, prepared } = fixture();
    const tokens = [ownedRoot, path.dirname(location)].map((directory) =>
      path.join(directory, "owner.sqlite"),
    );
    for (const token of tokens) {
      fs.writeFileSync(token, "");
    }
    const remove = fs.rmSync;
    const failDataRemoval: typeof fs.rmSync = (target, options) => {
      if (String(target) === ownedRoot) {
        // A recursive rm may unlink metadata before reaching a busy data file.
        for (const token of tokens) {
          remove(token, { force: true });
        }
      }
      if (String(target) === ownedRoot || String(target) === location) {
        throw Object.assign(new Error("snapshot data still open"), { code: "EBUSY" });
      }
      remove(target, options);
    };
    {
      using _ = asynchronous
        ? vi
            .spyOn(fs.promises, "rm")
            .mockImplementation(async (target, options) => failDataRemoval(target, options))
        : vi.spyOn(fs, "rmSync").mockImplementation(failDataRemoval);
      expect(asynchronous ? await prepared.cleanupAsync() : prepared.cleanup()).toBe(false);
      expect(fs.existsSync(location)).toBe(true);
      expect(tokens.every((token) => fs.existsSync(token))).toBe(true);
    }
    expect(await prepared.cleanupAsync()).toBe(true);
    expect(fs.existsSync(ownedRoot)).toBe(false);
  },
);

it("keeps the private read view until other shutdown owners have drained", async () => {
  const { ownedRoot, location } = fixture();
  const { entered, resume, hold } = createReadBarrier();
  const unregister = registerSignalExitBarrier(async () => {
    await hold(undefined);
    expect(fs.readFileSync(location, "utf8")).toBe("private synthetic snapshot");
  });
  const removal = vi.spyOn(fs.promises, "rm");
  const shutdown = waitForSignalExitBarriers();
  try {
    await entered.promise;
    expect(removal).not.toHaveBeenCalled();
  } finally {
    resume.resolve();
    try {
      await shutdown;
    } finally {
      unregister();
    }
  }
  expect(fs.existsSync(ownedRoot)).toBe(false);
});

it.each([false, true])(
  "joins async removal and refuses racing sync cleanup (strict: %s)",
  async (strict) => {
    const report = vi.fn();
    const { ownedRoot, sibling, prepared } = fixture(strict, report);
    const { entered, resume, hold } = createReadBarrier();
    const remove = fs.promises.rm;
    const removal = vi.spyOn(fs.promises, "rm").mockImplementation(async (...args) => {
      await hold(undefined);
      await remove(...args);
    });
    const synchronousRemoval = vi.spyOn(fs, "rmSync");
    const first = prepared.cleanupAsync();
    const second = prepared.cleanupAsync();
    const observation = observeSettlement(first);
    try {
      await entered.promise;
      expect(observation.settled).toBe(false);
      expect(fs.existsSync(ownedRoot)).toBe(true);
      if (strict) {
        expect(() => prepared.cleanup()).toThrow("snapshot cleanup failed");
      } else {
        expect(prepared.cleanup()).toBe(false);
      }
      expect(synchronousRemoval).not.toHaveBeenCalled();
      expect(removal).toHaveBeenCalledOnce();
      expect(report).not.toHaveBeenCalled();
    } finally {
      resume.resolve();
      await Promise.allSettled([first, second]);
    }
    expect([await first, await second]).toEqual([true, true]);
    expect(fs.existsSync(ownedRoot)).toBe(false);
    expect(fs.readFileSync(sibling, "utf8")).toBe("not owned by snapshot");
    expect([prepared.cleanup(), await prepared.cleanupAsync()]).toEqual([true, true]);
    expect(removal).toHaveBeenCalledOnce();
    expect(synchronousRemoval).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
  },
);

it.each([
  { strict: false, retry: "sync" },
  { strict: true, retry: "async" },
] as const)(
  "keeps failed async removal retryable with $retry cleanup (strict: $strict)",
  async ({ strict, retry }) => {
    const report = vi.fn();
    const { ownedRoot, prepared } = fixture(strict, report);
    const remove = vi.spyOn(fs.promises, "rm").mockRejectedValueOnce(busyError());
    const first = prepared.cleanupAsync();
    if (strict) {
      await expect(first).rejects.toThrow("snapshot cleanup failed");
    } else {
      expect(await first).toBe(false);
    }
    expect(fs.existsSync(ownedRoot)).toBe(true);
    expect(retry === "async" ? await prepared.cleanupAsync() : prepared.cleanup()).toBe(true);
    expect(fs.existsSync(ownedRoot)).toBe(false);
    expect(remove).toHaveBeenCalledTimes(retry === "async" ? 2 : 1);
    expect(await prepared.cleanupAsync()).toBe(true);
    expect(report).toHaveBeenCalledTimes(strict ? 0 : 1);
  },
);
