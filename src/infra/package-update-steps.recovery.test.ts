import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { runGlobalPackageUpdateSteps } from "./package-update-steps.js";
import {
  createNpmTarget,
  createRootRunner,
  writePackageRoot,
} from "./package-update-steps.test-support.js";

async function stageCandidatePackage(step: { name: string; argv: string[] }) {
  const stagePrefix = step.argv[step.argv.indexOf("--prefix") + 1];
  if (!stagePrefix) {
    throw new Error("missing stage prefix");
  }
  await writePackageRoot(path.join(stagePrefix, "lib", "node_modules", "openclaw"), "2.0.0");
  return {
    name: step.name,
    command: step.argv.join(" "),
    cwd: stagePrefix,
    durationMs: 0,
    exitCode: 0,
  };
}

async function stageCandidatePackageWithLauncher(step: { name: string; argv: string[] }) {
  const result = await stageCandidatePackage(step);
  const stagePrefix = step.argv[step.argv.indexOf("--prefix") + 1];
  if (!stagePrefix) {
    throw new Error("missing stage prefix");
  }
  const stagedBinDir = path.join(stagePrefix, "bin");
  await fs.mkdir(stagedBinDir, { recursive: true });
  await fs.writeFile(path.join(stagedBinDir, "openclaw"), "candidate launcher\n");
  return result;
}

describe("npm lifecycle policy preflight", () => {
  it.each([false, true])(
    "verifies the original package before recovery from preflight refusal (corrupt=%s)",
    async (corrupt) => {
      await withTestDir({ prefix: "openclaw-recovery-preflight-" }, async (base) => {
        const globalRoot = path.join(base, "lib", "node_modules");
        const target = createNpmTarget(globalRoot);
        const packageRoot = path.join(globalRoot, "openclaw");
        await writePackageRoot(packageRoot, "1.0.0");
        if (corrupt) {
          await fs.rm(path.join(packageRoot, "dist", "index.js"));
        }
        target.npmOwner = {
          version: null,
          lifecyclePolicy: null,
          probeError: "version probe failed",
        };
        const runStep = vi.fn();
        const runCommand = vi.fn(createRootRunner(globalRoot));
        const result = await runGlobalPackageUpdateSteps({
          installTarget: target,
          installSpec: "openclaw@2.0.0",
          packageName: "openclaw",
          runCommand,
          runStep,
          timeoutMs: 1000,
        });
        expect(result.failedStep?.stderrTail).toContain(
          "Unable to determine the owning npm version",
        );
        expect(runCommand).not.toHaveBeenCalled();
        expect(runStep).not.toHaveBeenCalled();
        expect(result.recovery).toEqual(
          corrupt
            ? { serviceRestartSafe: false, reason: "runtime-verification-failed" }
            : { serviceRestartSafe: true, version: "1.0.0" },
        );
      });
    },
  );
});

