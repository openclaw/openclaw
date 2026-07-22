// Covers package update step orchestration.
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
import { runGlobalPackageUpdateSteps } from "./package-update-steps.js";
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

describe("runGlobalPackageUpdateSteps", () => {
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
              "--allow-build=openclaw",
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
              "--allow-build=openclaw",
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
});
