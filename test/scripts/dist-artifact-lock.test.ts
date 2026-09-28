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
beforeEach(() => {
  vi.mocked(fileLock.acquireFileLock).mockReset().mockImplementation(actual.acquireFileLock);
});
const fixture = createFixtureLifetime();
afterEach(async () => {
  vi.restoreAllMocks();
  await fixture.cleanup();
});
const createRoot = () => fs.realpathSync(fixture.createTempDir("openclaw-lock-cancel-"));

it("cancels an already contended same-process waiter without disturbing the owner", async () => {
  const root = createRoot();
  const enteredOwner = createDeferred<void>();
  const releaseOwner = createDeferred<void>();
  const owner = withDistArtifactOwnership(root, async () => {
    enteredOwner.resolve();
    await releaseOwner.promise;
  });
  await enteredOwner.promise;
  const ownerPath = path.join(resolveDistArtifactLockPath(root), "owner.json");
  const originalOwner = fs.readFileSync(ownerPath, "utf8");
  const attempted = createDeferred<void>();
  const acquire = actual.acquireFileLock;
  vi.mocked(fileLock.acquireFileLock).mockImplementation(async (...args) => {
    try {
      return await acquire(...args);
    } catch (error) {
      // Observe a real completed contention attempt, not merely waiter startup.
      attempted.resolve();
      throw error;
    }
  });
  const controller = new AbortController();
  const callback = vi.fn();
  const waiter = withDistArtifactOwnership(root, callback, controller.signal).then(
    () => undefined,
    (error: unknown) => error,
  );
  try {
    await attempted.promise;
    controller.abort();
    expect(await waiter).toBe(controller.signal.reason);
    expect(callback).not.toHaveBeenCalled();
    expect(fs.readFileSync(ownerPath, "utf8")).toBe(originalOwner);
  } finally {
    controller.abort();
    releaseOwner.resolve();
    await Promise.all([owner, waiter]);
  }
  await withDistArtifactOwnership(root, async () => {});
  expect(fs.existsSync(ownerPath)).toBe(false);
});

it.for([
  { direct: false, fails: false },
  { direct: false, fails: true },
  { direct: true, fails: false },
  { direct: true, fails: true },
])(
  "joins acquisition-race release before rejecting (direct=$direct, release fails=$fails)",
  async ({ direct, fails }) => {
    const root = createRoot();
    const entered = createDeferred<void>();
    const acquired = createDeferred<fileLock.FileLockHandle>();
    const releasing = createDeferred<void>();
    const released = createDeferred<void>();
    const failure = new Error("release failed");
    const controller = new AbortController();
    const callback = vi.fn();
    const release = vi.fn(async () => {
      releasing.resolve();
      await released.promise;
      if (fails) throw failure;
    });
    vi.mocked(fileLock.acquireFileLock).mockImplementation(async () => {
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
  const root = createRoot();
  const controller = new AbortController();
  const failure = new Error("acquisition cleanup failed");
  vi.mocked(fileLock.acquireFileLock).mockImplementation(async () => {
    controller.abort();
    throw failure;
  });
  const callback = vi.fn();
  await expect(withDistArtifactOwnership(root, callback, controller.signal)).rejects.toMatchObject({
    cause: failure,
    message: expect.stringContaining("filesystem error"),
  });
  expect(callback).not.toHaveBeenCalled();
});

it("does not acquire for an already cancelled waiter", async () => {
  const acquire = vi.mocked(fileLock.acquireFileLock);
  const signal = AbortSignal.abort();
  await expect(withDistArtifactOwnership(createRoot(), vi.fn(), signal)).rejects.toBe(
    signal.reason,
  );
  expect(acquire).not.toHaveBeenCalled();
});
