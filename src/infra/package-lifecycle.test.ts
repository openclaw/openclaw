import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  LEGACY_PACKAGE_INSTALL_GUARD_RELATIVE_PATH,
  PACKAGE_LIFECYCLE_MARKER_CONTRACT_RELATIVE_PATH,
  PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH,
} from "../../scripts/lib/package-lifecycle-marker.mjs";
import { createDeferred } from "../../test/helpers/promise.js";
import * as pidAlive from "../shared/pid-alive.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { completePendingPackageLifecycle } from "./package-lifecycle.js";

afterEach(() => vi.restoreAllMocks());

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

async function markModernLifecyclePending(packageRoot: string): Promise<string> {
  const markerPath = path.join(packageRoot, PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH);
  const contractPath = path.join(packageRoot, PACKAGE_LIFECYCLE_MARKER_CONTRACT_RELATIVE_PATH);
  await fs.mkdir(path.dirname(contractPath), { recursive: true });
  await fs.writeFile(contractPath, "export {};\n");
  await fs.writeFile(markerPath, "pending\n");
  return markerPath;
}

async function holdLifecycle(
  packageRoot: string,
  phase: "preinstall" | "postinstall",
  timeoutMs?: number,
) {
  const marker = await markModernLifecyclePending(packageRoot);
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
    const caller = completePendingPackageLifecycle({ packageRoot, runScript: script, timeoutMs });
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

describe("package lifecycle completion", () => {
  it("runs preinstall and postinstall once before releasing concurrent callers", async () => {
    await withTestDir({ prefix: "openclaw-package-lifecycle-" }, async (packageRoot) => {
      const held = await holdLifecycle(packageRoot, "preinstall");
      const calls = () => held.runScript.mock.calls.map(([script]) => script.name);
      try {
        const waitForContention = observeLifecycleContention();
        await waitForContention(held.start());
        expect(calls()).toEqual(["preinstall"]);
        held.release();
        await expect(Promise.all(held.callers)).resolves.toEqual([true, false]);
        held.start();
        await expect(Promise.all(held.callers)).resolves.toEqual([true, false, false]);
        expect(calls()).toEqual(["preinstall", "postinstall"]);
      } finally {
        await held.close();
      }
    });
  });

  it.each(["throws", "leaves the marker"])(
    "retains pending state when modern postinstall %s",
    async (failure) => {
      await withTestDir({ prefix: "openclaw-package-lifecycle-failure-" }, async (packageRoot) => {
        const markerPath = await markModernLifecyclePending(packageRoot);

        await expect(
          completePendingPackageLifecycle({
            packageRoot,
            runScript: (script) => {
              if (script.name === "postinstall" && failure === "throws") {
                throw new Error("postinstall failed");
              }
            },
          }),
        ).rejects.toThrow(
          failure === "throws"
            ? "postinstall failed"
            : "postinstall did not complete its lifecycle marker",
        );
        await expect(fs.readFile(markerPath, "utf8")).resolves.toBe("pending\n");
      });
    },
  );

  it("waits for a held invocation after postinstall clears its pending marker", async () => {
    await withTestDir({ prefix: "openclaw-lifecycle-marker-settlement-" }, async (packageRoot) => {
      const held = await holdLifecycle(packageRoot, "postinstall");
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
  });

  it.each([-1, 1])("keeps an unresolved owner across a %i day clock shift", async (direction) => {
    await withTestDir({ prefix: "openclaw-package-lifecycle-clock-" }, async (packageRoot) => {
      const held = await holdLifecycle(packageRoot, "preinstall", 1000);
      let clock: MockInstance<() => number> | undefined;
      try {
        const now = Date.now();
        clock = vi.spyOn(Date, "now").mockReturnValue(now + direction * 24 * 60 * 60_000);
        const waitForContention = observeLifecycleContention();
        const second = held.start();
        await waitForContention(second);
        expect(held.runScript.mock.calls.map(([script]) => script.name)).toEqual(["preinstall"]);
        clock.mockRestore();
        held.release();
        await expect(held.callers[0]).resolves.toBe(true);
        await expect(second).resolves.toBe(false);
      } finally {
        clock?.mockRestore();
        await held.close();
      }
    });
  });

  it.each(["none", "preinstall", "postinstall"])(
    "completes the shipped dist guard after %s interruption",
    async (failedScript) => {
      await withTestDir({ prefix: "openclaw-package-lifecycle-legacy-" }, async (packageRoot) => {
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
          await expect(completePendingPackageLifecycle({ packageRoot, runScript })).rejects.toThrow(
            "lifecycle interrupted",
          );
          await expect(fs.readFile(markerPath, "utf8")).resolves.toBe("pending\n");
          interrupted = false;
          runScript.mockClear();
        }
        await expect(completePendingPackageLifecycle({ packageRoot, runScript })).resolves.toBe(
          true,
        );
        expect(runScript.mock.calls.map(([script]) => script.name)).toEqual([
          "preinstall",
          "postinstall",
        ]);
        await expect(fs.access(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(fs.access(legacyGuardPath)).rejects.toMatchObject({ code: "ENOENT" });
      });
    },
  );
});
