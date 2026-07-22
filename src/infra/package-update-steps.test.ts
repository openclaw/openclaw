// Covers package update step orchestration.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { writePackageDistInventory } from "../../scripts/lib/package-dist-inventory.ts";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  applyLocalPackageOverrides,
  captureLocalPackageOverrides,
} from "./package-local-overrides.js";
import {
  markPackagePostInstallDoctorAdvisory,
  runGlobalPackageUpdateSteps,
} from "./package-update-steps.js";
import {
  createDeferredConfiguredPluginRepairDoctorResult,
  UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE,
} from "./update-doctor-result.js";
import {
  resolveNpmGlobalPrefixLayoutFromPrefix,
  type CommandRunner,
  type ResolvedGlobalInstallTarget,
} from "./update-global.js";

type PackageUpdateStepResult = Awaited<
  ReturnType<typeof runGlobalPackageUpdateSteps>
>["steps"][number];

const originalStateDir = process.env.OPENCLAW_STATE_DIR;
let packageUpdateTestStateDir = "";

beforeAll(async () => {
  packageUpdateTestStateDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "openclaw-package-update-state-"),
  );
  process.env.OPENCLAW_STATE_DIR = packageUpdateTestStateDir;
});

afterAll(async () => {
  if (originalStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalStateDir;
  }
  await fs.rm(packageUpdateTestStateDir, { recursive: true, force: true });
});

async function writePackageRoot(packageRoot: string, version: string): Promise<void> {
  await fs.mkdir(path.join(packageRoot, "dist"), { recursive: true });
  await Promise.all([
    fs.writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version }),
      "utf8",
    ),
    fs.writeFile(path.join(packageRoot, "dist", "index.js"), "export {};\n", "utf8"),
  ]);
  await writePackageDistInventory(packageRoot);
}

function createNpmTarget(globalRoot: string): ResolvedGlobalInstallTarget {
  return {
    manager: "npm",
    command: "npm",
    globalRoot,
    packageRoot: path.join(globalRoot, "openclaw"),
  };
}

function createFsError(code: string, message = code): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

async function expectPathMissing(filePath: string): Promise<void> {
  try {
    await fs.access(filePath);
  } catch (error) {
    expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
    return;
  }
  throw new Error(`Expected missing path: ${filePath}`);
}

function createRootRunner(globalRoot: string): CommandRunner {
  return async (argv) => {
    if (argv.join(" ") === "npm root -g") {
      return { stdout: `${globalRoot}\n`, stderr: "", code: 0 };
    }
    throw new Error(`unexpected command: ${argv.join(" ")}`);
  };
}

describe("markPackagePostInstallDoctorAdvisory", () => {
  it("marks only explicit post-install doctor advisory exits", () => {
    const step = markPackagePostInstallDoctorAdvisory(
      {
        exitCode: UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE,
        stderrTail: "doctor deferred repair",
        signal: null,
        killed: false,
        termination: "exit" as const,
      },
      createDeferredConfiguredPluginRepairDoctorResult(["deferred configured plugin repair"]),
    );

    expect(step.advisory).toEqual({
      kind: "package-post-install-doctor",
      message: expect.stringContaining("recoverable update-time repair warning"),
    });
    expect(step.stderrTail).toContain("doctor deferred repair");
    expect(step.stderrTail).toContain("deferred configured plugin repair");
  });

  it("keeps advisory diagnostics bounded after appending deferred repair details", () => {
    const step = markPackagePostInstallDoctorAdvisory(
      {
        exitCode: UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE,
        stderrTail: "doctor deferred repair",
        signal: null,
        killed: false,
        termination: "exit" as const,
      },
      createDeferredConfiguredPluginRepairDoctorResult([
        `deferred configured plugin repair ${"x".repeat(10_000)}`,
      ]),
    );

    expect(step.stderrTail).toHaveLength(8_001);
    expect(step.stderrTail).toMatch(/^…/u);
    expect(step.stderrTail).toContain("recoverable update-time repair warning");
  });

  it("does not mark unknown nonzero doctor exits as advisory", () => {
    const step = markPackagePostInstallDoctorAdvisory(
      {
        exitCode: 1,
        stderrTail: "doctor refused migration",
        signal: null,
        killed: false,
        termination: "exit" as const,
      },
      null,
    );

    expect(step.advisory).toBeUndefined();
    expect(step.stderrTail).toBe("doctor refused migration");
  });

  it("does not mark timed-out doctor exits as advisory when they report a code", () => {
    const step = markPackagePostInstallDoctorAdvisory(
      {
        exitCode: 124,
        stderrTail: "doctor timed out",
        signal: null,
        killed: true,
        termination: "timeout" as const,
      },
      createDeferredConfiguredPluginRepairDoctorResult(["deferred configured plugin repair"]),
    );

    expect(step.advisory).toBeUndefined();
    expect(step.stderrTail).toBe("doctor timed out");
  });
});

