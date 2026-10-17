import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from "vitest";
import {
  LEGACY_PACKAGE_INSTALL_GUARD_RELATIVE_PATH,
  PACKAGE_LIFECYCLE_MARKER_CONTRACT_RELATIVE_PATH,
  PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH,
} from "../../scripts/lib/package-lifecycle-marker.mjs";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as pidAlive from "../shared/pid-alive.js";
import { completePendingPackageLifecycle } from "./package-lifecycle.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
let packageRoot: string;
beforeEach(() => {
  packageRoot = dirs.make("openclaw-lifecycle-");
});
afterEach(() => vi.restoreAllMocks());
type RunScript = NonNullable<Parameters<typeof completePendingPackageLifecycle>[0]["runScript"]>;
const complete = (runScript: RunScript, timeoutMs?: number) =>
  completePendingPackageLifecycle({ packageRoot, runScript, timeoutMs });
const missing = (file: string) => expect(fs.access(file)).rejects.toMatchObject({ code: "ENOENT" });

function observeLifecycleContention() {
  // Admission probes this PID only after the real lock reports contention.
  const contended = createDeferred();
  const isPidAlive = pidAlive.isPidAlive;
  vi.spyOn(pidAlive, "isPidAlive").mockImplementation((pid) => {
    const alive = isPidAlive(pid);
    contended.resolve();
    return alive;
  });
  return async (contender: Promise<boolean>) => {
    await Promise.race([
      contended.promise,
      contender.then(() => {
        throw new Error("lifecycle contender completed before observing the held owner");
      }),
    ]);
  };
}

async function markModernLifecyclePending(): Promise<string> {
  const markerPath = path.join(packageRoot, PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH);
  const contractPath = path.join(packageRoot, PACKAGE_LIFECYCLE_MARKER_CONTRACT_RELATIVE_PATH);
  await fs.mkdir(path.dirname(contractPath), { recursive: true });
  await fs.writeFile(contractPath, "export {};\n");
  await fs.writeFile(markerPath, "pending\n");
  return markerPath;
}

async function holdLifecycle(phase: "preinstall" | "postinstall", timeoutMs?: number) {
  const marker = await markModernLifecyclePending();
  const entered = createDeferred();
  const released = createDeferred();
  const runScript = vi.fn(async (script: { name: string }) => {
    if (script.name === "postinstall") {
      await fs.rm(marker);
    }
    if (script.name === phase) {
      entered.resolve();
      await released.promise;
    }
  });
  const callers: Promise<boolean>[] = [];
  const start = (script = runScript) => {
    const caller = complete(script, timeoutMs);
    void caller.catch(() => {});
    callers.push(caller);
    return caller;
  };
  start();
  await entered.promise;
  return {
    runScript,
    callers,
    start,
    release: released.resolve,
    close: async () => {
      released.resolve();
      await Promise.allSettled(callers);
    },
  };
}

it.each([0, -1, 1])(
  "serializes lifecycle callers across a %i day clock shift",
  async (direction) => {
    const held = await holdLifecycle("preinstall", direction ? 1000 : undefined);
    const calls = () => held.runScript.mock.calls.map(([script]) => script.name);
    let clock: MockInstance<() => number> | undefined;
    try {
      if (direction) {
        clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + direction * 24 * 60 * 60_000);
      }
      const waitForContention = observeLifecycleContention();
      await waitForContention(held.start());
      expect(calls()).toEqual(["preinstall"]);
      clock?.mockRestore();
      held.release();
      await expect(Promise.all(held.callers)).resolves.toEqual([true, false]);
      if (!direction) {
        held.start();
        await expect(Promise.all(held.callers)).resolves.toEqual([true, false, false]);
      }
      expect(calls()).toEqual(["preinstall", "postinstall"]);
    } finally {
      clock?.mockRestore();
      await held.close();
    }
  },
);

it.each(["throws", "leaves marker"])("postinstall %s keeps pending", async (failure) => {
  const markerPath = await markModernLifecyclePending();

  await expect(
    complete((script) => {
      if (script.name === "postinstall" && failure === "throws") {
        throw new Error("postinstall failed");
      }
    }),
  ).rejects.toThrow(
    failure === "throws"
      ? "postinstall failed"
      : "postinstall did not complete its lifecycle marker",
  );
  await expect(fs.readFile(markerPath, "utf8")).resolves.toBe("pending\n");
});

it("waits for a held invocation after postinstall clears its pending marker", async () => {
  const held = await holdLifecycle("postinstall");
  const returned = vi.fn();
  const contenderScript = vi.fn(async (_script: { name: string }) => {});
  try {
    const waitForContention = observeLifecycleContention();
    const contender = held.start(contenderScript);
    void contender.then(returned, returned);
    await waitForContention(contender);
    expect(returned).not.toHaveBeenCalled();
    expect(contenderScript).not.toHaveBeenCalled();
    held.release();
    await expect(Promise.all(held.callers)).resolves.toEqual([true, false]);
  } finally {
    await held.close();
  }
});

it.each(["none", "preinstall", "postinstall"])("settles legacy %s", async (failedScript) => {
  const markerPath = path.join(packageRoot, PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH);
  const legacyGuardPath = path.join(packageRoot, LEGACY_PACKAGE_INSTALL_GUARD_RELATIVE_PATH);
  await fs.mkdir(path.dirname(legacyGuardPath), { recursive: true });
  await fs.writeFile(legacyGuardPath, "pending\n");
  let interrupted = failedScript !== "none";
  const runScript = vi.fn(async (script: { name: string }) => {
    await expect(fs.readFile(markerPath, "utf8")).resolves.toBe("pending\n");
    if (script.name === "preinstall") {
      await fs.rm(legacyGuardPath, { force: true });
    }
    if (interrupted && script.name === failedScript) {
      throw new Error("lifecycle interrupted");
    }
  });
  if (interrupted) {
    await expect(complete(runScript)).rejects.toThrow("lifecycle interrupted");
    await expect(fs.readFile(markerPath, "utf8")).resolves.toBe("pending\n");
    interrupted = false;
    runScript.mockClear();
  }
  await expect(complete(runScript)).resolves.toBe(true);
  expect(runScript.mock.calls.map(([script]) => script.name)).toEqual([
    "preinstall",
    "postinstall",
  ]);
  await missing(markerPath);
  await missing(legacyGuardPath);
});
