import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi, type MockInstance } from "vitest";
import {
  LEGACY_PACKAGE_INSTALL_GUARD_RELATIVE_PATH,
  PACKAGE_LIFECYCLE_MARKER_CONTRACT_RELATIVE_PATH,
  PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH,
} from "../../scripts/lib/package-lifecycle-marker.mjs";
import { createDeferred } from "../../test/helpers/promise.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { completePendingPackageLifecycle } from "./package-lifecycle.js";

async function markModernLifecyclePending(packageRoot: string): Promise<string> {
  const markerPath = path.join(packageRoot, PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH);
  const contractPath = path.join(packageRoot, PACKAGE_LIFECYCLE_MARKER_CONTRACT_RELATIVE_PATH);
  await fs.mkdir(path.dirname(contractPath), { recursive: true });
  await fs.writeFile(contractPath, "export {};\n");
  await fs.writeFile(markerPath, "pending\n");
  return markerPath;
}

describe("package lifecycle completion", () => {
  it("runs preinstall and postinstall once before releasing concurrent callers", async () => {
    await withTestDir({ prefix: "openclaw-package-lifecycle-" }, async (packageRoot) => {
      const markerPath = await markModernLifecyclePending(packageRoot);
      const calls: string[] = [];
      const { promise: preinstallBlocked, resolve: releasePreinstall } = createDeferred();
      const { promise: firstPreinstall, resolve: firstPreinstallStarted } = createDeferred();
      const runScript = vi.fn(async (script: { name: string }) => {
        calls.push(script.name);
        if (script.name === "preinstall") {
          firstPreinstallStarted?.();
          await preinstallBlocked;
        } else {
          await fs.rm(markerPath);
        }
      });

      const callers: Promise<boolean>[] = [];
      const startCaller = () => {
        const caller = completePendingPackageLifecycle({ packageRoot, runScript });
        void caller.catch(() => {});
        callers.push(caller);
      };
      startCaller();
      try {
        await firstPreinstall;
        startCaller();
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 250);
        });
        expect(calls).toEqual(["preinstall"]);
        startCaller();
        releasePreinstall();

        await expect(Promise.all(callers)).resolves.toEqual([true, false, false]);
        expect(calls).toEqual(["preinstall", "postinstall"]);
      } finally {
        releasePreinstall();
        await Promise.allSettled(callers);
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
      const marker = await markModernLifecyclePending(packageRoot);
      const preEntered = createDeferred();
      const releasePre = createDeferred();
      const postEntered = createDeferred();
      const releasePost = createDeferred();
      const owner = completePendingPackageLifecycle({
        packageRoot,
        runScript: async (script) => {
          if (script.name === "preinstall") {
            preEntered.resolve();
            await releasePre.promise;
          } else {
            await fs.rm(marker);
            postEntered.resolve();
            await releasePost.promise;
          }
        },
      });
      const completions = [owner];
      const returned = vi.fn();
      const contenderScript = vi.fn();
      const startContender = () => {
        const contender = completePendingPackageLifecycle({
          packageRoot,
          runScript: contenderScript,
        });
        completions.push(contender);
        void contender.then(returned, returned);
      };
      try {
        await preEntered.promise;
        startContender();
        releasePre.resolve();
        await postEntered.promise;
        startContender();
        await new Promise((resolve) => {
          setTimeout(resolve, 250);
        });
        expect(returned).not.toHaveBeenCalled();
        expect(contenderScript).not.toHaveBeenCalled();
        releasePost.resolve();
        await expect(Promise.all(completions)).resolves.toEqual([true, false, false]);
      } finally {
        releasePre.resolve();
        releasePost.resolve();
        await Promise.allSettled(completions);
      }
    });
  });

  it.each([-1, 1])("keeps an unresolved owner across a %i day clock shift", async (direction) => {
    await withTestDir({ prefix: "openclaw-package-lifecycle-clock-" }, async (packageRoot) => {
      const markerPath = await markModernLifecyclePending(packageRoot);
      const { promise: blocked, resolve: release } = createDeferred();
      const { promise: started, resolve: entered } = createDeferred();
      const runScript = vi.fn(async (script: { name: string }) => {
        if (script.name === "preinstall") {
          entered();
          await blocked;
        } else {
          await fs.rm(markerPath);
        }
      });
      const first = completePendingPackageLifecycle({ packageRoot, runScript, timeoutMs: 1000 });
      const completion = Promise.allSettled([first]);
      let second: Promise<boolean> | undefined;
      let clock: MockInstance<() => number> | undefined;
      try {
        await started;
        const now = Date.now();
        clock = vi.spyOn(Date, "now").mockReturnValue(now + direction * 24 * 60 * 60_000);
        second = completePendingPackageLifecycle({ packageRoot, runScript, timeoutMs: 1000 });
        void second.catch(() => {});
        await new Promise((resolve) => {
          setTimeout(resolve, 250);
        });
        expect(runScript.mock.calls.map(([script]) => script.name)).toEqual(["preinstall"]);
        clock.mockRestore();
        release();
        await expect(first).resolves.toBe(true);
        await expect(second).resolves.toBe(false);
      } finally {
        clock?.mockRestore();
        release();
        await completion;
        await Promise.allSettled(second ? [second] : []);
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
