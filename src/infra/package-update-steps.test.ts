// Covers package update step orchestration.
import fsSync from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { root as fsSafeRoot, type Root } from "@openclaw/fs-safe/root";
import { describe, expect, it, vi } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { runGlobalPackageUpdateSteps } from "./package-update-steps.js";
import {
  createNpmTarget,
  createRootRunner,
  writePackageRoot,
} from "./package-update-steps.test-support.js";
import { resolveNpmGlobalPrefixLayoutFromPrefix } from "./update-npm-prefix.js";

type PackageUpdateStepResult = Awaited<
  ReturnType<typeof runGlobalPackageUpdateSteps>
>["steps"][number];

async function addHardlinkedPackageFile(packageRoot: string, linkRoot: string): Promise<void> {
  const packageFile = path.join(packageRoot, "dist", "index.js");
  await fs.mkdir(linkRoot, { recursive: true });
  await fs.link(packageFile, path.join(linkRoot, `${path.basename(packageRoot)}-index.js`));
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

describe("runGlobalPackageUpdateSteps", () => {
  it.runIf(process.platform !== "win32")(
    "swaps npm package roots that contain package-manager hardlinks",
    async () => {
      await withTestDir({ prefix: "openclaw-package-update-hardlinks-" }, async (base) => {
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
            if (name !== "package-install") {
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
        expect(result.steps.map((step) => step.name)).toEqual(["package-install", "package-swap"]);
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
    await withTestDir({ prefix: "openclaw-package-update-direct-root-" }, async (base) => {
      const managedRoot = path.join(base, ".openclaw", "npm", "node_modules");
      const packageRoot = path.join(managedRoot, "openclaw");
      const staleRenameDir = path.join(managedRoot, ".openclaw-stale");
      await writePackageRoot(packageRoot, "1.0.0");
      await fs.mkdir(staleRenameDir);

      const runStep = vi.fn(async ({ name, argv, cwd }): Promise<PackageUpdateStepResult> => {
        if (name !== "package-install") {
          throw new Error(`unexpected step ${name}`);
        }
        await expectPathMissing(staleRenameDir);
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
      expect(result.activePackageRoot).toBe(packageRoot);
      expect(result.afterVersion).toBe("2.0.0");
      await expect(fs.readFile(path.join(packageRoot, "package.json"), "utf8")).resolves.toContain(
        '"version":"2.0.0"',
      );
      await expectPathMissing(path.join(managedRoot, ".bin", "openclaw"));
    });
  });

  it("accepts v-prefixed exact npm specs when verifying staged installs", async () => {
    await withTestDir({ prefix: "openclaw-package-update-v-prefix-" }, async (base) => {
      const prefix = path.join(base, "prefix");
      const globalRoot = path.join(prefix, "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      await writePackageRoot(packageRoot, "1.0.0");

      const runStep = vi.fn(async ({ name, argv, cwd }): Promise<PackageUpdateStepResult> => {
        if (name !== "package-install") {
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
      expect(result.steps.map((step) => step.name)).toEqual(["package-install", "package-swap"]);
    });
  });

  it.each([
    { installSpec: "openclaw@^2.0.0", installedVersion: "2.4.1" },
    { installSpec: "openclaw@nightly", installedVersion: "3.0.0-beta.2" },
  ])(
    "accepts concrete version $installedVersion staged from $installSpec",
    async ({ installSpec, installedVersion }) => {
      await withTestDir({ prefix: "openclaw-package-update-moving-spec-" }, async (base) => {
        const prefix = path.join(base, "prefix");
        const globalRoot = path.join(prefix, "lib", "node_modules");
        const packageRoot = path.join(globalRoot, "openclaw");
        await writePackageRoot(packageRoot, "1.0.0");
        const postVerifyStep = vi.fn(async (root: string) => ({
          name: "candidate validation",
          command: "doctor",
          cwd: root,
          durationMs: 1,
          exitCode: 0,
        }));

        const result = await runGlobalPackageUpdateSteps({
          installTarget: createNpmTarget(globalRoot),
          installSpec,
          packageName: "openclaw",
          packageRoot,
          runCommand: createRootRunner(globalRoot),
          runStep: async ({ name, argv, cwd }) => {
            if (name !== "package-install") {
              throw new Error(`unexpected step ${name}`);
            }
            const stagePrefix = argv[argv.indexOf("--prefix") + 1];
            if (!stagePrefix) {
              throw new Error("missing staged prefix");
            }
            await writePackageRoot(
              path.join(stagePrefix, "lib", "node_modules", "openclaw"),
              installedVersion,
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

        expect(result.failedStep).toBeNull();
        expect(result.afterVersion).toBe(installedVersion);
        expect(result.steps.map((step) => step.name)).toEqual([
          "package-install",
          "package-swap",
          "candidate validation",
        ]);
        expect(postVerifyStep).toHaveBeenCalledWith(packageRoot, expect.any(Array));
        expect(result.recovery).toEqual({ serviceRestartSafe: true, version: installedVersion });
        await expect(
          fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
        ).resolves.toContain(`"version":"${installedVersion}"`);
      });
    },
  );

  it.each([
    {
      policy: "unbounded",
      workTimeoutMs: null,
      expectedTimeoutMs: undefined,
      outputLimitExceeded: false,
    },
    {
      policy: "explicit",
      workTimeoutMs: 2000,
      expectedTimeoutMs: 2000,
      outputLimitExceeded: false,
    },
    {
      policy: "legacy",
      workTimeoutMs: undefined,
      expectedTimeoutMs: 1000,
      outputLimitExceeded: false,
    },
    {
      policy: "output limited",
      workTimeoutMs: null,
      expectedTimeoutMs: undefined,
      outputLimitExceeded: true,
    },
  ])(
    "packs and installs npm GitHub specs with the $policy work policy",
    async ({ workTimeoutMs, expectedTimeoutMs, outputLimitExceeded }) => {
      await withTestDir({ prefix: "openclaw-package-update-npm-pack-" }, async (base) => {
        const prefix = path.join(base, "prefix");
        const globalRoot = path.join(prefix, "lib", "node_modules");
        const packageRoot = path.join(globalRoot, "openclaw");
        const sourceSpec = "OpenClaw@github:openclaw/openclaw#release/2026.5.12";
        await writePackageRoot(packageRoot, "1.0.0");

        let packDir: string | undefined;
        const runStep = vi.fn(async ({ name, argv, cwd }): Promise<PackageUpdateStepResult> => {
          if (name === "package-pack") {
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
              outputLimitExceeded,
            };
          }
          if (name !== "package-install") {
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
            `--allow-scripts=${path.join(packDir, "openclaw-2.0.0.tgz")}`,
            "--prefix",
            stagePrefix,
            path.join(packDir, "openclaw-2.0.0.tgz"),
            "--no-fund",
            "--no-audit",
            "--loglevel=error",
            "--min-release-age=0",
          ]);
          expect(cwd).toBe(packDir);
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
        });

        const result = await runGlobalPackageUpdateSteps({
          installTarget: createNpmTarget(globalRoot),
          installSpec: sourceSpec,
          packageName: "openclaw",
          packageRoot,
          runCommand: createRootRunner(globalRoot),
          runStep,
          timeoutMs: 1000,
          workTimeoutMs,
        });

        if (outputLimitExceeded) {
          expect(result.failedStep).toMatchObject({
            name: "package-pack",
            exitCode: 0,
            outputLimitExceeded: true,
          });
          expect(runStep).toHaveBeenCalledOnce();
          expect(await fs.readFile(path.join(packageRoot, "package.json"), "utf8")).toContain(
            '"version":"1.0.0"',
          );
        } else {
          expect(result.failedStep).toBeNull();
          expect(result.afterVersion).toBe("2.0.0");
          expect(result.steps.map((step) => step.name)).toEqual([
            "package-pack",
            "package-install",
            "package-swap",
          ]);
        }
        for (const [step] of runStep.mock.calls) {
          expect(step).toMatchObject({ timeoutMs: expectedTimeoutMs });
        }
        if (!packDir) {
          throw new Error("expected npm pack directory");
        }
        await expectPathMissing(packDir);
      });
    },
  );

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
      await withTestDir({ prefix: "openclaw-package-update-npm-pack-variant-" }, async (base) => {
        const globalRoot = path.join(base, "prefix", "lib", "node_modules");
        const packageRoot = path.join(globalRoot, "openclaw");
        await writePackageRoot(packageRoot, "1.0.0");

        let tarball: string | undefined;
        const runStep = vi.fn(async ({ name, argv, cwd }): Promise<PackageUpdateStepResult> => {
          if (name === "package-pack") {
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
          if (name !== "package-install" || !tarball) {
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
          "package-pack",
          "package-install",
          "package-swap",
        ]);
      });
    },
  );

  it("swaps staged npm package roots through the copy fallback when rename crosses devices", async () => {
    await withTestDir({ prefix: "openclaw-package-update-exdev-" }, async (base) => {
      const prefix = path.join(base, "prefix");
      const globalRoot = path.join(prefix, "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");

      const realRename = fs.rename.bind(fs);
      let stagedPackageRoot: string | undefined;
      let exdevMoves = 0;
      const renameSpy = vi
        .spyOn(fs, "rename")
        .mockImplementation(async (...args: Parameters<typeof fs.rename>) => {
          const [from, to] = args;
          if (
            exdevMoves === 0 &&
            String(from) === stagedPackageRoot &&
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
            stagedPackageRoot = path.join(stageLayout.globalRoot, "openclaw");
            await writePackageRoot(stagedPackageRoot, "2.0.0");
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

  it.each(["delayed", "manual"] as const)(
    "keeps a successful staged swap with %s cleanup after a Windows native module error",
    async (cleanupMode) => {
      await withTestDir({ prefix: "openclaw-package-update-staged-cleanup-" }, async (base) => {
        const prefix = path.join(base, "prefix");
        const globalRoot = path.join(prefix, "lib", "node_modules");
        const packageRoot = path.join(globalRoot, "openclaw");
        await writePackageRoot(packageRoot, "1.0.0");
        await fs.writeFile(path.join(packageRoot, "native.node"), "old native module");

        const realUnlink = fs.unlink.bind(fs);
        const realRename = fs.rename;
        let removalAttempts = 0;
        let retirementRefusals = 0;
        const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
          if (
            cleanupMode === "manual" &&
            path.basename(String(args[1])).startsWith(".openclaw-package-backup-")
          ) {
            retirementRefusals += 1;
            throw Object.assign(new Error("backup retirement failed"), { code: "EACCES" });
          }
          return await realRename(...args);
        });
        const unlinkSpy = vi.spyOn(fs, "unlink").mockImplementation(async (target) => {
          const targetPath = String(target);
          if (
            path.basename(targetPath) === "native.node" &&
            path.basename(path.dirname(targetPath)).startsWith(".openclaw.package-backup-")
          ) {
            removalAttempts += 1;
            throw Object.assign(new Error("EPERM: operation not permitted, unlink native.node"), {
              code: "EPERM",
            });
          }
          return await realUnlink(target);
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

          expect(removalAttempts).toBe(process.platform === "win32" ? 2 : 1);
          expect(retirementRefusals).toBe(cleanupMode === "manual" ? 1 : 0);
          expect(result.failedStep).toBeNull();
          expect(result.afterVersion).toBe("2.0.0");
          const swapStep = result.steps.find((step) => step.name === "package-swap");
          expect(swapStep?.stdoutTail).toContain("preserved old package");
          expect(swapStep?.stdoutTail).toContain(
            cleanupMode === "manual" ? "remove it manually" : "delayed cleanup",
          );
          const delayedCleanupDirs = (await fs.readdir(globalRoot)).filter((entry) =>
            entry.startsWith(
              cleanupMode === "manual" ? ".openclaw.package-backup-" : ".openclaw-package-backup-",
            ),
          );
          expect(delayedCleanupDirs).toHaveLength(1);
          await expect(
            fs.readFile(path.join(globalRoot, delayedCleanupDirs[0] ?? "", "native.node"), "utf8"),
          ).resolves.toBe("old native module");
          await expect(
            fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
          ).resolves.toContain('"version":"2.0.0"');
        } finally {
          unlinkSpy.mockRestore();
          renameSpy.mockRestore();
        }
      });
    },
  );

  it("does not run post-verify work when staged npm verification fails", async () => {
    await withTestDir({ prefix: "openclaw-package-update-verify-" }, async (base) => {
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

      expect(result.failedStep?.name).toBe("package-verify");
      expect(result.steps.map((step) => step.name)).toEqual(["package-install", "package-verify"]);
      expect(result.steps.at(-1)?.stderrTail).toContain(
        "expected installed version 2.0.0, found 1.5.0",
      );
      // Staged tree never reached live swap — do not exempt the future-config guard.
      expect(result.activePackageRoot).toBe(packageRoot);
      expect(result.afterVersion).toBe("1.0.0");
      expect(postVerifyStep).not.toHaveBeenCalled();
      await expect(fs.readFile(path.join(packageRoot, "package.json"), "utf8")).resolves.toContain(
        '"version":"1.0.0"',
      );
    });
  });

  it
    .runIf(process.platform !== "win32")
    .each([
      "regular copy",
      "symlink copy",
      "backup copy",
      "shim restore",
      "mode restore",
      "package restore",
    ] as const)("preserves staged swap rollback safety after %s failure", async (failure) => {
    await withTestDir({ prefix: "openclaw-package-update-shim-rollback-" }, async (base) => {
      const prefix = path.join(base, "prefix");
      const globalRoot = path.join(prefix, "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      const targetShim = path.join(prefix, "bin", "openclaw");
      const oldLink = "../lib/node_modules/openclaw/dist/legacy.js";
      const newLink = "../lib/node_modules/openclaw/dist/index.js";
      await writePackageRoot(packageRoot, "1.0.0");
      await fs.mkdir(path.dirname(targetShim), { recursive: true });
      if (failure === "symlink copy") {
        await fs.writeFile(path.join(packageRoot, "dist", "legacy.js"), "old shim\n");
        await fs.symlink(oldLink, targetShim);
      } else {
        await fs.writeFile(targetShim, "old shim\n", "utf8");
      }

      await fs.chmod(targetShim, 0o755);
      let stagedShimForFailure: string | undefined;
      let restoringShim: string | undefined;
      const canonicalBin = await fs.realpath(path.dirname(targetShim));
      const isLauncherStage = (entry: string) =>
        path.dirname(path.dirname(entry)) === canonicalBin &&
        path.basename(path.dirname(entry)).startsWith(".openclaw-shim-stage-");
      const prototype = Object.getPrototypeOf(await fsSafeRoot(base)) as Root;
      // oxlint-disable-next-line typescript/unbound-method -- Called below with the intercepted Root receiver to preserve its path and mutation authority.
      const realCopy = prototype.copyIn;
      const realSymlink = fs.symlink.bind(fs);
      const realRename = fs.rename.bind(fs);
      let copyRefusals = 0;
      let modeRefusals = 0;
      let symlinkRefusals = 0;
      const refusedPackageRestores: Array<[string, string]> = [];
      const rejectRestoredMode = (mode: string | number) => {
        if (failure === "mode restore" && restoringShim && mode === 0o755) {
          modeRefusals += 1;
          throw createFsError("EACCES", "shim mode restoration failed");
        }
      };
      // fs-safe finalizes native copies by fd; its Node fallback uses FileHandle.
      // Exercise the actual mode operation in either installed dependency route.
      const realFchmodSync = fsSync.fchmodSync.bind(fsSync);
      const chmodSyncSpy = vi.spyOn(fsSync, "fchmodSync").mockImplementation((fd, mode) => {
        rejectRestoredMode(mode);
        realFchmodSync(fd, mode);
      });
      const handle = await fs.open(targetShim, "r");
      const handlePrototype = Object.getPrototypeOf(handle) as FileHandle;
      await handle.close();
      // oxlint-disable-next-line typescript/unbound-method -- Called below with the intercepted FileHandle receiver so mode changes retain descriptor custody.
      const realHandleChmod = handlePrototype.chmod;
      const chmodSpy = vi.spyOn(handlePrototype, "chmod").mockImplementation(async function (
        this: FileHandle,
        mode,
      ) {
        rejectRestoredMode(mode);
        await realHandleChmod.call(this, mode);
      });
      const copySpy = vi.spyOn(prototype, "copyIn").mockImplementation(async function (
        this: Root,
        target,
        source,
        options,
      ) {
        const destination = path.join(this.rootReal, target);
        const restoring =
          typeof source === "string" &&
          isLauncherStage(destination) &&
          path.basename(path.dirname(source)).startsWith(".openclaw.shim-backup-");
        if (restoring) {
          restoringShim = destination;
        }
        try {
          if (
            (failure === "backup copy" && source === targetShim) ||
            (failure !== "backup copy" && source === stagedShimForFailure) ||
            (failure === "shim restore" && restoring)
          ) {
            copyRefusals += 1;
            throw createFsError("EACCES", `${failure} failed`);
          }
          await realCopy.call(this, target, source, options);
        } finally {
          if (restoring) {
            restoringShim = undefined;
          }
        }
      });
      const symlinkSpy = vi.spyOn(fs, "symlink").mockImplementation(async (...args) => {
        if (failure === "symlink copy" && args[0] === newLink && isLauncherStage(String(args[1]))) {
          symlinkRefusals += 1;
          throw createFsError("EACCES", "staged symlink creation failed");
        }
        return await realSymlink(...args);
      });
      const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
        if (
          failure === "package restore" &&
          String(args[1]) === packageRoot &&
          path.basename(String(args[0])).startsWith(".openclaw.package-backup-")
        ) {
          refusedPackageRestores.push([String(args[0]), String(args[1])]);
          throw createFsError("EACCES", "package restoration failed");
        }
        return await realRename(...args);
      });
      const beforeActivate = vi.fn(async () => {});

      let result: Awaited<ReturnType<typeof runGlobalPackageUpdateSteps>>;
      try {
        result = await runGlobalPackageUpdateSteps({
          installTarget: createNpmTarget(globalRoot),
          installSpec: "openclaw@2.0.0",
          packageName: "openclaw",
          packageRoot,
          runCommand: createRootRunner(globalRoot),
          beforeActivate,
          runStep: async ({ name, argv, cwd }) => {
            const stagePrefix = argv[argv.indexOf("--prefix") + 1];
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
            if (failure === "symlink copy") {
              await fs.symlink(newLink, stagedShim);
            } else {
              await fs.writeFile(stagedShim, "new shim\n", "utf8");
            }
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
        copySpy.mockRestore();
        symlinkSpy.mockRestore();
        renameSpy.mockRestore();
        chmodSpy.mockRestore();
        chmodSyncSpy.mockRestore();
      }

      expect(copyRefusals).toBe(
        failure === "symlink copy" ? 0 : failure === "shim restore" ? 2 : 1,
      );
      expect(modeRefusals).toBe(failure === "mode restore" ? 1 : 0);
      expect(symlinkRefusals).toBe(failure === "symlink copy" ? 1 : 0);
      expect(result.failedStep?.name).toBe("package-swap");
      if (failure === "package restore") {
        expect(result.afterVersion).toBeNull();
        await expectPathMissing(packageRoot);
        const backupRoot = refusedPackageRestores[0]?.[0];
        if (!backupRoot) {
          throw new Error("expected a refused package restoration");
        }
        // Both original restoration and compensation of the parked candidate are refused.
        expect(refusedPackageRestores).toEqual([
          [backupRoot, packageRoot],
          [`${backupRoot}.candidate`, packageRoot],
        ]);
        await expect(fs.readFile(path.join(backupRoot, "package.json"), "utf8")).resolves.toContain(
          '"version":"1.0.0"',
        );
        await expect(
          fs.readFile(path.join(`${backupRoot}.candidate`, "package.json"), "utf8"),
        ).resolves.toContain('"version":"2.0.0"');
      } else {
        expect(refusedPackageRestores).toEqual([]);
        expect(result.afterVersion).toBe("1.0.0");
        await expect(
          fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
        ).resolves.toContain('"version":"1.0.0"');
      }
      if (failure === "shim restore" || failure === "mode restore") {
        // Atomic replacement preserves the old entry if restoration cannot stage or set its mode.
        await expect(fs.readFile(targetShim, "utf8")).resolves.toBe("old shim\n");
        const backups = (await fs.readdir(globalRoot)).filter((entry) =>
          entry.startsWith(".openclaw.shim-backup-"),
        );
        expect(backups).toHaveLength(1);
        await expect(
          fs.readFile(path.join(globalRoot, backups[0] ?? "", "openclaw"), "utf8"),
        ).resolves.toBe("old shim\n");
      } else {
        await expect(fs.readFile(targetShim, "utf8")).resolves.toBe("old shim\n");
        if (failure === "symlink copy") {
          expect(await fs.readlink(targetShim)).toBe(oldLink);
        }
        expect((await fs.stat(targetShim)).mode & 0o777).toBe(0o755);
      }
      if (
        failure === "shim restore" ||
        failure === "mode restore" ||
        failure === "package restore"
      ) {
        expect(result.recovery?.serviceRestartSafe).toBe(false);
        const backups = (await fs.readdir(globalRoot)).filter((entry) => entry.startsWith("."));
        expect(backups.length).toBeGreaterThan(0);
        const retry = await runGlobalPackageUpdateSteps({
          installTarget: createNpmTarget(globalRoot),
          installSpec: "openclaw@2.0.0",
          packageName: "openclaw",
          packageRoot,
          runCommand: createRootRunner(globalRoot),
          runStep: async ({ name, argv, cwd }) => ({
            name,
            command: argv.join(" "),
            cwd: cwd ?? process.cwd(),
            durationMs: 0,
            exitCode: 1,
            stderrTail: "retry install failed before activation",
          }),
          timeoutMs: 1000,
        });
        expect(retry.failedStep).not.toBeNull();
        expect(await fs.readdir(globalRoot)).toEqual(expect.arrayContaining(backups));
      }
      if (failure === "backup copy") {
        // Launcher backup failed before activation; the original runtime was verified again.
        expect(beforeActivate).not.toHaveBeenCalled();
        expect(result.recovery).toEqual({ serviceRestartSafe: true, version: "1.0.0" });
      } else {
        // After activation, package rollback alone cannot reverse lifecycle state changes.
        expect(beforeActivate).toHaveBeenCalledOnce();
        expect(result.recovery?.serviceRestartSafe).toBe(false);
      }
    });
  });

  it("cleans the staged npm prefix when the install command throws", async () => {
    await withTestDir({ prefix: "openclaw-package-update-cleanup-" }, async (base) => {
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
      ).resolves.toMatchObject({
        failedStep: { stderrTail: "install crashed", exitCode: 1 },
        recovery: { serviceRestartSafe: true, version: "1.0.0" },
      });

      if (stagePrefix === undefined) {
        throw new Error("expected staged install prefix");
      }
      await expectPathMissing(stagePrefix);
    });
  });
});
