// Covers package update step orchestration.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { writePackageDistInventory } from "../../scripts/lib/package-dist-inventory.ts";
import { withTempDir } from "../test-helpers/temp-dir.js";
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

function createNpmTarget(globalRoot: string): ResolvedGlobalInstallTarget {
  return {
    manager: "npm",
    command: "npm",
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
});
