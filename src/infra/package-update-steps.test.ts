// Covers package update step orchestration.
import fs from "node:fs/promises";
import path from "node:path";
import { root as fsSafeRoot, type Root } from "@openclaw/fs-safe/root";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { runGlobalPackageUpdateSteps } from "./package-update-steps.js";
import {
  createNpmUpdateOptions,
  createNpmTarget,
  createRootRunner,
  packageUpdateStepResult,
  stagedNpmPrefix,
  writePackageRoot,
} from "./package-update-steps.test-support.js";
import { resolveNpmGlobalPrefixLayoutFromPrefix } from "./update-npm-prefix.js";
import { updateRunStepsFromResultStep, updateRunWarningMessages } from "./update-run-step.js";
import { runStep as runCommandStep } from "./update-runner-command.js";

type PackageUpdateStepResult = Awaited<
  ReturnType<typeof runGlobalPackageUpdateSteps>
>["steps"][number];

async function addHardlinkedPackageFile(packageRoot: string, linkRoot: string): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
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
  it("swaps staged npm updates into an explicitly selected direct node_modules root", async () => {
    await withTestDir({ prefix: "openclaw-package-update-direct-root-" }, async (base) => {
      const managedRoot = path.join(base, ".openclaw", "npm", "node_modules");
      const packageRoot = path.join(managedRoot, "openclaw");
      const staleRenameDir = path.join(managedRoot, ".openclaw-stale");
      await writePackageRoot(packageRoot, "1.0.0");
      await addHardlinkedPackageFile(packageRoot, path.join(base, "cache", "existing"));
      await fs.mkdir(staleRenameDir);

      const runStep = vi.fn(async ({ name, argv, cwd }): Promise<PackageUpdateStepResult> => {
        if (name !== "package-install") {
          throw new Error(`unexpected step ${name}`);
        }
        await expectPathMissing(staleRenameDir);
        const prefixIndex = argv.indexOf("--prefix");
        expect(prefixIndex).toBeGreaterThan(0);
        const stagePrefix = stagedNpmPrefix(argv);
        expect(path.dirname(stagePrefix)).toBe(managedRoot);
        const stagedRoot = path.join(stagePrefix, "lib", "node_modules", "openclaw");
        await writePackageRoot(stagedRoot, "2.0.0");
        await addHardlinkedPackageFile(stagedRoot, path.join(base, "cache", "staged"));
        expect(argv).toContain("openclaw@v2.0.0");
        await fs.mkdir(path.join(stagePrefix, "bin"), { recursive: true });
        await fs.symlink(
          "../lib/node_modules/openclaw/dist/index.js",
          path.join(stagePrefix, "bin", "openclaw"),
        );
        return packageUpdateStepResult({ name, argv, cwd });
      });

      const result = await runGlobalPackageUpdateSteps({
        installTarget: {
          ...createNpmTarget(managedRoot),
          directNodeModulesRoot: true,
        },
        installSpec: "openclaw@v2.0.0",
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
      if (process.platform !== "win32") {
        await expect(fs.lstat(path.join(packageRoot, "dist", "index.js"))).resolves.toMatchObject({
          nlink: 2,
        });
      }
      await expectPathMissing(path.join(managedRoot, ".bin", "openclaw"));
    });
  });

  it("rejects npm pack output overflow before installation", async () => {
    await withTestDir({ prefix: "openclaw-package-update-npm-pack-" }, async (base) => {
      const globalRoot = path.join(base, "prefix", "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      await writePackageRoot(packageRoot, "1.0.0");
      let packDir: string | undefined;
      const runStep = vi.fn(async ({ name, argv, cwd }): Promise<PackageUpdateStepResult> => {
        packDir = argv[argv.indexOf("--pack-destination") + 1];
        return packageUpdateStepResult({ name, argv, cwd }, { outputLimitExceeded: true });
      });
      const result = await runGlobalPackageUpdateSteps({
        ...createNpmUpdateOptions(globalRoot, "OpenClaw@github:openclaw/openclaw#main"),
        runStep,
        workTimeoutMs: null,
      });
      expect(result.failedStep).toMatchObject({
        name: "package-pack",
        exitCode: 0,
        outputLimitExceeded: true,
      });
      expect(runStep).toHaveBeenCalledOnce();
      expect(runStep.mock.calls[0]?.[0].timeoutMs).toBeUndefined();
      await expect(fs.readFile(path.join(packageRoot, "package.json"), "utf8")).resolves.toContain(
        '"version":"1.0.0"',
      );
      if (!packDir) {
        throw new Error("expected npm pack directory");
      }
      await expectPathMissing(packDir);
    });
  });

  it("packs an aliased hosted GitHub URL and installs without an implicit deadline", async () => {
    await withTestDir({ prefix: "openclaw-package-update-npm-pack-variant-" }, async (base) => {
      const globalRoot = path.join(base, "prefix", "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      const sourceSpec = "openclaw@https://github.com/openclaw/openclaw#main";
      await writePackageRoot(packageRoot, "1.0.0");
      let tarball: string | undefined;
      const runStep = vi.fn(async ({ name, argv, cwd }): Promise<PackageUpdateStepResult> => {
        if (name === "package-pack") {
          const destination = argv[argv.indexOf("--pack-destination") + 1];
          if (!destination) {
            throw new Error("missing pack destination");
          }
          expect(argv).toEqual([
            "npm",
            "pack",
            sourceSpec,
            "--pack-destination",
            destination,
            "--json",
            "--loglevel=error",
          ]);
          tarball = path.join(destination, "openclaw-2.0.0.tgz");
          await fs.writeFile(tarball, "packed\n", "utf8");
          return packageUpdateStepResult({ name, argv, cwd });
        }
        if (name !== "package-install" || !tarball) {
          throw new Error(`unexpected step ${name}`);
        }
        expect(argv).toContain(tarball);
        expect(argv).toContain(`--allow-scripts=${tarball}`);
        expect(cwd).toBe(path.dirname(tarball));
        const stagePrefix = stagedNpmPrefix(argv);
        await writePackageRoot(path.join(stagePrefix, "lib", "node_modules", "openclaw"), "2.0.0");
        return packageUpdateStepResult({ name, argv, cwd });
      });
      const result = await runGlobalPackageUpdateSteps({
        ...createNpmUpdateOptions(globalRoot, sourceSpec),
        runStep,
        workTimeoutMs: null,
      });
      expect(result.failedStep).toBeNull();
      expect(result.afterVersion).toBe("2.0.0");
      expect(result.steps.map((step) => step.name)).toEqual([
        "package-pack",
        "package-install",
        "package-swap",
      ]);
      for (const [step] of runStep.mock.calls) {
        expect(step.timeoutMs).toBeUndefined();
      }
      if (!tarball) {
        throw new Error("expected npm pack tarball");
      }
      await expectPathMissing(path.dirname(tarball));
    });
  });

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
          ...createNpmUpdateOptions(globalRoot),
          packageRoot,
          runStep: async ({ name, argv, cwd }) => {
            const stagePrefix = stagedNpmPrefix(argv);
            const stageLayout = resolveNpmGlobalPrefixLayoutFromPrefix(stagePrefix);
            stagedPackageRoot = path.join(stageLayout.globalRoot, "openclaw");
            await writePackageRoot(stagedPackageRoot, "2.0.0");
            return packageUpdateStepResult({ name, argv, cwd });
          },
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
            ...createNpmUpdateOptions(globalRoot),
            packageRoot,
            runStep: async ({ name, argv, cwd }) => {
              const stagePrefix = stagedNpmPrefix(argv);
              const stageLayout = resolveNpmGlobalPrefixLayoutFromPrefix(stagePrefix);
              await writePackageRoot(path.join(stageLayout.globalRoot, "openclaw"), "2.0.0");
              return packageUpdateStepResult({ name, argv, cwd });
            },
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
        ...createNpmUpdateOptions(globalRoot),
        packageRoot,
        runStep: async ({ name, argv, cwd }) => {
          const stagePrefix = stagedNpmPrefix(argv);
          await writePackageRoot(
            path.join(stagePrefix, "lib", "node_modules", "openclaw"),
            "1.5.0",
          );
          return packageUpdateStepResult({ name, argv, cwd });
        },
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

  it.runIf(process.platform !== "win32").each(["symlink copy", "package restore"] as const)(
    "preserves staged swap rollback safety after %s failure",
    async (failure) => {
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
        let symlinkRefusals = 0;
        const refusedPackageRestores: Array<[string, string]> = [];
        const copySpy = vi.spyOn(prototype, "copyIn").mockImplementation(async function (
          this: Root,
          target,
          source,
          options,
        ) {
          if (source === stagedShimForFailure) {
            copyRefusals += 1;
            throw createFsError("EACCES", `${failure} failed`);
          }
          await realCopy.call(this, target, source, options);
        });
        const symlinkSpy = vi.spyOn(fs, "symlink").mockImplementation(async (...args) => {
          if (
            failure === "symlink copy" &&
            args[0] === newLink &&
            isLauncherStage(String(args[1]))
          ) {
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
            ...createNpmUpdateOptions(globalRoot),
            packageRoot,
            beforeActivate,
            runStep: async ({ name, argv, cwd }) => {
              const stagePrefix = stagedNpmPrefix(argv);
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
              return packageUpdateStepResult({ name, argv, cwd });
            },
          });
        } finally {
          copySpy.mockRestore();
          symlinkSpy.mockRestore();
          renameSpy.mockRestore();
        }

        expect(copyRefusals).toBe(failure === "symlink copy" ? 0 : 1);
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
          await expect(
            fs.readFile(path.join(backupRoot, "package.json"), "utf8"),
          ).resolves.toContain('"version":"1.0.0"');
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
        await expect(fs.readFile(targetShim, "utf8")).resolves.toBe("old shim\n");
        if (failure === "symlink copy") {
          expect(await fs.readlink(targetShim)).toBe(oldLink);
        }
        expect((await fs.stat(targetShim)).mode & 0o777).toBe(0o755);
        if (failure === "package restore") {
          expect(result.recovery?.serviceRestartSafe).toBe(false);
          const backups = (await fs.readdir(globalRoot)).filter((entry) => entry.startsWith("."));
          expect(backups.length).toBeGreaterThan(0);
          const retry = await runGlobalPackageUpdateSteps({
            ...createNpmUpdateOptions(globalRoot),
            packageRoot,
            runStep: async ({ name, argv, cwd }) => ({
              name,
              command: argv.join(" "),
              cwd: cwd ?? process.cwd(),
              durationMs: 0,
              exitCode: 1,
              stderrTail: "retry install failed before activation",
            }),
          });
          expect(retry.failedStep).not.toBeNull();
          expect(await fs.readdir(globalRoot)).toEqual(expect.arrayContaining(backups));
        }
        // Package rollback alone cannot reverse state changed after activation.
        expect(beforeActivate).toHaveBeenCalledOnce();
        expect(result.recovery?.serviceRestartSafe).toBe(false);
      });
    },
  );
});

