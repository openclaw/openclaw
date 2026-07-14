// Covers package update source preparation and first-stage activation.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  TEST_GIT_COMMIT,
  TEST_GIT_SHA256_COMMIT,
  addHardlinkedPackageFile,
  createNpmTarget,
  createRootRunner,
  expectPathMissing,
  successfulPackagePostinstallStep,
  successfulSourceMetadataStep,
  type PackageUpdateStepResult,
  writeInstalledPackageRoot,
  writePackageRoot,
  writePackageTarball,
} from "../../test/helpers/package-update-steps.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { PACKAGE_INSTALL_GUARD_RELATIVE_PATH } from "./package-dist-inventory.js";
import { readPackageVersion } from "./package-json.js";
import {
  npmPackageMetadataInstallSpec,
  pinGitPackageInstallSpec,
} from "./package-manager-install-policy.js";
import { resolvePackageRuntimeNpmCommand } from "./package-runtime-env.js";
import { preparePackedPackageInstallSpec } from "./package-update-source.js";
import {
  markPackagePostInstallDoctorAdvisory,
  runGlobalPackageUpdateSteps,
} from "./package-update-steps.js";
import {
  createDeferredConfiguredPluginRepairDoctorResult,
  UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE,
} from "./update-doctor-result.js";
import type { CommandRunner } from "./update-global.js";

