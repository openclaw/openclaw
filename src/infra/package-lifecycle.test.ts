import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
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

  it.each([
    ["default update", 30 * 60_000],
    ["automatic update", 45 * 60_000],
    ["explicit longer update", 75 * 60_000],
  ])("records the %s lifecycle budget on its lock", async (_name, scriptTimeoutMs) => {
    await withTestDir({ prefix: "openclaw-package-lifecycle-lock-" }, async (packageRoot) => {
      const markerPath = await markModernLifecyclePending(packageRoot);
      const { promise: preinstallBlocked, resolve: releasePreinstall } = createDeferred();
      const { promise: firstPreinstall, resolve: firstPreinstallStarted } = createDeferred();
      const runScript = async (script: { name: string }) => {
        if (script.name === "preinstall") {
          firstPreinstallStarted?.();
          await preinstallBlocked;
        } else {
          await fs.rm(markerPath);
        }
      };

      const startedAt = Date.now();
      const first = completePendingPackageLifecycle({
        packageRoot,
        runScript,
        timeoutMs: scriptTimeoutMs,
      });
      const completion = Promise.allSettled([first]);
      try {
        await firstPreinstall;
        const lockStat = await fs.stat(path.join(packageRoot, ".openclaw-lifecycle-lock"));
        expect(lockStat.mtimeMs).toBeGreaterThanOrEqual(startedAt + scriptTimeoutMs * 2 - 1_000);
        releasePreinstall();
        await expect(first).resolves.toBe(true);
        await expect(fs.access(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        releasePreinstall();
        await completion;
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
