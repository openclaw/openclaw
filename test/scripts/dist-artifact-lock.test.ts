import fs from "node:fs";
import path from "node:path";
import * as fileLock from "@openclaw/fs-safe/file-lock";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  acquireDistArtifactOwnership,
  resolveDistArtifactLockPath,
  runNativeTsgoArtifactEntry,
  runOwnedDistArtifactEntry,
  withDistArtifactOwnership,
} from "../../scripts/lib/dist-artifact-lock.mts";
import { runManagedCommand } from "../../scripts/lib/managed-child-process.mts";
import { inspectSourceUpdateArtifacts } from "../../scripts/lib/source-update-artifact-preflight.mts";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import { createDeferred } from "../helpers/promise.js";
import { installDistArtifactScripts } from "./dist-artifact-fixture.js";
import { materializeNativeCompiler } from "./native-boundary-fixture.js";

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
const createRoot = () => {
  const root = fs.realpathSync(fixture.createTempDir("openclaw-lock-cancel-"));
  // Keep checkout discovery from selecting an ancestor of the temporary fixture.
  fs.mkdirSync(path.join(root, ".git"));
  return root;
};

it("cancels an already contended same-process waiter without disturbing the owner", async () => {
  const root = createRoot();
  const enteredOwner = createDeferred();
  const releaseOwner = createDeferred();
  const owner = withDistArtifactOwnership(root, async () => {
    enteredOwner.resolve();
    await releaseOwner.promise;
  });
  await enteredOwner.promise;
  const ownerPath = path.join(resolveDistArtifactLockPath(root), "owner.json");
  const originalOwner = fs.readFileSync(ownerPath, "utf8");
  const attempted = createDeferred();
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
  { direct: false, fails: true },
  { direct: true, fails: false },
])(
  "joins acquisition-race release before rejecting (direct=$direct, release fails=$fails)",
  async ({ direct, fails }) => {
    const root = createRoot();
    const entered = createDeferred();
    const acquired = createDeferred<fileLock.FileLockHandle>();
    const releasing = createDeferred();
    const released = createDeferred();
    const failure = new Error("release failed");
    const controller = new AbortController();
    const callback = vi.fn();
    const release = vi.fn(async () => {
      releasing.resolve();
      await released.promise;
      if (fails) {
        throw failure;
      }
    });
    let actualLock: fileLock.FileLockHandle | undefined;
    vi.mocked(fileLock.acquireFileLock).mockImplementation(async (...args) => {
      actualLock = await actual.acquireFileLock(...args);
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
      ...actualLock!,
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
    await actualLock?.release();
  },
);

it.for([false, true])(
  "preserves an acquisition cleanup failure racing cancellation (owner=%s)",
  async (ownerPresent) => {
    const root = createRoot();
    if (ownerPresent) {
      const directory = resolveDistArtifactLockPath(root);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, "owner.json"), JSON.stringify({ pid: process.pid }));
    }
    const controller = new AbortController();
    const failure = new Error("acquisition cleanup failed");
    vi.mocked(fileLock.acquireFileLock).mockImplementation(async () => {
      controller.abort();
      throw failure;
    });
    const callback = vi.fn();
    await expect(
      withDistArtifactOwnership(root, callback, controller.signal),
    ).rejects.toMatchObject({
      cause: failure,
      message: expect.stringContaining("filesystem error"),
    });
    expect(callback).not.toHaveBeenCalled();
  },
);

it("does not acquire for an already cancelled waiter", async () => {
  const acquire = vi.mocked(fileLock.acquireFileLock);
  const signal = AbortSignal.abort();
  await expect(withDistArtifactOwnership(createRoot(), vi.fn(), signal)).rejects.toBe(
    signal.reason,
  );
  expect(acquire).not.toHaveBeenCalled();
});

