// Covers package update step orchestration.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { writePackageDistInventory } from "./package-dist-inventory.js";
import {
  applyLocalPackageOverrides,
  captureLocalPackageOverrides,
} from "./package-local-overrides.js";
import {
  runGlobalPackageUpdateSteps,
  type PackageUpdateStepResult,
} from "./package-update-steps.js";
import {
  resolveNpmGlobalPrefixLayoutFromPrefix,
  type CommandRunner,
  type ResolvedGlobalInstallTarget,
} from "./update-global.js";

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
      helperRelativePath: "dist/local-helper.js",
      name: "minified re-export",
      source: 'export*from"./local-helper.js";\n',
    },
    {
      featureRelativePath: "dist/local-feature.js",
      helperRelativePath: "dist/local-helper.js",
      name: "commented dynamic import",
      source: 'void import(/* webpackChunkName: "local" */ "./local-helper.js");\n',
    },
    {
      featureRelativePath: "dist/local-feature.js",
      helperRelativePath: "dist/local-helper.js",
      name: "template dynamic import",
      source: "void import(`./local-helper.js`);\n",
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
      helperRelativePath: "dist/local-helper.js",
      name: "plain runtime path string",
      source: 'const helperPath = "./local-helper.js";\n',
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

  it("reports a conflict when an updated file blocks a nested added override", async () => {
    await withTempDir({ prefix: "openclaw-package-update-local-added-enotdir-" }, async (base) => {
      const prefix = path.join(base, "prefix");
      const globalRoot = path.join(prefix, "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      const featurePath = path.join(packageRoot, "dist", "feature");
      const localFeaturePath = path.join(packageRoot, "dist", "Feature", "local.js");
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

      const realLstat = fs.lstat.bind(fs);
      const lstatSpy = vi
        .spyOn(fs, "lstat")
        .mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
          const targetPath = String(args[0]);
          if (targetPath === localFeaturePath) {
            const packageVersion = JSON.parse(
              await fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
            ).version;
            if (packageVersion === "2.0.0") {
              throw createFsError("ENOTDIR", "case-aliased ancestor is a file");
            }
          }
          return await realLstat(...args);
        });
      const realRealpath = fs.realpath.bind(fs);
      const realpathSpy = vi
        .spyOn(fs, "realpath")
        .mockImplementation(async (...args: Parameters<typeof fs.realpath>) => {
          if (String(args[0]) === path.dirname(localFeaturePath)) {
            const packageVersion = JSON.parse(
              await fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
            ).version;
            if (packageVersion === "2.0.0") {
              return (await realRealpath(featurePath)) as never;
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
        expect(result.localOverrides?.conflicts).toEqual(
          expect.arrayContaining([
            { path: "dist/feature", reason: "target-changed" },
            { path: "dist/Feature/local.js", reason: "target-exists" },
          ]),
        );
        await expect(fs.readFile(featurePath, "utf8")).resolves.toBe(
          "export const baseline = true;\n",
        );
      } finally {
        lstatSpy.mockRestore();
        realpathSpy.mockRestore();
      }
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
    "reapplies deleted overrides by unlinking hardlinked updated files",
    async () => {
      await withTempDir(
        { prefix: "openclaw-package-update-local-hardlink-delete-" },
        async (base) => {
          const prefix = path.join(base, "prefix");
          const globalRoot = path.join(prefix, "lib", "node_modules");
          const packageRoot = path.join(globalRoot, "openclaw");
          const stagedCache = path.join(base, "cache", "staged");
          await writePackageRoot(packageRoot, "1.0.0");
          await fs.rm(path.join(packageRoot, "dist", "index.js"));

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
          expect(result.localOverrides?.status).toBe("applied");
          expect(result.localOverrides?.applied).toBe(1);
          expect(result.localOverrides?.conflicts).toEqual([]);
          await expectPathMissing(path.join(packageRoot, "dist", "index.js"));
          await expect(
            fs.readFile(path.join(stagedCache, "openclaw-index.js"), "utf8"),
          ).resolves.toBe("export {};\n");
        },
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "reapplies groups containing only deleted hardlinked overrides",
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
          expect(result.localOverrides?.status).toBe("applied");
          expect(result.localOverrides?.applied).toBe(2);
          expect(result.localOverrides?.conflicts).toEqual([]);
          await expectPathMissing(indexPath);
          await expectPathMissing(aliasPath);
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
            { path: "dist/index.js", reason: "target-changed" },
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

  it("does not reapply deleted overrides when a legacy updated package lacks content inventory", async () => {
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
            await writePackageRoot(stagedPackageRoot, "2026.6.6");
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
          installSpec: "openclaw@2026.6.6",
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
          "export {};\n",
        );
      },
    );
  });

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
          "--prefix",
          stagePrefix,
          path.join(packDir, "openclaw-2.0.0.tgz"),
          "--no-fund",
          "--no-audit",
          "--loglevel=error",
          "--min-release-age=0",
        ]);
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
      const staleChunk = path.join(packageRoot, "dist", "install-C_GuuNz6.js");
      await writePackageRoot(packageRoot, "1.0.0");
      await fs.writeFile(staleChunk, 'import "./install.runtime-Xom5hOHq.js";\n', "utf8");

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
      await expectPathMissing(staleChunk);
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
          expect(argv).toEqual(["pnpm", "add", "-g", "--global-dir", globalDir, "openclaw@2.0.0"]);
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

  it("allows in-place updates for legacy installed packages without content inventory", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      await withTempDir(
        { prefix: "openclaw-package-update-in-place-legacy-missing-inventory-" },
        async (base) => {
          const globalDir = path.join(base, "pnpm", "global");
          const globalRoot = path.join(globalDir, "5", "node_modules");
          const packageRoot = path.join(globalRoot, "openclaw");
          await writePackageRoot(packageRoot, "2026.6.6");
          await fs.rm(path.join(packageRoot, "dist", "postinstall-content-inventory.json"));

          const runStep = vi.fn(async ({ name, argv, cwd }): Promise<PackageUpdateStepResult> => {
            await writePackageRoot(packageRoot, "2026.6.8");
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
            installSpec: "openclaw@2026.6.8",
            packageName: "openclaw",
            packageRoot,
            runCommand: createRootRunner(globalRoot),
            runStep,
            timeoutMs: 1000,
          });

          expect(result.failedStep).toBeNull();
          expect(result.afterVersion).toBe("2026.6.8");
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

        const realChmod = fs.chmod.bind(fs);
        const chmodSpy = vi.spyOn(fs, "chmod").mockImplementation(async (targetPath, mode) => {
          if (targetPath === indexPath) {
            throw createFsError("EACCES", "override chmod failed");
          }
          return await realChmod(targetPath, mode);
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
          chmodSpy.mockRestore();
        }
      });
    },
  );

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
      const realCopyFile = fs.copyFile.bind(fs);
      let applyFailureTriggered = false;
      const copyFileSpy = vi
        .spyOn(fs, "copyFile")
        .mockImplementation(async (...args: Parameters<typeof fs.copyFile>) => {
          const [source, destination] = args.map(String);
          if (destination === helperPath) {
            applyFailureTriggered = true;
            throw createFsError("EIO", "reapply copy failed");
          }
          if (
            applyFailureTriggered &&
            source.includes(`${path.sep}rollback-`) &&
            destination === indexPath
          ) {
            throw createFsError("EACCES", "rollback restore failed");
          }
          return await realCopyFile(...args);
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
          "package may be partially modified",
        );
        expect(result.localOverrides?.warnings.join("\n")).toContain(
          "Rollback failed for dist/index.js",
        );
        await expectPathMissing(indexPath);
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
        copyFileSpy.mockRestore();
      }
    });
  });

  it("records rollback removal failures even when byte restoration succeeds", async () => {
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
        const realCopyFile = fs.copyFile.bind(fs);
        const realRm = fs.rm.bind(fs);
        let applyFailureTriggered = false;
        const copyFileSpy = vi
          .spyOn(fs, "copyFile")
          .mockImplementation(async (...args: Parameters<typeof fs.copyFile>) => {
            if (String(args[1]) === helperPath) {
              applyFailureTriggered = true;
              throw createFsError("EIO", "reapply copy failed");
            }
            return await realCopyFile(...args);
          });
        const rmSpy = vi
          .spyOn(fs, "rm")
          .mockImplementation(async (...args: Parameters<typeof fs.rm>) => {
            if (applyFailureTriggered && String(args[0]) === indexPath) {
              throw createFsError("EACCES", "rollback remove failed");
            }
            return await realRm(...args);
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
          await expect(fs.readFile(indexPath, "utf8")).resolves.toBe("export {};\n");
          const rollbackDir = (await fs.readdir(result.localOverrides?.recoveryDir ?? "")).find(
            (entry) => entry.startsWith("rollback-"),
          );
          expect(rollbackDir).toBeDefined();
        } finally {
          copyFileSpy.mockRestore();
          rmSpy.mockRestore();
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
