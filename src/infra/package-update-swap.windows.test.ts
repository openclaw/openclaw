import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as packageFilesystem from "./package-update-filesystem.js";
import { swapStagedPackageInstall } from "./package-update-swap.js";
import {
  createPackageSwapFixture,
  createRetainedPackageSwap,
} from "./package-update-swap.test-support.js";
import * as retry from "./retry.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const runRetry = retry.retryAsync;
const backupPackageRoot = packageFilesystem.backupNpmPackageRoot;
const activatePackageRoot = packageFilesystem.activateStagedNpmPackageRoot;
const restorePackageRoot = packageFilesystem.restoreNpmPackageRoot;
let wait: ReturnType<typeof vi.fn<(ms: number) => Promise<void>>>;
beforeEach(() => {
  // Select the Windows rename policy without changing fs-safe's native platform.
  vi.spyOn(packageFilesystem, "backupNpmPackageRoot").mockImplementation(
    (source, destination, assertCurrent, warnings) =>
      backupPackageRoot(source, destination, assertCurrent, warnings, "win32"),
  );
  vi.spyOn(packageFilesystem, "activateStagedNpmPackageRoot").mockImplementation(
    (source, destination, assertCurrent, unjournaled) =>
      activatePackageRoot(
        source,
        destination,
        assertCurrent,
        unjournaled && { ...unjournaled, platform: "win32" },
      ),
  );
  wait = vi.fn(async (_ms: number) => {});
  vi.spyOn(retry, "retryAsync").mockImplementation((fn, options) =>
    runRetry(fn, { ...(typeof options === "object" ? options : {}), sleep: wait }),
  );
});
afterEach(() => vi.restoreAllMocks());

// Activation publishes the sibling stage; the other scenarios deny the package backup.
const renameScenarios = ["transient", "persistent", "authority", "source", "destination"] as const;
it.each([...renameScenarios, "activation-transient", "activation-persistent"] as const)(
  "preserves the installation during Windows rename failure: %s",
  async (scenario) => {
    const { params, packageRoot, launcher } = await createPackageSwapFixture(
      dirs.make("swap-rename-"),
    );
    const interrupted = ["authority", "source", "destination"].includes(scenario);
    const transient = scenario.endsWith("transient");
    const denied = scenario.startsWith("activation") ? params.stage.packageRoot : packageRoot;
    const rename = fs.rename.bind(fs);
    let attempts = 0;
    let revoked = false;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(from) === denied) {
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
      expect(attempts).toBe(16);
      await expect(fs.readFile(path.join(denied, "package.json"), "utf8")).resolves.toContain(
        scenario === "persistent" ? `"version":"1.0.0"` : `"version":"2.0.0"`,
      );
    }
    await expect(fs.readFile(path.join(packageRoot, "package.json"), "utf8")).resolves.toContain(
      `"version":"${transient ? "2.0.0" : "1.0.0"}"`,
    );
    await expect(fs.readFile(launcher, "utf8")).resolves.toBe(
      transient ? "candidate launcher\n" : "old launcher\n",
    );
  },
);

it("retries a transiently denied Windows rollback publication rename", async () => {
  const { transaction, packageRoot, launcher } = await createRetainedPackageSwap(
    dirs.make("swap-rollback-retry-"),
  );
  vi.spyOn(packageFilesystem, "restoreNpmPackageRoot").mockImplementation((params) =>
    restorePackageRoot({ ...params, platform: "win32" }),
  );
  const rename = fs.rename.bind(fs);
  let publicationAttempts = 0;
  vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
    if (String(from) === transaction.backupRoot) {
      publicationAttempts++;
      if (publicationAttempts <= 2) {
        throw Object.assign(new Error("EPERM: package is in use"), { code: "EPERM" });
      }
    }
    return rename(from, to);
  });

  expect(await transaction.rollback(() => {})).toMatchObject({
    exitCode: 0,
    activePackageRoot: packageRoot,
  });

  expect(publicationAttempts).toBe(3);
  await expect(fs.readFile(path.join(packageRoot, "package.json"), "utf8")).resolves.toContain(
    `"version":"1.0.0"`,
  );
  await expect(fs.readFile(launcher, "utf8")).resolves.toBe("old launcher\n");
  expect(await transaction.complete({ activationVerified: false }, () => {})).toBeUndefined();
});

it("names the exact recovery action when Windows rollback denials strand the live root", async () => {
  const { transaction, packageRoot } = await createRetainedPackageSwap(
    dirs.make("swap-rollback-strand-"),
  );
  vi.spyOn(packageFilesystem, "restoreNpmPackageRoot").mockImplementation((params) =>
    restorePackageRoot({ ...params, platform: "win32" }),
  );
  const rename = fs.rename.bind(fs);
  vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
    if (String(to) === packageRoot) {
      throw Object.assign(new Error("EPERM: package is in use"), { code: "EPERM" });
    }
    return rename(from, to);
  });

  const result = await transaction.rollback(() => {});

  expect(result).toMatchObject({ exitCode: 1, activePackageRoot: null });
  expect(result.stderrTail).toContain("rollback failed:");
  expect(result.stderrTail).toContain(`${packageRoot} is missing`);
  expect(result.stderrTail).toContain(`moving ${transaction.backupRoot}`);
  expect(result.stderrTail).toContain(`or ${transaction.backupRoot}.candidate`);
  expect(result.stderrTail).toContain(`to ${packageRoot}`);
  expect(result.stderrTail).toContain(`update retained at ${transaction.backupRoot}.candidate`);
  await expect(fs.lstat(packageRoot)).rejects.toHaveProperty("code", "ENOENT");
  await expect(
    fs.readFile(path.join(transaction.backupRoot, "package.json"), "utf8"),
  ).resolves.toContain(`"version":"1.0.0"`);
  await expect(
    fs.readFile(path.join(`${transaction.backupRoot}.candidate`, "package.json"), "utf8"),
  ).resolves.toContain(`"version":"2.0.0"`);
  expect(await transaction.complete({ activationVerified: true }, () => {})).toMatchObject({
    exitCode: 1,
  });
});
