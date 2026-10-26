import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as packageFilesystem from "./package-update-filesystem.js";
import { swapStagedPackageInstall } from "./package-update-swap.js";
import { createPackageSwapFixture } from "./package-update-swap.test-support.js";
import * as retry from "./retry.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const runRetry = retry.retryAsync;
const backupPackageRoot = packageFilesystem.backupNpmPackageRoot;
let wait: ReturnType<typeof vi.fn<(ms: number) => Promise<void>>>;
beforeEach(() => {
  // Select the Windows rename policy without changing fs-safe's native platform.
  vi.spyOn(packageFilesystem, "backupNpmPackageRoot").mockImplementation(
    (source, destination, assertCurrent, warnings) =>
      backupPackageRoot(source, destination, assertCurrent, warnings, "win32"),
  );
  wait = vi.fn(async (_ms: number) => {});
  vi.spyOn(retry, "retryAsync").mockImplementation((fn, options) =>
    runRetry(fn, { ...(typeof options === "object" ? options : {}), sleep: wait }),
  );
});
afterEach(() => vi.restoreAllMocks());

it.each(["transient", "persistent", "authority", "source", "destination"] as const)(
  "preserves the installation during Windows rename failure: %s",
  async (scenario) => {
    const { params, packageRoot, launcher } = await createPackageSwapFixture(
      dirs.make("swap-rename-"),
    );
    const interrupted = scenario !== "transient" && scenario !== "persistent";
    const transient = scenario === "transient";
    const rename = fs.rename.bind(fs);
    let attempts = 0;
    let revoked = false;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(from) === packageRoot) {
        attempts++;
        if (interrupted) {
          wait.mockImplementationOnce(async () => {
            if (scenario === "authority") {
              revoked = true;
            } else {
              const replacement = scenario === "source" ? packageRoot : String(to);
              if (scenario === "source") {
                await rename(packageRoot, `${packageRoot}.retained`);
              }
              await fs.mkdir(replacement);
              await fs.writeFile(path.join(replacement, "replacement"), "keep");
            }
          });
        }
        if (!transient || attempts <= 2) {
          throw Object.assign(new Error("EPERM: package is in use"), { code: "EPERM" });
        }
      }
      return rename(from, to);
    });
    const result = await swapStagedPackageInstall({
      ...params,
      assertCurrent: () => {
        if (revoked) {
          throw Object.assign(new Error("update owner revoked"), { code: "EPERM" });
        }
      },
    });
    if (interrupted) {
      expect(result.status).toBe("failed");
      expect(result.step.stderrTail).toContain(
        scenario === "authority" ? "update owner revoked" : "package path changed",
      );
      return;
    }
    expect(result.status).toBe(transient ? "committed" : "failed");
    expect(result.step.warnings).toContainEqual(
      expect.stringContaining("EPERM: package is in use"),
    );
    if (!transient) {
      expect(result).toMatchObject({
        activePackageRoot: packageRoot,
        packageRollbackVerified: true,
        step: { failureFacts: [expect.objectContaining({ code: "EPERM" })] },
      });
      expect(result.step.stderrTail).toContain(packageRoot);
    }
    await expect(fs.readFile(path.join(packageRoot, "package.json"), "utf8")).resolves.toContain(
      `"version":"${transient ? "2.0.0" : "1.0.0"}"`,
    );
    await expect(fs.readFile(launcher, "utf8")).resolves.toBe(
      transient ? "candidate launcher\n" : "old launcher\n",
    );
  },
);
