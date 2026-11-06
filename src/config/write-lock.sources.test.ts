import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { hasErrnoCode } from "../infra/errno.js";
import * as fileLocks from "../plugin-sdk/file-lock.js";
import {
  captureConfigWriteLockGuard,
  markActiveConfigMutationPath,
  withConfigSourceLocks,
  withConfigWriteLock,
} from "./write-lock.js";

const fixture = vi.hoisted(() => ({ root: "" }));
vi.mock("../shared/pid-alive.js", async (original) => ({
  ...(await original<typeof import("../shared/pid-alive.js")>()),
  isPidDefinitelyDead: () => false,
  getFileLockProcessStartTime: () => 123,
}));
vi.mock("../infra/tmp-openclaw-dir.js", () => ({
  DEFAULT_POSIX_TMP_ROOT: "/tmp/openclaw",
  resolvePreferredOpenClawTmpDir: () => fixture.root,
}));

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await fileLocks.drainFileLockStateForTest();
    vi.restoreAllMocks();
    cleanup();
  }),
);

beforeEach(() => {
  fixture.root = dirs.make("config-source-locks-");
  fileLocks.resetFileLockStateForTest();
});

const sourcePath = (name: string) => path.join(fixture.root, name);
async function createSourceFile(name: string, content = "{}") {
  const filename = sourcePath(name);
  await fs.writeFile(filename, content);
  return filename;
}
const writeLocked = (filename: string, content: string, onWrite?: () => void) =>
  withConfigWriteLock(filename, async () => {
    onWrite?.();
    await fs.writeFile(filename, content);
  });
const lockOptions = {
  retries: { retries: 0, factor: 1, minTimeout: 0, maxTimeout: 0 },
  stale: 30_000,
};
const probeLock = (filename: string) =>
  fileLocks.withFileLock(filename, lockOptions, async () => {});
const sourceWriteError = "not allowed inside a config source scope";

it("keeps root and include writers outside cleanup and closes captured source admission", async () => {
  const root = await createSourceFile("root.json");
  const include = await createSourceFile("plugins.json", "original include");
  const entered = createDeferred();
  const finish = createDeferred();
  const afterScope = createDeferred();
  const events: string[] = [];
  let captured: (() => void) | undefined;
  let includeGuard: (() => void) | undefined;
  let lateWrite: Promise<unknown> | undefined;
  const scope = withConfigSourceLocks([root, include], async (assertCurrent) => {
    captured = assertCurrent;
    includeGuard = captureConfigWriteLockGuard(include);
    lateWrite = afterScope.promise.then(() => writeLocked(include, "late"));
    void lateWrite.catch(() => {});
    await expect(writeLocked(include, "nested")).rejects.toThrow(sourceWriteError);
    expect(() => markActiveConfigMutationPath(root)).toThrow(sourceWriteError);
    entered.resolve();
    await finish.promise;
    assertCurrent();
    events.push("cleanup settled");
    expect(await fs.readFile(include, "utf8")).toBe("original include");
  });
  await entered.promise;
  const writers = [root, include].map((target) =>
    writeLocked(target, "changed", () => events.push(path.basename(target))),
  );
  finish.resolve();
  await scope;
  await Promise.all(writers);
  afterScope.resolve();
  expect(events[0]).toBe("cleanup settled");
  expect(events.slice(1).toSorted()).toEqual(["plugins.json", "root.json"]);
  expect(captured).toThrow("ownership has closed");
  expect(includeGuard).toThrow("no live source ownership");
  await expect(lateWrite).rejects.toThrow(sourceWriteError);
});

