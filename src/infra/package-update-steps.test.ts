// Covers package update step orchestration.
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { configureFsSafePython, getFsSafePythonConfig } from "@openclaw/fs-safe/config";
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

async function addHardlinkedPackageFile(packageRoot: string, linkRoot: string): Promise<void> {
  const packageFile = path.join(packageRoot, "dist", "index.js");
  await fs.mkdir(linkRoot, { recursive: true });
  await fs.link(packageFile, path.join(linkRoot, `${path.basename(packageRoot)}-index.js`));
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

function createPnpmTarget(globalRoot: string): ResolvedGlobalInstallTarget {
  return {
    manager: "pnpm",
    command: "pnpm",
    globalRoot,
    packageRoot: path.join(globalRoot, "openclaw"),
  };
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
  it("rejects recovery roots inside the package being updated", async () => {
    await withTempDir({ prefix: "openclaw-package-update-local-recovery-root-" }, async (base) => {
      const packageRoot = path.join(base, "package");
      const indexPath = path.join(packageRoot, "dist", "index.js");
      await writePackageRoot(packageRoot, "1.0.0");
      await fs.writeFile(indexPath, "export const local = true;\n", "utf8");

      const priorStateDir = process.env.OPENCLAW_STATE_DIR;
      process.env.OPENCLAW_STATE_DIR = path.join(packageRoot, "state");
      try {
        await expect(captureLocalPackageOverrides({ packageRoot })).rejects.toThrow(
          "local override recovery root must be outside package root",
        );
      } finally {
        if (priorStateDir === undefined) {
          delete process.env.OPENCLAW_STATE_DIR;
        } else {
          process.env.OPENCLAW_STATE_DIR = priorStateDir;
        }
      }
      await expectPathMissing(path.join(packageRoot, "state"));
    });
  });

  it.runIf(process.platform !== "win32")(
    "does not capture override payloads through symlinked source ancestors",
    async () => {
      await withTempDir(
        { prefix: "openclaw-package-update-local-capture-symlink-ancestor-" },
        async (base) => {
          const packageRoot = path.join(base, "package");
          const distPath = path.join(packageRoot, "dist");
          const preservedDistPath = path.join(packageRoot, "preserved-dist");
          const indexPath = path.join(distPath, "index.js");
          const outsideRoot = path.join(base, "outside");
          const outsideIndexPath = path.join(outsideRoot, "index.js");
          await writePackageRoot(packageRoot, "1.0.0");
          await fs.writeFile(indexPath, "export const local = true;\n", "utf8");
          await fs.mkdir(outsideRoot);
          await fs.writeFile(outsideIndexPath, "export const outside = true;\n", "utf8");

          let ancestorChanged = false;
          __setFsSafeTestHooksForTest({
            afterPreOpenLstat: async (filePath) => {
              if (!ancestorChanged && path.basename(filePath) === path.basename(indexPath)) {
                ancestorChanged = true;
                await fs.rename(distPath, preservedDistPath);
                await fs.symlink(outsideRoot, distPath, "dir");
              }
            },
          });

          try {
            await expect(captureLocalPackageOverrides({ packageRoot })).rejects.toMatchObject({
              code: expect.stringMatching(/outside-workspace|path-mismatch|symlink/),
            });
            expect(ancestorChanged).toBe(true);
            await expect(fs.readFile(outsideIndexPath, "utf8")).resolves.toBe(
              "export const outside = true;\n",
            );
          } finally {
            __setFsSafeTestHooksForTest(undefined);
          }
        },
      );
    },
  );

  it("does not classify baseline files replaced by directories as deletions", async () => {
    await withTempDir(
      { prefix: "openclaw-package-update-local-capture-non-file-" },
      async (base) => {
        const packageRoot = path.join(base, "package");
        const indexPath = path.join(packageRoot, "dist", "index.js");
        await writePackageRoot(packageRoot, "1.0.0");
        await fs.rm(indexPath);
        await fs.mkdir(indexPath);

        await expect(captureLocalPackageOverrides({ packageRoot })).rejects.toMatchObject({
          code: "not-file",
        });
        expect((await fs.stat(indexPath)).isDirectory()).toBe(true);
      },
    );
  });

  it.runIf(process.platform !== "win32")(
    "opens override capture reads nonblocking so unsupported entries cannot stall capture",
    async () => {
      await withTempDir(
        { prefix: "openclaw-package-update-local-capture-nonblocking-" },
        async (base) => {
          const packageRoot = path.join(base, "package");
          const indexPath = path.join(packageRoot, "dist", "index.js");
          await writePackageRoot(packageRoot, "1.0.0");
          await fs.writeFile(indexPath, "export const local = true;\n", "utf8");

          const openFlags: number[] = [];
          __setFsSafeTestHooksForTest({
            beforeOpen: (_filePath, flags) => {
              openFlags.push(flags);
            },
          });

          try {
            await expect(captureLocalPackageOverrides({ packageRoot })).resolves.not.toBeNull();
            expect(openFlags.length).toBeGreaterThan(0);
            expect(openFlags.every((flags) => (flags & fsConstants.O_NONBLOCK) !== 0)).toBe(true);
          } finally {
            __setFsSafeTestHooksForTest(undefined);
          }
        },
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not move updated targets when required fs-safe Python is unavailable",
    async () => {
      await withTempDir({ prefix: "openclaw-package-update-local-no-python-" }, async (base) => {
        const packageRoot = path.join(base, "package");
        const indexPath = path.join(packageRoot, "dist", "index.js");
        await writePackageRoot(packageRoot, "1.0.0");
        await fs.writeFile(indexPath, "export const local = true;\n", "utf8");

        const plan = await captureLocalPackageOverrides({ packageRoot });
        expect(plan).not.toBeNull();
        await writePackageRoot(packageRoot, "2.0.0");

        const previousPythonConfig = getFsSafePythonConfig();
        configureFsSafePython({
          mode: "off",
          pythonPath: path.join(base, "missing-python"),
        });
        try {
          const result = await applyLocalPackageOverrides({
            packageRoot,
            plan,
            reapply: true,
          });

          expect(result.status).toBe("error");
          expect(result.applied).toBe(0);
          expect(result.conflicts).toEqual([{ path: "dist/index.js", reason: "apply-failed" }]);
          await expect(fs.readFile(indexPath, "utf8")).resolves.toBe("export {};\n");
          expect(
            (await fs.readdir(path.dirname(indexPath))).filter((entry) =>
              entry.startsWith(".openclaw-override-"),
            ),
          ).toEqual([]);
        } finally {
          configureFsSafePython(previousPythonConfig);
        }
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not reapply added overrides through symlinked target ancestors",
    async () => {
      await withTempDir(
        { prefix: "openclaw-package-update-local-symlink-ancestor-" },
        async (base) => {
          const packageRoot = path.join(base, "package");
          const outsideRoot = path.join(base, "outside");
          const localAddedPath = path.join(packageRoot, "dist", "local", "added.js");
          await writePackageRoot(packageRoot, "1.0.0");
          await fs.mkdir(path.dirname(localAddedPath), { recursive: true });
          await fs.writeFile(localAddedPath, "export const local = true;\n", "utf8");

          const plan = await captureLocalPackageOverrides({ packageRoot });
          expect(plan).not.toBeNull();
          await fs.rm(path.join(packageRoot, "dist"), { recursive: true, force: true });
          await fs.mkdir(outsideRoot, { recursive: true });
          await fs.symlink(outsideRoot, path.join(packageRoot, "dist"), "dir");

          const result = await applyLocalPackageOverrides({
            packageRoot,
            plan,
            reapply: true,
          });

          expect(result.status).toBe("conflict");
          expect(result.applied).toBe(0);
          expect(result.conflicts).toEqual([
            { path: "dist/local/added.js", reason: "target-inspection-failed" },
          ]);
          await expectPathMissing(path.join(outsideRoot, "local", "added.js"));
        },
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not publish overrides when a target ancestor swaps at the final mutation boundary",
    async () => {
      await withTempDir(
        { prefix: "openclaw-package-update-local-publish-symlink-ancestor-" },
        async (base) => {
          const packageRoot = path.join(base, "package");
          const distPath = path.join(packageRoot, "dist");
          const preservedDistPath = path.join(packageRoot, "preserved-dist");
          const localAddedPath = path.join(distPath, "local.js");
          const outsideRoot = path.join(base, "outside");
          const outsideAddedPath = path.join(outsideRoot, "local.js");
          await writePackageRoot(packageRoot, "1.0.0");
          await fs.writeFile(localAddedPath, "export const local = true;\n", "utf8");

          const plan = await captureLocalPackageOverrides({ packageRoot });
          expect(plan).not.toBeNull();
          await writePackageRoot(packageRoot, "2.0.0");
          await fs.rm(localAddedPath);
          await writePackageDistInventory(packageRoot);
          await fs.mkdir(outsideRoot);

          const realRealpath = fs.realpath.bind(fs);
          let ancestorChanged = false;
          const realpathSpy = vi
            .spyOn(fs, "realpath")
            .mockImplementation(async (...args: Parameters<typeof fs.realpath>) => {
              const result = await realRealpath(...args);
              const entries =
                String(args[0]) === distPath
                  ? await fs.readdir(distPath).catch(() => [] as string[])
                  : [];
              if (
                !ancestorChanged &&
                entries.some((entry) => entry.startsWith(".openclaw-override-next-"))
              ) {
                ancestorChanged = true;
                await fs.rename(distPath, preservedDistPath);
                await fs.symlink(outsideRoot, distPath, "dir");
              }
              return result;
            });

          try {
            const result = await applyLocalPackageOverrides({
              packageRoot,
              plan,
              reapply: true,
            });

            expect(ancestorChanged).toBe(true);
            expect(result.status).toBe("error");
            expect(result.applied).toBe(0);
            await expectPathMissing(outsideAddedPath);
          } finally {
            realpathSpy.mockRestore();
          }
        },
      );
    },
  );

  it("does not reapply added overrides after the package root changes", async () => {
    await withTempDir({ prefix: "openclaw-package-update-local-root-swap-" }, async (base) => {
      const packageRoot = path.join(base, "package");
      const replacementRoot = path.join(base, "replacement");
      const preservedRoot = path.join(base, "preserved");
      const addedPath = path.join(packageRoot, "dist", "local.js");
      await writePackageRoot(packageRoot, "1.0.0");
      await fs.writeFile(addedPath, "export const local = true;\n", "utf8");

      const plan = await captureLocalPackageOverrides({ packageRoot });
      expect(plan).not.toBeNull();
      await writePackageRoot(packageRoot, "2.0.0");
      await fs.rm(addedPath);
      await writePackageDistInventory(packageRoot);
      await writePackageRoot(replacementRoot, "2.0.0");

      const realRealpath = fs.realpath.bind(fs);
      let rootChanged = false;
      const realpathSpy = vi
        .spyOn(fs, "realpath")
        .mockImplementation(async (...args: Parameters<typeof fs.realpath>) => {
          const result = await realRealpath(...args);
          if (!rootChanged && String(args[0]) === path.join(packageRoot, "dist")) {
            rootChanged = true;
            await fs.rename(packageRoot, preservedRoot);
            await fs.rename(replacementRoot, packageRoot);
          }
          return result;
        });

      try {
        const result = await applyLocalPackageOverrides({
          packageRoot,
          plan,
          reapply: true,
        });

        expect(rootChanged).toBe(true);
        expect(result.status).toBe("conflict");
        expect(result.applied).toBe(0);
        expect(result.conflicts).toEqual([
          { path: "dist/local.js", reason: "target-inspection-failed" },
        ]);
        await expectPathMissing(path.join(packageRoot, "dist", "local.js"));
        await expectPathMissing(path.join(preservedRoot, "dist", "local.js"));
      } finally {
        realpathSpy.mockRestore();
      }
    });
  });

  it.runIf(process.platform !== "win32").each([
    ["modified", "outside"],
    ["deleted", "outside"],
    ["added", "outside"],
    ["modified", "inside"],
    ["deleted", "inside"],
    ["added", "inside"],
  ] as const)(
    "does not reapply %s overrides after a target ancestor becomes an %s symlink",
    async (overrideKind, redirectKind) => {
      await withTempDir(
        {
          prefix: `openclaw-package-update-local-symlink-race-${overrideKind}-${redirectKind}-`,
        },
        async (base) => {
          const packageRoot = path.join(base, "package");
          const redirectRoot =
            redirectKind === "outside"
              ? path.join(base, "outside")
              : path.join(packageRoot, "redirect");
          const indexPath = path.join(packageRoot, "dist", "index.js");
          const addedPath = path.join(packageRoot, "dist", "local.js");
          const redirectIndexPath = path.join(redirectRoot, "index.js");
          const redirectAddedPath = path.join(redirectRoot, "local.js");
          await writePackageRoot(packageRoot, "1.0.0");
          if (overrideKind === "modified") {
            await fs.writeFile(indexPath, "export const local = true;\n", "utf8");
          } else if (overrideKind === "deleted") {
            await fs.rm(indexPath);
          } else {
            await fs.writeFile(addedPath, "export const local = true;\n", "utf8");
          }

          const plan = await captureLocalPackageOverrides({ packageRoot });
          expect(plan).not.toBeNull();
          await writePackageRoot(packageRoot, "2.0.0");
          if (overrideKind === "added") {
            await fs.rm(addedPath);
            await writePackageDistInventory(packageRoot);
          }
          await fs.mkdir(redirectRoot, { recursive: true });
          await fs.writeFile(redirectIndexPath, "export const redirect = true;\n", "utf8");

          const realMkdtemp = fs.mkdtemp.bind(fs);
          const mkdtempSpy = vi
            .spyOn(fs, "mkdtemp")
            .mockImplementation(async (prefixArg, options) => {
              if (prefixArg.endsWith(`${path.sep}rollback-`)) {
                await fs.rm(path.join(packageRoot, "dist"), { recursive: true, force: true });
                await fs.symlink(redirectRoot, path.join(packageRoot, "dist"), "dir");
              }
              return await realMkdtemp(prefixArg, options);
            });

          try {
            const result = await applyLocalPackageOverrides({
              packageRoot,
              plan,
              reapply: true,
            });

            expect(result.status).toBe("error");
            expect(result.applied).toBe(0);
            await expect(fs.readFile(redirectIndexPath, "utf8")).resolves.toBe(
              "export const redirect = true;\n",
            );
            await expectPathMissing(redirectAddedPath);
          } finally {
            mkdtempSpy.mockRestore();
          }
        },
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not hash replay targets after they are replaced with symlinks",
    async () => {
      await withTempDir(
        { prefix: "openclaw-package-update-local-hash-symlink-race-" },
        async (base) => {
          const packageRoot = path.join(base, "package");
          const indexPath = path.join(packageRoot, "dist", "index.js");
          const outsidePath = path.join(base, "outside.js");
          await writePackageRoot(packageRoot, "1.0.0");
          await fs.writeFile(indexPath, "export const local = true;\n", "utf8");

          const plan = await captureLocalPackageOverrides({ packageRoot });
          expect(plan).not.toBeNull();
          await writePackageRoot(packageRoot, "2.0.0");
          await fs.writeFile(outsidePath, "export const outside = true;\n", "utf8");
          const realIndexPath = await fs.realpath(indexPath);

          let targetReplaced = false;
          __setFsSafeTestHooksForTest({
            afterPreOpenLstat: async (filePath) => {
              if (!targetReplaced && filePath === realIndexPath) {
                targetReplaced = true;
                await fs.rm(indexPath);
                await fs.symlink(outsidePath, indexPath, "file");
              }
            },
          });

          try {
            const result = await applyLocalPackageOverrides({
              packageRoot,
              plan,
              reapply: true,
            });

            expect(targetReplaced).toBe(true);
            expect(result.status).toBe("conflict");
            expect(result.applied).toBe(0);
            expect(result.conflicts).toEqual([
              { path: "dist/index.js", reason: "target-inspection-failed" },
            ]);
            await expect(fs.readFile(outsidePath, "utf8")).resolves.toBe(
              "export const outside = true;\n",
            );
          } finally {
            __setFsSafeTestHooksForTest(undefined);
          }
        },
      );
    },
  );

  it.runIf(process.platform !== "win32").each(["modified", "deleted"] as const)(
    "does not reapply %s overrides over upstream mode changes",
    async (overrideKind) => {
      await withTempDir(
        { prefix: `openclaw-package-update-local-mode-${overrideKind}-` },
        async (base) => {
          const packageRoot = path.join(base, "package");
          const indexPath = path.join(packageRoot, "dist", "index.js");
          await writePackageRoot(packageRoot, "1.0.0");
          await fs.chmod(indexPath, 0o644);
          await writePackageDistInventory(packageRoot);
          if (overrideKind === "modified") {
            await fs.writeFile(indexPath, "export const local = true;\n", "utf8");
          } else {
            await fs.rm(indexPath);
          }

          const plan = await captureLocalPackageOverrides({ packageRoot });
          expect(plan).not.toBeNull();
          await fs.writeFile(indexPath, "export {};\n", "utf8");
          await fs.chmod(indexPath, 0o755);
          await writePackageDistInventory(packageRoot);

          const result = await applyLocalPackageOverrides({
            packageRoot,
            plan,
            reapply: true,
          });

          expect(result.status).toBe("conflict");
          expect(result.applied).toBe(0);
          expect(result.conflicts).toEqual([{ path: "dist/index.js", reason: "target-changed" }]);
          await expect(fs.readFile(indexPath, "utf8")).resolves.toBe("export {};\n");
          expect((await fs.stat(indexPath)).mode & 0o777).toBe(0o755);
        },
      );
    },
  );

  it.runIf(process.platform !== "win32")("captures and reapplies mode-only overrides", async () => {
    await withTempDir({ prefix: "openclaw-package-update-local-mode-only-" }, async (base) => {
      const packageRoot = path.join(base, "package");
      const indexPath = path.join(packageRoot, "dist", "index.js");
      await writePackageRoot(packageRoot, "1.0.0");
      await fs.chmod(indexPath, 0o644);
      await writePackageDistInventory(packageRoot);
      await fs.chmod(indexPath, 0o755);

      const plan = await captureLocalPackageOverrides({ packageRoot });
      expect(plan).not.toBeNull();
      expect(plan?.result.modified).toBe(1);

      await writePackageRoot(packageRoot, "2.0.0");
      await fs.chmod(indexPath, 0o644);
      await writePackageDistInventory(packageRoot);

      const result = await applyLocalPackageOverrides({
        packageRoot,
        plan,
        reapply: true,
      });

      expect(result.status).toBe("applied");
      expect(result.applied).toBe(1);
      await expect(fs.readFile(indexPath, "utf8")).resolves.toBe("export {};\n");
      expect((await fs.stat(indexPath)).mode & 0o777).toBe(0o755);
    });
  });

  it.runIf(process.platform !== "win32")(
    "captures and reapplies distinct executable-mask overrides",
    async () => {
      await withTempDir(
        { prefix: "openclaw-package-update-local-executable-mask-" },
        async (base) => {
          const packageRoot = path.join(base, "package");
          const indexPath = path.join(packageRoot, "dist", "index.js");
          await writePackageRoot(packageRoot, "1.0.0");
          await fs.chmod(indexPath, 0o755);
          await writePackageDistInventory(packageRoot);
          await fs.chmod(indexPath, 0o700);

          const plan = await captureLocalPackageOverrides({ packageRoot });
          expect(plan).not.toBeNull();
          expect(plan?.result.modified).toBe(1);

          await writePackageRoot(packageRoot, "2.0.0");
          await fs.chmod(indexPath, 0o755);
          await writePackageDistInventory(packageRoot);

          const result = await applyLocalPackageOverrides({
            packageRoot,
            plan,
            reapply: true,
          });

          expect(result.status).toBe("applied");
          expect(result.applied).toBe(1);
          expect((await fs.stat(indexPath)).mode & 0o777).toBe(0o744);
        },
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "ignores non-executable mode normalization during capture",
    async () => {
      await withTempDir(
        { prefix: "openclaw-package-update-local-mode-normalized-" },
        async (base) => {
          const packageRoot = path.join(base, "package");
          const indexPath = path.join(packageRoot, "dist", "index.js");
          await writePackageRoot(packageRoot, "1.0.0");
          await fs.chmod(indexPath, 0o644);
          await writePackageDistInventory(packageRoot);
          await fs.chmod(indexPath, 0o600);

          await expect(captureLocalPackageOverrides({ packageRoot })).resolves.toBeNull();
        },
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "reapplies byte overrides over non-executable mode normalization",
    async () => {
      await withTempDir({ prefix: "openclaw-package-update-local-mode-reapply-" }, async (base) => {
        const packageRoot = path.join(base, "package");
        const indexPath = path.join(packageRoot, "dist", "index.js");
        await writePackageRoot(packageRoot, "1.0.0");
        await fs.chmod(indexPath, 0o644);
        await writePackageDistInventory(packageRoot);
        await fs.writeFile(indexPath, "export const local = true;\n", "utf8");

        const plan = await captureLocalPackageOverrides({ packageRoot });
        expect(plan).not.toBeNull();
        await writePackageRoot(packageRoot, "2.0.0");
        await fs.chmod(indexPath, 0o644);
        await writePackageDistInventory(packageRoot);
        await fs.chmod(indexPath, 0o600);

        const result = await applyLocalPackageOverrides({
          packageRoot,
          plan,
          reapply: true,
        });

        expect(result.status).toBe("applied");
        expect(result.applied).toBe(1);
        expect(result.conflicts).toEqual([]);
        await expect(fs.readFile(indexPath, "utf8")).resolves.toBe("export const local = true;\n");
        expect((await fs.stat(indexPath)).mode & 0o777).toBe(0o600);
      });
    },
  );

  it("captures and reapplies locally added files excluded from package files", async () => {
    await withTempDir({ prefix: "openclaw-package-update-local-excluded-files-" }, async (base) => {
      const packageRoot = path.join(base, "package");
      const localFiles = new Map([
        ["dist/index.js.map", '{"version":3,"sources":["index.ts"]}\n'],
        ["dist/local-runtime.js", "export const local = true;\n"],
        ["dist/local-assets/theme.css", "body {}\n"],
        ["dist/local-assets/runtime.wasm", "local wasm\n"],
        ["dist/local-assets/settings.json", '{"local":true}\n'],
      ]);
      const writePackageJson = async (version: string) => {
        await fs.writeFile(
          path.join(packageRoot, "package.json"),
          JSON.stringify({
            name: "openclaw",
            version,
            files: ["dist/", "!dist/**/*.map", "!dist/local-runtime.js", "!dist/local-assets/**"],
          }),
          "utf8",
        );
      };
      await writePackageRoot(packageRoot, "1.0.0");
      await writePackageJson("1.0.0");
      await writePackageDistInventory(packageRoot);
      for (const [relativePath, content] of localFiles) {
        const filePath = path.join(packageRoot, relativePath);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, content, "utf8");
      }

      const plan = await captureLocalPackageOverrides({ packageRoot });
      expect(plan).not.toBeNull();
      expect(plan?.result.added).toBe(localFiles.size);

      await writePackageRoot(packageRoot, "2.0.0");
      await writePackageJson("2.0.0");
      for (const relativePath of localFiles.keys()) {
        await fs.rm(path.join(packageRoot, relativePath));
      }
      await writePackageDistInventory(packageRoot);

      const result = await applyLocalPackageOverrides({
        packageRoot,
        plan,
        reapply: true,
      });

      expect(result.status).toBe("applied");
      expect(result.applied).toBe(localFiles.size);
      for (const [relativePath, content] of localFiles) {
        await expect(fs.readFile(path.join(packageRoot, relativePath), "utf8")).resolves.toBe(
          content,
        );
      }
    });
  });

  it.runIf(process.platform !== "win32")(
    "does not reapply overrides after an unrecorded installed mode change",
    async () => {
      await withTempDir({ prefix: "openclaw-package-update-local-actual-mode-" }, async (base) => {
        const packageRoot = path.join(base, "package");
        const indexPath = path.join(packageRoot, "dist", "index.js");
        await writePackageRoot(packageRoot, "1.0.0");
        await fs.chmod(indexPath, 0o644);
        await writePackageDistInventory(packageRoot);
        await fs.writeFile(indexPath, "export const local = true;\n", "utf8");

        const plan = await captureLocalPackageOverrides({ packageRoot });
        expect(plan).not.toBeNull();
        await fs.writeFile(indexPath, "export {};\n", "utf8");
        await fs.chmod(indexPath, 0o644);
        await writePackageDistInventory(packageRoot);
        await fs.chmod(indexPath, 0o755);

        const result = await applyLocalPackageOverrides({
          packageRoot,
          plan,
          reapply: true,
        });

        expect(result.status).toBe("conflict");
        expect(result.applied).toBe(0);
        expect(result.conflicts).toEqual([{ path: "dist/index.js", reason: "target-changed" }]);
        await expect(fs.readFile(indexPath, "utf8")).resolves.toBe("export {};\n");
        expect((await fs.stat(indexPath)).mode & 0o777).toBe(0o755);
      });
    },
  );

  it.each(["modified", "deleted"] as const)(
    "does not reapply %s overrides after an unrecorded installed byte change",
    async (overrideKind) => {
      await withTempDir(
        { prefix: `openclaw-package-update-local-actual-bytes-${overrideKind}-` },
        async (base) => {
          const packageRoot = path.join(base, "package");
          const indexPath = path.join(packageRoot, "dist", "index.js");
          await writePackageRoot(packageRoot, "1.0.0");
          if (overrideKind === "modified") {
            await fs.writeFile(indexPath, "export const local = true;\n", "utf8");
          } else {
            await fs.rm(indexPath);
          }

          const plan = await captureLocalPackageOverrides({ packageRoot });
          expect(plan).not.toBeNull();
          await fs.writeFile(indexPath, "export {};\n", "utf8");
          await writePackageDistInventory(packageRoot);
          await fs.writeFile(indexPath, "export const changedAfterVerify = true;\n", "utf8");

          const result = await applyLocalPackageOverrides({
            packageRoot,
            plan,
            reapply: true,
          });

          expect(result.status).toBe("conflict");
          expect(result.applied).toBe(0);
          expect(result.conflicts).toEqual([{ path: "dist/index.js", reason: "target-changed" }]);
          await expect(fs.readFile(indexPath, "utf8")).resolves.toBe(
            "export const changedAfterVerify = true;\n",
          );
        },
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not overwrite a modified target changed after replay preflight",
    async () => {
      await withTempDir({ prefix: "openclaw-package-update-local-late-replace-" }, async (base) => {
        const packageRoot = path.join(base, "package");
        const indexPath = path.join(packageRoot, "dist", "index.js");
        await writePackageRoot(packageRoot, "1.0.0");
        await fs.writeFile(indexPath, "export const local = true;\n", "utf8");

        const plan = await captureLocalPackageOverrides({ packageRoot });
        expect(plan).not.toBeNull();
        await writePackageRoot(packageRoot, "2.0.0");

        const realMkdtemp = fs.mkdtemp.bind(fs);
        let targetChanged = false;
        const mkdtempSpy = vi
          .spyOn(fs, "mkdtemp")
          .mockImplementation(async (prefixArg, options) => {
            const result = await realMkdtemp(prefixArg, options);
            if (!targetChanged && prefixArg.endsWith(`${path.sep}rollback-`)) {
              targetChanged = true;
              await fs.writeFile(indexPath, "export const concurrent = true;\n", "utf8");
            }
            return result;
          });

        try {
          const result = await applyLocalPackageOverrides({
            packageRoot,
            plan,
            reapply: true,
          });

          expect(targetChanged).toBe(true);
          expect(result.status).toBe("error");
          expect(result.applied).toBe(0);
          await expect(fs.readFile(indexPath, "utf8")).resolves.toBe(
            "export const concurrent = true;\n",
          );
        } finally {
          mkdtempSpy.mockRestore();
        }
      });
    },
  );

  it("does not overwrite a target created at the final replacement boundary", async () => {
    await withTempDir({ prefix: "openclaw-package-update-local-final-replace-" }, async (base) => {
      const packageRoot = path.join(base, "package");
      const indexPath = path.join(packageRoot, "dist", "index.js");
      await writePackageRoot(packageRoot, "1.0.0");
      await fs.writeFile(indexPath, "export const local = true;\n", "utf8");

      const plan = await captureLocalPackageOverrides({ packageRoot });
      expect(plan).not.toBeNull();
      await writePackageRoot(packageRoot, "2.0.0");

      const realRealpath = fs.realpath.bind(fs);
      let targetChanged = false;
      const realpathSpy = vi
        .spyOn(fs, "realpath")
        .mockImplementation(async (...args: Parameters<typeof fs.realpath>) => {
          const result = await realRealpath(...args);
          const entries =
            String(args[0]) === path.dirname(indexPath)
              ? await fs.readdir(path.dirname(indexPath)).catch(() => [] as string[])
              : [];
          if (
            !targetChanged &&
            entries.some((entry) => entry.startsWith(".openclaw-override-next-"))
          ) {
            targetChanged = true;
            await fs.writeFile(indexPath, "export const concurrent = true;\n", "utf8");
          }
          return result;
        });

      try {
        const result = await applyLocalPackageOverrides({
          packageRoot,
          plan,
          reapply: true,
        });

        expect(targetChanged).toBe(true);
        expect(result.status).toBe("error");
        expect(result.applied).toBe(0);
        await expect(fs.readFile(indexPath, "utf8")).resolves.toBe(
          "export const concurrent = true;\n",
        );
        expect(
          (await fs.readdir(path.dirname(indexPath))).filter((entry) =>
            entry.startsWith(".openclaw-override-"),
          ),
        ).toEqual([]);
      } finally {
        realpathSpy.mockRestore();
      }
    });
  });

  it("does not delete a target changed at the final deletion boundary", async () => {
    await withTempDir({ prefix: "openclaw-package-update-local-late-delete-" }, async (base) => {
      const packageRoot = path.join(base, "package");
      const indexPath = path.join(packageRoot, "dist", "index.js");
      await writePackageRoot(packageRoot, "1.0.0");
      await fs.rm(indexPath);

      const plan = await captureLocalPackageOverrides({ packageRoot });
      expect(plan).not.toBeNull();
      await writePackageRoot(packageRoot, "2.0.0");

      let targetChanged = false;
      __setFsSafeTestHooksForTest({
        beforeRootFallbackMutation: async (operation, targetPath) => {
          if (
            !targetChanged &&
            operation === "move" &&
            path.basename(targetPath).startsWith(".openclaw-override-previous-")
          ) {
            targetChanged = true;
            await fs.writeFile(indexPath, "export const concurrent = true;\n", "utf8");
          }
        },
      });

      try {
        const result = await applyLocalPackageOverrides({
          packageRoot,
          plan,
          reapply: true,
        });

        expect(targetChanged).toBe(true);
        expect(result.status).toBe("error");
        expect(result.applied).toBe(0);
        await expect(fs.readFile(indexPath, "utf8")).resolves.toBe(
          "export const concurrent = true;\n",
        );
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

  it("does not report a deletion applied when the target is recreated during cleanup", async () => {
    await withTempDir(
      { prefix: "openclaw-package-update-local-recreated-delete-" },
      async (base) => {
        const packageRoot = path.join(base, "package");
        const indexPath = path.join(packageRoot, "dist", "index.js");
        await writePackageRoot(packageRoot, "1.0.0");
        await fs.rm(indexPath);

        const plan = await captureLocalPackageOverrides({ packageRoot });
        expect(plan).not.toBeNull();
        await writePackageRoot(packageRoot, "2.0.0");

        let targetRecreated = false;
        __setFsSafeTestHooksForTest({
          beforeRootFallbackMutation: async (operation, targetPath) => {
            if (
              !targetRecreated &&
              operation === "remove" &&
              path.basename(targetPath).startsWith(".openclaw-override-previous-")
            ) {
              targetRecreated = true;
              await fs.writeFile(indexPath, "export const concurrent = true;\n", "utf8");
            }
          },
        });

        try {
          const result = await applyLocalPackageOverrides({
            packageRoot,
            plan,
            reapply: true,
          });

          expect(targetRecreated).toBe(true);
          expect(result.status).toBe("error");
          expect(result.applied).toBe(0);
          await expect(fs.readFile(indexPath, "utf8")).resolves.toBe(
            "export const concurrent = true;\n",
          );
        } finally {
          __setFsSafeTestHooksForTest(undefined);
        }
      },
    );
  });

  it.runIf(process.platform !== "win32")(
    "does not mutate a redirect target when a deletion ancestor swaps at the mutation boundary",
    async () => {
      await withTempDir(
        { prefix: "openclaw-package-update-local-delete-topology-" },
        async (base) => {
          const packageRoot = path.join(base, "package");
          const distPath = path.join(packageRoot, "dist");
          const preservedDistPath = path.join(packageRoot, "preserved-dist");
          const indexPath = path.join(distPath, "index.js");
          const outsideRoot = path.join(base, "outside");
          const outsideIndexPath = path.join(outsideRoot, "index.js");
          await writePackageRoot(packageRoot, "1.0.0");
          await fs.rm(indexPath);

          const plan = await captureLocalPackageOverrides({ packageRoot });
          expect(plan).not.toBeNull();
          await writePackageRoot(packageRoot, "2.0.0");
          await fs.mkdir(outsideRoot);
          await fs.writeFile(outsideIndexPath, "export const outside = true;\n", "utf8");

          let topologyChanged = false;
          __setFsSafeTestHooksForTest({
            beforeRootFallbackMutation: async (operation, targetPath) => {
              if (
                !topologyChanged &&
                operation === "move" &&
                path.basename(targetPath).startsWith(".openclaw-override-previous-")
              ) {
                topologyChanged = true;
                await fs.rename(distPath, preservedDistPath);
                await fs.symlink(outsideRoot, distPath, "dir");
              }
            },
          });

          try {
            const result = await applyLocalPackageOverrides({
              packageRoot,
              plan,
              reapply: true,
            });

            expect(topologyChanged).toBe(true);
            expect(result.status).toBe("error");
            expect(result.applied).toBe(0);
            await expect(fs.readFile(outsideIndexPath, "utf8")).resolves.toBe(
              "export const outside = true;\n",
            );
            await expect(
              fs.readFile(path.join(preservedDistPath, "index.js"), "utf8"),
            ).resolves.toBe("export {};\n");
          } finally {
            __setFsSafeTestHooksForTest(undefined);
          }
        },
      );
    },
  );

  it("treats deletions already satisfied by the updated package as a no-op", async () => {
    await withTempDir(
      { prefix: "openclaw-package-update-local-deleted-upstream-" },
      async (base) => {
        const packageRoot = path.join(base, "package");
        const indexPath = path.join(packageRoot, "dist", "index.js");
        await writePackageRoot(packageRoot, "1.0.0");
        await fs.rm(indexPath);

        const plan = await captureLocalPackageOverrides({ packageRoot });
        expect(plan).not.toBeNull();
        await writePackageRoot(packageRoot, "2.0.0");
        await fs.rm(indexPath);
        await writePackageDistInventory(packageRoot);

        const result = await applyLocalPackageOverrides({
          packageRoot,
          plan,
          reapply: true,
        });

        expect(result.status).toBe("applied");
        expect(result.applied).toBe(0);
        expect(result.conflicts).toEqual([]);
        await expectPathMissing(indexPath);
      },
    );
  });

  it.runIf(process.platform !== "win32")(
    "reapplies overrides when Windows reports synthetic installed modes",
    async () => {
      await withTempDir({ prefix: "openclaw-package-update-local-windows-mode-" }, async (base) => {
        const packageRoot = path.join(base, "package");
        const indexPath = path.join(packageRoot, "dist", "index.js");
        await writePackageRoot(packageRoot, "1.0.0");
        await fs.chmod(indexPath, 0o644);
        await writePackageDistInventory(packageRoot);
        await fs.writeFile(indexPath, "export const local = true;\n", "utf8");

        const plan = await captureLocalPackageOverrides({ packageRoot });
        expect(plan).not.toBeNull();
        await fs.writeFile(indexPath, "export {};\n", "utf8");
        await fs.chmod(indexPath, 0o644);
        await writePackageDistInventory(packageRoot);
        await fs.chmod(indexPath, 0o666);

        const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
        let result;
        try {
          result = await applyLocalPackageOverrides({
            packageRoot,
            plan,
            reapply: true,
          });
        } finally {
          platformSpy.mockRestore();
        }

        expect(result.status).toBe("applied");
        expect(result.applied).toBe(1);
        expect(result.conflicts).toEqual([]);
        await expect(fs.readFile(indexPath, "utf8")).resolves.toBe("export const local = true;\n");
      });
    },
  );

  it("installs npm updates into a clean staged prefix before swapping the global package", async () => {
    await withTempDir({ prefix: "openclaw-package-update-staged-" }, async (base) => {
      const prefix = path.join(base, "prefix");
      const globalRoot = path.join(prefix, "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      await writePackageRoot(packageRoot, "1.0.0");
      await fs.mkdir(path.join(packageRoot, "dist", "extensions", "qa-channel"), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(packageRoot, "dist", "extensions", "qa-channel", "runtime-api.js"),
        "export {};\n",
        "utf8",
      );

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
          expect(path.dirname(stagePrefix)).toBe(globalRoot);
          await writePackageRoot(
            path.join(stagePrefix, "lib", "node_modules", "openclaw"),
            "2.0.0",
          );
          await fs.mkdir(path.join(stagePrefix, "bin"), { recursive: true });
          await fs.symlink(
            "../lib/node_modules/openclaw/dist/index.js",
            path.join(stagePrefix, "bin", "openclaw"),
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
        reapplyLocalOverrides: true,
        timeoutMs: 1000,
      });

      expect(result.failedStep).toBeNull();
      expect(result.verifiedPackageRoot).toBe(packageRoot);
      expect(result.afterVersion).toBe("2.0.0");
      expect(result.steps.map((step) => step.name)).toEqual([
        "global update",
        "global install swap",
      ]);
      await expect(fs.readFile(path.join(packageRoot, "package.json"), "utf8")).resolves.toContain(
        '"version":"2.0.0"',
      );
      await expectPathMissing(
        path.join(packageRoot, "dist", "extensions", "qa-channel", "runtime-api.js"),
      );
      await expect(fs.readlink(path.join(prefix, "bin", "openclaw"))).resolves.toBe(
        "../lib/node_modules/openclaw/dist/index.js",
      );
    });
  });

  it("reapplies local dist overrides created while a staged package is prepared", async () => {
    await withTempDir({ prefix: "openclaw-package-update-local-overrides-" }, async (base) => {
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
          await writePackageRoot(
            path.join(stagePrefix, "lib", "node_modules", "openclaw"),
            "2.0.0",
          );
          await fs.writeFile(
            path.join(packageRoot, "dist", "index.js"),
            "import './local-helper.js?local';\nexport const local = true;\n",
            "utf8",
          );
          await fs.writeFile(
            path.join(packageRoot, "dist", "local-helper.js"),
            "export const helper = true;\n",
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
        reapplyLocalOverrides: true,
        timeoutMs: 1000,
      });

      expect(result.failedStep).toBeNull();
      expect(result.localOverrides?.status).toBe("applied");
      expect(result.localOverrides?.modified).toBe(1);
      expect(result.localOverrides?.added).toBe(1);
      expect(result.localOverrides?.applied).toBe(2);
      expect(result.steps.map((step) => step.name)).toContain("local overrides");
      await expect(fs.readFile(path.join(packageRoot, "dist", "index.js"), "utf8")).resolves.toBe(
        "import './local-helper.js?local';\nexport const local = true;\n",
      );
      await expect(
        fs.readFile(path.join(packageRoot, "dist", "local-helper.js"), "utf8"),
      ).resolves.toBe("export const helper = true;\n");
    });
  });

  it("preserves local dist overrides created at the staged swap boundary", async () => {
    await withTempDir({ prefix: "openclaw-package-update-local-swap-boundary-" }, async (base) => {
      const prefix = path.join(base, "prefix");
      const globalRoot = path.join(prefix, "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      const lateOverridePath = path.join(packageRoot, "dist", "late-local.js");
      await writePackageRoot(packageRoot, "1.0.0");

      const realRename = fs.rename.bind(fs);
      let lateOverrideCreated = false;
      const renameSpy = vi
        .spyOn(fs, "rename")
        .mockImplementation(async (...args: Parameters<typeof fs.rename>) => {
          if (!lateOverrideCreated && String(args[0]) === packageRoot) {
            lateOverrideCreated = true;
            await fs.writeFile(lateOverridePath, "export const late = true;\n", "utf8");
          }
          return await realRename(...args);
        });

      try {
        const result = await runGlobalPackageUpdateSteps({
          installTarget: createNpmTarget(globalRoot),
          installSpec: "openclaw@2.0.0",
          packageName: "openclaw",
          packageRoot,
          runCommand: createRootRunner(globalRoot),
          runStep: async ({ name, argv, cwd }) => {
            const stagePrefix = argv[argv.indexOf("--prefix") + 1];
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
          timeoutMs: 1000,
        });

        expect(lateOverrideCreated).toBe(true);
        expect(result.failedStep).toBeNull();
        expect(result.localOverrides?.status).toBe("preserved");
        expect(result.localOverrides?.added).toBe(1);
        await expectPathMissing(lateOverridePath);
        await expect(
          fs.readFile(
            path.join(result.localOverrides?.recoveryDir ?? "", "files", "dist", "late-local.js"),
            "utf8",
          ),
        ).resolves.toBe("export const late = true;\n");
        await expect(
          fs
            .readFile(path.join(result.localOverrides?.recoveryDir ?? "", "manifest.json"), "utf8")
            .then((contents) => JSON.parse(contents)),
        ).resolves.toMatchObject({ packageRoot });
      } finally {
        renameSpy.mockRestore();
      }
    });
  });

  it("rejects staged recapture recovery roots inside the recorded live package path", async () => {
    await withTempDir({ prefix: "openclaw-package-update-local-swap-recovery-" }, async (base) => {
      const prefix = path.join(base, "prefix");
      const globalRoot = path.join(prefix, "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      const lateOverridePath = path.join(packageRoot, "dist", "late-local.js");
      const stateDir = path.join(packageRoot, "state");
      await writePackageRoot(packageRoot, "1.0.0");

      const priorStateDir = process.env.OPENCLAW_STATE_DIR;
      process.env.OPENCLAW_STATE_DIR = stateDir;
      const realRename = fs.rename.bind(fs);
      let lateOverrideCreated = false;
      const renameSpy = vi
        .spyOn(fs, "rename")
        .mockImplementation(async (...args: Parameters<typeof fs.rename>) => {
          if (!lateOverrideCreated && String(args[0]) === packageRoot) {
            lateOverrideCreated = true;
            await fs.writeFile(lateOverridePath, "export const late = true;\n", "utf8");
          }
          return await realRename(...args);
        });

      try {
        const result = await runGlobalPackageUpdateSteps({
          installTarget: createNpmTarget(globalRoot),
          installSpec: "openclaw@2.0.0",
          packageName: "openclaw",
          packageRoot,
          runCommand: createRootRunner(globalRoot),
          runStep: async ({ name, argv, cwd }) => {
            const stagePrefix = argv[argv.indexOf("--prefix") + 1];
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
          timeoutMs: 1000,
        });

        expect(lateOverrideCreated).toBe(true);
        expect(result.failedStep?.name).toBe("local overrides");
        expect(result.failedStep?.stderrTail).toContain(
          "local override recovery root must be outside package root",
        );
        expect(result.afterVersion).toBe("1.0.0");
        await expect(
          fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
        ).resolves.toContain('"version":"1.0.0"');
        await expect(fs.readFile(lateOverridePath, "utf8")).resolves.toBe(
          "export const late = true;\n",
        );
        await expectPathMissing(stateDir);
      } finally {
        renameSpy.mockRestore();
        if (priorStateDir === undefined) {
          delete process.env.OPENCLAW_STATE_DIR;
        } else {
          process.env.OPENCLAW_STATE_DIR = priorStateDir;
        }
      }
    });
  });

  it("preserves local dist overrides without reapplying by default", async () => {
    await withTempDir({ prefix: "openclaw-package-update-local-preserved-" }, async (base) => {
      const prefix = path.join(base, "prefix");
      const globalRoot = path.join(prefix, "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      await writePackageRoot(packageRoot, "1.0.0");
      await fs.writeFile(
        path.join(packageRoot, "dist", "index.js"),
        "export const local = true;\n",
        "utf8",
      );

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

      const result = await runGlobalPackageUpdateSteps({
        installTarget: createNpmTarget(globalRoot),
        installSpec: "openclaw@2.0.0",
        packageName: "openclaw",
        packageRoot,
        runCommand: createRootRunner(globalRoot),
        runStep,
        timeoutMs: 1000,
      });

      expect(result.failedStep).toBeNull();
      expect(result.localOverrides?.status).toBe("preserved");
      expect(result.localOverrides?.modified).toBe(1);
      expect(result.localOverrides?.applied).toBe(0);
      expect(path.basename(result.localOverrides?.recoveryDir ?? "")).toMatch(
        /^openclaw-local-overrides-/u,
      );
      expect(path.dirname(result.localOverrides?.recoveryDir ?? "")).toBe(
        path.join(packageUpdateTestStateDir, "update-recovery"),
      );
      expect(result.localOverrides?.recoveryDir?.startsWith(globalRoot)).toBe(false);
      await expect(fs.readFile(path.join(packageRoot, "dist", "index.js"), "utf8")).resolves.toBe(
        "export {};\n",
      );
      await expect(
        fs.readFile(
          path.join(result.localOverrides?.recoveryDir ?? "", "files", "dist", "index.js"),
          "utf8",
        ),
      ).resolves.toBe("export const local = true;\n");
    });
  });

  it("preserves standalone local added dist files without requiring importer changes", async () => {
    await withTempDir(
      { prefix: "openclaw-package-update-local-standalone-added-" },
      async (base) => {
        const prefix = path.join(base, "prefix");
        const globalRoot = path.join(prefix, "lib", "node_modules");
        const packageRoot = path.join(globalRoot, "openclaw");
        await writePackageRoot(packageRoot, "1.0.0");
        await fs.writeFile(
          path.join(packageRoot, "dist", "local-data.json"),
          '{"local":true}\n',
          "utf8",
        );

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

        const result = await runGlobalPackageUpdateSteps({
          installTarget: createNpmTarget(globalRoot),
          installSpec: "openclaw@2.0.0",
          packageName: "openclaw",
          packageRoot,
          runCommand: createRootRunner(globalRoot),
          runStep,
          timeoutMs: 1000,
        });

        expect(result.failedStep).toBeNull();
        expect(result.localOverrides?.status).toBe("preserved");
        expect(result.localOverrides?.added).toBe(1);
        expect(result.localOverrides?.modified).toBe(0);
        expect(result.localOverrides?.applied).toBe(0);
        await expectPathMissing(path.join(packageRoot, "dist", "local-data.json"));
        await expect(
          fs.readFile(
            path.join(result.localOverrides?.recoveryDir ?? "", "files", "dist", "local-data.json"),
            "utf8",
          ),
        ).resolves.toBe('{"local":true}\n');
      },
    );
  });

  it.each([
    {
      featureRelativePath: "dist/local-feature.js",
      helperRelativePath: "dist/local-helper.js",
      name: "spaced import",
      source: 'import "./local-helper.js";\n',
    },
    {
      featureRelativePath: "dist/local-feature.js",
      helperRelativePath: "dist/local-helper.js",
      name: "minified import",
      source: 'import"./local-helper.js";\n',
    },
    {
      featureRelativePath: "dist/local-feature.js",
      helperRelativePath: "dist/local-helper-AbC12345.js",
      name: "content-hashed helper import",
      source: 'import "./local-helper-AbC12345.js";\n',
    },
    {
      featureRelativePath: "dist/local-feature.js",
      helperRelativePath: "dist/local-helper.js",
      name: "minified re-export",
      source: 'export*from"./local-helper.js";\n',
    },
    {
      featureRelativePath: "dist/local-feature.js",
      helperRelativePath: "dist/local-helper-AbC12345.js",
      name: "content-hashed commented dynamic import",
      source: 'void import(/* webpackChunkName: "local" */ "./local-helper-AbC12345.js");\n',
    },
    {
      featureRelativePath: "dist/local-feature.js",
      helperRelativePath: "dist/local-helper-AbC12345.js",
      name: "content-hashed template dynamic import",
      source: "void import(`./local-helper-AbC12345.js`);\n",
    },
    {
      featureRelativePath: "dist/local-feature.js",
      helperRelativePath: "dist/local-helper/index.mjs",
      name: "extensionless mjs index import",
      source: 'import "./local-helper";\n',
    },
    {
      featureRelativePath: "dist/local-feature.js",
      helperRelativePath: "dist/local-helper/index.cjs",
      name: "extensionless cjs index import",
      source: 'require("./local-helper");\n',
    },
    {
      featureRelativePath: "dist/local-feature.js",
      helperRelativePath: "dist/local-helper-AbC12345.js",
      name: "content-hashed runtime path string",
      source: 'const helperPath = "./local-helper-AbC12345.js";\n',
    },
    {
      featureRelativePath: "dist/local-feature.css",
      helperRelativePath: "dist/local-font.woff2",
      name: "CSS URL",
      source: 'body { font-family: local; src: url("./local-font.woff2"); }\n',
    },
  ])(
    "does not partially reapply standalone added dependency trees with $name",
    async ({ featureRelativePath, helperRelativePath, source }) => {
      await withTempDir(
        { prefix: "openclaw-package-update-local-standalone-tree-" },
        async (base) => {
          const prefix = path.join(base, "prefix");
          const globalRoot = path.join(prefix, "lib", "node_modules");
          const packageRoot = path.join(globalRoot, "openclaw");
          const featurePath = path.join(packageRoot, featureRelativePath);
          const helperPath = path.join(packageRoot, helperRelativePath);
          await writePackageRoot(packageRoot, "1.0.0");
          await fs.mkdir(path.dirname(featurePath), { recursive: true });
          await fs.writeFile(featurePath, source, "utf8");
          await fs.mkdir(path.dirname(helperPath), { recursive: true });
          await fs.writeFile(helperPath, "export const local = true;\n", "utf8");

          const result = await runGlobalPackageUpdateSteps({
            installTarget: createNpmTarget(globalRoot),
            installSpec: "openclaw@2.0.0",
            packageName: "openclaw",
            packageRoot,
            runCommand: createRootRunner(globalRoot),
            runStep: async ({ name, argv, cwd }): Promise<PackageUpdateStepResult> => {
              const prefixIndex = argv.indexOf("--prefix");
              const stagePrefix = argv[prefixIndex + 1];
              if (!stagePrefix) {
                throw new Error("missing staged prefix");
              }
              const stagedPackageRoot = path.join(stagePrefix, "lib", "node_modules", "openclaw");
              await writePackageRoot(stagedPackageRoot, "2.0.0");
              const stagedHelperPath = path.join(stagedPackageRoot, helperRelativePath);
              await fs.mkdir(path.dirname(stagedHelperPath), { recursive: true });
              await fs.writeFile(stagedHelperPath, "export const upstream = true;\n", "utf8");
              await writePackageDistInventory(stagedPackageRoot);
              return {
                name,
                command: argv.join(" "),
                cwd: cwd ?? process.cwd(),
                durationMs: 1,
                exitCode: 0,
              };
            },
            reapplyLocalOverrides: true,
            timeoutMs: 1000,
          });

          expect(result.failedStep).toBeNull();
          expect(result.localOverrides?.status).toBe("conflict");
          expect(result.localOverrides?.applied).toBe(0);
          expect(result.localOverrides?.conflicts).toEqual([
            { path: helperRelativePath, reason: "target-exists" },
            { path: featureRelativePath, reason: "target-changed" },
          ]);
          await expectPathMissing(featurePath);
          await expect(fs.readFile(helperPath, "utf8")).resolves.toBe(
            "export const upstream = true;\n",
          );
        },
      );
    },
  );

  it("aborts staged updates before package-manager work when local override capture fails", async () => {
    await withTempDir({ prefix: "openclaw-package-update-staged-capture-fail-" }, async (base) => {
      const prefix = path.join(base, "prefix");
      const globalRoot = path.join(prefix, "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      await writePackageRoot(packageRoot, "1.0.0");
      await fs.writeFile(
        path.join(packageRoot, "dist", "postinstall-content-inventory.json"),
        "[",
        "utf8",
      );
      await fs.writeFile(
        path.join(packageRoot, "dist", "index.js"),
        "export const local = true;\n",
        "utf8",
      );

      const runStep = vi.fn();

      const result = await runGlobalPackageUpdateSteps({
        installTarget: createNpmTarget(globalRoot),
        installSpec: "openclaw@2.0.0",
        packageName: "openclaw",
        packageRoot,
        runCommand: createRootRunner(globalRoot),
        runStep,
        timeoutMs: 1000,
      });

      expect(result.failedStep?.name).toBe("local overrides");
      expect(result.failedStep?.stderrTail).toContain("could not be inspected safely");
      expect(result.afterVersion).toBeNull();
      expect(result.localOverrides).toBeUndefined();
      expect(result.steps.map((step) => step.name)).toEqual(["local overrides"]);
      expect(runStep).not.toHaveBeenCalled();
      await expect(fs.readFile(path.join(packageRoot, "dist", "index.js"), "utf8")).resolves.toBe(
        "export const local = true;\n",
      );
      await expect(fs.readFile(path.join(packageRoot, "package.json"), "utf8")).resolves.toContain(
        '"version":"1.0.0"',
      );
    });
  });

  it("reports the live version when staged override recapture fails before swap", async () => {
    await withTempDir(
      { prefix: "openclaw-package-update-staged-recapture-fail-" },
      async (base) => {
        const prefix = path.join(base, "prefix");
        const globalRoot = path.join(prefix, "lib", "node_modules");
        const packageRoot = path.join(globalRoot, "openclaw");
        await writePackageRoot(packageRoot, "1.0.0");

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
              "2.0.0",
            );
            await fs.writeFile(
              path.join(packageRoot, "dist", "postinstall-content-inventory.json"),
              "{ invalid json\n",
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
          timeoutMs: 1000,
        });

        expect(result.failedStep?.name).toBe("local overrides");
        expect(result.afterVersion).toBe("1.0.0");
        expect(result.steps.map((step) => step.name)).not.toContain("global install swap");
        await expect(
          fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
        ).resolves.toContain('"version":"1.0.0"');
      },
    );
  });

  it("preserves local overrides without overwriting updated dist files", async () => {
    await withTempDir({ prefix: "openclaw-package-update-local-conflict-" }, async (base) => {
      const prefix = path.join(base, "prefix");
      const globalRoot = path.join(prefix, "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      await writePackageRoot(packageRoot, "1.0.0");
      await fs.writeFile(
        path.join(packageRoot, "dist", "index.js"),
        "export const local = true;\n",
        "utf8",
      );

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
            "export const upstream = true;\n",
            "utf8",
          );
          await writePackageDistInventory(stagedPackageRoot);
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
        reapplyLocalOverrides: true,
        timeoutMs: 1000,
      });

      expect(result.failedStep).toBeNull();
      expect(result.localOverrides?.status).toBe("conflict");
      expect(result.localOverrides?.conflicts).toEqual([
        { path: "dist/index.js", reason: "target-changed" },
      ]);
      await expect(fs.readFile(path.join(packageRoot, "dist", "index.js"), "utf8")).resolves.toBe(
        "export const upstream = true;\n",
      );
      await expect(
        fs.readFile(
          path.join(result.localOverrides?.recoveryDir ?? "", "files", "dist", "index.js"),
          "utf8",
        ),
      ).resolves.toBe("export const local = true;\n");
    });
  });

  it("does not reapply case-aliased delete and add changes independently", async () => {
    await withTempDir({ prefix: "openclaw-package-update-local-case-alias-" }, async (base) => {
      const prefix = path.join(base, "prefix");
      const globalRoot = path.join(prefix, "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      const originalPath = path.join(packageRoot, "dist", "index.js");
      const renamedPath = path.join(packageRoot, "dist", "Index.js");
      await writePackageRoot(packageRoot, "1.0.0");
      await fs.rename(originalPath, renamedPath);

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
      const realLstat = fs.lstat.bind(fs);
      const lstatSpy = vi
        .spyOn(fs, "lstat")
        .mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
          const targetPath = String(args[0]);
          if (targetPath === originalPath || targetPath === renamedPath) {
            const packageVersion = JSON.parse(
              await fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
            ).version;
            if (packageVersion === "2.0.0") {
              const stats = await realLstat(originalPath, { bigint: true });
              return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, {
                ino: 0n,
                ...(targetPath === renamedPath && process.platform === "win32" ? { dev: 0n } : {}),
              }) as never;
            }
          }
          return await realLstat(...args);
        });
      const realRealpath = fs.realpath.bind(fs);
      const realpathSpy = vi
        .spyOn(fs, "realpath")
        .mockImplementation(async (...args: Parameters<typeof fs.realpath>) => {
          if (String(args[0]) === renamedPath) {
            const packageVersion = JSON.parse(
              await fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
            ).version;
            if (packageVersion === "2.0.0") {
              return (await realRealpath(originalPath)) as never;
            }
          }
          return await realRealpath(...args);
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

        expect(result.failedStep).toBeNull();
        expect(result.localOverrides?.status).toBe("conflict");
        expect(result.localOverrides?.applied).toBe(0);
        expect(
          result.localOverrides?.conflicts.map((conflict) => conflict.path).toSorted(),
        ).toEqual(["dist/Index.js", "dist/index.js"]);
        await expect(fs.readFile(originalPath, "utf8")).resolves.toBe("export {};\n");
      } finally {
        lstatSpy.mockRestore();
        realpathSpy.mockRestore();
      }
    });
  });

  it("rejects a baseline file replaced by a directory containing a nested override", async () => {
    await withTempDir({ prefix: "openclaw-package-update-local-added-enotdir-" }, async (base) => {
      const prefix = path.join(base, "prefix");
      const globalRoot = path.join(prefix, "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      const featurePath = path.join(packageRoot, "dist", "feature");
      const localFeaturePath = path.join(featurePath, "local.js");
      await writePackageRoot(packageRoot, "1.0.0");
      await fs.writeFile(featurePath, "export const baseline = true;\n", "utf8");
      await writePackageDistInventory(packageRoot);
      await fs.rm(featurePath);
      await fs.mkdir(path.dirname(localFeaturePath), { recursive: true });
      await fs.writeFile(localFeaturePath, "export const local = true;\n", "utf8");

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
          const stagedPackageRoot = path.join(stagePrefix, "lib", "node_modules", "openclaw");
          await writePackageRoot(stagedPackageRoot, "2.0.0");
          await fs.writeFile(
            path.join(stagedPackageRoot, "dist", "feature"),
            "export const baseline = true;\n",
            "utf8",
          );
          await writePackageDistInventory(stagedPackageRoot);
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
        reapplyLocalOverrides: true,
        timeoutMs: 1000,
      });

      expect(runStep).not.toHaveBeenCalled();
      expect(result.failedStep).toMatchObject({
        name: "local overrides",
        exitCode: 1,
        stderrTail: expect.stringContaining("not a file"),
      });
      expect(result.localOverrides).toBeUndefined();
      await expect(fs.readFile(localFeaturePath, "utf8")).resolves.toBe(
        "export const local = true;\n",
      );
    });
  });

  it.runIf(process.platform !== "win32")(
    "does not reapply local overrides onto hardlinked updated files",
    async () => {
      await withTempDir(
        { prefix: "openclaw-package-update-local-hardlink-conflict-" },
        async (base) => {
          const prefix = path.join(base, "prefix");
          const globalRoot = path.join(prefix, "lib", "node_modules");
          const packageRoot = path.join(globalRoot, "openclaw");
          const stagedCache = path.join(base, "cache", "staged");
          await writePackageRoot(packageRoot, "1.0.0");
          await fs.writeFile(
            path.join(packageRoot, "dist", "index.js"),
            "export const local = true;\n",
            "utf8",
          );

          const result = await runGlobalPackageUpdateSteps({
            installTarget: createNpmTarget(globalRoot),
            installSpec: "openclaw@2.0.0",
            packageName: "openclaw",
            packageRoot,
            runCommand: createRootRunner(globalRoot),
            runStep: async ({ name, argv, cwd }): Promise<PackageUpdateStepResult> => {
              const prefixIndex = argv.indexOf("--prefix");
              const stagePrefix = argv[prefixIndex + 1];
              if (!stagePrefix) {
                throw new Error("missing staged prefix");
              }
              const stagedPackageRoot = path.join(stagePrefix, "lib", "node_modules", "openclaw");
              await writePackageRoot(stagedPackageRoot, "2.0.0");
              await addHardlinkedPackageFile(stagedPackageRoot, stagedCache);
              return {
                name,
                command: argv.join(" "),
                cwd: cwd ?? process.cwd(),
                durationMs: 1,
                exitCode: 0,
              };
            },
            reapplyLocalOverrides: true,
            timeoutMs: 1000,
          });

          expect(result.failedStep).toBeNull();
          expect(result.localOverrides?.status).toBe("conflict");
          expect(result.localOverrides?.applied).toBe(0);
          expect(result.localOverrides?.conflicts).toEqual([
            { path: "dist/index.js", reason: "target-hardlinked" },
          ]);
          await expect(
            fs.readFile(path.join(packageRoot, "dist", "index.js"), "utf8"),
          ).resolves.toBe("export {};\n");
          await expect(
            fs.readFile(path.join(stagedCache, "openclaw-index.js"), "utf8"),
          ).resolves.toBe("export {};\n");
        },
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "preserves deleted overrides when updated files are hardlinked",
    async () => {
      await withTempDir(
        { prefix: "openclaw-package-update-local-hardlink-delete-" },
        async (base) => {
          const prefix = path.join(base, "prefix");
          const globalRoot = path.join(prefix, "lib", "node_modules");
          const packageRoot = path.join(globalRoot, "openclaw");
          const indexPath = path.join(packageRoot, "dist", "index.js");
          const stagedCache = path.join(base, "cache", "staged");
          await writePackageRoot(packageRoot, "1.0.0");
          await fs.rm(indexPath);

          const result = await runGlobalPackageUpdateSteps({
            installTarget: createNpmTarget(globalRoot),
            installSpec: "openclaw@2.0.0",
            packageName: "openclaw",
            packageRoot,
            runCommand: createRootRunner(globalRoot),
            runStep: async ({ name, argv, cwd }): Promise<PackageUpdateStepResult> => {
              const prefixIndex = argv.indexOf("--prefix");
              const stagePrefix = argv[prefixIndex + 1];
              if (!stagePrefix) {
                throw new Error("missing staged prefix");
              }
              const stagedPackageRoot = path.join(stagePrefix, "lib", "node_modules", "openclaw");
              await writePackageRoot(stagedPackageRoot, "2.0.0");
              await addHardlinkedPackageFile(stagedPackageRoot, stagedCache);
              return {
                name,
                command: argv.join(" "),
                cwd: cwd ?? process.cwd(),
                durationMs: 1,
                exitCode: 0,
              };
            },
            reapplyLocalOverrides: true,
            timeoutMs: 1000,
          });

          expect(result.failedStep).toBeNull();
          expect(result.localOverrides?.status).toBe("conflict");
          expect(result.localOverrides?.applied).toBe(0);
          expect(result.localOverrides?.conflicts).toEqual([
            { path: "dist/index.js", reason: "target-hardlinked" },
          ]);
          await expect(fs.readFile(indexPath, "utf8")).resolves.toBe("export {};\n");
          await expect(
            fs.readFile(path.join(stagedCache, "openclaw-index.js"), "utf8"),
          ).resolves.toBe("export {};\n");
        },
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "preserves groups containing only deleted hardlinked overrides",
    async () => {
      await withTempDir(
        { prefix: "openclaw-package-update-local-hardlink-delete-group-" },
        async (base) => {
          const prefix = path.join(base, "prefix");
          const globalRoot = path.join(prefix, "lib", "node_modules");
          const packageRoot = path.join(globalRoot, "openclaw");
          const indexPath = path.join(packageRoot, "dist", "index.js");
          const aliasPath = path.join(packageRoot, "dist", "index-alias.js");
          await writePackageRoot(packageRoot, "1.0.0");
          await fs.link(indexPath, aliasPath);
          await writePackageDistInventory(packageRoot);
          await fs.rm(indexPath);
          await fs.rm(aliasPath);

          const result = await runGlobalPackageUpdateSteps({
            installTarget: createNpmTarget(globalRoot),
            installSpec: "openclaw@2.0.0",
            packageName: "openclaw",
            packageRoot,
            runCommand: createRootRunner(globalRoot),
            runStep: async ({ name, argv, cwd }): Promise<PackageUpdateStepResult> => {
              const prefixIndex = argv.indexOf("--prefix");
              const stagePrefix = argv[prefixIndex + 1];
              if (!stagePrefix) {
                throw new Error("missing staged prefix");
              }
              const stagedPackageRoot = path.join(stagePrefix, "lib", "node_modules", "openclaw");
              const stagedIndexPath = path.join(stagedPackageRoot, "dist", "index.js");
              await writePackageRoot(stagedPackageRoot, "2.0.0");
              await fs.link(
                stagedIndexPath,
                path.join(stagedPackageRoot, "dist", "index-alias.js"),
              );
              await writePackageDistInventory(stagedPackageRoot);
              return {
                name,
                command: argv.join(" "),
                cwd: cwd ?? process.cwd(),
                durationMs: 1,
                exitCode: 0,
              };
            },
            reapplyLocalOverrides: true,
            timeoutMs: 1000,
          });

          expect(result.failedStep).toBeNull();
          expect(result.localOverrides?.status).toBe("conflict");
          expect(result.localOverrides?.applied).toBe(0);
          expect(result.localOverrides?.conflicts).toEqual([
            { path: "dist/index-alias.js", reason: "target-hardlinked" },
            { path: "dist/index.js", reason: "target-hardlinked" },
          ]);
          await expect(fs.readFile(indexPath, "utf8")).resolves.toBe("export {};\n");
          await expect(fs.readFile(aliasPath, "utf8")).resolves.toBe("export {};\n");
        },
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "preserves deletions when a hardlinked modification conflicts",
    async () => {
      await withTempDir(
        { prefix: "openclaw-package-update-local-hardlink-mixed-" },
        async (base) => {
          const prefix = path.join(base, "prefix");
          const globalRoot = path.join(prefix, "lib", "node_modules");
          const packageRoot = path.join(globalRoot, "openclaw");
          const indexPath = path.join(packageRoot, "dist", "index.js");
          const aliasPath = path.join(packageRoot, "dist", "index-alias.js");
          await writePackageRoot(packageRoot, "1.0.0");
          await fs.link(indexPath, aliasPath);
          await writePackageDistInventory(packageRoot);
          await fs.rm(indexPath);
          await fs.writeFile(aliasPath, "export const local = true;\n", "utf8");

          const result = await runGlobalPackageUpdateSteps({
            installTarget: createNpmTarget(globalRoot),
            installSpec: "openclaw@2.0.0",
            packageName: "openclaw",
            packageRoot,
            runCommand: createRootRunner(globalRoot),
            runStep: async ({ name, argv, cwd }): Promise<PackageUpdateStepResult> => {
              const prefixIndex = argv.indexOf("--prefix");
              const stagePrefix = argv[prefixIndex + 1];
              if (!stagePrefix) {
                throw new Error("missing staged prefix");
              }
              const stagedPackageRoot = path.join(stagePrefix, "lib", "node_modules", "openclaw");
              const stagedIndexPath = path.join(stagedPackageRoot, "dist", "index.js");
              await writePackageRoot(stagedPackageRoot, "2.0.0");
              await fs.link(
                stagedIndexPath,
                path.join(stagedPackageRoot, "dist", "index-alias.js"),
              );
              await writePackageDistInventory(stagedPackageRoot);
              return {
                name,
                command: argv.join(" "),
                cwd: cwd ?? process.cwd(),
                durationMs: 1,
                exitCode: 0,
              };
            },
            reapplyLocalOverrides: true,
            timeoutMs: 1000,
          });

          expect(result.failedStep).toBeNull();
          expect(result.localOverrides?.status).toBe("conflict");
          expect(result.localOverrides?.applied).toBe(0);
          expect(result.localOverrides?.conflicts).toEqual([
            { path: "dist/index-alias.js", reason: "target-hardlinked" },
            { path: "dist/index.js", reason: "target-hardlinked" },
          ]);
          await expect(fs.readFile(indexPath, "utf8")).resolves.toBe("export {};\n");
          await expect(fs.readFile(aliasPath, "utf8")).resolves.toBe("export {};\n");
        },
      );
    },
  );

  it("does not replay deletions when a modified override conflicts", async () => {
    await withTempDir({ prefix: "openclaw-package-update-local-import-delete-" }, async (base) => {
      const prefix = path.join(base, "prefix");
      const globalRoot = path.join(prefix, "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      const indexPath = path.join(packageRoot, "dist", "index.js");
      const helperPath = path.join(packageRoot, "dist", "helper.js");
      await writePackageRoot(packageRoot, "1.0.0");
      await fs.writeFile(indexPath, 'import "./helper.js";\n', "utf8");
      await fs.writeFile(helperPath, "export const helper = true;\n", "utf8");
      await writePackageDistInventory(packageRoot);
      await fs.writeFile(indexPath, "export const local = true;\n", "utf8");
      await fs.rm(helperPath);

      const result = await runGlobalPackageUpdateSteps({
        installTarget: createNpmTarget(globalRoot),
        installSpec: "openclaw@2.0.0",
        packageName: "openclaw",
        packageRoot,
        runCommand: createRootRunner(globalRoot),
        runStep: async ({ name, argv, cwd }): Promise<PackageUpdateStepResult> => {
          const prefixIndex = argv.indexOf("--prefix");
          const stagePrefix = argv[prefixIndex + 1];
          if (!stagePrefix) {
            throw new Error("missing staged prefix");
          }
          const stagedPackageRoot = path.join(stagePrefix, "lib", "node_modules", "openclaw");
          const stagedIndexPath = path.join(stagedPackageRoot, "dist", "index.js");
          await writePackageRoot(stagedPackageRoot, "2.0.0");
          await fs.writeFile(
            stagedIndexPath,
            'import "./helper.js";\nexport const upstream = true;\n',
            "utf8",
          );
          await fs.writeFile(
            path.join(stagedPackageRoot, "dist", "helper.js"),
            "export const helper = true;\n",
            "utf8",
          );
          await writePackageDistInventory(stagedPackageRoot);
          return {
            name,
            command: argv.join(" "),
            cwd: cwd ?? process.cwd(),
            durationMs: 1,
            exitCode: 0,
          };
        },
        reapplyLocalOverrides: true,
        timeoutMs: 1000,
      });

      expect(result.failedStep).toBeNull();
      expect(result.localOverrides?.status).toBe("conflict");
      expect(result.localOverrides?.applied).toBe(0);
      expect(result.localOverrides?.conflicts).toEqual([
        { path: "dist/index.js", reason: "target-changed" },
        { path: "dist/helper.js", reason: "target-changed" },
      ]);
      await expect(fs.readFile(indexPath, "utf8")).resolves.toBe(
        'import "./helper.js";\nexport const upstream = true;\n',
      );
      await expect(fs.readFile(helperPath, "utf8")).resolves.toBe("export const helper = true;\n");
    });
  });

  it("does not replay deletions when an added override conflicts", async () => {
    await withTempDir({ prefix: "openclaw-package-update-local-added-delete-" }, async (base) => {
      const prefix = path.join(base, "prefix");
      const globalRoot = path.join(prefix, "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      const featurePath = path.join(packageRoot, "dist", "feature.js");
      const helperPath = path.join(packageRoot, "dist", "helper.js");
      await writePackageRoot(packageRoot, "1.0.0");
      await fs.writeFile(helperPath, "export const helper = true;\n", "utf8");
      await writePackageDistInventory(packageRoot);
      await fs.writeFile(featurePath, "export const local = true;\n", "utf8");
      await fs.rm(helperPath);

      const result = await runGlobalPackageUpdateSteps({
        installTarget: createNpmTarget(globalRoot),
        installSpec: "openclaw@2.0.0",
        packageName: "openclaw",
        packageRoot,
        runCommand: createRootRunner(globalRoot),
        runStep: async ({ name, argv, cwd }): Promise<PackageUpdateStepResult> => {
          const prefixIndex = argv.indexOf("--prefix");
          const stagePrefix = argv[prefixIndex + 1];
          if (!stagePrefix) {
            throw new Error("missing staged prefix");
          }
          const stagedPackageRoot = path.join(stagePrefix, "lib", "node_modules", "openclaw");
          await writePackageRoot(stagedPackageRoot, "2.0.0");
          await fs.writeFile(
            path.join(stagedPackageRoot, "dist", "feature.js"),
            'import "./helper.js";\n',
            "utf8",
          );
          await fs.writeFile(
            path.join(stagedPackageRoot, "dist", "helper.js"),
            "export const helper = true;\n",
            "utf8",
          );
          await writePackageDistInventory(stagedPackageRoot);
          return {
            name,
            command: argv.join(" "),
            cwd: cwd ?? process.cwd(),
            durationMs: 1,
            exitCode: 0,
          };
        },
        reapplyLocalOverrides: true,
        timeoutMs: 1000,
      });

      expect(result.failedStep).toBeNull();
      expect(result.localOverrides?.status).toBe("conflict");
      expect(result.localOverrides?.applied).toBe(0);
      expect(result.localOverrides?.conflicts).toEqual([
        { path: "dist/feature.js", reason: "target-exists" },
        { path: "dist/helper.js", reason: "target-changed" },
      ]);
      await expect(fs.readFile(featurePath, "utf8")).resolves.toBe('import "./helper.js";\n');
      await expect(fs.readFile(helperPath, "utf8")).resolves.toBe("export const helper = true;\n");
    });
  });

  it("returns a structured conflict when updated target inspection fails", async () => {
    await withTempDir(
      { prefix: "openclaw-package-update-local-inspection-conflict-" },
      async (base) => {
        const prefix = path.join(base, "prefix");
        const globalRoot = path.join(prefix, "lib", "node_modules");
        const packageRoot = path.join(globalRoot, "openclaw");
        const indexPath = path.join(packageRoot, "dist", "index.js");
        await writePackageRoot(packageRoot, "1.0.0");
        await fs.writeFile(indexPath, "export const local = true;\n", "utf8");

        const realLstat = fs.lstat.bind(fs);
        const lstatSpy = vi
          .spyOn(fs, "lstat")
          .mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
            if (String(args[0]) === indexPath) {
              const packageVersion = JSON.parse(
                await fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
              ).version;
              if (packageVersion === "2.0.0") {
                throw createFsError("EACCES", "target inspection failed");
              }
            }
            return await realLstat(...args);
          });

        try {
          const result = await runGlobalPackageUpdateSteps({
            installTarget: createNpmTarget(globalRoot),
            installSpec: "openclaw@2.0.0",
            packageName: "openclaw",
            packageRoot,
            runCommand: createRootRunner(globalRoot),
            runStep: async ({ name, argv, cwd }): Promise<PackageUpdateStepResult> => {
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
            reapplyLocalOverrides: true,
            timeoutMs: 1000,
          });

          expect(result.failedStep).toBeNull();
          expect(result.localOverrides?.status).toBe("conflict");
          expect(result.localOverrides?.applied).toBe(0);
          expect(result.localOverrides?.recoveryDir).toBeDefined();
          expect(result.localOverrides?.conflicts).toEqual([
            { path: "dist/index.js", reason: "target-inspection-failed" },
          ]);
          await expect(fs.readFile(indexPath, "utf8")).resolves.toBe("export {};\n");
        } finally {
          lstatSpy.mockRestore();
        }
      },
    );
  });

  it("returns a structured conflict when replay preflight fails", async () => {
    await withTempDir({ prefix: "openclaw-package-update-local-preflight-fail-" }, async (base) => {
      const packageRoot = path.join(base, "package");
      const indexPath = path.join(packageRoot, "dist", "index.js");
      await writePackageRoot(packageRoot, "1.0.0");
      await fs.writeFile(indexPath, "export const local = true;\n", "utf8");

      const plan = await captureLocalPackageOverrides({ packageRoot });
      expect(plan).not.toBeNull();
      await writePackageRoot(packageRoot, "2.0.0");
      await fs.writeFile(
        path.join(packageRoot, "dist", "postinstall-content-inventory.json"),
        "{ invalid json\n",
        "utf8",
      );

      const result = await applyLocalPackageOverrides({
        packageRoot,
        plan,
        reapply: true,
      });

      expect(result.status).toBe("conflict");
      expect(result.applied).toBe(0);
      expect(result.recoveryDir).toBe(plan?.recoveryDir);
      expect(result.conflicts).toEqual([
        { path: "dist/index.js", reason: "target-inspection-failed" },
      ]);
      expect(result.warnings.join("\n")).toContain("could not be safely inspected");
      await expect(fs.readFile(indexPath, "utf8")).resolves.toBe("export {};\n");
    });
  });

  it("aborts before package-manager work for unsafe inventory paths", async () => {
    await withTempDir({ prefix: "openclaw-package-update-local-inventory-path-" }, async (base) => {
      const prefix = path.join(base, "prefix");
      const globalRoot = path.join(prefix, "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      await writePackageRoot(packageRoot, "1.0.0");
      await fs.writeFile(
        path.join(packageRoot, "dist", "postinstall-content-inventory.json"),
        JSON.stringify(
          [
            {
              path: "dist/../package.json",
              sha256: "0".repeat(64),
              mode: 0o644,
              size: 2,
            },
          ],
          null,
          2,
        ) + "\n",
        "utf8",
      );
      await fs.writeFile(
        path.join(packageRoot, "package.json"),
        JSON.stringify({ name: "openclaw", version: "1.0.0", local: true }),
        "utf8",
      );

      const runStep = vi.fn();

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
      expect(result.failedStep?.stderrTail).toContain("unsafe local override path");
      expect(result.afterVersion).toBeNull();
      expect(result.localOverrides).toBeUndefined();
      expect(runStep).not.toHaveBeenCalled();
      await expect(fs.readFile(path.join(packageRoot, "package.json"), "utf8")).resolves.toContain(
        '"version":"1.0.0"',
      );
      await expect(fs.readFile(path.join(packageRoot, "package.json"), "utf8")).resolves.toContain(
        '"local":true',
      );
    });
  });

  it("does not partially reapply clean overrides when another override conflicts", async () => {
    await withTempDir(
      { prefix: "openclaw-package-update-local-partial-conflict-" },
      async (base) => {
        const prefix = path.join(base, "prefix");
        const globalRoot = path.join(prefix, "lib", "node_modules");
        const packageRoot = path.join(globalRoot, "openclaw");
        await writePackageRoot(packageRoot, "1.0.0");
        await fs.writeFile(
          path.join(packageRoot, "dist", "extra.js"),
          "export const extra = 1;\n",
          "utf8",
        );
        await writePackageDistInventory(packageRoot);
        await fs.writeFile(
          path.join(packageRoot, "dist", "index.js"),
          "export const localConflict = true;\n",
          "utf8",
        );
        await fs.writeFile(
          path.join(packageRoot, "dist", "extra.js"),
          "export const localClean = true;\n",
          "utf8",
        );

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
              path.join(stagedPackageRoot, "dist", "extra.js"),
              "export const extra = 1;\n",
              "utf8",
            );
            await writePackageDistInventory(stagedPackageRoot);
            await fs.writeFile(
              path.join(stagedPackageRoot, "dist", "index.js"),
              "export const upstreamConflict = true;\n",
              "utf8",
            );
            await writePackageDistInventory(stagedPackageRoot);
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
          reapplyLocalOverrides: true,
          timeoutMs: 1000,
        });

        expect(result.failedStep).toBeNull();
        expect(result.localOverrides?.status).toBe("conflict");
        expect(result.localOverrides?.applied).toBe(0);
        expect(result.localOverrides?.conflicts).toEqual([
          { path: "dist/index.js", reason: "target-changed" },
          { path: "dist/extra.js", reason: "target-changed" },
        ]);
        await expect(fs.readFile(path.join(packageRoot, "dist", "index.js"), "utf8")).resolves.toBe(
          "export const upstreamConflict = true;\n",
        );
        await expect(fs.readFile(path.join(packageRoot, "dist", "extra.js"), "utf8")).resolves.toBe(
          "export const extra = 1;\n",
        );
      },
    );
  });

  it("does not partially reapply shared added trees with incomplete dependency graphs", async () => {
    await withTempDir(
      { prefix: "openclaw-package-update-local-shared-dependency-" },
      async (base) => {
        const prefix = path.join(base, "prefix");
        const globalRoot = path.join(prefix, "lib", "node_modules");
        const packageRoot = path.join(globalRoot, "openclaw");
        await writePackageRoot(packageRoot, "1.0.0");
        await fs.writeFile(path.join(packageRoot, "dist", "index.js"), "export {};\n", "utf8");
        await fs.writeFile(path.join(packageRoot, "dist", "feature.js"), "export {};\n", "utf8");
        await writePackageDistInventory(packageRoot);
        await fs.writeFile(
          path.join(packageRoot, "dist", "index.js"),
          "import './shared.js';\nexport const localConflict = true;\n",
          "utf8",
        );
        await fs.writeFile(
          path.join(packageRoot, "dist", "feature.js"),
          "import './shared.js';\nexport const localClean = true;\n",
          "utf8",
        );
        await fs.writeFile(
          path.join(packageRoot, "dist", "shared.js"),
          "import './nested.js';\nexport const shared = true;\n",
          "utf8",
        );
        await fs.writeFile(
          path.join(packageRoot, "dist", "nested.js"),
          "export const nested = true;\n",
          "utf8",
        );

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
              "export const upstreamConflict = true;\n",
              "utf8",
            );
            await fs.writeFile(
              path.join(stagedPackageRoot, "dist", "feature.js"),
              "export {};\n",
              "utf8",
            );
            await writePackageDistInventory(stagedPackageRoot);
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
          reapplyLocalOverrides: true,
          timeoutMs: 1000,
        });

        expect(result.failedStep).toBeNull();
        expect(result.localOverrides?.status).toBe("conflict");
        expect(result.localOverrides?.applied).toBe(0);
        expect(result.localOverrides?.conflicts).toEqual([
          { path: "dist/index.js", reason: "target-changed" },
          { path: "dist/feature.js", reason: "target-changed" },
          { path: "dist/nested.js", reason: "target-changed" },
          { path: "dist/shared.js", reason: "target-changed" },
        ]);
        await expect(fs.readFile(path.join(packageRoot, "dist", "index.js"), "utf8")).resolves.toBe(
          "export const upstreamConflict = true;\n",
        );
        await expect(
          fs.readFile(path.join(packageRoot, "dist", "feature.js"), "utf8"),
        ).resolves.toBe("export {};\n");
        await expectPathMissing(path.join(packageRoot, "dist", "shared.js"));
        await expectPathMissing(path.join(packageRoot, "dist", "nested.js"));
      },
    );
  });

  it("does not reapply modified importers when a modified dependency conflicts", async () => {
    await withTempDir(
      { prefix: "openclaw-package-update-local-modified-dependency-" },
      async (base) => {
        const prefix = path.join(base, "prefix");
        const globalRoot = path.join(prefix, "lib", "node_modules");
        const packageRoot = path.join(globalRoot, "openclaw");
        await writePackageRoot(packageRoot, "1.0.0");
        await fs.writeFile(path.join(packageRoot, "dist", "index.js"), "export {};\n", "utf8");
        await fs.writeFile(
          path.join(packageRoot, "dist", "helper.js"),
          "export const helper = 1;\n",
          "utf8",
        );
        await writePackageDistInventory(packageRoot);
        await fs.writeFile(
          path.join(packageRoot, "dist", "index.js"),
          "import './helper.js';\nexport const localIndex = true;\n",
          "utf8",
        );
        await fs.writeFile(
          path.join(packageRoot, "dist", "helper.js"),
          "export const localHelper = true;\n",
          "utf8",
        );

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
              "export {};\n",
              "utf8",
            );
            await fs.writeFile(
              path.join(stagedPackageRoot, "dist", "helper.js"),
              "export const upstreamHelper = true;\n",
              "utf8",
            );
            await writePackageDistInventory(stagedPackageRoot);
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
          reapplyLocalOverrides: true,
          timeoutMs: 1000,
        });

        expect(result.failedStep).toBeNull();
        expect(result.localOverrides?.status).toBe("conflict");
        expect(result.localOverrides?.applied).toBe(0);
        expect(result.localOverrides?.conflicts).toEqual([
          { path: "dist/helper.js", reason: "target-changed" },
          { path: "dist/index.js", reason: "target-changed" },
        ]);
        await expect(fs.readFile(path.join(packageRoot, "dist", "index.js"), "utf8")).resolves.toBe(
          "export {};\n",
        );
        await expect(
          fs.readFile(path.join(packageRoot, "dist", "helper.js"), "utf8"),
        ).resolves.toBe("export const upstreamHelper = true;\n");
      },
    );
  });

  it("does not reapply added dependencies when every importer conflicts", async () => {
    await withTempDir({ prefix: "openclaw-package-update-importer-conflict-" }, async (base) => {
      const prefix = path.join(base, "prefix");
      const globalRoot = path.join(prefix, "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      await writePackageRoot(packageRoot, "1.0.0");
      await fs.writeFile(
        path.join(packageRoot, "dist", "index.js"),
        "import './local-helper.js';\n",
        "utf8",
      );
      await fs.writeFile(
        path.join(packageRoot, "dist", "local-helper.js"),
        "export const local = true;\n",
        "utf8",
      );

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
            "export const upstream = true;\n",
            "utf8",
          );
          await writePackageDistInventory(stagedPackageRoot);
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
        reapplyLocalOverrides: true,
        timeoutMs: 1000,
      });

      expect(result.failedStep).toBeNull();
      expect(result.localOverrides?.status).toBe("conflict");
      expect(result.localOverrides?.conflicts).toEqual([
        { path: "dist/index.js", reason: "target-changed" },
        { path: "dist/local-helper.js", reason: "target-changed" },
      ]);
      await expect(fs.readFile(path.join(packageRoot, "dist", "index.js"), "utf8")).resolves.toBe(
        "export const upstream = true;\n",
      );
      await expectPathMissing(path.join(packageRoot, "dist", "local-helper.js"));
    });
  });

  it("preserves local added dist files without overwriting upstream additions", async () => {
    await withTempDir({ prefix: "openclaw-package-update-local-added-conflict-" }, async (base) => {
      const prefix = path.join(base, "prefix");
      const globalRoot = path.join(prefix, "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      await writePackageRoot(packageRoot, "1.0.0");
      await fs.writeFile(
        path.join(packageRoot, "dist", "index.js"),
        "import './local-helper.js';\n",
        "utf8",
      );
      await fs.writeFile(
        path.join(packageRoot, "dist", "local-helper.js"),
        "export const local = true;\n",
        "utf8",
      );

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
            path.join(stagedPackageRoot, "dist", "local-helper.js"),
            "export const upstream = true;\n",
            "utf8",
          );
          await writePackageDistInventory(stagedPackageRoot);
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
        reapplyLocalOverrides: true,
        timeoutMs: 1000,
      });

      expect(result.failedStep).toBeNull();
      expect(result.localOverrides?.status).toBe("conflict");
      expect(result.localOverrides?.conflicts).toEqual([
        { path: "dist/local-helper.js", reason: "target-exists" },
        { path: "dist/index.js", reason: "target-changed" },
      ]);
      await expect(fs.readFile(path.join(packageRoot, "dist", "index.js"), "utf8")).resolves.toBe(
        "export {};\n",
      );
      await expect(
        fs.readFile(path.join(packageRoot, "dist", "local-helper.js"), "utf8"),
      ).resolves.toBe("export const upstream = true;\n");
      await expect(
        fs.readFile(
          path.join(result.localOverrides?.recoveryDir ?? "", "files", "dist", "local-helper.js"),
          "utf8",
        ),
      ).resolves.toBe("export const local = true;\n");
    });
  });

  it.each(["2026.6.6", "2026.7.1-beta.4", "2026.7.1-beta.5"])(
    "does not reapply deleted overrides when legacy updated package %s lacks content inventory",
    async (updatedVersion) => {
      await withTempDir(
        { prefix: "openclaw-package-update-deleted-no-content-inventory-" },
        async (base) => {
          const prefix = path.join(base, "prefix");
          const globalRoot = path.join(prefix, "lib", "node_modules");
          const packageRoot = path.join(globalRoot, "openclaw");
          await writePackageRoot(packageRoot, "1.0.0");
          await fs.rm(path.join(packageRoot, "dist", "index.js"));

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
              await writePackageRoot(stagedPackageRoot, updatedVersion);
              await fs.rm(
                path.join(stagedPackageRoot, "dist", "postinstall-content-inventory.json"),
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
            installSpec: `openclaw@${updatedVersion}`,
            packageName: "openclaw",
            packageRoot,
            runCommand: createRootRunner(globalRoot),
            runStep,
            reapplyLocalOverrides: true,
            timeoutMs: 1000,
          });

          expect(result.failedStep).toBeNull();
          expect(result.localOverrides?.status).toBe("conflict");
          expect(result.localOverrides?.conflicts).toEqual([
            { path: "dist/index.js", reason: "target-changed" },
          ]);
          await expect(
            fs.readFile(path.join(packageRoot, "dist", "index.js"), "utf8"),
          ).resolves.toBe("export {};\n");
        },
      );
    },
  );

  it("rejects updated packages that require content inventory before package swap", async () => {
    await withTempDir(
      { prefix: "openclaw-package-update-missing-content-inventory-" },
      async (base) => {
        const prefix = path.join(base, "prefix");
        const globalRoot = path.join(prefix, "lib", "node_modules");
        const packageRoot = path.join(globalRoot, "openclaw");
        await writePackageRoot(packageRoot, "1.0.0");
        await fs.writeFile(
          path.join(packageRoot, "dist", "index.js"),
          "export const local = true;\n",
          "utf8",
        );

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
            await writePackageRoot(stagedPackageRoot, "2026.6.7");
            await fs.rm(path.join(stagedPackageRoot, "dist", "postinstall-content-inventory.json"));
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
          installSpec: "openclaw@2026.6.7",
          packageName: "openclaw",
          packageRoot,
          runCommand: createRootRunner(globalRoot),
          runStep,
          timeoutMs: 1000,
        });

        expect(result.failedStep?.name).toBe("global install verify");
        expect(result.failedStep?.stderrTail).toContain("missing package dist content inventory");
        expect(result.steps.map((step) => step.name)).not.toContain("global install swap");
        await expect(
          fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
        ).resolves.toContain('"version":"1.0.0"');
        expect(
          (await fs.readdir(globalRoot)).filter((entry) =>
            entry.startsWith("openclaw-local-overrides-"),
          ),
        ).toEqual([]);
      },
    );
  });

  it("rejects malformed staged content inventories before package swap", async () => {
    await withTempDir(
      { prefix: "openclaw-package-update-bad-content-inventory-" },
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
              path.join(stagedPackageRoot, "dist", "postinstall-content-inventory.json"),
              "{}\n",
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
        expect(result.failedStep?.stderrTail).toContain("Invalid package dist content inventory");
        expect(result.steps.map((step) => step.name)).not.toContain("global install swap");
        await expect(
          fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
        ).resolves.toContain('"version":"1.0.0"');
      },
    );
  });

  it.runIf(process.platform !== "win32")(
    "swaps npm package roots that contain package-manager hardlinks",
    async () => {
      await withTempDir({ prefix: "openclaw-package-update-hardlinks-" }, async (base) => {
        const prefix = path.join(base, "prefix");
        const globalRoot = path.join(prefix, "lib", "node_modules");
        const packageRoot = path.join(globalRoot, "openclaw");
        await writePackageRoot(packageRoot, "1.0.0");
        await addHardlinkedPackageFile(packageRoot, path.join(base, "cache", "existing"));

        const result = await runGlobalPackageUpdateSteps({
          installTarget: createNpmTarget(globalRoot),
          installSpec: "openclaw@2.0.0",
          packageName: "openclaw",
          packageRoot,
          runCommand: createRootRunner(globalRoot),
          runStep: async ({ name, argv, cwd }): Promise<PackageUpdateStepResult> => {
            if (name !== "global update") {
              throw new Error(`unexpected step ${name}`);
            }
            const prefixIndex = argv.indexOf("--prefix");
            const stagePrefix = argv[prefixIndex + 1];
            if (!stagePrefix) {
              throw new Error("missing staged prefix");
            }
            const stagedPackageRoot = path.join(stagePrefix, "lib", "node_modules", "openclaw");
            await writePackageRoot(stagedPackageRoot, "2.0.0");
            await addHardlinkedPackageFile(stagedPackageRoot, path.join(base, "cache", "staged"));
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
        expect(result.steps.map((step) => step.name)).toEqual([
          "global update",
          "global install swap",
        ]);
        await expect(
          fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
        ).resolves.toContain('"version":"2.0.0"');
        await expect(fs.lstat(path.join(packageRoot, "dist", "index.js"))).resolves.toMatchObject({
          nlink: 2,
        });
      });
    },
  );

  it("swaps staged npm updates into an explicitly selected direct node_modules root", async () => {
    await withTempDir({ prefix: "openclaw-package-update-direct-root-" }, async (base) => {
      const managedRoot = path.join(base, ".openclaw", "npm", "node_modules");
      const packageRoot = path.join(managedRoot, "openclaw");
      await writePackageRoot(packageRoot, "1.0.0");

      const runStep = vi.fn(async ({ name, argv, cwd }): Promise<PackageUpdateStepResult> => {
        if (name !== "global update") {
          throw new Error(`unexpected step ${name}`);
        }
        const prefixIndex = argv.indexOf("--prefix");
        expect(prefixIndex).toBeGreaterThan(0);
        const stagePrefix = argv[prefixIndex + 1];
        if (!stagePrefix) {
          throw new Error("missing staged prefix");
        }
        expect(path.dirname(stagePrefix)).toBe(managedRoot);
        await writePackageRoot(path.join(stagePrefix, "lib", "node_modules", "openclaw"), "2.0.0");
        await fs.mkdir(path.join(stagePrefix, "bin"), { recursive: true });
        await fs.symlink(
          "../lib/node_modules/openclaw/dist/index.js",
          path.join(stagePrefix, "bin", "openclaw"),
        );
        return {
          name,
          command: argv.join(" "),
          cwd: cwd ?? process.cwd(),
          durationMs: 1,
          exitCode: 0,
        };
      });

      const result = await runGlobalPackageUpdateSteps({
        installTarget: {
          ...createNpmTarget(managedRoot),
          directNodeModulesRoot: true,
        },
        installSpec: "openclaw@2.0.0",
        packageName: "openclaw",
        packageRoot,
        runCommand: createRootRunner(path.join(base, "shell", "lib", "node_modules")),
        runStep,
        timeoutMs: 1000,
      });

      expect(result.failedStep).toBeNull();
      expect(result.verifiedPackageRoot).toBe(packageRoot);
      expect(result.afterVersion).toBe("2.0.0");
      await expect(fs.readFile(path.join(packageRoot, "package.json"), "utf8")).resolves.toContain(
        '"version":"2.0.0"',
      );
      await expectPathMissing(path.join(managedRoot, ".bin", "openclaw"));
    });
  });

  it("accepts v-prefixed exact npm specs when verifying staged installs", async () => {
    await withTempDir({ prefix: "openclaw-package-update-v-prefix-" }, async (base) => {
      const prefix = path.join(base, "prefix");
      const globalRoot = path.join(prefix, "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      await writePackageRoot(packageRoot, "1.0.0");

      const runStep = vi.fn(async ({ name, argv, cwd }): Promise<PackageUpdateStepResult> => {
        if (name !== "global update") {
          throw new Error(`unexpected step ${name}`);
        }
        expect(argv).toContain("openclaw@v2.0.0");
        const prefixIndex = argv.indexOf("--prefix");
        const stagePrefix = argv[prefixIndex + 1];
        if (!stagePrefix) {
          throw new Error("missing staged prefix");
        }
        await writePackageRoot(path.join(stagePrefix, "lib", "node_modules", "openclaw"), "2.0.0");
        await fs.mkdir(path.join(stagePrefix, "bin"), { recursive: true });
        await fs.symlink(
          "../lib/node_modules/openclaw/dist/index.js",
          path.join(stagePrefix, "bin", "openclaw"),
        );
        return {
          name,
          command: argv.join(" "),
          cwd: cwd ?? process.cwd(),
          durationMs: 1,
          exitCode: 0,
        };
      });

      const result = await runGlobalPackageUpdateSteps({
        installTarget: createNpmTarget(globalRoot),
        installSpec: "openclaw@v2.0.0",
        packageName: "openclaw",
        packageRoot,
        runCommand: createRootRunner(globalRoot),
        runStep,
        timeoutMs: 1000,
      });

      expect(result.failedStep).toBeNull();
      expect(result.afterVersion).toBe("2.0.0");
      expect(result.steps.map((step) => step.name)).toEqual([
        "global update",
        "global install swap",
      ]);
    });
  });

  it("packs npm GitHub specs before installing into the staged prefix", async () => {
    await withTempDir({ prefix: "openclaw-package-update-npm-pack-" }, async (base) => {
      const prefix = path.join(base, "prefix");
      const globalRoot = path.join(prefix, "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      const sourceSpec = "OpenClaw@github:openclaw/openclaw#release/2026.5.12";
      await writePackageRoot(packageRoot, "1.0.0");

      let packDir: string | undefined;
      const runStep = vi.fn(async ({ name, argv, cwd }): Promise<PackageUpdateStepResult> => {
        if (name === "global update pack") {
          expect(argv).toEqual([
            "npm",
            "pack",
            sourceSpec,
            "--pack-destination",
            expect.any(String),
            "--json",
            "--loglevel=error",
          ]);
          const destination = argv[4];
          if (!destination) {
            throw new Error("missing pack destination");
          }
          packDir = destination;
          await fs.writeFile(path.join(destination, "openclaw-2.0.0.tgz"), "packed\n", "utf8");
          return {
            name,
            command: argv.join(" "),
            cwd: cwd ?? process.cwd(),
            durationMs: 1,
            exitCode: 0,
          };
        }
        if (name !== "global update") {
          throw new Error(`unexpected step ${name}`);
        }
        const prefixIndex = argv.indexOf("--prefix");
        const stagePrefix = argv[prefixIndex + 1];
        if (!stagePrefix || !packDir) {
          throw new Error("missing staged prefix or pack dir");
        }
        expect(argv).toEqual([
          "npm",
          "i",
          "-g",
          "--allow-scripts=./openclaw-2.0.0.tgz",
          "--prefix",
          stagePrefix,
          path.join(packDir, "openclaw-2.0.0.tgz"),
          "--no-fund",
          "--no-audit",
          "--loglevel=error",
          "--min-release-age=0",
        ]);
        expect(cwd).toBe(packDir);
        await writePackageRoot(path.join(stagePrefix, "lib", "node_modules", "openclaw"), "2.0.0");
        await fs.mkdir(path.join(stagePrefix, "bin"), { recursive: true });
        await fs.symlink(
          "../lib/node_modules/openclaw/dist/index.js",
          path.join(stagePrefix, "bin", "openclaw"),
        );
        return {
          name,
          command: argv.join(" "),
          cwd: cwd ?? process.cwd(),
          durationMs: 1,
          exitCode: 0,
        };
      });

      const result = await runGlobalPackageUpdateSteps({
        installTarget: createNpmTarget(globalRoot),
        installSpec: sourceSpec,
        packageName: "openclaw",
        packageRoot,
        runCommand: createRootRunner(globalRoot),
        runStep,
        timeoutMs: 1000,
      });

      expect(result.failedStep).toBeNull();
      expect(result.afterVersion).toBe("2.0.0");
      expect(result.steps.map((step) => step.name)).toEqual([
        "global update pack",
        "global update",
        "global install swap",
      ]);
      if (!packDir) {
        throw new Error("expected npm pack directory");
      }
      await expectPathMissing(packDir);
    });
  });

  it.each([
    {
      name: "full git url",
      sourceSpec: "https://github.com/openclaw/openclaw.git#main",
    },
    {
      name: "hosted GitHub URL without git suffix",
      sourceSpec: "https://github.com/openclaw/openclaw#main",
    },
    {
      name: "aliased hosted GitHub URL without git suffix",
      sourceSpec: "openclaw@https://github.com/openclaw/openclaw#main",
    },
    {
      name: "GitHub shorthand",
      sourceSpec: "openclaw/openclaw#main",
    },
    {
      name: "SCP-style SSH",
      sourceSpec: "git@github.com:openclaw/openclaw.git#main",
    },
  ] as const)(
    "packs additional npm git source spec forms before install: $name",
    async ({ sourceSpec }) => {
      await withTempDir({ prefix: "openclaw-package-update-npm-pack-variant-" }, async (base) => {
        const globalRoot = path.join(base, "prefix", "lib", "node_modules");
        const packageRoot = path.join(globalRoot, "openclaw");
        await writePackageRoot(packageRoot, "1.0.0");

        let tarball: string | undefined;
        const runStep = vi.fn(async ({ name, argv, cwd }): Promise<PackageUpdateStepResult> => {
          if (name === "global update pack") {
            const destination = argv[argv.indexOf("--pack-destination") + 1];
            if (!destination) {
              throw new Error("missing pack destination");
            }
            expect(argv.slice(0, 3)).toEqual(["npm", "pack", sourceSpec]);
            tarball = path.join(destination, "openclaw-2.0.0.tgz");
            await fs.writeFile(tarball, "packed\n", "utf8");
            return {
              name,
              command: argv.join(" "),
              cwd: cwd ?? process.cwd(),
              durationMs: 1,
              exitCode: 0,
            };
          }
          if (name !== "global update" || !tarball) {
            throw new Error(`unexpected step ${name}`);
          }
          expect(argv).toContain(tarball);
          const stagePrefix = argv[argv.indexOf("--prefix") + 1];
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
        });

        const result = await runGlobalPackageUpdateSteps({
          installTarget: createNpmTarget(globalRoot),
          installSpec: sourceSpec,
          packageName: "openclaw",
          packageRoot,
          runCommand: createRootRunner(globalRoot),
          runStep,
          timeoutMs: 1000,
        });

        expect(result.failedStep).toBeNull();
        expect(result.steps.map((step) => step.name)).toEqual([
          "global update pack",
          "global update",
          "global install swap",
        ]);
      });
    },
  );

  it("swaps staged npm package roots through the copy fallback when rename crosses devices", async () => {
    await withTempDir({ prefix: "openclaw-package-update-exdev-" }, async (base) => {
      const prefix = path.join(base, "prefix");
      const globalRoot = path.join(prefix, "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");

      const realRename = fs.rename.bind(fs);
      let exdevMoves = 0;
      const renameSpy = vi
        .spyOn(fs, "rename")
        .mockImplementation(async (...args: Parameters<typeof fs.rename>) => {
          const [from, to] = args;
          const fromPath = String(from);
          if (
            exdevMoves === 0 &&
            fromPath.includes(`${path.sep}.openclaw-update-stage-`) &&
            path.basename(fromPath) === "openclaw" &&
            String(to) === packageRoot
          ) {
            exdevMoves += 1;
            throw createFsError("EXDEV", "cross-device link not permitted");
          }
          return await realRename(...args);
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
        expect(exdevMoves).toBe(1);
        await expect(
          fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
        ).resolves.toContain('"version":"2.0.0"');
      } finally {
        renameSpy.mockRestore();
      }
    });
  });

  it("stages pnpm-detected updates through npm when the global root has npm prefix layout", async () => {
    await withTempDir({ prefix: "openclaw-package-update-pnpm-staged-" }, async (base) => {
      const prefix = path.join(base, "prefix");
      const globalRoot = path.join(prefix, "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      const staleChunk = path.join(packageRoot, "dist", "install-abcdefghi.js");
      const localImporter = path.join(packageRoot, "dist", "index.js");
      await writePackageRoot(packageRoot, "1.0.0");
      await fs.writeFile(staleChunk, 'import "./install.runtime-abcdefghi.js";\n', "utf8");
      await fs.writeFile(
        localImporter,
        'const chunkHash = "abcdefghi";\nvoid import("./install-" + chunkHash + ".js");\n',
        "utf8",
      );

      const runStep = vi.fn(async ({ name, argv, cwd }): Promise<PackageUpdateStepResult> => {
        if (name !== "global update") {
          throw new Error(`unexpected step ${name}`);
        }
        expect(argv[0]).toBe("npm");
        expect(argv).toContain("i");
        expect(argv).toContain("-g");
        expect(argv).toContain("--prefix");
        expect(argv).toContain("openclaw@2.0.0");
        expect(argv).not.toContain("pnpm");
        const prefixIndex = argv.indexOf("--prefix");
        const stagePrefix = argv[prefixIndex + 1];
        if (!stagePrefix) {
          throw new Error("missing staged prefix");
        }
        await writePackageRoot(path.join(stagePrefix, "lib", "node_modules", "openclaw"), "2.0.0");
        return {
          name,
          command: argv.join(" "),
          cwd: cwd ?? process.cwd(),
          durationMs: 1,
          exitCode: 0,
        };
      });

      const result = await runGlobalPackageUpdateSteps({
        installTarget: createPnpmTarget(globalRoot),
        installSpec: "openclaw@2.0.0",
        packageName: "openclaw",
        packageRoot,
        runCommand: createRootRunner(globalRoot),
        runStep,
        reapplyLocalOverrides: true,
        timeoutMs: 1000,
      });

      expect(result.failedStep).toBeNull();
      expect(result.afterVersion).toBe("2.0.0");
      expect(result.steps.map((step) => step.name)).toEqual([
        "global update",
        "global install swap",
        "local overrides",
      ]);
      expect(result.localOverrides?.status).toBe("preserved");
      expect(result.localOverrides?.added).toBe(1);
      expect(result.localOverrides?.modified).toBe(1);
      expect(result.localOverrides?.applied).toBe(0);
      expect(result.localOverrides?.warnings).toEqual([
        expect.stringContaining("no local changes were reapplied"),
      ]);
      await expectPathMissing(staleChunk);
      await expect(fs.readFile(localImporter, "utf8")).resolves.toBe("export {};\n");
      await expect(
        fs.readFile(
          path.join(
            result.localOverrides?.recoveryDir ?? "",
            "files",
            "dist",
            "install-abcdefghi.js",
          ),
          "utf8",
        ),
      ).resolves.toBe('import "./install.runtime-abcdefghi.js";\n');
      await expect(
        fs.readFile(
          path.join(result.localOverrides?.recoveryDir ?? "", "files", "dist", "index.js"),
          "utf8",
        ),
      ).resolves.toBe(
        'const chunkHash = "abcdefghi";\nvoid import("./install-" + chunkHash + ".js");\n',
      );
      await expect(
        fs
          .readFile(path.join(result.localOverrides?.recoveryDir ?? "", "manifest.json"), "utf8")
          .then((content) => JSON.parse(content))
          .then((manifest) => manifest.changes),
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "added",
            path: "dist/install-abcdefghi.js",
            reapply: false,
          }),
          expect.objectContaining({
            kind: "modified",
            path: "dist/index.js",
          }),
        ]),
      );
    });
  });

  it("keeps Windows pnpm global roots on the pnpm update path", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      await withTempDir({ prefix: "openclaw-package-update-win32-pnpm-" }, async (base) => {
        const globalDir = path.join(base, "pnpm", "global");
        const globalRoot = path.join(globalDir, "5", "node_modules");
        const packageRoot = path.join(globalRoot, "openclaw");
        await writePackageRoot(packageRoot, "1.0.0");
        await fs.writeFile(
          path.join(packageRoot, "dist", "index.js"),
          "export const installed = true;\n",
          "utf8",
        );
        await writePackageDistInventory(packageRoot);
        await fs.writeFile(
          path.join(packageRoot, "dist", "index.js"),
          "export const local = true;\n",
          "utf8",
        );

        const runStep = vi.fn(async ({ name, argv, cwd }): Promise<PackageUpdateStepResult> => {
          if (name !== "global update") {
            throw new Error(`unexpected step ${name}`);
          }
          expect(argv).toEqual([
            "pnpm",
            "add",
            "-g",
            "--global-dir",
            globalDir,
            "--allow-build=openclaw",
            "openclaw@2.0.0",
          ]);
          await writePackageRoot(packageRoot, "2.0.0");
          await fs.writeFile(
            path.join(packageRoot, "dist", "index.js"),
            "export const updated = true;\n",
            "utf8",
          );
          await writePackageDistInventory(packageRoot);
          return {
            name,
            command: argv.join(" "),
            cwd: cwd ?? process.cwd(),
            durationMs: 1,
            exitCode: 0,
          };
        });

        const result = await runGlobalPackageUpdateSteps({
          installTarget: createPnpmTarget(globalRoot),
          installSpec: "openclaw@2.0.0",
          packageName: "openclaw",
          packageRoot,
          runCommand: createRootRunner(globalRoot),
          runStep,
          timeoutMs: 1000,
        });

        expect(result.failedStep).toBeNull();
        expect(result.afterVersion).toBe("2.0.0");
        expect(result.localOverrides?.status).toBe("preserved");
        expect(result.localOverrides?.modified).toBe(1);
        expect(result.steps.map((step) => step.name)).toEqual(["global update", "local overrides"]);
        await expect(fs.readFile(path.join(packageRoot, "dist", "index.js"), "utf8")).resolves.toBe(
          "export const updated = true;\n",
        );
        await expect(
          fs.readFile(
            path.join(result.localOverrides?.recoveryDir ?? "", "files", "dist", "index.js"),
            "utf8",
          ),
        ).resolves.toBe("export const local = true;\n");
      });
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("aborts in-place updates before package-manager work when local override capture fails", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      await withTempDir(
        { prefix: "openclaw-package-update-in-place-capture-fail-" },
        async (base) => {
          const globalDir = path.join(base, "pnpm", "global");
          const globalRoot = path.join(globalDir, "5", "node_modules");
          const packageRoot = path.join(globalRoot, "openclaw");
          await writePackageRoot(packageRoot, "1.0.0");
          await fs.writeFile(
            path.join(packageRoot, "dist", "postinstall-content-inventory.json"),
            "[",
            "utf8",
          );
          await fs.writeFile(
            path.join(packageRoot, "dist", "index.js"),
            "export const local = true;\n",
            "utf8",
          );

          const runStep = vi.fn();

          const result = await runGlobalPackageUpdateSteps({
            installTarget: createPnpmTarget(globalRoot),
            installSpec: "openclaw@2.0.0",
            packageName: "openclaw",
            packageRoot,
            runCommand: createRootRunner(globalRoot),
            runStep,
            timeoutMs: 1000,
          });

          expect(result.failedStep?.name).toBe("local overrides");
          expect(result.failedStep?.stderrTail).toContain("could not be inspected safely");
          expect(result.afterVersion).toBeNull();
          expect(result.localOverrides).toBeUndefined();
          expect(result.steps.map((step) => step.name)).toEqual(["local overrides"]);
          expect(runStep).not.toHaveBeenCalled();
          await expect(
            fs.readFile(path.join(packageRoot, "dist", "index.js"), "utf8"),
          ).resolves.toBe("export const local = true;\n");
          await expect(
            fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
          ).resolves.toContain('"version":"1.0.0"');
        },
      );
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("aborts in-place updates when the installed package root cannot be inspected", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      await withTempDir(
        { prefix: "openclaw-package-update-in-place-root-inspection-fail-" },
        async (base) => {
          const globalDir = path.join(base, "pnpm", "global");
          const globalRoot = path.join(globalDir, "5", "node_modules");
          const packageRoot = path.join(globalRoot, "openclaw");
          await writePackageRoot(packageRoot, "2026.6.7");

          const realLstat = fs.lstat.bind(fs);
          const lstatSpy = vi
            .spyOn(fs, "lstat")
            .mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
              if (String(args[0]) === packageRoot) {
                throw createFsError("EACCES", "permission denied");
              }
              return await realLstat(...args);
            });
          const runStep = vi.fn();

          try {
            const result = await runGlobalPackageUpdateSteps({
              installTarget: createPnpmTarget(globalRoot),
              installSpec: "openclaw@2026.6.8",
              packageName: "openclaw",
              packageRoot,
              runCommand: createRootRunner(globalRoot),
              runStep,
              timeoutMs: 1000,
            });

            expect(result.failedStep?.name).toBe("local overrides");
            expect(result.failedStep?.stderrTail).toContain("permission denied");
            expect(result.afterVersion).toBeNull();
            expect(result.steps.map((step) => step.name)).toEqual(["local overrides"]);
            expect(runStep).not.toHaveBeenCalled();
          } finally {
            lstatSpy.mockRestore();
          }
        },
      );
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("aborts in-place updates before package-manager work when required inventory is missing", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      await withTempDir(
        { prefix: "openclaw-package-update-in-place-missing-inventory-" },
        async (base) => {
          const globalDir = path.join(base, "pnpm", "global");
          const globalRoot = path.join(globalDir, "5", "node_modules");
          const packageRoot = path.join(globalRoot, "openclaw");
          await writePackageRoot(packageRoot, "2026.6.7");
          await fs.rm(path.join(packageRoot, "dist", "postinstall-content-inventory.json"));
          await fs.writeFile(
            path.join(packageRoot, "dist", "index.js"),
            "export const local = true;\n",
            "utf8",
          );

          const runStep = vi.fn();

          const result = await runGlobalPackageUpdateSteps({
            installTarget: createPnpmTarget(globalRoot),
            installSpec: "openclaw@2026.6.8",
            packageName: "openclaw",
            packageRoot,
            runCommand: createRootRunner(globalRoot),
            runStep,
            timeoutMs: 1000,
          });

          expect(result.failedStep?.name).toBe("local overrides");
          expect(result.failedStep?.stderrTail).toContain("missing package dist content inventory");
          expect(result.afterVersion).toBeNull();
          expect(result.localOverrides).toBeUndefined();
          expect(result.steps.map((step) => step.name)).toEqual(["local overrides"]);
          expect(runStep).not.toHaveBeenCalled();
          await expect(
            fs.readFile(path.join(packageRoot, "dist", "index.js"), "utf8"),
          ).resolves.toBe("export const local = true;\n");
          await expect(
            fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
          ).resolves.toContain('"version":"2026.6.7"');
        },
      );
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("allows in-place updates for already-published installed packages without content inventory", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      await withTempDir(
        { prefix: "openclaw-package-update-in-place-legacy-missing-inventory-" },
        async (base) => {
          const globalDir = path.join(base, "pnpm", "global");
          const globalRoot = path.join(globalDir, "5", "node_modules");
          const packageRoot = path.join(globalRoot, "openclaw");
          await writePackageRoot(packageRoot, "2026.6.8");
          await fs.rm(path.join(packageRoot, "dist", "postinstall-content-inventory.json"));

          const runStep = vi.fn(async ({ name, argv, cwd }): Promise<PackageUpdateStepResult> => {
            await writePackageRoot(packageRoot, "2026.6.9");
            return {
              name,
              command: argv.join(" "),
              cwd: cwd ?? process.cwd(),
              durationMs: 1,
              exitCode: 0,
            };
          });

          const result = await runGlobalPackageUpdateSteps({
            installTarget: createPnpmTarget(globalRoot),
            installSpec: "openclaw@2026.6.9",
            packageName: "openclaw",
            packageRoot,
            runCommand: createRootRunner(globalRoot),
            runStep,
            timeoutMs: 1000,
          });

          expect(result.failedStep).toBeNull();
          expect(result.afterVersion).toBe("2026.6.9");
          expect(runStep).toHaveBeenCalledTimes(1);
        },
      );
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("prints preserved local override recovery when an in-place update command fails", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      await withTempDir(
        { prefix: "openclaw-package-update-in-place-command-fail-" },
        async (base) => {
          const globalDir = path.join(base, "pnpm", "global");
          const globalRoot = path.join(globalDir, "5", "node_modules");
          const packageRoot = path.join(globalRoot, "openclaw");
          await writePackageRoot(packageRoot, "1.0.0");
          await fs.writeFile(
            path.join(packageRoot, "dist", "index.js"),
            "export const local = true;\n",
            "utf8",
          );

          const runStep = vi.fn(async ({ name, argv, cwd }): Promise<PackageUpdateStepResult> => {
            if (name !== "global update") {
              throw new Error(`unexpected step ${name}`);
            }
            expect(argv).toEqual([
              "pnpm",
              "add",
              "-g",
              "--global-dir",
              globalDir,
              "openclaw@2.0.0",
            ]);
            await writePackageRoot(packageRoot, "2.0.0");
            await fs.writeFile(
              path.join(packageRoot, "dist", "index.js"),
              "export const partial = true;\n",
              "utf8",
            );
            return {
              name,
              command: argv.join(" "),
              cwd: cwd ?? process.cwd(),
              durationMs: 1,
              exitCode: 1,
              stderrTail: "package manager failed after mutation",
            };
          });

          const result = await runGlobalPackageUpdateSteps({
            installTarget: createPnpmTarget(globalRoot),
            installSpec: "openclaw@2.0.0",
            packageName: "openclaw",
            packageRoot,
            runCommand: createRootRunner(globalRoot),
            runStep,
            reapplyLocalOverrides: true,
            timeoutMs: 1000,
          });

          expect(result.failedStep?.name).toBe("global update");
          expect(result.localOverrides?.status).toBe("preserved");
          expect(result.localOverrides?.modified).toBe(1);
          expect(result.localOverrides?.applied).toBe(0);
          expect(result.steps.map((step) => step.name)).toEqual([
            "global update",
            "local overrides",
          ]);
          await expect(
            fs.readFile(path.join(packageRoot, "dist", "index.js"), "utf8"),
          ).resolves.toBe("export const partial = true;\n");
          await expect(
            fs.readFile(
              path.join(result.localOverrides?.recoveryDir ?? "", "files", "dist", "index.js"),
              "utf8",
            ),
          ).resolves.toBe("export const local = true;\n");
        },
      );
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("prints preserved local override recovery when an in-place update fails verification", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      await withTempDir(
        { prefix: "openclaw-package-update-in-place-verify-fail-" },
        async (base) => {
          const globalDir = path.join(base, "pnpm", "global");
          const globalRoot = path.join(globalDir, "5", "node_modules");
          const packageRoot = path.join(globalRoot, "openclaw");
          await writePackageRoot(packageRoot, "1.0.0");
          await fs.writeFile(
            path.join(packageRoot, "dist", "index.js"),
            "export const installed = true;\n",
            "utf8",
          );
          await writePackageDistInventory(packageRoot);
          await fs.writeFile(
            path.join(packageRoot, "dist", "index.js"),
            "export const local = true;\n",
            "utf8",
          );

          const runStep = vi.fn(async ({ name, argv, cwd }): Promise<PackageUpdateStepResult> => {
            if (name !== "global update") {
              throw new Error(`unexpected step ${name}`);
            }
            expect(argv).toEqual([
              "pnpm",
              "add",
              "-g",
              "--global-dir",
              globalDir,
              "openclaw@2.0.0",
            ]);
            await writePackageRoot(packageRoot, "2.0.0");
            await fs.writeFile(
              path.join(packageRoot, "dist", "index.js"),
              "export const updated = true;\n",
              "utf8",
            );
            await fs.writeFile(
              path.join(packageRoot, "dist", "postinstall-content-inventory.json"),
              "[",
              "utf8",
            );
            return {
              name,
              command: argv.join(" "),
              cwd: cwd ?? process.cwd(),
              durationMs: 1,
              exitCode: 0,
            };
          });

          const result = await runGlobalPackageUpdateSteps({
            installTarget: createPnpmTarget(globalRoot),
            installSpec: "openclaw@2.0.0",
            packageName: "openclaw",
            packageRoot,
            runCommand: createRootRunner(globalRoot),
            runStep,
            reapplyLocalOverrides: true,
            timeoutMs: 1000,
          });

          expect(result.failedStep?.name).toBe("global install verify");
          expect(result.localOverrides?.status).toBe("preserved");
          expect(result.localOverrides?.modified).toBe(1);
          expect(result.localOverrides?.applied).toBe(0);
          expect(result.steps.map((step) => step.name)).toEqual([
            "global update",
            "global install verify",
            "local overrides",
          ]);
          await expect(
            fs.readFile(
              path.join(result.localOverrides?.recoveryDir ?? "", "files", "dist", "index.js"),
              "utf8",
            ),
          ).resolves.toBe("export const local = true;\n");
        },
      );
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("reports local override errors when rollback setup fails", async () => {
    await withTempDir({ prefix: "openclaw-package-update-local-rollback-setup-" }, async (base) => {
      const prefix = path.join(base, "prefix");
      const globalRoot = path.join(prefix, "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      await writePackageRoot(packageRoot, "1.0.0");
      await fs.writeFile(
        path.join(packageRoot, "dist", "index.js"),
        "export const local = true;\n",
        "utf8",
      );

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
          return {
            name,
            command: argv.join(" "),
            cwd: cwd ?? process.cwd(),
            durationMs: 1,
            exitCode: 0,
          };
        },
      );
      const realMkdtemp = fs.mkdtemp.bind(fs);
      const mkdtempSpy = vi.spyOn(fs, "mkdtemp").mockImplementation(async (prefixArg, options) => {
        if (prefixArg.endsWith(`${path.sep}rollback-`)) {
          throw createFsError("EACCES", "rollback setup failed");
        }
        return await realMkdtemp(prefixArg, options);
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
          { path: "dist/index.js", reason: "apply-failed" },
        ]);
        expect(result.steps.at(-1)?.name).toBe("local overrides");
        expect(result.steps.at(-1)?.exitCode).toBe(1);
        await expect(fs.readFile(path.join(packageRoot, "dist", "index.js"), "utf8")).resolves.toBe(
          "export {};\n",
        );
        await expect(
          fs.readFile(
            path.join(result.localOverrides?.recoveryDir ?? "", "files", "dist", "index.js"),
            "utf8",
          ),
        ).resolves.toBe("export const local = true;\n");
      } finally {
        mkdtempSpy.mockRestore();
      }
    });
  });

  it.runIf(process.platform !== "win32")(
    "rolls back and reports override chmod failures",
    async () => {
      await withTempDir({ prefix: "openclaw-package-update-local-chmod-fail-" }, async (base) => {
        const packageRoot = path.join(base, "package");
        const indexPath = path.join(packageRoot, "dist", "index.js");
        await writePackageRoot(packageRoot, "1.0.0");
        await fs.writeFile(indexPath, "export const local = true;\n", "utf8");

        const plan = await captureLocalPackageOverrides({ packageRoot });
        expect(plan).not.toBeNull();
        await writePackageRoot(packageRoot, "2.0.0");

        const realOpen = fs.open.bind(fs);
        const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
          const handle = await realOpen(...args);
          if (path.basename(String(args[0])).startsWith(".openclaw-override-")) {
            vi.spyOn(handle, "chmod").mockRejectedValueOnce(
              createFsError("EACCES", "override chmod failed"),
            );
          }
          return handle;
        });

        try {
          const result = await applyLocalPackageOverrides({
            packageRoot,
            plan,
            reapply: true,
          });

          expect(result.status).toBe("error");
          expect(result.applied).toBe(0);
          expect(result.conflicts).toEqual([{ path: "dist/index.js", reason: "apply-failed" }]);
          await expect(fs.readFile(indexPath, "utf8")).resolves.toBe("export {};\n");
        } finally {
          openSpy.mockRestore();
        }
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not expose required fs-safe Python configuration to concurrent operations",
    async () => {
      await withTempDir(
        { prefix: "openclaw-package-update-local-concurrent-config-" },
        async (base) => {
          const previousPythonConfig = getFsSafePythonConfig();
          configureFsSafePython({ mode: "off" });
          try {
            const prepared = await Promise.all(
              ["first", "second"].map(async (name) => {
                const packageRoot = path.join(base, name);
                const indexPath = path.join(packageRoot, "dist", "index.js");
                await writePackageRoot(packageRoot, "1.0.0");
                await fs.writeFile(indexPath, `export const ${name} = true;\n`, "utf8");
                const plan = await captureLocalPackageOverrides({ packageRoot });
                await writePackageRoot(packageRoot, "2.0.0");
                return { packageRoot, plan };
              }),
            );

            const observedModes = new Set<string>();
            const configObserver = setInterval(() => {
              observedModes.add(getFsSafePythonConfig().mode);
            }, 0);
            const results = await Promise.all(
              prepared.map(({ packageRoot, plan }) =>
                applyLocalPackageOverrides({ packageRoot, plan, reapply: true }),
              ),
            ).finally(() => clearInterval(configObserver));

            expect(results.map((result) => result.status)).toEqual(["applied", "applied"]);
            expect([...observedModes]).toEqual(["off"]);
            expect(getFsSafePythonConfig().mode).toBe("off");
          } finally {
            configureFsSafePython(previousPythonConfig);
          }
        },
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "restores updated deletion modes when a later override fails",
    async () => {
      await withTempDir({ prefix: "openclaw-package-update-local-delete-mode-" }, async (base) => {
        const packageRoot = path.join(base, "package");
        const indexPath = path.join(packageRoot, "dist", "index.js");
        const helperPath = path.join(packageRoot, "dist", "helper.js");
        await writePackageRoot(packageRoot, "1.0.0");
        await fs.writeFile(helperPath, "export const helper = true;\n", "utf8");
        await writePackageDistInventory(packageRoot);
        await fs.writeFile(indexPath, "export const local = true;\n", "utf8");
        await fs.rm(helperPath);

        const plan = await captureLocalPackageOverrides({ packageRoot });
        expect(plan).not.toBeNull();
        await writePackageRoot(packageRoot, "2.0.0");
        await fs.writeFile(helperPath, "export const helper = true;\n", "utf8");
        await writePackageDistInventory(packageRoot);
        await fs.chmod(helperPath, 0o600);

        let previousMoveCount = 0;
        __setFsSafeTestHooksForTest({
          beforeRootFallbackMutation: (operation, targetPath) => {
            if (
              operation === "move" &&
              path.basename(targetPath).startsWith(".openclaw-override-previous-")
            ) {
              previousMoveCount += 1;
              if (previousMoveCount === 2) {
                throw createFsError("EACCES", "later override failed");
              }
            }
          },
        });

        try {
          const result = await applyLocalPackageOverrides({
            packageRoot,
            plan,
            reapply: true,
          });

          expect(previousMoveCount).toBe(2);
          expect(result.status).toBe("error");
          expect(result.applied).toBe(0);
          expect(result.conflicts).toEqual([
            { path: "dist/helper.js", reason: "apply-failed" },
            { path: "dist/index.js", reason: "apply-failed" },
          ]);
          await expect(fs.readFile(indexPath, "utf8")).resolves.toBe("export {};\n");
          await expect(fs.readFile(helperPath, "utf8")).resolves.toBe(
            "export const helper = true;\n",
          );
          expect((await fs.stat(helperPath)).mode & 0o777).toBe(0o600);
        } finally {
          __setFsSafeTestHooksForTest(undefined);
        }
      });
    },
  );

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