it("keeps the published two-argument wait inside one native acquisition", async () => {
  const acquire = vi.mocked(fileLock.acquireFileLock);
  const failure = Object.assign(new Error("native timeout"), { code: "file_lock_timeout" });
  acquire.mockRejectedValue(failure);
  await expect(withDistArtifactOwnership(createRoot(), vi.fn())).rejects.toMatchObject({
    cause: failure,
  });
  expect(acquire).toHaveBeenCalledOnce();
  expect(acquire.mock.calls[0]?.[1]?.timeoutMs).toBe(Number.POSITIVE_INFINITY);
});

it.for([
  JSON.stringify({ pid: 2147483647, startedAt: "2026-01-01T00:00:00.000Z" }),
  "{broken legacy owner",
])("keeps unresolved source admission truthful (%s)", async (record) => {
  const root = createRoot();
  const directory = resolveDistArtifactLockPath(root);
  fs.mkdirSync(directory, { recursive: true });
  const ownerFile = path.join(directory, "owner.json");
  fs.writeFileSync(ownerFile, record);
  const error = await inspectSourceUpdateArtifacts(root).catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).toContain("identity unavailable");
  expect(String(error)).toContain("heartbeat unavailable");
  expect(String(error)).toContain("custody unresolved");
  expect(String(error)).not.toContain("rm -rf");
  expect(fs.readFileSync(ownerFile, "utf8")).toBe(record);
});

it("refuses unowned legacy child claims before admitting a new writer", async () => {
  const root = createRoot();
  const directory = resolveDistArtifactLockPath(root);
  fs.mkdirSync(directory, { recursive: true });
  const claim = path.join(directory, "child-12345");
  fs.writeFileSync(claim, "legacy child without owner identity");
  await expect(inspectSourceUpdateArtifacts(root)).rejects.toThrow("custody unresolved");
  expect(fs.readFileSync(claim, "utf8")).toBe("legacy child without owner identity");
  expect(fs.existsSync(path.join(directory, "owner.json"))).toBe(false);
});

it("refuses a waiting caller when a live owner's generation retains unjoined work", async () => {
  const root = createRoot();
  const owner = await acquireDistArtifactOwnership(root);
  const directory = resolveDistArtifactLockPath(root);
  const raw = fs.readFileSync(path.join(directory, "owner.json"), "utf8");
  const payload = JSON.parse(raw) as { custodyId: string };
  await owner.release();
  // Model a durable failed owner from another invocation, without entering
  // fs-safe's same-process live-handle queue before its stale-record reader.
  fs.mkdirSync(path.join(directory, payload.custodyId));
  fs.writeFileSync(path.join(directory, "owner.json"), raw);
  const marker = path.join(directory, payload.custodyId, "unjoined");
  fs.writeFileSync(marker, "Fixture cleanup was not verified.");
  const controller = new AbortController();
  vi.mocked(fileLock.acquireFileLock).mockImplementation((target, options) =>
    actual.acquireFileLock(target, {
      ...options,
      shouldReclaim: async (snapshot) => {
        const refused = await options.shouldReclaim?.(snapshot);
        // Bound the original incorrect wait at its actual stale-owner decision,
        // without sleeps or killing the still-live owner.
        if (!refused) {
          controller.abort(new Error("incorrectly waited for unresolved custody"));
        }
        return refused === true;
      },
    }),
  );
  try {
    await expect(acquireDistArtifactOwnership(root, true, controller.signal)).rejects.toThrow(
      "custody unresolved",
    );
    expect(fs.readFileSync(path.join(directory, "owner.json"), "utf8")).toBe(raw);
    expect(fs.readFileSync(marker, "utf8")).toBe("Fixture cleanup was not verified.");
  } finally {
    controller.abort();
  }
});