describe("npm Git source metadata", () => {
  it("preserves an explicit failure to resolve npm for the selected Node", async () => {
    const runStep = vi.fn(async (): Promise<PackageUpdateStepResult> => {
      throw new Error("pack must not run");
    });

    const result = await preparePackedPackageInstallSpec({
      installTarget: createNpmTarget(path.join(process.cwd(), "global")),
      installSpec: "openclaw@2.0.0",
      packageName: "openclaw",
      runStep,
      timeoutMs: 1000,
      runtimeVersion: process.version,
      forcePack: true,
      packCommandArgv: null,
    });

    expect(result.failedStep).toMatchObject({
      name: "global update pack preflight",
      command: "resolve npm for selected Node",
      stderrTail: "could not resolve an npm CLI for the selected managed-service Node",
    });
    expect(runStep).not.toHaveBeenCalled();
  });

  it.each([
    { name: "SHA-1", commit: TEST_GIT_COMMIT },
    { name: "SHA-256", commit: TEST_GIT_SHA256_COMMIT },
  ])("peels an exact $name commit before the npm 10 metadata probe", async ({ commit }) => {
    await withTempDir({ prefix: "openclaw-package-update-exact-git-" }, async (base) => {
      const sourceSpec = `openclaw@github:openclaw/openclaw#${commit}::path:packages/openclaw`;
      const metadataSpec = `github:openclaw/openclaw#${commit}^0::path:packages/openclaw`;
      const pinnedSpec = `github:openclaw/openclaw#${commit}::path:packages/openclaw`;
      const runStep = vi.fn(async ({ name, argv, cwd }): Promise<PackageUpdateStepResult> => {
        if (name === "global update source metadata") {
          expect(argv[2]).toBe(metadataSpec);
          return {
            name,
            command: argv.join(" "),
            cwd: cwd ?? process.cwd(),
            durationMs: 1,
            exitCode: 0,
            stdoutTail: JSON.stringify({
              "engines.node": ">=0.0.0",
              _resolved: `git+https://github.com/openclaw/openclaw.git#${commit}`,
            }),
          };
        }
        if (name === "global update pack") {
          expect(argv[2]).toBe(pinnedSpec);
          const destination = argv[argv.indexOf("--pack-destination") + 1];
          if (!destination) {
            throw new Error("missing pack destination");
          }
          await writePackageTarball(destination, "2.0.0");
          return {
            name,
            command: argv.join(" "),
            cwd: cwd ?? process.cwd(),
            durationMs: 1,
            exitCode: 0,
          };
        }
        throw new Error(`unexpected step ${name}`);
      });

      const result = await preparePackedPackageInstallSpec({
        installTarget: createNpmTarget(path.join(base, "global")),
        installSpec: sourceSpec,
        packageName: "openclaw",
        runStep,
        timeoutMs: 1000,
        runtimeVersion: process.version,
      });

      expect(result.failedStep).toBeNull();
      expect(result.installSpec).toMatch(/openclaw-2\.0\.0\.tgz$/u);
      expect(npmPackageMetadataInstallSpec("openclaw", sourceSpec)).toBe(metadataSpec);
      expect(pinGitPackageInstallSpec("openclaw", sourceSpec, commit)).toBe(pinnedSpec);
      if (result.packDir) {
        await fs.rm(result.packDir, { recursive: true, force: true });
      }
    });
  });
});

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
          const postinstallStep = successfulPackagePostinstallStep({ name, argv, cwd });
          if (postinstallStep) {
            return postinstallStep;
          }
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
          expect(argv).toContain("openclaw@2.0.0");
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
        timeoutMs: 1000,
      });

      expect(result.failedStep).toBeNull();
      expect(result.verifiedPackageRoot).toBe(packageRoot);
      expect(result.afterVersion).toBe("2.0.0");
      expect(result.steps.map((step) => step.name)).toEqual([
        "global update",
        "global install runtime guard",
        "global install postinstall",
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

  it("runs only validated OpenClaw hooks for npm staged installs", async () => {
    await withTempDir({ prefix: "openclaw-package-update-old-npm-" }, async (base) => {
      const prefix = path.join(base, "prefix");
      const globalRoot = path.join(prefix, "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      await writePackageRoot(packageRoot, "1.0.0");

      let stagePackageRoot: string | undefined;
      const runStep = vi.fn(async ({ name, argv, cwd }): Promise<PackageUpdateStepResult> => {
        if (name === "global update") {
          expect(argv).toContain("--ignore-scripts");
          expect(argv.some((arg: string) => arg.startsWith("--allow-scripts="))).toBe(false);
          const stagePrefix = argv[argv.indexOf("--prefix") + 1];
          if (!stagePrefix) {
            throw new Error("missing staged prefix");
          }
          stagePackageRoot = path.join(stagePrefix, "lib", "node_modules", "openclaw");
          await writePackageRoot(stagePackageRoot, "2.0.0");
          await fs.mkdir(path.join(stagePrefix, "bin"), { recursive: true });
          await fs.symlink(
            "../lib/node_modules/openclaw/dist/index.js",
            path.join(stagePrefix, "bin", "openclaw"),
          );
        } else if (name === "global install postinstall") {
          expect(stagePackageRoot).toBeDefined();
          expect(cwd).toBe(stagePackageRoot);
          expect(argv[1]).toBe(
            path.join(stagePackageRoot ?? "", "scripts", "postinstall-bundled-plugins.mjs"),
          );
        } else {
          throw new Error(`unexpected step ${name}`);
        }
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
        "global install runtime guard",
        "global install postinstall",
        "global install swap",
      ]);
      await expectPathMissing(path.join(packageRoot, PACKAGE_INSTALL_GUARD_RELATIVE_PATH));
    });
  });

  it("keeps the live npm package when staged installation fails", async () => {
    await withTempDir({ prefix: "openclaw-package-update-postinstall-failure-" }, async (base) => {
      const globalRoot = path.join(base, "prefix", "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      await writePackageRoot(packageRoot, "1.0.0");

      const result = await runGlobalPackageUpdateSteps({
        installTarget: createNpmTarget(globalRoot),
        installSpec: "openclaw@2.0.0",
        packageName: "openclaw",
        packageRoot,
        runCommand: createRootRunner(globalRoot),
        runStep: async ({ name, argv, cwd }) => {
          if (name === "global update" || name === "global update (omit optional)") {
            return {
              name,
              command: argv.join(" "),
              cwd: cwd ?? process.cwd(),
              durationMs: 1,
              exitCode: 1,
              stderrTail: "postinstall failed",
            };
          }
          throw new Error(`unexpected step ${name}`);
        },
        timeoutMs: 1000,
      });

      expect(result.failedStep).toMatchObject({
        name: "global update (omit optional)",
        stderrTail: "postinstall failed",
      });
      expect(result.afterVersion).toBe("1.0.0");
      expect(await readPackageVersion(packageRoot)).toBe("1.0.0");
      expect(result.steps.some((step) => step.name === "global install swap")).toBe(false);
    });
  });

  it("rejects a new staged package when its install guard is missing", async () => {
    await withTempDir({ prefix: "openclaw-package-update-incomplete-lifecycle-" }, async (base) => {
      const globalRoot = path.join(base, "prefix", "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      await writePackageRoot(packageRoot, "1.0.0");

      const result = await runGlobalPackageUpdateSteps({
        installTarget: createNpmTarget(globalRoot),
        installSpec: "openclaw@2026.7.2",
        packageName: "openclaw",
        packageRoot,
        runCommand: createRootRunner(globalRoot),
        runStep: async ({ name, argv, cwd }) => {
          if (name !== "global update") {
            throw new Error(`unexpected step ${name}`);
          }
          const stagePrefix = argv[argv.indexOf("--prefix") + 1];
          if (!stagePrefix) {
            throw new Error("missing staged prefix");
          }
          await writeInstalledPackageRoot(
            path.join(stagePrefix, "lib", "node_modules", "openclaw"),
            "2026.7.2",
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

      expect(result.failedStep).toMatchObject({
        name: "global install runtime guard",
        stderrTail: expect.stringContaining("missing its package install guard"),
      });
      expect(result.afterVersion).toBe("1.0.0");
      expect(await readPackageVersion(packageRoot)).toBe("1.0.0");
    });
  });

  it("fails before npm activation when selected Node has no usable npm CLI", async () => {
    await withTempDir({ prefix: "openclaw-package-update-npm-preflight-" }, async (base) => {
      const globalRoot = path.join(base, "prefix", "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      await writePackageRoot(packageRoot, "1.0.0");
      const runStep = vi.fn(async (): Promise<PackageUpdateStepResult> => {
        throw new Error("npm activation must not run");
      });

      const result = await runGlobalPackageUpdateSteps({
        installTarget: { ...createNpmTarget(globalRoot), command: "missing-npm" },
        installSpec: "openclaw@2.0.0",
        packageName: "openclaw",
        packageRoot,
        nodePath: path.join(base, "missing", "node"),
        runCommand: async (argv) => ({
          stdout: argv.includes("--version") ? "v24.15.0\n" : "",
          stderr: "",
          code: 0,
        }),
        runStep,
        timeoutMs: 1000,
        env: { PATH: path.join(base, "empty-bin") },
      });

      expect(result.failedStep).toMatchObject({
        name: "global install npm preflight",
        command: "resolve npm for selected Node",
        stderrTail: "could not resolve an npm CLI for the selected managed-service Node",
      });
      expect(result.afterVersion).toBe("1.0.0");
      expect(runStep).not.toHaveBeenCalled();
    });
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
            const postinstallStep = successfulPackagePostinstallStep({ name, argv, cwd });
            if (postinstallStep) {
              return postinstallStep;
            }
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
          "global install runtime guard",
          "global install postinstall",
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
        const postinstallStep = successfulPackagePostinstallStep({ name, argv, cwd });
        if (postinstallStep) {
          return postinstallStep;
        }
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
        const postinstallStep = successfulPackagePostinstallStep({ name, argv, cwd });
        if (postinstallStep) {
          return postinstallStep;
        }
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
        "global install runtime guard",
        "global install postinstall",
        "global install swap",
      ]);
    });
  });

  it("runs only the validated OpenClaw lifecycle after installing a Git candidate", async () => {
    await withTempDir({ prefix: "openclaw-package-update-npm-pack-" }, async (base) => {
      const prefix = path.join(base, "prefix");
      const globalRoot = path.join(prefix, "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      const sourceSpec = "OpenClaw@github:openclaw/openclaw#release/2026.5.12";
      await writePackageRoot(packageRoot, "1.0.0");

      let packDir: string | undefined;
      let finalTarball: string | undefined;
      const runStep = vi.fn(async ({ name, argv, cwd, env }): Promise<PackageUpdateStepResult> => {
        const metadataStep = successfulSourceMetadataStep({
          name,
          argv,
          cwd,
          resolved: `git+https://github.com/openclaw/openclaw.git#${TEST_GIT_COMMIT}`,
          arrayOutput: false,
        });
        if (metadataStep) {
          expect(argv).toEqual([
            resolvePackageRuntimeNpmCommand(process.execPath),
            "view",
            sourceSpec,
            "engines.node",
            "_resolved",
            "--allow-git=root",
            "--ignore-scripts",
            "--json",
            "--loglevel=error",
          ]);
          return metadataStep;
        }
        if (name === "global update pack") {
          const pinnedSpec = pinGitPackageInstallSpec("openclaw", sourceSpec, TEST_GIT_COMMIT);
          expect(argv).toEqual([
            resolvePackageRuntimeNpmCommand(process.execPath),
            "pack",
            pinnedSpec,
            "--allow-git=all",
            "--pack-destination",
            expect.any(String),
            "--ignore-scripts=false",
            "--json",
            "--loglevel=error",
          ]);
          const pathEnv = env?.PATH ?? env?.Path ?? "";
          expect(pathEnv.split(path.delimiter)[0]).toBe(path.dirname(process.execPath));
          const destination = argv[argv.indexOf("--pack-destination") + 1];
          if (!destination) {
            throw new Error("missing pack destination");
          }
          packDir = destination;
          finalTarball = await writePackageTarball(destination, "2.0.0");
          return {
            name,
            command: argv.join(" "),
            cwd: cwd ?? process.cwd(),
            durationMs: 1,
            exitCode: 0,
          };
        }
        if (name === "global install postinstall") {
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
        if (!stagePrefix || !packDir || !finalTarball) {
          throw new Error("missing staged prefix or packed candidate");
        }
        expect(argv).toEqual([
          resolvePackageRuntimeNpmCommand(process.execPath),
          "i",
          "-g",
          "--prefix",
          stagePrefix,
          "--ignore-scripts",
          `openclaw@file:${finalTarball}`,
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
      expect(result.steps[0]?.stdoutTail).toBe(
        "resolved source metadata without running lifecycle scripts",
      );
      expect(result.steps.map((step) => step.name)).toEqual([
        "global update source metadata",
        "global update source runtime guard",
        "global update pack",
        "global update",
        "global install runtime guard",
        "global install postinstall",
        "global install swap",
      ]);
      if (!packDir) {
        throw new Error("expected npm pack directory");
      }
      await expectPathMissing(packDir);
    });
  });

  it("rejects mutable npm Git metadata before the source pack lifecycle", async () => {
    await withTempDir({ prefix: "openclaw-package-update-source-pin-" }, async (base) => {
      const globalRoot = path.join(base, "prefix", "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      const sourceSpec = "github:openclaw/openclaw#main";
      await writePackageRoot(packageRoot, "1.0.0");

      const runStep = vi.fn(async ({ name, argv, cwd }): Promise<PackageUpdateStepResult> => {
        const metadataStep = successfulSourceMetadataStep({
          name,
          argv,
          cwd,
          resolved: "git+https://github.com/openclaw/openclaw.git#main",
        });
        if (!metadataStep) {
          throw new Error(`unexpected step ${name}`);
        }
        return metadataStep;
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

      expect(result.failedStep?.name).toBe("global update source runtime guard");
      expect(result.failedStep?.stderrTail).toContain("immutable Git commit");
      expect(result.steps.map((step) => step.name)).toEqual([
        "global update source metadata",
        "global update source runtime guard",
      ]);
      expect(runStep).toHaveBeenCalledTimes(1);
    });
  });

  it("rejects an npm source before its pack lifecycle when selected Node is unsupported", async () => {
    await withTempDir({ prefix: "openclaw-package-update-source-guard-" }, async (base) => {
      const globalRoot = path.join(base, "prefix", "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      const sourceSpec = "github:openclaw/openclaw#main";
      await writePackageRoot(packageRoot, "1.0.0");

      const runStep = vi.fn(async ({ name, argv, cwd }): Promise<PackageUpdateStepResult> => {
        const metadataStep = successfulSourceMetadataStep({
          name,
          argv,
          cwd,
          nodeEngine: ">=24.15.0 <25",
          resolved: `git+https://github.com/openclaw/openclaw.git#${TEST_GIT_COMMIT}`,
        });
        if (!metadataStep) {
          throw new Error(`unexpected step ${name}`);
        }
        expect(argv).toContain("--ignore-scripts");
        return metadataStep;
      });
      const rootRunner = createRootRunner(globalRoot);
      const runCommand = vi.fn<CommandRunner>(async (argv, options) =>
        argv[0] === "/service/node" && argv[1] === "--version"
          ? { stdout: "v24.14.0\n", stderr: "", code: 0 }
          : await rootRunner(argv, options),
      );

      const result = await runGlobalPackageUpdateSteps({
        installTarget: createNpmTarget(globalRoot),
        installSpec: sourceSpec,
        packageName: "openclaw",
        packageRoot,
        nodePath: "/service/node",
        runCommand,
        runStep,
        timeoutMs: 1000,
      });

      expect(result.failedStep?.name).toBe("global update source runtime guard");
      expect(result.failedStep?.stderrTail).toContain("detected Node 24.14.0");
      expect(result.steps.map((step) => step.name)).toEqual([
        "global update source metadata",
        "global update source runtime guard",
      ]);
      expect(runStep).toHaveBeenCalledTimes(1);
    });
  });
});
