import fs from "node:fs";
import path from "node:path";
import * as fileLock from "@openclaw/fs-safe/file-lock";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  acquireDistArtifactOwnership,
  resolveDistArtifactLockPath,
  withDistArtifactOwnership,
} from "../../scripts/lib/dist-artifact-lock.mts";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import { createDeferred } from "../helpers/promise.js";

vi.mock("@openclaw/fs-safe/file-lock", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/fs-safe/file-lock")>()),
  acquireFileLock: vi.fn(),
}));
const actual = await vi.importActual<typeof import("@openclaw/fs-safe/file-lock")>(
  "@openclaw/fs-safe/file-lock",
);
const acquire = vi.mocked(fileLock.acquireFileLock);
const callback = vi.fn();
let root: string;
let ownerPath: string;
let controller: AbortController;
beforeEach(() => {
  acquire.mockReset().mockImplementation(actual.acquireFileLock);
  callback.mockReset();
  root = fs.realpathSync(fixture.createTempDir("openclaw-lock-cancel-"));
  // Keep checkout discovery from selecting an ancestor of the temporary fixture.
  fs.mkdirSync(path.join(root, ".git"));
  ownerPath = path.join(resolveDistArtifactLockPath(root), "owner.json");
  controller = new AbortController();
});
const fixture = createFixtureLifetime();
afterEach(async () => {
  vi.restoreAllMocks();
  await fixture.cleanup();
});
const readOwner = () => fs.readFileSync(ownerPath, "utf8");

it("cancels an already contended same-process waiter without disturbing the owner", async () => {
  const enteredOwner = createDeferred();
  const releaseOwner = createDeferred();
  const owner = withDistArtifactOwnership(root, async () => {
    enteredOwner.resolve();
    await releaseOwner.promise;
  });
  await enteredOwner.promise;
  const originalOwner = readOwner();
  const attempted = createDeferred();
  acquire.mockImplementation(async (...args) => {
    try {
      return await actual.acquireFileLock(...args);
    } catch (error) {
      // Observe a real completed contention attempt, not merely waiter startup.
      attempted.resolve();
      throw error;
    }
  });
  const waiter = withDistArtifactOwnership(root, callback, controller.signal).catch(
    (error: unknown) => error,
  );
  try {
    await attempted.promise;
    controller.abort();
    expect(await waiter).toBe(controller.signal.reason);
    expect(callback).not.toHaveBeenCalled();
    expect(readOwner()).toBe(originalOwner);
  } finally {
    controller.abort();
    releaseOwner.resolve();
    await Promise.all([owner, waiter]);
  }
  await withDistArtifactOwnership(root, async () => {});
  expect(fs.existsSync(ownerPath)).toBe(false);
});

it.for([
  { direct: false, fails: true },
  { direct: true, fails: false },
])(
  "joins acquisition-race release before rejecting (direct=$direct, release fails=$fails)",
  async ({ direct, fails }) => {
    const entered = createDeferred();
    const acquired = createDeferred<fileLock.FileLockHandle>();
    const releasing = createDeferred();
    const released = createDeferred();
    const failure = new Error("release failed");
    const release = vi.fn(async () => {
      releasing.resolve();
      await released.promise;
      if (fails) {
        throw failure;
      }
    });
    acquire.mockImplementation(async () => {
      entered.resolve();
      return await acquired.promise;
    });
    let settled = false;
    const waiter = (
      direct
        ? acquireDistArtifactOwnership(root, true, controller.signal)
        : withDistArtifactOwnership(root, callback, controller.signal)
    )
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });
    await entered.promise;
    controller.abort();
    acquired.resolve({
      lockPath: resolveDistArtifactLockPath(root),
      normalizedTargetPath: root,
      verifyStillHeld: async () => true,
      release,
      [Symbol.asyncDispose]: release,
    });
    await releasing.promise;
    expect(callback).not.toHaveBeenCalled();
    expect(settled).toBe(false);
    released.resolve();
    expect(await waiter).toBe(fails ? failure : controller.signal.reason);
    expect(release).toHaveBeenCalledOnce();
  },
);

it("preserves an acquisition cleanup failure racing cancellation", async () => {
  const failure = new Error("acquisition cleanup failed");
  acquire.mockImplementation(async () => {
    controller.abort();
    throw failure;
  });
  await expect(withDistArtifactOwnership(root, callback, controller.signal)).rejects.toMatchObject({
    cause: failure,
    message: expect.stringContaining("filesystem error"),
  });
  expect(callback).not.toHaveBeenCalled();
});

it("does not acquire for an already cancelled waiter", async () => {
  const signal = AbortSignal.abort();
  await expect(withDistArtifactOwnership(root, callback, signal)).rejects.toBe(signal.reason);
  expect(acquire).not.toHaveBeenCalled();
});

it("keeps the published two-argument wait inside one native acquisition", async () => {
  const failure = Object.assign(new Error("native timeout"), { code: "file_lock_timeout" });
  acquire.mockRejectedValue(failure);
  await expect(withDistArtifactOwnership(root, callback)).rejects.toMatchObject({
    cause: failure,
  });
  expect(acquire).toHaveBeenCalledOnce();
  expect(acquire.mock.calls[0]?.[1]?.timeoutMs).toBe(Number.POSITIVE_INFINITY);
});
