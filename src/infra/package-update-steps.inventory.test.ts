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
});