describe("runGlobalPackageUpdateSteps", () => {
  it("rolls back published replacements when post-publish cleanup fails", async () => {
    await withTempDir({ prefix: "openclaw-package-update-local-cleanup-fail-" }, async (base) => {
      const packageRoot = path.join(base, "package");
      const indexPath = path.join(packageRoot, "dist", "index.js");
      await writePackageRoot(packageRoot, "1.0.0");
      await fs.writeFile(indexPath, "export const local = true;\n", "utf8");

      const plan = await captureLocalPackageOverrides({ packageRoot });
      expect(plan).not.toBeNull();
      await writePackageRoot(packageRoot, "2.0.0");
      if (process.platform !== "win32") {
        await fs.chmod(indexPath, 0o600);
      }

      let cleanupFailed = false;
      __setFsSafeTestHooksForTest({
        beforeRootFallbackMutation: (operation, targetPath) => {
          if (
            !cleanupFailed &&
            operation === "remove" &&
            targetPath.includes(`${path.sep}.openclaw-override-previous-`)
          ) {
            cleanupFailed = true;
            throw createFsError("EACCES", "post-publish cleanup failed");
          }
        },
      });

      try {
        const result = await applyLocalPackageOverrides({
          packageRoot,
          plan,
          reapply: true,
        });

        expect(cleanupFailed).toBe(true);
        expect(result.status).toBe("error");
        expect(result.applied).toBe(0);
        expect(result.conflicts).toEqual([{ path: "dist/index.js", reason: "apply-failed" }]);
        await expect(fs.readFile(indexPath, "utf8")).resolves.toBe("export {};\n");
        if (process.platform !== "win32") {
          expect((await fs.stat(indexPath)).mode & 0o777).toBe(0o600);
        }
        expect(
          (await fs.readdir(path.dirname(indexPath))).filter((entry) =>
            entry.startsWith(".openclaw-override-"),
          ),
        ).toEqual([]);
      } finally {
        __setFsSafeTestHooksForTest(undefined);
      }
    });
  });

  it("preserves rollback data when a current replacement cannot restore", async () => {
    await withTempDir(
      { prefix: "openclaw-package-update-local-current-restore-" },
      async (base) => {
        const packageRoot = path.join(base, "package");
        const indexPath = path.join(packageRoot, "dist", "index.js");
        await writePackageRoot(packageRoot, "1.0.0");
        await fs.writeFile(indexPath, "export const local = true;\n", "utf8");

        const plan = await captureLocalPackageOverrides({ packageRoot });
        expect(plan).not.toBeNull();
        await writePackageRoot(packageRoot, "2.0.0");

        let cleanupFailed = false;
        __setFsSafeTestHooksForTest({
          beforeRootFallbackMutation: async (operation, targetPath) => {
            if (
              !cleanupFailed &&
              operation === "remove" &&
              targetPath.includes(`${path.sep}.openclaw-override-previous-`)
            ) {
              cleanupFailed = true;
              await fs.writeFile(indexPath, "export const concurrent = true;\n", "utf8");
              throw createFsError("EIO", "replacement cleanup failed");
            }
          },
        });

        try {
          const result = await applyLocalPackageOverrides({
            packageRoot,
            plan,
            reapply: true,
          });

          expect(cleanupFailed).toBe(true);
          expect(result.status).toBe("error");
          expect(result.applied).toBe(0);
          expect(result.conflicts).toEqual([{ path: "dist/index.js", reason: "rollback-failed" }]);
          expect(result.warnings.join("\n")).toContain("Rollback failed for dist/index.js");
          await expect(fs.readFile(indexPath, "utf8")).resolves.toBe(
            "export const concurrent = true;\n",
          );
          const recoveryDir = result.recoveryDir ?? "";
          const rollbackDir = (await fs.readdir(recoveryDir)).find((entry) =>
            entry.startsWith("rollback-"),
          );
          expect(rollbackDir).toBeDefined();
          await expect(
            fs.readFile(path.join(recoveryDir, rollbackDir ?? "", "dist/index.js"), "utf8"),
          ).resolves.toBe("export {};\n");
        } finally {
          __setFsSafeTestHooksForTest(undefined);
        }
      },
    );
  });

  it("preserves rollback data when a current deletion cannot restore", async () => {
    await withTempDir(
      { prefix: "openclaw-package-update-local-current-delete-restore-" },
      async (base) => {
        const packageRoot = path.join(base, "package");
        const indexPath = path.join(packageRoot, "dist", "index.js");
        await writePackageRoot(packageRoot, "1.0.0");
        await fs.rm(indexPath);

        const plan = await captureLocalPackageOverrides({ packageRoot });
        expect(plan).not.toBeNull();
        await writePackageRoot(packageRoot, "2.0.0");

        let deleteCleanupFailed = false;
        __setFsSafeTestHooksForTest({
          beforeRootFallbackMutation: async (operation, targetPath) => {
            if (
              !deleteCleanupFailed &&
              operation === "remove" &&
              targetPath.includes(`${path.sep}.openclaw-override-previous-`)
            ) {
              deleteCleanupFailed = true;
              await fs.writeFile(indexPath, "export const concurrent = true;\n", "utf8");
              throw createFsError("EIO", "deletion cleanup failed");
            }
          },
        });

        try {
          const result = await applyLocalPackageOverrides({
            packageRoot,
            plan,
            reapply: true,
          });

          expect(deleteCleanupFailed).toBe(true);
          expect(result.status).toBe("error");
          expect(result.applied).toBe(0);
          expect(result.conflicts).toEqual([{ path: "dist/index.js", reason: "rollback-failed" }]);
          expect(result.warnings.join("\n")).toContain("Rollback failed for dist/index.js");
          await expect(fs.readFile(indexPath, "utf8")).resolves.toBe(
            "export const concurrent = true;\n",
          );
          const recoveryDir = result.recoveryDir ?? "";
          const rollbackDir = (await fs.readdir(recoveryDir)).find((entry) =>
            entry.startsWith("rollback-"),
          );
          expect(rollbackDir).toBeDefined();
          await expect(
            fs.readFile(path.join(recoveryDir, rollbackDir ?? "", "dist/index.js"), "utf8"),
          ).resolves.toBe("export {};\n");
        } finally {
          __setFsSafeTestHooksForTest(undefined);
        }
      },
    );
  });

  it("reports and preserves rollback data when reapply rollback is incomplete", async () => {
    await withTempDir({ prefix: "openclaw-package-update-local-rollback-fail-" }, async (base) => {
      const prefix = path.join(base, "prefix");
      const globalRoot = path.join(prefix, "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      const indexPath = path.join(packageRoot, "dist", "index.js");
      const helperPath = path.join(packageRoot, "dist", "local-helper.js");
      await writePackageRoot(packageRoot, "1.0.0");
      await fs.writeFile(indexPath, "export const local = true;\n", "utf8");
      await fs.writeFile(helperPath, "export const helper = true;\n", "utf8");

      const runStep = vi.fn(
        async ({ name, argv, cwd, timeoutMs }): Promise<PackageUpdateStepResult> => {
          expect(timeoutMs).toBe(1000);
          if (name !== "global update") {
            throw new Error(`unexpected step ${name}`);
          }
          const prefixIndex = argv.indexOf("--prefix");
          const stagePrefix = argv[prefixIndex + 1];
          if (!stagePrefix) {
            throw new Error("missing staged prefix");
          }
          await writePackageRoot(
            path.join(stagePrefix, "lib", "node_modules", "openclaw"),
            "2.0.0",
          );
          return {
            name,
            command: argv.join(" "),
            cwd: cwd ?? process.cwd(),
            durationMs: 1,
            exitCode: 0,
          };
        },
      );
      const realRealpath = fs.realpath.bind(fs);
      let applyFailureTriggered = false;
      let rollbackRestoreBlocked = false;
      const realpathSpy = vi
        .spyOn(fs, "realpath")
        .mockImplementation(async (...args: Parameters<typeof fs.realpath>) => {
          const result = await realRealpath(...args);
          if (String(args[0]) !== path.dirname(indexPath)) {
            return result;
          }
          const entries = await fs.readdir(path.dirname(indexPath)).catch(() => [] as string[]);
          if (!entries.some((entry) => entry.startsWith(".openclaw-override-next-"))) {
            return result;
          }
          const indexContent = await fs.readFile(indexPath, "utf8").catch(() => null);
          const helperExists = await fs
            .access(helperPath)
            .then(() => true)
            .catch(() => false);
          if (
            !applyFailureTriggered &&
            indexContent === "export const local = true;\n" &&
            !helperExists
          ) {
            applyFailureTriggered = true;
            await fs.writeFile(helperPath, "export const concurrent = true;\n", "utf8");
          } else if (applyFailureTriggered && !rollbackRestoreBlocked && indexContent === null) {
            rollbackRestoreBlocked = true;
            await fs.writeFile(indexPath, "export const concurrent rollback = true;\n", "utf8");
          }
          return result;
        });

      try {
        const result = await runGlobalPackageUpdateSteps({
          installTarget: createNpmTarget(globalRoot),
          installSpec: "openclaw@2.0.0",
          packageName: "openclaw",
          packageRoot,
          runCommand: createRootRunner(globalRoot),
          runStep,
          reapplyLocalOverrides: true,
          timeoutMs: 1000,
        });

        expect(applyFailureTriggered).toBe(true);
        expect(rollbackRestoreBlocked).toBe(true);
        expect(result.failedStep?.name).toBe("local overrides");
        expect(result.localOverrides?.status).toBe("error");
        expect(result.localOverrides?.applied).toBe(0);
        expect(result.localOverrides?.conflicts).toEqual([
          { path: "dist/index.js", reason: "rollback-failed" },
          { path: "dist/local-helper.js", reason: "apply-failed" },
        ]);
        expect(result.localOverrides?.warnings.join("\n")).toContain(
          "package may be partially modified",
        );
        expect(result.localOverrides?.warnings.join("\n")).toContain(
          "Rollback failed for dist/index.js",
        );
        await expect(fs.readFile(indexPath, "utf8")).resolves.toBe(
          "export const concurrent rollback = true;\n",
        );
        const rollbackDir = (await fs.readdir(result.localOverrides?.recoveryDir ?? "")).find(
          (entry) => entry.startsWith("rollback-"),
        );
        expect(rollbackDir).toBeDefined();
        await expect(
          fs.readFile(
            path.join(result.localOverrides?.recoveryDir ?? "", rollbackDir ?? "", "dist/index.js"),
            "utf8",
          ),
        ).resolves.toBe("export {};\n");
      } finally {
        realpathSpy.mockRestore();
      }
    });
  });

  it("preserves rollback data when a rollback target cannot be safely removed", async () => {
    await withTempDir(
      { prefix: "openclaw-package-update-local-rollback-remove-" },
      async (base) => {
        const prefix = path.join(base, "prefix");
        const globalRoot = path.join(prefix, "lib", "node_modules");
        const packageRoot = path.join(globalRoot, "openclaw");
        const indexPath = path.join(packageRoot, "dist", "index.js");
        const helperPath = path.join(packageRoot, "dist", "local-helper.js");
        await writePackageRoot(packageRoot, "1.0.0");
        await fs.writeFile(indexPath, "export const local = true;\n", "utf8");
        await fs.writeFile(helperPath, "export const helper = true;\n", "utf8");

        const runStep = vi.fn(
          async ({ name, argv, cwd, timeoutMs }): Promise<PackageUpdateStepResult> => {
            expect(timeoutMs).toBe(1000);
            if (name !== "global update") {
              throw new Error(`unexpected step ${name}`);
            }
            const prefixIndex = argv.indexOf("--prefix");
            const stagePrefix = argv[prefixIndex + 1];
            if (!stagePrefix) {
              throw new Error("missing staged prefix");
            }
            await writePackageRoot(
              path.join(stagePrefix, "lib", "node_modules", "openclaw"),
              "2.0.0",
            );
            return {
              name,
              command: argv.join(" "),
              cwd: cwd ?? process.cwd(),
              durationMs: 1,
              exitCode: 0,
            };
          },
        );
        const realRealpath = fs.realpath.bind(fs);
        let applyFailureTriggered = false;
        const realpathSpy = vi
          .spyOn(fs, "realpath")
          .mockImplementation(async (...args: Parameters<typeof fs.realpath>) => {
            const result = await realRealpath(...args);
            if (String(args[0]) !== path.dirname(indexPath)) {
              return result;
            }
            const entries = await fs.readdir(path.dirname(indexPath)).catch(() => [] as string[]);
            const indexContent = await fs.readFile(indexPath, "utf8").catch(() => null);
            const helperExists = await fs
              .access(helperPath)
              .then(() => true)
              .catch(() => false);
            if (
              !applyFailureTriggered &&
              entries.some((entry) => entry.startsWith(".openclaw-override-next-")) &&
              indexContent === "export const local = true;\n" &&
              !helperExists
            ) {
              applyFailureTriggered = true;
              await fs.writeFile(helperPath, "export const concurrent = true;\n", "utf8");
            }
            return result;
          });
        __setFsSafeTestHooksForTest({
          beforeRootFallbackMutation: (operation, targetPath) => {
            if (
              applyFailureTriggered &&
              operation === "remove" &&
              targetPath.includes(`${path.sep}.openclaw-override-previous-`)
            ) {
              throw createFsError("EACCES", "rollback remove failed");
            }
          },
        });

        try {
          const result = await runGlobalPackageUpdateSteps({
            installTarget: createNpmTarget(globalRoot),
            installSpec: "openclaw@2.0.0",
            packageName: "openclaw",
            packageRoot,
            runCommand: createRootRunner(globalRoot),
            runStep,
            reapplyLocalOverrides: true,
            timeoutMs: 1000,
          });

          expect(result.failedStep?.name).toBe("local overrides");
          expect(result.localOverrides?.status).toBe("error");
          expect(result.localOverrides?.applied).toBe(0);
          expect(result.localOverrides?.conflicts).toEqual([
            { path: "dist/index.js", reason: "rollback-failed" },
            { path: "dist/local-helper.js", reason: "apply-failed" },
          ]);
          expect(result.localOverrides?.warnings.join("\n")).toContain(
            "Rollback failed for dist/index.js: remove partial target",
          );
          await expect(fs.readFile(indexPath, "utf8")).resolves.toBe(
            "export const local = true;\n",
          );
          const rollbackDir = (await fs.readdir(result.localOverrides?.recoveryDir ?? "")).find(
            (entry) => entry.startsWith("rollback-"),
          );
          expect(rollbackDir).toBeDefined();
        } finally {
          realpathSpy.mockRestore();
          __setFsSafeTestHooksForTest(undefined);
        }
      },
    );
  });

  it("keeps a successful staged swap when old package cleanup hits a transient Windows native module error", async () => {
    await withTempDir({ prefix: "openclaw-package-update-staged-cleanup-" }, async (base) => {
      const prefix = path.join(base, "prefix");
      const globalRoot = path.join(prefix, "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      await writePackageRoot(packageRoot, "1.0.0");

      const realRm = fs.rm;
      const rmSpy = vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
        const targetPath = String(target);
        if (
          targetPath.includes(`${path.sep}.openclaw-`) &&
          !targetPath.includes(".openclaw-update-stage-") &&
          !targetPath.includes(".openclaw-shim-backup-")
        ) {
          throw Object.assign(new Error("EPERM: operation not permitted, unlink native.node"), {
            code: "EPERM",
          });
        }
        return realRm(target, options);
      });

      try {
        const result = await runGlobalPackageUpdateSteps({
          installTarget: createNpmTarget(globalRoot),
          installSpec: "openclaw@2.0.0",
          packageName: "openclaw",
          packageRoot,
          runCommand: createRootRunner(globalRoot),
          runStep: async ({ name, argv, cwd }) => {
            const prefixIndex = argv.indexOf("--prefix");
            const stagePrefix = argv[prefixIndex + 1];
            if (!stagePrefix) {
              throw new Error("missing staged prefix");
            }
            const stageLayout = resolveNpmGlobalPrefixLayoutFromPrefix(stagePrefix);
            await writePackageRoot(path.join(stageLayout.globalRoot, "openclaw"), "2.0.0");
            return {
              name,
              command: argv.join(" "),
              cwd: cwd ?? process.cwd(),
              durationMs: 1,
              exitCode: 0,
            };
          },
          timeoutMs: 1000,
        });

        expect(result.failedStep).toBeNull();
        expect(result.afterVersion).toBe("2.0.0");
        const swapStep = result.steps.find((step) => step.name === "global install swap");
        expect(swapStep?.stdoutTail).toContain("preserved old package");
        const delayedCleanupDirs = (await fs.readdir(globalRoot)).filter((entry) =>
          entry.startsWith(".openclaw-"),
        );
        expect(delayedCleanupDirs).toHaveLength(1);
        await expect(
          fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
        ).resolves.toContain('"version":"2.0.0"');
      } finally {
        rmSpy.mockRestore();
      }
    });
  });

  it("does not run post-verify work when staged npm verification fails", async () => {
    await withTempDir({ prefix: "openclaw-package-update-verify-" }, async (base) => {
      const prefix = path.join(base, "prefix");
      const globalRoot = path.join(prefix, "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      await writePackageRoot(packageRoot, "1.0.0");
      const postVerifyStep = vi.fn();

      const result = await runGlobalPackageUpdateSteps({
        installTarget: createNpmTarget(globalRoot),
        installSpec: "openclaw@2.0.0",
        packageName: "openclaw",
        packageRoot,
        runCommand: createRootRunner(globalRoot),
        runStep: async ({ name, argv, cwd }) => {
          const prefixIndex = argv.indexOf("--prefix");
          const stagePrefix = argv[prefixIndex + 1];
          if (!stagePrefix) {
            throw new Error("missing staged prefix");
          }
          await writePackageRoot(
            path.join(stagePrefix, "lib", "node_modules", "openclaw"),
            "1.5.0",
          );
          return {
            name,
            command: argv.join(" "),
            cwd: cwd ?? process.cwd(),
            durationMs: 1,
            exitCode: 0,
          };
        },
        timeoutMs: 1000,
        postVerifyStep,
      });

      expect(result.failedStep?.name).toBe("global install verify");
      expect(result.steps.map((step) => step.name)).toEqual([
        "global update",
        "global install verify",
      ]);
      expect(result.steps.at(-1)?.stderrTail).toContain(
        "expected installed version 2.0.0, found 1.5.0",
      );
      expect(result.verifiedPackageRoot).toBe(packageRoot);
      expect(result.afterVersion).toBe("1.0.0");
      expect(postVerifyStep).not.toHaveBeenCalled();
      await expect(fs.readFile(path.join(packageRoot, "package.json"), "utf8")).resolves.toContain(
        '"version":"1.0.0"',
      );
    });
  });

  it("rejects stale staged content inventories before package swap", async () => {
    await withTempDir(
      { prefix: "openclaw-package-update-stale-content-inventory-" },
      async (base) => {
        const prefix = path.join(base, "prefix");
        const globalRoot = path.join(prefix, "lib", "node_modules");
        const packageRoot = path.join(globalRoot, "openclaw");
        await writePackageRoot(packageRoot, "1.0.0");

        const runStep = vi.fn(
          async ({ name, argv, cwd, timeoutMs }): Promise<PackageUpdateStepResult> => {
            expect(timeoutMs).toBe(1000);
            if (name !== "global update") {
              throw new Error(`unexpected step ${name}`);
            }
            const prefixIndex = argv.indexOf("--prefix");
            expect(prefixIndex).toBeGreaterThan(0);
            const stagePrefix = argv[prefixIndex + 1];
            if (!stagePrefix) {
              throw new Error("missing staged prefix");
            }
            const stagedPackageRoot = path.join(stagePrefix, "lib", "node_modules", "openclaw");
            await writePackageRoot(stagedPackageRoot, "2.0.0");
            await fs.writeFile(
              path.join(stagedPackageRoot, "dist", "index.js"),
              "export const stale = true;\n",
              "utf8",
            );
            return {
              name,
              command: argv.join(" "),
              cwd: cwd ?? process.cwd(),
              durationMs: 1,
              exitCode: 0,
            };
          },
        );

        const result = await runGlobalPackageUpdateSteps({
          installTarget: createNpmTarget(globalRoot),
          installSpec: "openclaw@2.0.0",
          packageName: "openclaw",
          packageRoot,
          runCommand: createRootRunner(globalRoot),
          runStep,
          timeoutMs: 1000,
        });

        expect(result.failedStep?.name).toBe("global install verify");
        expect(result.failedStep?.stderrTail).toContain("expected packaged file hashes");
        expect(result.steps.map((step) => step.name)).not.toContain("global install swap");
        await expect(
          fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
        ).resolves.toContain('"version":"1.0.0"');
      },
    );
  });

  it.runIf(process.platform !== "win32")(
    "restores the existing bin shim when staged shim replacement fails",
    async () => {
      await withTempDir({ prefix: "openclaw-package-update-shim-rollback-" }, async (base) => {
        const prefix = path.join(base, "prefix");
        const globalRoot = path.join(prefix, "lib", "node_modules");
        const packageRoot = path.join(globalRoot, "openclaw");
        const targetShim = path.join(prefix, "bin", "openclaw");
        await writePackageRoot(packageRoot, "1.0.0");
        await fs.writeFile(
          path.join(packageRoot, "dist", "index.js"),
          "export const local = true;\n",
          "utf8",
        );
        await fs.mkdir(path.dirname(targetShim), { recursive: true });
        await fs.writeFile(targetShim, "old shim\n", "utf8");

        let stagedShimForFailure: string | undefined;
        const realCopyFile = fs.copyFile.bind(fs);
        const copyFileSpy = vi
          .spyOn(fs, "copyFile")
          .mockImplementation(async (...args: Parameters<typeof fs.copyFile>) => {
            const [source] = args;
            if (stagedShimForFailure && String(source) === stagedShimForFailure) {
              throw createFsError("EACCES", "staged shim copy failed");
            }
            return await realCopyFile(...args);
          });

        let result: Awaited<ReturnType<typeof runGlobalPackageUpdateSteps>>;
        try {
          result = await runGlobalPackageUpdateSteps({
            installTarget: createNpmTarget(globalRoot),
            installSpec: "openclaw@2.0.0",
            packageName: "openclaw",
            packageRoot,
            runCommand: createRootRunner(globalRoot),
            runStep: async ({ name, argv, cwd }) => {
              const prefixIndex = argv.indexOf("--prefix");
              const stagePrefix = argv[prefixIndex + 1];
              if (!stagePrefix) {
                throw new Error("missing staged prefix");
              }
              await writePackageRoot(
                path.join(stagePrefix, "lib", "node_modules", "openclaw"),
                "2.0.0",
              );
              const stagedShim = path.join(stagePrefix, "bin", "openclaw");
              stagedShimForFailure = stagedShim;
              await fs.mkdir(path.dirname(stagedShim), { recursive: true });
              await fs.writeFile(stagedShim, "new shim\n", "utf8");
              return {
                name,
                command: argv.join(" "),
                cwd: cwd ?? process.cwd(),
                durationMs: 1,
                exitCode: 0,
              };
            },
            timeoutMs: 1000,
          });
        } finally {
          copyFileSpy.mockRestore();
        }

        expect(result.failedStep?.name).toBe("global install swap");
        expect(result.verifiedPackageRoot).toBe(packageRoot);
        expect(result.afterVersion).toBe("1.0.0");
        expect(result.localOverrides?.status).toBe("preserved");
        expect(result.localOverrides?.modified).toBe(1);
        await expect(
          fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
        ).resolves.toContain('"version":"1.0.0"');
        await expect(
          fs.readFile(
            path.join(result.localOverrides?.recoveryDir ?? "", "files", "dist", "index.js"),
            "utf8",
          ),
        ).resolves.toBe("export const local = true;\n");
        await expect(fs.readFile(targetShim, "utf8")).resolves.toBe("old shim\n");
      });
    },
  );

  it("cleans the staged npm prefix when the install command throws", async () => {
    await withTempDir({ prefix: "openclaw-package-update-cleanup-" }, async (base) => {
      const prefix = path.join(base, "prefix");
      const globalRoot = path.join(prefix, "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      await writePackageRoot(packageRoot, "1.0.0");

      let stagePrefix: string | undefined;
      await expect(
        runGlobalPackageUpdateSteps({
          installTarget: createNpmTarget(globalRoot),
          installSpec: "openclaw@2.0.0",
          packageName: "openclaw",
          packageRoot,
          runCommand: createRootRunner(globalRoot),
          runStep: async ({ argv }) => {
            const prefixIndex = argv.indexOf("--prefix");
            stagePrefix = argv[prefixIndex + 1];
            throw new Error("install crashed");
          },
          timeoutMs: 1000,
        }),
      ).rejects.toThrow("install crashed");

      if (stagePrefix === undefined) {
        throw new Error("expected staged install prefix");
      }
      await expectPathMissing(stagePrefix);
    });
  });
});
