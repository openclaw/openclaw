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
import { runGlobalPackageUpdateSteps } from "./package-update-steps.js";
import type { CommandRunner, ResolvedGlobalInstallTarget } from "./update-global.js";

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
});