const dirs = useAutoCleanupTempDirTracker(afterEach);

it.each([
  { manager: "npm", code: "E404", spec: "@example/dependency@*", repaired: true, attempts: 2 },
  { manager: "npm", code: "EINTEGRITY", spec: "file-type@22.1.1", repaired: true, attempts: 2 },
  {
    manager: "npm",
    code: "ETARGET",
    spec: "https://private.invalid/package",
    repaired: false,
    attempts: 1,
  },
  { manager: "npm", code: "ECONNRESET", spec: "", repaired: false, attempts: 2 },
  { manager: "bun", code: "ETARGET", spec: "file-type@22.1.1", repaired: true, attempts: 2 },
] as const)(
  "bounds $manager $code retry for $spec (repaired=$repaired)",
  async ({ manager, code, spec, repaired, attempts }) => {
    const base = dirs.make("package-cache-retry-");
    const globalRoot =
      manager === "npm"
        ? resolveNpmGlobalPrefixLayoutFromPrefix(base).globalRoot
        : path.join(base, "global", "node_modules");
    const packageRoot = path.join(globalRoot, "openclaw");
    await writePackageRoot(packageRoot, "1.0.0");
    const stderr =
      manager === "bun"
        ? `error: No version matching "${spec.split("@")[1]}" found for specifier "${spec.split("@")[0]}" (but package exists)`
        : [
            `npm error code ${code}`,
            ...(spec
              ? [
                  code === "ETARGET"
                    ? `npm error notarget No matching version found for ${spec}.`
                    : code === "E404"
                      ? `npm error 404 '${spec}' is not in this registry.`
                      : `npm warn tarball tarball data for ${spec} (sha512-synthetic) seems to be corrupted. Trying again.`,
                ]
              : []),
          ].join("\n");
    const installs: { argv: string[]; root: string }[] = [];
    const command = vi.fn(async (argv: string[], options: { env?: NodeJS.ProcessEnv }) => {
      const prefix = argv[argv.indexOf("--prefix") + 1];
      const stageRoot =
        manager === "npm"
          ? resolveNpmGlobalPrefixLayoutFromPrefix(prefix!).globalRoot
          : path.join(options.env!.BUN_INSTALL_GLOBAL_DIR!, "node_modules");
      installs.push({ argv, root: stageRoot });
      if (installs.length === 1 || !repaired) {
        return { code: 1, stdout: "", stderr };
      }
      await writePackageRoot(path.join(stageRoot, "openclaw"), "2.0.0");
      return { code: 0, stdout: "", stderr: "" };
    });
    const result = await runGlobalPackageUpdateSteps({
      installTarget:
        manager === "npm"
          ? createNpmTarget(globalRoot)
          : { manager, command: manager, globalRoot, packageRoot },
      packageName: "openclaw",
      installSpec: "openclaw@2.0.0",
      timeoutMs: 1000,
      env: {
        BUN_INSTALL_GLOBAL_DIR: path.dirname(globalRoot),
        BUN_INSTALL_BIN: path.join(base, "bin"),
      },
      runCommand: async () => ({ code: 0, stdout: path.join(base, "bin"), stderr: "" }),
      runStep: async (options) =>
        await runCommandStep({
          ...options,
          cwd: options.cwd ?? base,
          runCommand: command,
          stepIndex: 0,
          totalSteps: 1,
        }),
    });
    expect(installs).toHaveLength(attempts);
    const refresh = attempts === 2 && code !== "ECONNRESET";
    expect(
      installs
        .flatMap(({ argv }) => argv)
        .filter((arg) => arg === "--prefer-online" || arg === "--no-cache"),
    ).toEqual(refresh ? [manager === "npm" ? "--prefer-online" : "--no-cache"] : []);
    expect(installs.flatMap(({ argv }) => argv).includes("--omit=optional")).toBe(
      code === "ECONNRESET",
    );
    if (attempts === 2) {
      expect(installs[1]!.root).not.toBe(installs[0]!.root);
      await expect(fs.access(installs[0]!.root)).rejects.toThrow();
      expect(result.steps[1]?.name).toBe(
        refresh ? "package-install-prefer-online" : "package-install-omit-optional",
      );
    }
    expect(result.failedStep === null).toBe(repaired);
    expect(result.afterVersion).toBe(repaired ? "2.0.0" : null);
    expect(result.recovery.serviceRestartSafe).toBe(true);
    await expect(fs.readFile(path.join(packageRoot, "package.json"), "utf8")).resolves.toContain(
      `"version":"${repaired ? "2.0.0" : "1.0.0"}"`,
    );
    const warnings = updateRunWarningMessages(result.steps.flatMap(updateRunStepsFromResultStep));
    expect(
      warnings.some((message) => message.includes(`Repaired stale package cache for ${spec}`)),
    ).toBe(repaired);
  },
);