describe("package update recovery safety", () => {
  it("recovers the verified original when staging preparation fails before hooks run", async () => {
    await withTestDir({ prefix: "openclaw-package-stage-recovery-" }, async (base) => {
      const globalRoot = path.join(base, "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      await writePackageRoot(packageRoot, "1.0.0");
      const stage = vi
        .spyOn(fs, "mkdtemp")
        .mockRejectedValueOnce(Object.assign(new Error("stage denied"), { code: "EACCES" }));
      const runStep = vi.fn();
      try {
        const result = await runGlobalPackageUpdateSteps({
          installTarget: createNpmTarget(globalRoot),
          installSpec: "openclaw@2.0.0",
          packageName: "openclaw",
          packageRoot,
          runCommand: createRootRunner(globalRoot),
          runStep,
          timeoutMs: 1000,
        });
        expect(result.failedStep?.name).toBe("global install stage");
        expect(result.recovery).toEqual({ serviceRestartSafe: true, version: "1.0.0" });
        expect(runStep).not.toHaveBeenCalled();
        expect(await fs.readFile(path.join(packageRoot, "dist", "index.js"), "utf8")).toBe(
          "export {};\n",
        );
      } finally {
        stage.mockRestore();
      }
    });
  });

  it.each(
    (["pnpm", "bun", "npm"] as const).flatMap((manager) =>
      (["install exit", "install throw", "doctor throw"] as const).flatMap((failure) =>
        (manager === "npm" && failure !== "doctor throw"
          ? (["none", "replaced", "corrupt"] as const)
          : (["none"] as const)
        ).map((stagingSideEffect) => ({ manager, failure, stagingSideEffect })),
      ),
    ),
  )(
    "verifies $manager recovery after $failure with $stagingSideEffect staging side effect",
    async ({ manager, failure, stagingSideEffect }) => {
      await withTestDir({ prefix: "openclaw-package-recovery-" }, async (base) => {
        const globalRoot =
          manager === "npm" ? path.join(base, "lib", "node_modules") : path.join(base, "global");
        const packageRoot = path.join(globalRoot, "openclaw");
        await writePackageRoot(packageRoot, "1.0.0");
        const params = {
          installTarget:
            manager === "npm"
              ? createNpmTarget(globalRoot)
              : { manager, command: manager, globalRoot, packageRoot },
          installSpec: "openclaw@2.0.0",
          packageName: "openclaw",
          packageRoot,
          runCommand: createRootRunner(globalRoot),
          runStep: async ({ name, argv }: { name: string; argv: string[] }) => {
            const prefix = argv[argv.indexOf("--prefix") + 1];
            const installRoot =
              manager === "npm" && prefix
                ? path.join(prefix, "lib", "node_modules", "openclaw")
                : packageRoot;
            await writePackageRoot(installRoot, "2.0.0");
            if (stagingSideEffect === "replaced") {
              await writePackageRoot(packageRoot, "2.0.0");
            } else if (stagingSideEffect === "corrupt") {
              await fs.rm(path.join(packageRoot, "dist", "index.js"), { force: true });
            }
            if (failure === "install throw") {
              throw new Error("install interrupted");
            }
            return {
              name,
              command: argv.join(" "),
              cwd: globalRoot,
              durationMs: 0,
              exitCode: failure === "install exit" ? 1 : 0,
            };
          },
          postVerifyStep: async () => {
            throw new Error("doctor interrupted after replacement");
          },
          timeoutMs: 1000,
        };
        const result = await runGlobalPackageUpdateSteps(params);

        expect(result.failedStep).not.toBeNull();
        const safe =
          manager === "npm" && failure !== "doctor throw" && stagingSideEffect === "none";
        expect(result.recovery).toEqual(
          safe
            ? { serviceRestartSafe: true, version: "1.0.0" }
            : {
                serviceRestartSafe: false,
                reason: "runtime-verification-failed",
                ...(manager === "npm" && failure === "doctor throw"
                  ? { packageRollbackVerified: true }
                  : {}),
              },
        );
        const liveVersion =
          manager === "npm" && stagingSideEffect !== "replaced" ? "1.0.0" : "2.0.0";
        if (failure === "doctor throw") {
          expect(result.afterVersion).toBe(liveVersion);
        }
        expect(await fs.readFile(path.join(packageRoot, "package.json"), "utf8")).toContain(
          `"version":"${liveVersion}"`,
        );
      });
    },
  );

  it.each(["backup", "activation"] as const)(
    "handles a %s move rejected after staged lifecycle mutates state",
    async (failure) => {
      await withTestDir({ prefix: "openclaw-package-move-recovery-" }, async (base) => {
        const globalRoot = path.join(base, "lib", "node_modules");
        const packageRoot = path.join(globalRoot, "openclaw");
        await writePackageRoot(packageRoot, "1.0.0");
        const stateCanary = path.join(base, "synthetic-state");
        let source = failure === "backup" ? packageRoot : "";
        let copied = false;
        let cleanupRejected = false;
        const rename = fs.rename.bind(fs);
        const unlink = fs.unlink.bind(fs);
        const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
          if (String(args[0]) === source && !copied) {
            copied = true;
            throw Object.assign(new Error("cross-device move"), { code: "EXDEV" });
          }
          return await rename(...args);
        });
        const unlinkSpy = vi.spyOn(fs, "unlink").mockImplementation(async (target) => {
          await unlink(target);
          if (String(target) === path.join(source, "dist", "index.js") && !cleanupRejected) {
            cleanupRejected = true;
            throw Object.assign(new Error("source cleanup failed after commit"), {
              code: "EACCES",
            });
          }
        });
        let result: Awaited<ReturnType<typeof runGlobalPackageUpdateSteps>>;
        try {
          result = await runGlobalPackageUpdateSteps({
            installTarget: createNpmTarget(globalRoot),
            installSpec: "openclaw@2.0.0",
            packageName: "openclaw",
            packageRoot,
            runCommand: createRootRunner(globalRoot),
            timeoutMs: 1000,
            runStep: async ({ name, argv }) => {
              const prefix = argv[argv.indexOf("--prefix") + 1];
              if (!prefix) {
                throw new Error("missing stage prefix");
              }
              const staged = path.join(prefix, "lib", "node_modules", "openclaw");
              await writePackageRoot(staged, "2.0.0");
              await fs.writeFile(stateCanary, "migrated by staged lifecycle");
              if (failure === "activation") {
                source = staged;
              }
              return { name, command: argv.join(" "), cwd: prefix, durationMs: 0, exitCode: 0 };
            },
          });
        } finally {
          renameSpy.mockRestore();
          unlinkSpy.mockRestore();
        }
        expect(cleanupRejected).toBe(true);
        expect(await fs.readFile(stateCanary, "utf8")).toBe("migrated by staged lifecycle");
        // Main's old activation decision allowed anything except an explicit false.
        // Restored package bytes cannot undo the lifecycle's state mutation.
        expect(result.recovery?.serviceRestartSafe).toBe(false);
        expect(result.failedStep?.stderrTail).toContain("source cleanup failed after commit");
        if (failure === "backup") {
          await expect(
            fs.readFile(path.join(packageRoot, "dist", "index.js")),
          ).rejects.toMatchObject({ code: "ENOENT" });
          const backups = (await fs.readdir(globalRoot)).filter((name) =>
            name.startsWith(`.openclaw.package-backup-${process.pid}-`),
          );
          expect(backups).toHaveLength(1);
          await expect(
            fs.readFile(path.join(globalRoot, backups[0] ?? "", "dist", "index.js"), "utf8"),
          ).resolves.toBe("export {};\n");
        } else {
          expect(result.afterVersion).toBe("1.0.0");
          await expect(
            fs.readFile(path.join(packageRoot, "dist", "index.js"), "utf8"),
          ).resolves.toBe("export {};\n");
        }
      });
    },
  );

  it.each(["blocking", "throwing", "missing", "success"] as const)(
    "commits staged npm only after a %s Doctor outcome",
    async (outcome) => {
      await withTestDir({ prefix: "openclaw-package-recovery-swap-" }, async (base) => {
        const prefix = path.join(base, "prefix");
        const globalRoot = path.join(prefix, "lib", "node_modules");
        const packageRoot = path.join(globalRoot, "openclaw");
        const binDir = path.join(prefix, "bin");
        const shimNames = ["openclaw", "openclaw.cmd", "openclaw.ps1"];
        const stateCanary = path.join(base, "candidate-doctor-state");
        await writePackageRoot(packageRoot, "1.0.0");
        await fs.mkdir(binDir, { recursive: true });
        await Promise.all(
          shimNames.map((name) => fs.writeFile(path.join(binDir, name), `old ${name}\n`, "utf8")),
        );

        const result = await runGlobalPackageUpdateSteps({
          installTarget: createNpmTarget(globalRoot),
          installSpec: "openclaw@2.0.0",
          packageName: "openclaw",
          packageRoot,
          runCommand: createRootRunner(globalRoot),
          runStep: async ({ name, argv }) => {
            const stagePrefix = argv[argv.indexOf("--prefix") + 1];
            if (!stagePrefix) {
              throw new Error("missing stage prefix");
            }
            await writePackageRoot(
              path.join(stagePrefix, "lib", "node_modules", "openclaw"),
              "2.0.0",
            );
            const stagedBinDir = path.join(stagePrefix, "bin");
            await fs.mkdir(stagedBinDir, { recursive: true });
            await Promise.all(
              shimNames.map((shimName) =>
                fs.writeFile(path.join(stagedBinDir, shimName), `new ${shimName}\n`, "utf8"),
              ),
            );
            return {
              name,
              command: argv.join(" "),
              cwd: stagePrefix,
              durationMs: 0,
              exitCode: 0,
            };
          },
          postVerifyStep: async (candidateRoot) => {
            expect(candidateRoot).toBe(packageRoot);
            await expect(
              fs.readFile(path.join(candidateRoot, "package.json"), "utf8"),
            ).resolves.toContain('"version":"2.0.0"');
            for (const shimName of shimNames) {
              await expect(fs.readFile(path.join(binDir, shimName), "utf8")).resolves.toBe(
                `new ${shimName}\n`,
              );
            }
            await fs.writeFile(stateCanary, "mutated by candidate Doctor\n", "utf8");
            if (outcome === "throwing") {
              throw new Error("doctor interrupted after swap");
            }
            if (outcome === "missing") {
              return null;
            }
            return {
              name: "openclaw doctor",
              command: "openclaw doctor --non-interactive --fix",
              cwd: candidateRoot,
              durationMs: 0,
              exitCode: outcome === "blocking" ? 1 : 0,
              stderrTail: outcome === "blocking" ? "doctor rejected candidate" : null,
            };
          },
          timeoutMs: 1000,
        });

        const expectedVersion = outcome === "success" ? "2.0.0" : "1.0.0";
        expect(result.afterVersion).toBe(expectedVersion);
        expect(await fs.readFile(stateCanary, "utf8")).toBe("mutated by candidate Doctor\n");
        await expect(
          fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
        ).resolves.toContain(`"version":"${expectedVersion}"`);
        for (const shimName of shimNames) {
          await expect(fs.readFile(path.join(binDir, shimName), "utf8")).resolves.toBe(
            `${outcome === "success" ? "new" : "old"} ${shimName}\n`,
          );
        }
        expect((await fs.readdir(globalRoot)).filter((entry) => entry.startsWith("."))).toEqual([]);
        if (outcome === "success") {
          expect(result.failedStep).toBeNull();
          expect(result.recovery).toEqual({ serviceRestartSafe: true, version: "2.0.0" });
        } else {
          expect(result.failedStep).not.toBeNull();
          expect(result.recovery).toEqual({
            serviceRestartSafe: false,
            reason: "runtime-verification-failed",
            packageRollbackVerified: true,
          });
          expect(
            result.steps.find((step) => step.name === "global install swap")?.stdoutTail,
          ).toContain("restored previous openclaw package and affected launchers");
          expect(
            result.steps.find((step) => step.name === "global install swap")?.stdoutTail,
          ).toContain("candidate Doctor may have changed persistent state");
        }
      });
    },
  );

  it("restores but does not verify the old package after copy-fallback parking", async () => {
    await withTestDir({ prefix: "openclaw-package-recovery-backup-exdev-" }, async (base) => {
      const globalRoot = path.join(base, "prefix", "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      await writePackageRoot(packageRoot, "1.0.0");

      const rename = fs.rename.bind(fs);
      let forcedCopyFallback = false;
      const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
        const [from, to] = args;
        if (
          !forcedCopyFallback &&
          String(from) === packageRoot &&
          path.basename(String(to)).startsWith(".openclaw.package-backup-")
        ) {
          forcedCopyFallback = true;
          throw Object.assign(new Error("cross-device package backup"), { code: "EXDEV" });
        }
        return await rename(...args);
      });

      let result: Awaited<ReturnType<typeof runGlobalPackageUpdateSteps>>;
      try {
        result = await runGlobalPackageUpdateSteps({
          installTarget: createNpmTarget(globalRoot),
          installSpec: "openclaw@2.0.0",
          packageName: "openclaw",
          packageRoot,
          runCommand: createRootRunner(globalRoot),
          runStep: stageCandidatePackage,
          postVerifyStep: async (candidateRoot) => ({
            name: "openclaw doctor",
            command: "openclaw doctor --non-interactive --fix",
            cwd: candidateRoot,
            durationMs: 0,
            exitCode: 1,
            stderrTail: "doctor rejected candidate",
          }),
          timeoutMs: 1000,
        });
      } finally {
        renameSpy.mockRestore();
      }

      expect(forcedCopyFallback).toBe(true);
      expect(result.afterVersion).toBe("1.0.0");
      expect(result.recovery).toEqual({
        serviceRestartSafe: false,
        reason: "runtime-verification-failed",
        packageRollbackVerified: false,
      });
      expect(result.failedStep?.stderrTail).toContain(
        "package backup did not preserve filesystem identity",
      );
      await expect(fs.readFile(path.join(packageRoot, "dist", "index.js"), "utf8")).resolves.toBe(
        "export {};\n",
      );
      expect((await fs.readdir(globalRoot)).filter((entry) => entry.startsWith("."))).toEqual([]);
    });
  });

  it("retains launcher backup evidence when post-Doctor rollback fails", async () => {
    await withTestDir({ prefix: "openclaw-package-recovery-failed-rollback-" }, async (base) => {
      const prefix = path.join(base, "prefix");
      const globalRoot = path.join(prefix, "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      const binDir = path.join(prefix, "bin");
      const targetShim = path.join(binDir, "openclaw");
      const targetCmdShim = path.join(binDir, "openclaw.cmd");
      await writePackageRoot(packageRoot, "1.0.0");
      await fs.mkdir(binDir, { recursive: true });
      await fs.writeFile(targetShim, "old openclaw\n", "utf8");
      await fs.writeFile(targetCmdShim, "old openclaw.cmd\n", "utf8");
      const copyFile = fs.copyFile.bind(fs);
      const copyFileSpy = vi.spyOn(fs, "copyFile").mockImplementation(async (...args) => {
        const source = String(args[0]);
        if (
          String(args[1]) === targetCmdShim &&
          path.basename(path.dirname(source)).startsWith(".openclaw.shim-backup-")
        ) {
          throw Object.assign(new Error("launcher restoration denied"), { code: "EACCES" });
        }
        return await copyFile(...args);
      });
      let result: Awaited<ReturnType<typeof runGlobalPackageUpdateSteps>>;
      try {
        result = await runGlobalPackageUpdateSteps({
          installTarget: createNpmTarget(globalRoot),
          installSpec: "openclaw@2.0.0",
          packageName: "openclaw",
          packageRoot,
          runCommand: createRootRunner(globalRoot),
          runStep: async ({ name, argv }) => {
            const stagePrefix = argv[argv.indexOf("--prefix") + 1];
            if (!stagePrefix) {
              throw new Error("missing stage prefix");
            }
            await writePackageRoot(
              path.join(stagePrefix, "lib", "node_modules", "openclaw"),
              "2.0.0",
            );
            const stagedBinDir = path.join(stagePrefix, "bin");
            await fs.mkdir(stagedBinDir, { recursive: true });
            await fs.writeFile(path.join(stagedBinDir, "openclaw"), "new openclaw\n", "utf8");
            await fs.writeFile(
              path.join(stagedBinDir, "openclaw.cmd"),
              "new openclaw.cmd\n",
              "utf8",
            );
            return {
              name,
              command: argv.join(" "),
              cwd: stagePrefix,
              durationMs: 0,
              exitCode: 0,
            };
          },
          postVerifyStep: async (candidateRoot) => ({
            name: "openclaw doctor",
            command: "openclaw doctor --non-interactive --fix",
            cwd: candidateRoot,
            durationMs: 0,
            exitCode: 1,
            stderrTail: "doctor rejected candidate",
          }),
          timeoutMs: 1000,
        });
      } finally {
        copyFileSpy.mockRestore();
      }

      expect(result.failedStep).toMatchObject({ name: "global install swap", exitCode: 1 });
      expect(result.failedStep?.stderrTail).toContain("launcher restoration denied");
      expect(result.failedStep?.stderrTail).toContain(`launcher ${targetCmdShim} was not restored`);
      expect(result.recovery).toEqual({
        serviceRestartSafe: false,
        reason: "runtime-verification-failed",
        packageRollbackVerified: false,
      });
      expect(result.afterVersion).toBe("1.0.0");
      await expect(fs.readFile(targetShim, "utf8")).resolves.toBe("old openclaw\n");
      await expect(fs.readFile(targetCmdShim, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      const backupDirs = (await fs.readdir(globalRoot)).filter((entry) =>
        entry.startsWith(".openclaw.shim-backup-"),
      );
      expect(backupDirs).toHaveLength(1);
      await expect(
        fs.readFile(path.join(globalRoot, backupDirs[0] ?? "", "openclaw.cmd"), "utf8"),
      ).resolves.toBe("old openclaw.cmd\n");
    });
  });

  it("rejects a launcher restored from a backup altered by candidate Doctor", async () => {
    await withTestDir({ prefix: "openclaw-package-recovery-altered-launcher-" }, async (base) => {
      const prefix = path.join(base, "prefix");
      const globalRoot = path.join(prefix, "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      const launcher = path.join(prefix, "bin", "openclaw");
      await writePackageRoot(packageRoot, "1.0.0");
      await fs.mkdir(path.dirname(launcher), { recursive: true });
      await fs.writeFile(launcher, "original launcher\n");

      const result = await runGlobalPackageUpdateSteps({
        installTarget: createNpmTarget(globalRoot),
        installSpec: "openclaw@2.0.0",
        packageName: "openclaw",
        packageRoot,
        runCommand: createRootRunner(globalRoot),
        runStep: stageCandidatePackageWithLauncher,
        postVerifyStep: async (candidateRoot) => {
          const backupDir = (await fs.readdir(globalRoot)).find((entry) =>
            entry.startsWith(".openclaw.shim-backup-"),
          );
          if (!backupDir) {
            throw new Error("missing launcher backup");
          }
          await fs.writeFile(path.join(globalRoot, backupDir, "openclaw"), "altered launcher\n");
          return {
            name: "openclaw doctor",
            command: "openclaw doctor --non-interactive --fix",
            cwd: candidateRoot,
            durationMs: 0,
            exitCode: 1,
            stderrTail: "doctor rejected candidate",
          };
        },
        timeoutMs: 1000,
      });

      expect(result.recovery).toEqual({
        serviceRestartSafe: false,
        reason: "runtime-verification-failed",
        packageRollbackVerified: false,
      });
      expect(result.failedStep?.stderrTail).toContain(`launcher backup for ${launcher} changed`);
      await expect(fs.readFile(launcher, "utf8")).resolves.toBe("altered launcher\n");
      expect(
        (await fs.readdir(globalRoot)).filter((entry) =>
          entry.startsWith(".openclaw.shim-backup-"),
        ),
      ).toHaveLength(1);
    });
  });

  it("rejects launcher-backup ownership drift after candidate Doctor", async () => {
    await withTestDir({ prefix: "openclaw-package-recovery-launcher-owner-" }, async (base) => {
      const prefix = path.join(base, "prefix");
      const globalRoot = path.join(prefix, "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      const launcher = path.join(prefix, "bin", "openclaw");
      await writePackageRoot(packageRoot, "1.0.0");
      await fs.mkdir(path.dirname(launcher), { recursive: true });
      await fs.writeFile(launcher, "original launcher\n");
      let doctorRejected = false;
      const lstat = fs.lstat.bind(fs);
      const lstatSpy = vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
        const stat = await lstat(...args);
        if (
          doctorRejected &&
          typeof stat.uid === "bigint" &&
          path.basename(path.dirname(String(args[0]))).startsWith(".openclaw.shim-backup-")
        ) {
          Object.assign(stat, { uid: stat.uid + 1n });
        }
        return stat;
      });

      try {
        const result = await runGlobalPackageUpdateSteps({
          installTarget: createNpmTarget(globalRoot),
          installSpec: "openclaw@2.0.0",
          packageName: "openclaw",
          packageRoot,
          runCommand: createRootRunner(globalRoot),
          runStep: stageCandidatePackageWithLauncher,
          postVerifyStep: async (candidateRoot) => {
            doctorRejected = true;
            return {
              name: "openclaw doctor",
              command: "openclaw doctor --non-interactive --fix",
              cwd: candidateRoot,
              durationMs: 0,
              exitCode: 1,
              stderrTail: "doctor rejected candidate",
            };
          },
          timeoutMs: 1000,
        });

        expect(result.recovery).toEqual({
          serviceRestartSafe: false,
          reason: "runtime-verification-failed",
          packageRollbackVerified: false,
        });
        expect(result.failedStep?.stderrTail).toContain(`launcher backup for ${launcher} changed`);
        await expect(fs.readFile(launcher, "utf8")).resolves.toBe("original launcher\n");
      } finally {
        lstatSpy.mockRestore();
      }
    });
  });

  it("rejects a restored launcher replaced after its fingerprint lstat", async () => {
    await withTestDir({ prefix: "openclaw-package-recovery-launcher-race-" }, async (base) => {
      const prefix = path.join(base, "prefix");
      const globalRoot = path.join(prefix, "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      const launcher = path.join(prefix, "bin", "openclaw");
      const movedLauncher = `${launcher}.moved`;
      await writePackageRoot(packageRoot, "1.0.0");
      await fs.mkdir(path.dirname(launcher), { recursive: true });
      await fs.writeFile(launcher, "original launcher\n");
      let doctorRejected = false;
      let launcherReplaced = false;
      const open = fs.open.bind(fs);
      const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        const handle = await open(...args);
        if (doctorRejected && String(args[0]) === launcher) {
          const stat = handle.stat.bind(handle);
          let statCalls = 0;
          vi.spyOn(handle, "stat").mockImplementation(async () => {
            const openedStat = await stat({ bigint: true });
            statCalls += 1;
            if (statCalls === 2 && !launcherReplaced) {
              launcherReplaced = true;
              await fs.rename(launcher, movedLauncher);
              await fs.symlink(path.basename(movedLauncher), launcher);
            }
            return openedStat;
          });
        }
        return handle;
      });

      try {
        const result = await runGlobalPackageUpdateSteps({
          installTarget: createNpmTarget(globalRoot),
          installSpec: "openclaw@2.0.0",
          packageName: "openclaw",
          packageRoot,
          runCommand: createRootRunner(globalRoot),
          runStep: stageCandidatePackageWithLauncher,
          postVerifyStep: async (candidateRoot) => {
            doctorRejected = true;
            return {
              name: "openclaw doctor",
              command: "openclaw doctor --non-interactive --fix",
              cwd: candidateRoot,
              durationMs: 0,
              exitCode: 1,
              stderrTail: "doctor rejected candidate",
            };
          },
          timeoutMs: 1000,
        });

        expect(launcherReplaced).toBe(true);
        expect(result.recovery).toEqual({
          serviceRestartSafe: false,
          reason: "runtime-verification-failed",
          packageRollbackVerified: false,
        });
        expect(result.failedStep?.stderrTail).toContain(`launcher ${launcher} was not restored`);
        expect((await fs.lstat(launcher)).isSymbolicLink()).toBe(true);
        await expect(fs.readFile(launcher, "utf8")).resolves.toBe("original launcher\n");
      } finally {
        openSpy.mockRestore();
      }
    });
  });

  it("uses nanosecond precision when checking parked package-root metadata", async () => {
    await withTestDir({ prefix: "openclaw-package-recovery-root-ctime-" }, async (base) => {
      const globalRoot = path.join(base, "prefix", "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      await writePackageRoot(packageRoot, "1.0.0");
      let doctorRejected = false;
      const lstat = fs.lstat.bind(fs);
      const lstatSpy = vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
        const stat = await lstat(...args);
        if (
          doctorRejected &&
          "ctimeNs" in stat &&
          path.basename(String(args[0])).startsWith(".openclaw.package-backup-")
        ) {
          Object.assign(stat, { ctimeNs: stat.ctimeNs + 1n });
        }
        return stat;
      });

      try {
        const result = await runGlobalPackageUpdateSteps({
          installTarget: createNpmTarget(globalRoot),
          installSpec: "openclaw@2.0.0",
          packageName: "openclaw",
          packageRoot,
          runCommand: createRootRunner(globalRoot),
          runStep: stageCandidatePackage,
          postVerifyStep: async (candidateRoot) => {
            doctorRejected = true;
            return {
              name: "openclaw doctor",
              command: "openclaw doctor --non-interactive --fix",
              cwd: candidateRoot,
              durationMs: 0,
              exitCode: 1,
              stderrTail: "doctor rejected candidate",
            };
          },
          timeoutMs: 1000,
        });

        expect(result.recovery).toMatchObject({
          serviceRestartSafe: false,
          packageRollbackVerified: false,
        });
        expect(result.failedStep?.stderrTail).toContain("parked package metadata changed");
      } finally {
        lstatSpy.mockRestore();
      }
    });
  });

  it("rechecks parked package-root metadata immediately before restoration", async () => {
    await withTestDir({ prefix: "openclaw-package-recovery-root-race-" }, async (base) => {
      const globalRoot = path.join(base, "prefix", "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      await writePackageRoot(packageRoot, "1.0.0");
      let doctorRejected = false;
      let changedAfterCandidateRemoval = false;
      const rm = fs.rm.bind(fs);
      const rmSpy = vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
        const result = await rm(...args);
        if (doctorRejected && !changedAfterCandidateRemoval && String(args[0]) === packageRoot) {
          const backupName = (await fs.readdir(globalRoot)).find((entry) =>
            entry.startsWith(".openclaw.package-backup-"),
          );
          if (!backupName) {
            throw new Error("missing old-package backup during rollback");
          }
          changedAfterCandidateRemoval = true;
          await fs.utimes(path.join(globalRoot, backupName), new Date(1), new Date(1));
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
          runStep: stageCandidatePackage,
          postVerifyStep: async (candidateRoot) => {
            doctorRejected = true;
            return {
              name: "openclaw doctor",
              command: "openclaw doctor --non-interactive --fix",
              cwd: candidateRoot,
              durationMs: 0,
              exitCode: 1,
              stderrTail: "doctor rejected candidate",
            };
          },
          timeoutMs: 1000,
        });

        expect(changedAfterCandidateRemoval).toBe(true);
        expect(result.afterVersion).toBe("1.0.0");
        expect(result.recovery).toMatchObject({
          serviceRestartSafe: false,
          packageRollbackVerified: false,
        });
        expect(result.failedStep?.stderrTail).toContain("parked package metadata changed");
      } finally {
        rmSpy.mockRestore();
      }
    });
  });

  it("restores the old package when post-backup metadata capture fails", async () => {
    await withTestDir({ prefix: "openclaw-package-recovery-backup-stat-" }, async (base) => {
      const globalRoot = path.join(base, "prefix", "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      const packageEntry = path.join(packageRoot, "dist", "index.js");
      await writePackageRoot(packageRoot, "1.0.0");
      await fs.writeFile(packageEntry, "original old package\n", "utf8");
      const lstat = fs.lstat.bind(fs);
      const lstatSpy = vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
        if (path.basename(String(args[0])).startsWith(".openclaw.package-backup-")) {
          throw Object.assign(new Error("backup metadata unavailable"), { code: "EACCES" });
        }
        return await lstat(...args);
      });

      let result: Awaited<ReturnType<typeof runGlobalPackageUpdateSteps>>;
      try {
        result = await runGlobalPackageUpdateSteps({
          installTarget: createNpmTarget(globalRoot),
          installSpec: "openclaw@2.0.0",
          packageName: "openclaw",
          packageRoot,
          runCommand: createRootRunner(globalRoot),
          runStep: stageCandidatePackage,
          timeoutMs: 1000,
        });
      } finally {
        lstatSpy.mockRestore();
      }

      expect(result.afterVersion).toBe("1.0.0");
      expect(result.recovery).toMatchObject({
        serviceRestartSafe: false,
        packageRollbackVerified: false,
      });
      expect(result.failedStep?.stderrTail).toContain("backup metadata unavailable");
      await expect(fs.readFile(packageEntry, "utf8")).resolves.toBe("original old package\n");
    });
  });

  it("does not verify rollback when candidate Doctor alters the parked old package", async () => {
    await withTestDir({ prefix: "openclaw-package-recovery-altered-backup-" }, async (base) => {
      const globalRoot = path.join(base, "prefix", "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      const packageEntry = path.join(packageRoot, "dist", "index.js");
      await writePackageRoot(packageRoot, "1.0.0");
      await fs.writeFile(packageEntry, "original old package\n", "utf8");

      const result = await runGlobalPackageUpdateSteps({
        installTarget: createNpmTarget(globalRoot),
        installSpec: "openclaw@2.0.0",
        packageName: "openclaw",
        packageRoot,
        runCommand: createRootRunner(globalRoot),
        runStep: stageCandidatePackage,
        postVerifyStep: async (candidateRoot) => {
          expect(candidateRoot).toBe(packageRoot);
          const backupName = (await fs.readdir(globalRoot)).find((entry) =>
            entry.startsWith(".openclaw.package-backup-"),
          );
          if (!backupName) {
            throw new Error("missing old-package backup during candidate Doctor");
          }
          await fs.writeFile(
            path.join(globalRoot, backupName, "dist", "index.js"),
            "altered old package\n",
            "utf8",
          );
          return {
            name: "openclaw doctor",
            command: "openclaw doctor --non-interactive --fix",
            cwd: candidateRoot,
            durationMs: 0,
            exitCode: 1,
            stderrTail: "doctor rejected candidate",
          };
        },
        timeoutMs: 1000,
      });

      expect(result.afterVersion).toBe("1.0.0");
      expect(result.recovery).toEqual({
        serviceRestartSafe: false,
        reason: "runtime-verification-failed",
        packageRollbackVerified: false,
      });
      expect(result.failedStep).toMatchObject({ name: "global install swap", exitCode: 1 });
      expect(result.failedStep?.stderrTail).toContain(
        "rollback verification failed: restored package tree does not match backup",
      );
      await expect(fs.readFile(packageEntry, "utf8")).resolves.toBe("altered old package\n");
    });
  });

  it.each(["add", "remove", "rename"] as const)(
    "does not verify rollback when candidate Doctor performs a parked-tree %s",
    async (mutation) => {
      await withTestDir({ prefix: "openclaw-package-recovery-inventory-" }, async (base) => {
        const globalRoot = path.join(base, "prefix", "lib", "node_modules");
        const packageRoot = path.join(globalRoot, "openclaw");
        await writePackageRoot(packageRoot, "1.0.0");

        const result = await runGlobalPackageUpdateSteps({
          installTarget: createNpmTarget(globalRoot),
          installSpec: "openclaw@2.0.0",
          packageName: "openclaw",
          packageRoot,
          runCommand: createRootRunner(globalRoot),
          runStep: stageCandidatePackage,
          postVerifyStep: async (candidateRoot) => {
            const backupName = (await fs.readdir(globalRoot)).find((entry) =>
              entry.startsWith(".openclaw.package-backup-"),
            );
            if (!backupName) {
              throw new Error("missing old-package backup during candidate Doctor");
            }
            const backupDist = path.join(globalRoot, backupName, "dist");
            const originalEntry = path.join(backupDist, "index.js");
            if (mutation === "add") {
              await fs.writeFile(path.join(backupDist, "added.js"), "added\n");
            } else if (mutation === "remove") {
              await fs.rm(originalEntry);
            } else {
              await fs.rename(originalEntry, path.join(backupDist, "renamed.js"));
            }
            return {
              name: "openclaw doctor",
              command: "openclaw doctor --non-interactive --fix",
              cwd: candidateRoot,
              durationMs: 0,
              exitCode: 1,
              stderrTail: "doctor rejected candidate",
            };
          },
          timeoutMs: 1000,
        });

        expect(result.afterVersion).toBe("1.0.0");
        expect(result.recovery).toMatchObject({
          serviceRestartSafe: false,
          packageRollbackVerified: false,
        });
        expect(result.failedStep?.stderrTail).toContain(
          "rollback verification failed: restored package tree does not match backup",
        );
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "verifies a stable rollback that preserves package hardlink topology",
    async () => {
      await withTestDir({ prefix: "openclaw-package-recovery-stable-hardlink-" }, async (base) => {
        const globalRoot = path.join(base, "prefix", "lib", "node_modules");
        const packageRoot = path.join(globalRoot, "openclaw");
        const packageEntry = path.join(packageRoot, "dist", "index.js");
        const hardlinkPeer = path.join(packageRoot, "dist", "hardlink-peer.js");
        await writePackageRoot(packageRoot, "1.0.0");
        await fs.link(packageEntry, hardlinkPeer);

        const result = await runGlobalPackageUpdateSteps({
          installTarget: createNpmTarget(globalRoot),
          installSpec: "openclaw@2.0.0",
          packageName: "openclaw",
          packageRoot,
          runCommand: createRootRunner(globalRoot),
          runStep: stageCandidatePackage,
          postVerifyStep: async (candidateRoot) => ({
            name: "openclaw doctor",
            command: "openclaw doctor --non-interactive --fix",
            cwd: candidateRoot,
            durationMs: 0,
            exitCode: 1,
            stderrTail: "doctor rejected candidate",
          }),
          timeoutMs: 1000,
        });

        expect(result.recovery).toMatchObject({
          serviceRestartSafe: false,
          packageRollbackVerified: true,
        });
        expect((await fs.stat(packageEntry)).ino).toBe((await fs.stat(hardlinkPeer)).ino);
      });
    },
  );
});