it("releases partial source locks before waiting on an inverted include writer", async () => {
  const [root, first, second] = await Promise.all([
    createSourceFile("root.json"),
    createSourceFile("a.json"),
    createSourceFile("b.json"),
  ]);
  // This peer participates through the sidecar, as another config process would.
  const peer = await fileLocks.acquireFileLock(second, lockOptions);
  const firstAcquired = createDeferred();
  const acquire = fileLocks.acquireFileLock;
  vi.spyOn(fileLocks, "acquireFileLock").mockImplementation(async (filename, options) => {
    const lock = await acquire(filename, options);
    if (filename === first) {
      firstAcquired.resolve();
    }
    return lock;
  });
  const events: string[] = [];
  const source = withConfigSourceLocks([root, first, second], async () => {
    events.push("source");
    expect(await fs.readFile(first, "utf8")).toBe("updated include");
  });
  let writer: Promise<void> | undefined;
  let released = false;
  try {
    await firstAcquired.promise;
    writer = writeLocked(first, "updated include", () => events.push("peer writer"));
    await writer;
    await peer.release();
    released = true;
    await source;
  } finally {
    if (!released) {
      await peer.release();
    }
    await Promise.allSettled([source, ...(writer ? [writer] : [])]);
  }
  expect(events).toEqual(["peer writer", "source"]);
});

it.each(["regular", "symlink"])("locks every case spelling of %s config sources", async (kind) => {
  const lower = sourcePath("config.json");
  const upper = sourcePath("CONFIG.json");
  const createSource = async (filename: string, targetName: string) => {
    await fs.writeFile(kind === "regular" ? filename : sourcePath(targetName), "{}");
    if (kind === "symlink") {
      await fs.symlink(targetName, filename);
    }
  };
  await createSource(lower, "lower-target.json");
  try {
    await fs.lstat(upper);
  } catch (error) {
    if (!hasErrnoCode(error, "ENOENT")) {
      throw error;
    }
    await createSource(upper, "upper-target.json");
  }
  const sources = [...new Set([lower, upper, await fs.realpath(lower), await fs.realpath(upper)])];
  const attempted = new Set<string>();
  const acquire = fileLocks.acquireFileLock;
  const acquisition = vi
    .spyOn(fileLocks, "acquireFileLock")
    .mockImplementation(async (filename, options) => {
      expect(attempted.has(filename)).toBe(false);
      attempted.add(filename);
      return await acquire(filename, options);
    });
  await withConfigSourceLocks(sources, async (assertCurrent) => {
    acquisition.mockRestore();
    assertCurrent();
    for (const source of sources) {
      await expect(probeLock(source)).rejects.toMatchObject({
        code: fileLocks.FILE_LOCK_TIMEOUT_ERROR_CODE,
      });
    }
  });
  for (const source of sources) {
    await probeLock(source);
  }
});

it("keeps caller revocation live while releasing its source locks", async () => {
  const root = await createSourceFile("root.json");
  const refused = new Error("plugin cleanup owner revoked");
  let current = true;
  await expect(
    withConfigSourceLocks(
      [root],
      async (assertCurrent) => {
        current = false;
        assertCurrent();
      },
      undefined,
      () => {
        if (!current) {
          throw refused;
        }
      },
    ),
  ).rejects.toBe(refused);
  await writeLocked(root, "replacement");
  expect(await fs.readFile(root, "utf8")).toBe("replacement");
});

it("refuses a parent alias redirected after config source ownership begins", async () => {
  const original = sourcePath("original");
  const replacement = sourcePath("replacement");
  const alias = sourcePath("active");
  await Promise.all([original, replacement].map((directory) => fs.mkdir(directory)));
  await fs.writeFile(path.join(original, "config.json"), "original");
  await fs.writeFile(path.join(replacement, "config.json"), "replacement");
  await fs.symlink(original, alias, process.platform === "win32" ? "junction" : "dir");
  await expect(
    withConfigSourceLocks([path.join(alias, "config.json")], async (assertCurrent) => {
      await fs.unlink(alias);
      await fs.symlink(replacement, alias, process.platform === "win32" ? "junction" : "dir");
      assertCurrent();
    }),
  ).rejects.toMatchObject({ code: "path-mismatch" });
  await writeLocked(path.join(alias, "config.json"), "later writer");
  expect(
    await Promise.all(
      [original, replacement].map((dir) => fs.readFile(path.join(dir, "config.json"), "utf8")),
    ),
  ).toEqual(["original", "later writer"]);
});
