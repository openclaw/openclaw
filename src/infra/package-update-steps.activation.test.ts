// Covers package update activation, rollback, and package-manager layouts.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  TEST_GIT_COMMIT,
  createFsError,
  createNpmTarget,
  createPnpmTarget,
  createRootRunner,
  expectPathMissing,
  successfulPackagePostinstallStep,
  successfulSourceMetadataStep,
  type PackageUpdateStepResult,
  writePackageRoot,
  writePackageTarball,
} from "../../test/helpers/package-update-steps.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { readPackageVersion } from "./package-json.js";
import { pinGitPackageInstallSpec } from "./package-manager-install-policy.js";
import { runGlobalPackageUpdateSteps } from "./package-update-steps.js";
import { resolveNpmGlobalPrefixLayoutFromPrefix, type CommandRunner } from "./update-global.js";

function expectedPackageRuntimeNpmCommand(): string {
  return path.join(
    path.dirname(process.execPath),
    process.platform === "win32" ? "npm.cmd" : "npm",
  );
}

describe("runGlobalPackageUpdateSteps activation", () => {
  it("runs the resolved npm CLI under selected Node when adjacent npm is missing", async () => {
    await withTempDir({ prefix: "openclaw-package-update-local-pack-" }, async (base) => {
      const prefix = path.join(base, "prefix");
      const globalRoot = path.join(prefix, "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      const sourceDir = path.join(base, "candidate");
      const npmCommand = path.join(
        base,
        "npm-prefix",
        "bin",
        process.platform === "win32" ? "npm.cmd" : "npm",
      );
      const npmCli = path.join(
        base,
        "npm-prefix",
        "lib",
        "node_modules",
        "npm",
        "bin",
        "npm-cli.js",
      );
      await writePackageRoot(packageRoot, "1.0.0");
      await fs.mkdir(sourceDir, { recursive: true });
      await fs.mkdir(path.dirname(npmCommand), { recursive: true });
      await fs.mkdir(path.dirname(npmCli), { recursive: true });
      await fs.writeFile(npmCommand, "#!/bin/sh\n", "utf8");
      await fs.chmod(npmCommand, 0o755);
      await fs.writeFile(npmCli, "", "utf8");

      let tarball: string | undefined;
      const runStep = vi.fn(async ({ name, argv, cwd, env }): Promise<PackageUpdateStepResult> => {
        const metadataStep = successfulSourceMetadataStep({
          name,
          argv,
          cwd,
          resolved: sourceDir,
        });
        if (metadataStep) {
          expect(argv).toEqual([
            "/service/node",
            npmCli,
            "view",
            sourceDir,
            "engines.node",
            "_resolved",
            "--ignore-scripts",
            "--json",
            "--loglevel=error",
          ]);
          return metadataStep;
        }
        if (name === "global update pack") {
          expect(argv.slice(0, 4)).toEqual(["/service/node", npmCli, "pack", sourceDir]);
          expect(argv).not.toContain("--allow-git=all");
          expect(argv).toContain("--ignore-scripts=false");
          const pathEnv = env?.PATH ?? env?.Path ?? "";
          expect(pathEnv.split(path.delimiter)[0]).toBe("/service");
          const destination = argv[argv.indexOf("--pack-destination") + 1];
          if (!destination) {
            throw new Error("missing pack destination");
          }
          tarball = await writePackageTarball(destination, "2.0.0");
        } else if (name === "global install postinstall") {
          return successfulPackagePostinstallStep({ name, argv, cwd })!;
        } else if (name === "global update" || name === "global update (omit optional)") {
          if (!tarball) {
            throw new Error("missing packed local candidate");
          }
          expect(argv.slice(0, 4)).toEqual(["/service/node", npmCli, "i", "-g"]);
          expect(argv).toContain(`openclaw@file:${tarball}`);
          const stagePrefix = argv[argv.indexOf("--prefix") + 1];
          if (!stagePrefix) {
            throw new Error("missing staged prefix");
          }
          if (name === "global update") {
            return {
              name,
              command: argv.join(" "),
              cwd: cwd ?? process.cwd(),
              durationMs: 1,
              exitCode: 1,
            };
          }
          expect(argv).toContain("--omit=optional");
          await writePackageRoot(
            path.join(stagePrefix, "lib", "node_modules", "openclaw"),
            "2.0.0",
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
      const rootRunner = createRootRunner(globalRoot);
      const runCommand = vi.fn<CommandRunner>(async (argv, options) =>
        argv[0] === "/service/node" && argv[1] === "--version"
          ? { stdout: "v24.15.0\n", stderr: "", code: 0 }
          : await rootRunner(argv, options),
      );

      const result = await runGlobalPackageUpdateSteps({
        installTarget: { ...createNpmTarget(globalRoot), command: npmCommand },
        installSpec: sourceDir,
        packageName: "openclaw",
        packageRoot,
        nodePath: "/service/node",
        runCommand,
        runStep,
        timeoutMs: 1000,
        env: { PATH: "/usr/bin" },
      });

      expect(result.failedStep).toBeNull();
      expect(result.afterVersion).toBe("2.0.0");
      expect(result.steps.map((step) => step.name)).toEqual([
        "global update source metadata",
        "global update source runtime guard",
        "global update pack",
        "global update",
        "global update (omit optional)",
        "global install runtime guard",
        "global install postinstall",
        "global install swap",
      ]);
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
      name: "hosted GitLab URL without git suffix",
      sourceSpec: "https://gitlab.com/openclaw/openclaw#main",
    },
    {
      name: "hosted Bitbucket URL without git suffix",
      sourceSpec: "https://bitbucket.org/openclaw/openclaw#main",
    },
    {
      name: "hosted SourceHut URL without git suffix",
      sourceSpec: "https://git.sr.ht/~openclaw/openclaw#main",
    },
    {
      name: "GitHub shorthand",
      sourceSpec: "openclaw/openclaw#main",
    },
    {
      name: "GitHub semver with package subdirectory",
      sourceSpec: "github:openclaw/openclaw#semver:^2026.7.0::path:packages/openclaw",
    },
    {
      name: "SCP-style SSH",
      sourceSpec: "git@github.com:openclaw/openclaw.git#main",
    },
    {
      name: "GitLab shortcut",
      sourceSpec: "gitlab:openclaw/openclaw#main",
    },
    {
      name: "Bitbucket shortcut",
      sourceSpec: "bitbucket:openclaw/openclaw#main",
    },
    {
      name: "gist shortcut",
      sourceSpec: "gist:11081aaa281#main",
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
          const metadataStep = successfulSourceMetadataStep({
            name,
            argv,
            cwd,
            resolved: `git+https://example.invalid/openclaw.git#${TEST_GIT_COMMIT}`,
          });
          if (metadataStep) {
            expect(argv.slice(0, 6)).toEqual([
              expectedPackageRuntimeNpmCommand(),
              "view",
              sourceSpec,
              "engines.node",
              "_resolved",
              "--allow-git=root",
            ]);
            return metadataStep;
          }
          if (name === "global update pack") {
            const destination = argv[argv.indexOf("--pack-destination") + 1];
            if (!destination) {
              throw new Error("missing pack destination");
            }
            const pinnedSpec = pinGitPackageInstallSpec("openclaw", sourceSpec, TEST_GIT_COMMIT);
            expect(argv.slice(0, 4)).toEqual([
              expectedPackageRuntimeNpmCommand(),
              "pack",
              pinnedSpec,
              "--allow-git=all",
            ]);
            expect(argv).toContain("--ignore-scripts=false");
            tarball = await writePackageTarball(destination, "2.0.0");
            return {
              name,
              command: argv.join(" "),
              cwd: cwd ?? process.cwd(),
              durationMs: 1,
              exitCode: 0,
            };
          }
          const postinstallStep = successfulPackagePostinstallStep({ name, argv, cwd });
          if (postinstallStep) {
            return postinstallStep;
          }
          if (name !== "global update" || !tarball) {
            throw new Error(`unexpected step ${name}`);
          }
          expect(argv).toContain(`openclaw@file:${tarball}`);
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
          "global update source metadata",
          "global update source runtime guard",
          "global update pack",
          "global update",
          "global install runtime guard",
          "global install postinstall",
          "global install swap",
        ]);
      });
    },
  );

  it("keeps the canonical package root when activating an npm alias", async () => {
    await withTempDir({ prefix: "openclaw-package-update-npm-alias-" }, async (base) => {
      const globalRoot = path.join(base, "prefix", "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      const sourceSpec = "openclaw@npm:@vendor/openclaw@1.2.3";
      await writePackageRoot(packageRoot, "1.0.0");

      const runStep = vi.fn(async ({ name, argv, cwd }): Promise<PackageUpdateStepResult> => {
        const postinstallStep = successfulPackagePostinstallStep({ name, argv, cwd });
        if (postinstallStep) {
          return postinstallStep;
        }
        if (name !== "global update") {
          throw new Error(`unexpected step ${name}`);
        }
        expect(argv).toContain(sourceSpec);
        const stagePrefix = argv[argv.indexOf("--prefix") + 1];
        if (!stagePrefix) {
          throw new Error("missing staged prefix");
        }
        await writePackageRoot(path.join(stagePrefix, "lib", "node_modules", "openclaw"), "2.0.0", {
          packageName: "@vendor/openclaw",
        });
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
        "global update",
        "global install runtime guard",
        "global install postinstall",
        "global install swap",
      ]);
    });
  });

  it("keeps a known live package root when the selected Node owns another npm prefix", async () => {
    await withTempDir({ prefix: "openclaw-package-update-known-root-" }, async (base) => {
      const globalRoot = path.join(base, "custom", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      const nodePath = path.join(base, "service", "bin", "node");
      const npmCommand = path.join(base, "service", "bin", "npm");
      const npmOwnedPackageRoot = path.join(base, "service", "lib", "node_modules", "openclaw");
      await writePackageRoot(packageRoot, "1.0.0");
      await fs.mkdir(path.dirname(npmCommand), { recursive: true });
      await fs.writeFile(npmCommand, "#!/bin/sh\n", { encoding: "utf8", mode: 0o755 });

      const result = await runGlobalPackageUpdateSteps({
        installTarget: {
          ...createNpmTarget(path.join(base, "opaque-global-root")),
          packageRoot: null,
        },
        installSpec: "openclaw@2.0.0",
        packageName: "openclaw",
        packageRoot,
        nodePath,
        runCommand: async (argv) => {
          if (argv.join(" ") === `${nodePath} --version`) {
            return { stdout: "v24.15.0\n", stderr: "", code: 0 };
          }
          if (argv.at(-1) === "--version") {
            return { stdout: "11.9.0\n", stderr: "", code: 0 };
          }
          throw new Error(`unexpected command: ${argv.join(" ")}`);
        },
        runStep: async ({ name, argv, cwd }) => {
          const postinstallStep = successfulPackagePostinstallStep({ name, argv, cwd });
          if (postinstallStep) {
            return postinstallStep;
          }
          if (name !== "global update") {
            throw new Error(`unexpected step ${name}`);
          }
          expect(argv[0]).toBe(npmCommand);
          const stagePrefix = argv[argv.indexOf("--prefix") + 1];
          expect(stagePrefix).toMatch(
            new RegExp(`^${globalRoot.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`),
          );
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

      expect(result.failedStep).toBeNull();
      expect(result.afterVersion).toBe("2.0.0");
      expect(await readPackageVersion(packageRoot)).toBe("2.0.0");
      await expectPathMissing(npmOwnedPackageRoot);
    });
  });

  it.skipIf(process.platform === "win32")(
    "fails before activation when the npm prefix layout is unresolved",
    async () => {
      await withTempDir({ prefix: "openclaw-package-update-opaque-root-" }, async (base) => {
        const globalRoot = path.join(base, "opaque-global-root");
        const packageRoot = path.join(base, "live", "openclaw");
        const npmCli = path.join(base, "canonical", "npm-cli.js");
        await writePackageRoot(packageRoot, "1.0.0");
        await fs.mkdir(path.dirname(npmCli), { recursive: true });
        await fs.writeFile(npmCli, "#!/usr/bin/env node\n", { encoding: "utf8", mode: 0o755 });
        const runStep = vi.fn();

        const result = await runGlobalPackageUpdateSteps({
          installTarget: { ...createNpmTarget(globalRoot), command: npmCli, packageRoot },
          installSpec: "openclaw@2.0.0",
          packageName: "openclaw",
          packageRoot,
          nodePath: process.execPath,
          runCommand: async (argv) => {
            if (argv.join(" ") === `${process.execPath} --version`) {
              return { stdout: `${process.version}\n`, stderr: "", code: 0 };
            }
            throw new Error(`unexpected command: ${argv.join(" ")}`);
          },
          runStep,
          timeoutMs: 1000,
        });

        expect(result.failedStep).toMatchObject({
          name: "global install stage",
          stderrTail: "cannot resolve npm global prefix layout for safe staged activation",
        });
        expect(await readPackageVersion(packageRoot)).toBe("1.0.0");
        expect(runStep).not.toHaveBeenCalled();
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
            const postinstallStep = successfulPackagePostinstallStep({ name, argv, cwd });
            if (postinstallStep) {
              return postinstallStep;
            }
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
        const postinstallStep = successfulPackagePostinstallStep({ name, argv, cwd });
        if (postinstallStep) {
          return postinstallStep;
        }
        if (name !== "global update") {
          throw new Error(`unexpected step ${name}`);
        }
        expect(argv[0]).toBe(expectedPackageRuntimeNpmCommand());
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
        "global install runtime guard",
        "global install postinstall",
        "global install swap",
      ]);
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

        const runStep = vi.fn(async ({ name, argv, cwd }): Promise<PackageUpdateStepResult> => {
          if (name !== "global update") {
            throw new Error(`unexpected step ${name}`);
          }
          expect(argv).toEqual(["pnpm", "add", "-g", "--global-dir", globalDir, "openclaw@2.0.0"]);
          await writePackageRoot(packageRoot, "2.0.0");
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
        expect(result.steps.map((step) => step.name)).toEqual(["global update"]);
      });
    } finally {
      platformSpy.mockRestore();
    }
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
            const postinstallStep = successfulPackagePostinstallStep({ name, argv, cwd });
            if (postinstallStep) {
              return postinstallStep;
            }
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
          const postinstallStep = successfulPackagePostinstallStep({ name, argv, cwd });
          if (postinstallStep) {
            return postinstallStep;
          }
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
        "global install runtime guard",
        "global install postinstall",
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

  it.runIf(process.platform !== "win32")(
    "restores the existing bin shim when staged shim replacement fails",
    async () => {
      await withTempDir({ prefix: "openclaw-package-update-shim-rollback-" }, async (base) => {
        const prefix = path.join(base, "prefix");
        const globalRoot = path.join(prefix, "lib", "node_modules");
        const packageRoot = path.join(globalRoot, "openclaw");
        const targetShim = path.join(prefix, "bin", "openclaw");
        await writePackageRoot(packageRoot, "1.0.0");
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
              const postinstallStep = successfulPackagePostinstallStep({ name, argv, cwd });
              if (postinstallStep) {
                return postinstallStep;
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
        await expect(
          fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
        ).resolves.toContain('"version":"1.0.0"');
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
