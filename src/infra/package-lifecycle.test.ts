import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LEGACY_PACKAGE_INSTALL_GUARD_RELATIVE_PATH,
  PACKAGE_LIFECYCLE_MARKER_CONTRACT_RELATIVE_PATH,
  PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH,
} from "../../scripts/lib/package-lifecycle-marker.mjs";
import { createDeferred } from "../../test/helpers/promise.js";
import * as pidAlive from "../shared/pid-alive.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import {
  completePendingPackageLifecycle,
  type PackageLifecycleScript,
} from "./package-lifecycle.js";

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
  return async (contender: Promise<void>) => {
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

async function withBlockedLifecycle(
  stage: PackageLifecycleScript["name"],
  body: (fixture: {
    entered: Promise<void>;
    release: () => void;
    start: (script?: (script: PackageLifecycleScript) => void | Promise<void>) => Promise<void>;
    runScript: ReturnType<typeof vi.fn<(script: PackageLifecycleScript) => Promise<void>>>;
  }) => Promise<void>,
) {
  await withTestDir({ prefix: "openclaw-package-lifecycle-" }, async (packageRoot) => {
    const marker = await markModernLifecyclePending(packageRoot);
    const entered = createDeferred();
    const blocked = createDeferred();
    const callers: Promise<void>[] = [];
    const runScript = vi.fn(async (script: PackageLifecycleScript) => {
      if (script.name === "postinstall") {
        await fs.rm(marker);
      }
      if (script.name === stage) {
        entered.resolve();
        await blocked.promise;
      }
    });
    const start = (
      script: (script: PackageLifecycleScript) => void | Promise<void> = runScript,
    ) => {
      const caller = completePendingPackageLifecycle({ packageRoot, runScript: script });
      void caller.catch(() => {});
      callers.push(caller);
      return caller;
    };
    try {
      await body({ entered: entered.promise, release: blocked.resolve, start, runScript });
    } finally {
      blocked.resolve();
      await Promise.allSettled(callers);
    }
  });
}

describe("package lifecycle completion", () => {
  it.each(["preinstall", "postinstall"] as const)(
    "holds concurrent callers until %s settles, including after marker removal",
    async (stage) => {
      await withBlockedLifecycle(stage, async ({ entered, release, start, runScript }) => {
        const first = start();
        await entered;
        const waitForContention = observeLifecycleContention();
        const contenderScript = vi.fn();
        const returned = vi.fn();
        const second = start(contenderScript);
        void second.then(returned, returned);
        await waitForContention(second);
        expect(returned).not.toHaveBeenCalled();
        expect(contenderScript).not.toHaveBeenCalled();
        expect(runScript.mock.calls.map(([script]) => script.name)).toEqual(
          stage === "preinstall" ? ["preinstall"] : ["preinstall", "postinstall"],
        );
        release();
        await Promise.all([first, second]);
        await start();
        expect(contenderScript).not.toHaveBeenCalled();
        expect(runScript.mock.calls.map(([script]) => [script.name, script.relativePath])).toEqual([
          ["preinstall", path.join("scripts", "preinstall-package-manager-warning.mjs")],
          ["postinstall", path.join("scripts", "postinstall-bundled-plugins.mjs")],
        ]);
      });
    },
  );

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
        await completePendingPackageLifecycle({ packageRoot, runScript });
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
