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

it("keeps root and include writers outside cleanup and closes captured source admission", async () => {
  const root = path.join(fixture.root, "root.json");
  const include = path.join(fixture.root, "plugins.json");
  await fs.writeFile(root, '{"plugins":{"$include":"plugins.json"}}');
  await fs.writeFile(include, '{"load":{"paths":[]}}');
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
    lateWrite = afterScope.promise.then(() =>
      withConfigWriteLock(include, async () => fs.writeFile(include, "late")),
    );
    void lateWrite.catch(() => {});
    await expect(
      withConfigWriteLock(include, async () => fs.writeFile(include, "nested")),
    ).rejects.toThrow("not allowed inside a config source scope");
    expect(() => markActiveConfigMutationPath(root)).toThrow(
      "not allowed inside a config source scope",
    );
    entered.resolve();
    await finish.promise;
    assertCurrent();
    events.push("cleanup settled");
    expect(await fs.readFile(include, "utf8")).toBe('{"load":{"paths":[]}}');
  });
  const writers: Promise<unknown>[] = [];
  try {
    await entered.promise;
    for (const target of [root, include]) {
      writers.push(
        withConfigWriteLock(target, async () => {
          events.push(path.basename(target));
          await fs.writeFile(target, "changed");
        }),
      );
    }
  } finally {
    finish.resolve();
    await scope;
    await Promise.all(writers);
    afterScope.resolve();
  }
  expect(events[0]).toBe("cleanup settled");
  expect(events.slice(1).toSorted()).toEqual(["plugins.json", "root.json"]);
  expect(captured).toThrow("ownership has closed");
  expect(includeGuard).toThrow("no live source ownership");
  await expect(lateWrite).rejects.toThrow("not allowed inside a config source scope");
});

it("releases partial source locks before waiting on an inverted include writer", async () => {
  const root = path.join(fixture.root, "root.json");
  const first = path.join(fixture.root, "a.json");
  const second = path.join(fixture.root, "b.json");
  await Promise.all([root, first, second].map((filename) => fs.writeFile(filename, "{}")));
  const options = {
    retries: { retries: 0, factor: 1, minTimeout: 0, maxTimeout: 0 },
    stale: 30_000,
  };
  // This peer participates through the sidecar, as another config process would.
  const peer = await fileLocks.acquireFileLock(second, options);
  const firstAcquired = createDeferred();
  const acquire = fileLocks.acquireFileLock;
  vi.spyOn(fileLocks, "acquireFileLock").mockImplementation(async (filename, lockOptions) => {
    const lock = await acquire(filename, lockOptions);
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
    writer = withConfigWriteLock(first, async () => {
      events.push("peer writer");
      await fs.writeFile(first, "updated include");
    });
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
  const lower = path.join(fixture.root, "config.json");
  const upper = path.join(fixture.root, "CONFIG.json");
  const createSource = async (filename: string, targetName: string) => {
    if (kind === "regular") {
      await fs.writeFile(filename, "{}");
    } else {
      await fs.writeFile(path.join(fixture.root, targetName), "{}");
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
  const options = {
    retries: { retries: 0, factor: 1, minTimeout: 0, maxTimeout: 0 },
    stale: 30_000,
  };
  const attempted = new Set<string>();
  const acquire = fileLocks.acquireFileLock;
  const acquisition = vi
    .spyOn(fileLocks, "acquireFileLock")
    .mockImplementation(async (filename, lockOptions) => {
      if (attempted.has(filename)) {
        throw new Error(`Uncontended source acquisition repeated: ${filename}`);
      }
      attempted.add(filename);
      return await acquire(filename, lockOptions);
    });
  await withConfigSourceLocks(sources, async (assertCurrent) => {
    acquisition.mockRestore();
    assertCurrent();
    for (const source of sources) {
      await expect(fileLocks.withFileLock(source, options, async () => {})).rejects.toMatchObject({
        code: fileLocks.FILE_LOCK_TIMEOUT_ERROR_CODE,
      });
    }
  });
  for (const source of sources) {
    await fileLocks.withFileLock(source, options, async () => {});
  }
});

it("keeps caller revocation live while releasing its source locks", async () => {
  const root = path.join(fixture.root, "root.json");
  await fs.writeFile(root, "{}");
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
  await withConfigWriteLock(root, async () => fs.writeFile(root, "replacement"));
  expect(await fs.readFile(root, "utf8")).toBe("replacement");
});

it("refuses a parent alias redirected after config source ownership begins", async () => {
  const original = path.join(fixture.root, "original");
  const replacement = path.join(fixture.root, "replacement");
  const alias = path.join(fixture.root, "active");
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
  await withConfigWriteLock(path.join(alias, "config.json"), async () => {
    await fs.writeFile(path.join(alias, "config.json"), "later writer");
  });
  expect(await fs.readFile(path.join(original, "config.json"), "utf8")).toBe("original");
  expect(await fs.readFile(path.join(replacement, "config.json"), "utf8")).toBe("later writer");
});