it.for([
  ["NODE_OPTIONS", "--import=untracked-runtime.mjs"],
  ["LD_PRELOAD", "/synthetic/preload.so"],
  ["LD_LIBRARY_PATH", "/synthetic/libraries"],
] as const)(
  "does not certify native custody around an injected runtime preload (%s)",
  async ([key, value]) => {
    const root = createRoot();
    vi.stubEnv(key, value);
    try {
      expect(await runNativeTsgoArtifactEntry(root, [], process.execPath)).toBeUndefined();
      expect(fileLock.acquireFileLock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  },
);

it("refuses an unrelated entry attaching to an active native generation", async () => {
  const root = createRoot();
  const owner = await acquireDistArtifactOwnership(root);
  const ownerFile = path.join(resolveDistArtifactLockPath(root), "owner.json");
  const raw = fs.readFileSync(ownerFile, "utf8");
  const payload = JSON.parse(raw) as { custodyId: string };
  fs.writeFileSync(ownerFile, JSON.stringify({ ...payload, treeOwnership: "linux-subreaper" }));
  const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
  try {
    await expect(runOwnedDistArtifactEntry("file:///must-not-import.mjs", [])).rejects.toThrow(
      "generation mismatch",
    );
    expect(fs.readdirSync(path.join(resolveDistArtifactLockPath(root), payload.custodyId))).toEqual(
      [],
    );
  } finally {
    cwd.mockRestore();
    fs.writeFileSync(ownerFile, raw);
    await owner.release();
  }
});

it("keeps metadata execution available without source identity or zod dependencies", async ({
  signal,
}) => {
  const root = createRoot();
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module","private":true}');
  materializeNativeCompiler(root, { javaScriptApi: false });
  installDistArtifactScripts(root, ["run-tsgo.mjs", "run-tsgo.mts"], { compiler: false });
  expect(fs.existsSync(path.join(root, "src"))).toBe(false);
  expect(fs.existsSync(path.join(root, "node_modules/zod"))).toBe(false);
  let output = "",
    errors = "";
  const code = await runManagedCommand({
    bin: process.execPath,
    args: [path.join(root, "scripts/run-tsgo.mjs"), "--version"],
    cwd: root,
    signal,
    stdio: ["ignore", "pipe", "pipe"],
    requireProcessTreeExit: process.platform !== "win32",
    onReady(child) {
      child.stdout?.on("data", (chunk) => {
        output += String(chunk);
      });
      child.stderr?.on("data", (chunk) => {
        errors += String(chunk);
      });
    },
  });
  expect(code, errors).toBe(0);
  expect(output).toMatch(/^Version /);
  expect(errors).toBe("");
});

it("does not certify hook-capable Git provenance in metrics mode", async () => {
  const root = createRoot();
  vi.stubEnv("OPENCLAW_TSGO_METRICS_DIR", "metrics");
  try {
    expect(await runNativeTsgoArtifactEntry(root, [], process.execPath)).toBeUndefined();
    expect(fileLock.acquireFileLock).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllEnvs();
  }
});

it("refuses orphaned generation claims instead of treating missing owner as settlement", async () => {
  const root = createRoot();
  const directory = resolveDistArtifactLockPath(root);
  const claim = path.join(directory, "12345678-1234-1234-1234-123456789abc", "child-12345");
  fs.mkdirSync(path.dirname(claim), { recursive: true });
  fs.writeFileSync(claim, "Unknown live claimant");
  await expect(inspectSourceUpdateArtifacts(root)).rejects.toThrow("custody unresolved");
  expect(fs.readFileSync(claim, "utf8")).toBe("Unknown live claimant");
  expect(fs.existsSync(path.join(directory, "owner.json"))).toBe(false);
});

it("keeps terminal input and output with the ordinary explicit-release entry", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  try {
    expect(await runNativeTsgoArtifactEntry(createRoot(), [], process.execPath)).toBeUndefined();
    expect(fileLock.acquireFileLock).not.toHaveBeenCalled();
  } finally {
    if (descriptor) {
      Object.defineProperty(process.stdout, "isTTY", descriptor);
    } else {
      Reflect.deleteProperty(process.stdout, "isTTY");
    }
  }
});

it.for(["--api", "--lsp", "--watch", "-w"])(
  "keeps %s on its original input and lifetime contract",
  async (mode) => {
    expect(
      await runNativeTsgoArtifactEntry(createRoot(), [mode], process.execPath),
    ).toBeUndefined();
    expect(fileLock.acquireFileLock).not.toHaveBeenCalled();
  },
);
