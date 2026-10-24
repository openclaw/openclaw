import assert from "node:assert/strict";
import fsSync, { unlinkSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { root as fsSafeRoot, type Root } from "@openclaw/fs-safe/root";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { PACKAGE_DIST_INVENTORY_RELATIVE_PATH } from "./package-dist-inventory.js";
import { runGlobalPackageUpdateSteps } from "./package-update-steps.js";
import { packageUpdateStepResult, writePackageRoot } from "./package-update-steps.test-support.js";
import type { PackageUpdateTransaction } from "./package-update-swap-contract.js";
import type { ResolvedGlobalInstallTarget } from "./update-global.js";

const readText = (file: string) => fs.readFile(file, "utf8");
const expectText = async (file: string, expected: string) =>
  expect(await readText(file)).toBe(expected);
const expectVersion = async (root: string, version: string) =>
  expect(await readText(path.join(root, "package.json"))).toContain(`"version":"${version}"`);
const expectMissing = async (file: string) =>
  expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
const expectPresent = async (file: string) => expect(fs.stat(file)).resolves.toBeDefined();
const writeText = async (file: string, text: string) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
};
const writeOwner = async (root: string, version: string) => {
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ dependencies: { openclaw: version } }),
  );
  await fs.writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
};
function executorAuthority() {
  let current = true;
  return {
    revoke: () => {
      current = false;
    },
    assertCurrent: () => {
      assert(current, "native executor lost");
    },
  };
}
async function expectRevoked(transaction: PackageUpdateTransaction, assertCurrent: () => void) {
  await expect(transaction.rollback(assertCurrent)).rejects.toThrow("native executor lost");
  await expect(transaction.complete({ activationVerified: true }, () => {})).rejects.toThrow(
    "native executor lost",
  );
}

function readPnpmStageArgs(argv: string[]) {
  return {
    projectRoot: argv
      .find((arg) => arg.startsWith("--config.global-dir="))
      ?.slice("--config.global-dir=".length),
    binDir: argv
      .find((arg) => arg.startsWith("--config.global-bin-dir="))
      ?.slice("--config.global-bin-dir=".length),
  };
}

describe.runIf(process.platform !== "win32")("native package transactions", () => {
  it("stages pnpm before reading admission-gated options", async () => {
    const manager = "pnpm";
    await withTestDir({ prefix: "openclaw-native-admission-" }, async (base) => {
      const project = path.join(base, manager, "global");
      const globalRoot = path.join(project, "5", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      const binDir = path.join(base, "bin");
      await writePackageRoot(packageRoot, "1.0.0");
      const probes: string[][] = [];
      let admitted = false;
      const beforeVerifyCandidate = vi.fn(async () => {
        admitted = true;
        throw new Error("fixture stop at candidate admission");
      });
      const result = await runGlobalPackageUpdateSteps({
        installTarget: { manager, command: manager, globalRoot, packageRoot },
        installSpec: "openclaw@2.0.0",
        packageName: "openclaw",
        timeoutMs: 1000,
        get requirePackageReplacement() {
          if (!admitted) {
            throw new Error("Staged update has not been admitted for activation.");
          }
          return true;
        },
        beforeVerifyCandidate,
        runCommand: async (argv) => {
          probes.push(argv);
          const stage = readPnpmStageArgs(argv);
          return {
            code: 0,
            stderr: "",
            stdout:
              argv[1] === "root" && stage.projectRoot
                ? path.join(stage.projectRoot, "5", "node_modules")
                : (stage.binDir ?? binDir),
          };
        },
        runStep: async ({ name, argv, cwd }) => {
          if (!cwd) {
            throw new Error("missing native stage directory");
          }
          await writePackageRoot(
            path.join(cwd, path.relative(project, globalRoot), "openclaw"),
            "2.0.0",
          );
          return packageUpdateStepResult({ name, argv, cwd }, { durationMs: 0 });
        },
      });

      expect(result.failedStep?.stderrTail).toBe("fixture stop at candidate admission");
      expect(beforeVerifyCandidate).toHaveBeenCalledOnce();
      expect(probes[0]).toEqual(["pnpm", "bin", "-g"]);
      expect(probes.map((argv) => argv[1])).toEqual(["bin", "root", "bin"]);
    });
  });

  it.each([
    { siblingChange: "before", shimFailure: false, rollbackFailure: "none" },
    { siblingChange: "after", shimFailure: false, rollbackFailure: "none" },
    { siblingChange: "none", shimFailure: true, rollbackFailure: "launcher-owner" },
    ...(["shim", "package", "backup-cleanup", "copy-publication", "copy-cleanup"] as const).map(
      (rollbackFailure) => ({
        siblingChange: "none" as const,
        shimFailure: false,
        rollbackFailure,
      }),
    ),
  ] as const)(
    "preserves pnpm native project ownership (sibling change=$siblingChange, shim failure=$shimFailure, rollback failure=$rollbackFailure)",
    async ({ siblingChange, shimFailure, rollbackFailure }) => {
      await withTestDir({ prefix: "openclaw-native-update-" }, async (base) => {
        const manager = "pnpm";
        const project = path.join(base, manager, "global");
        const globalRoot = path.join(project, "v11");
        const oldOwner = path.join(globalRoot, "old");
        const packageRoot = path.join(oldOwner, "node_modules", "openclaw");
        const binDir = path.join(base, "native-bin");
        const launcher = path.join(binDir, "openclaw");
        const metadata = path.join(project, "manager-metadata");
        const sibling = path.join(project, "sibling-package");
        await writePackageRoot(packageRoot, "1.0.0");
        const existingSibling = path.join(path.dirname(packageRoot), "existing-sibling");
        await writeText(
          path.join(existingSibling, "package.json"),
          '{"name":"existing-sibling","version":"1.0.0"}',
        );
        await writeText(launcher, "old launcher\n");
        await fs.writeFile(metadata, "original metadata\n");
        await fs.writeFile(sibling, "unrelated package\n");
        await writeOwner(oldOwner, "1.0.0");
        await fs.symlink("old", path.join(globalRoot, "hash-openclaw"));
        const target: ResolvedGlobalInstallTarget = {
          manager,
          command: manager,
          globalRoot,
          packageRoot,
          pnpmIsolated: { layoutVersion: 11 },
        };
        let retained: PackageUpdateTransaction | undefined;
        let stagedLauncher: string;
        const preparationStarted = createDeferred();
        const finishPreparation = createDeferred();
        const phases: string[] = [];
        let cleanupRejected = false;
        const originalRename = fs.rename.bind(fs);
        const originalUnlink = fs.unlink.bind(fs);
        const backupRenameSpy = vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
          if (rollbackFailure === "backup-cleanup" && String(args[0]) === project) {
            throw Object.assign(new Error("cross-device move"), { code: "EXDEV" });
          }
          return originalRename(...args);
        });
        const backupUnlinkSpy = vi.spyOn(fs, "unlink").mockImplementation(async (entryPath) => {
          if (
            rollbackFailure === "backup-cleanup" &&
            String(entryPath) === path.join(packageRoot, "dist", "index.js")
          ) {
            await fs.rm(path.join(packageRoot, PACKAGE_DIST_INVENTORY_RELATIVE_PATH), {
              force: true,
            });
            await originalUnlink(entryPath);
            cleanupRejected = true;
            throw Object.assign(new Error("source cleanup failed after commit"), {
              code: "EACCES",
            });
          }
          return originalUnlink(entryPath);
        });
        const update = runGlobalPackageUpdateSteps({
          installTarget: target,
          installSpec: "openclaw@2.0.0",
          packageName: "openclaw",
          env: {
            PATH: process.env.PATH,
            PNPM_HOME: path.dirname(project),
            pnpm_config_global_dir: project,
            pnpm_config_global_bin_dir: binDir,
            PNPM_CONFIG_GLOBAL_BIN_DIR: binDir,
          },
          runCommand: async (argv, options) => {
            const stage = readPnpmStageArgs(argv);
            if (stage.projectRoot) {
              expect(options.cwd).toBe(stage.projectRoot);
              expect(stage.projectRoot).not.toBe(project);
              phases.push(`probe ${argv[1]}`);
            }
            return {
              code: 0,
              stderr: "",
              stdout: argv.includes("root")
                ? `${stage.projectRoot ? path.join(stage.projectRoot, path.relative(project, globalRoot)) : globalRoot}\n`
                : `${stage.binDir ?? binDir}\n`,
            };
          },
          runStep: async ({ name, argv, cwd }) => {
            expect(argv[0]).toBe(manager);
            const stageArgs = readPnpmStageArgs(argv);
            const stageProject = stageArgs.projectRoot;
            const stageBin = stageArgs.binDir;
            if (!stageProject || !stageBin) {
              throw new Error("native staging destinations missing");
            }
            expect(cwd).toBe(stageProject);
            expect(stageProject).not.toBe(project);
            expect(stageBin).not.toBe(binDir);
            await expectText(path.join(stageProject, "sibling-package"), "unrelated package\n");
            const stageGlobal = path.join(stageProject, path.relative(project, globalRoot));
            const nextOwner = path.join(stageGlobal, "new");
            const candidateRoot = path.join(nextOwner, "node_modules", "openclaw");
            await writePackageRoot(candidateRoot, "2.0.0");
            await fs.writeFile(path.join(stageProject, "manager-metadata"), "candidate metadata\n");
            await writeOwner(nextOwner, "2.0.0");
            await fs.rm(path.join(stageGlobal, "hash-openclaw"));
            await fs.symlink("new", path.join(stageGlobal, "hash-openclaw"));
            if (shimFailure) {
              await fs.rm(path.join(stageGlobal, "old"), { recursive: true });
            }
            const linkedPackage = path.join(
              stageGlobal,
              "hash-openclaw",
              "node_modules",
              "openclaw",
            );
            await fs.mkdir(stageBin, { recursive: true });
            stagedLauncher = path.join(stageBin, "openclaw");
            await fs.symlink(
              path.relative(stageBin, path.join(linkedPackage, "dist", "index.js")),
              stagedLauncher,
            );
            return packageUpdateStepResult(
              { name, argv, cwd: cwd ?? stageProject },
              { durationMs: 0 },
            );
          },
          validateCandidate: async (candidateRoot) => {
            phases.push("validate");
            await expectVersion(candidateRoot, "2.0.0");
            await expectVersion(packageRoot, "1.0.0");
            await expectText(metadata, "original metadata\n");
            return [];
          },
          beforeActivate: async () => {
            phases.push("stop");
            preparationStarted.resolve();
            if (siblingChange === "before") {
              await finishPreparation.promise;
            }
          },
          onTransaction: (transaction) => {
            retained = transaction;
            if (shimFailure) {
              // Lose a prepared launcher after backup, so publication fails only
              // after the new native project has replaced the old package path.
              unlinkSync(stagedLauncher);
            }
          },
          timeoutMs: 1000,
        });
        const siblingOwner = path.join(globalRoot, "sibling-owner");
        const siblingManifest = path.join(siblingOwner, "package.json");
        const siblingEntry = path.join(siblingOwner, "node_modules", "sibling", "index.js");
        const concurrentManifest = JSON.stringify({
          dependencies: { openclaw: "1.0.0", sibling: "2.0.0" },
        });
        if (siblingChange === "before") {
          await preparationStarted.promise;
          try {
            await fs.mkdir(path.dirname(siblingEntry), { recursive: true });
            await fs.writeFile(siblingEntry, "concurrent sibling package\n");
            await fs.writeFile(siblingManifest, concurrentManifest);
            await fs.symlink("sibling-owner", path.join(globalRoot, "hash-sibling"));
          } finally {
            finishPreparation.resolve();
          }
        }
        const result = await update.finally(() => {
          backupRenameSpy.mockRestore();
          backupUnlinkSpy.mockRestore();
        });
        if (rollbackFailure === "backup-cleanup") {
          expect(cleanupRejected).toBe(true);
          expect(result.failedStep?.stderrTail).toContain("source cleanup failed after commit");
          expect(result.activePackageRoot).toBeNull();
          expect(result.recovery?.serviceRestartSafe).toBe(false);
          assert(retained, "transaction missing");
          expect(await retained.rollback(() => {})).toMatchObject({
            exitCode: 1,
            activePackageRoot: null,
          });
          await expect(
            fs.readFile(path.join(packageRoot, "dist", "index.js")),
          ).rejects.toMatchObject({ code: "ENOENT" });
          const backupPackage = path.join(retained.backupRoot, path.relative(project, packageRoot));
          await expectText(path.join(backupPackage, "dist", "index.js"), "export {};\n");
          return;
        }
        if (shimFailure) {
          const activeRoot = path.join(globalRoot, "hash-openclaw", "node_modules", "openclaw");
          expect(result.failedStep).toMatchObject({ name: "package-swap", exitCode: 1 });
          expect(result).toMatchObject({ activePackageRoot: activeRoot, afterVersion: "2.0.0" });
          await expectMissing(packageRoot);
          const { revoke, assertCurrent } = executorAuthority();
          const prototype = Object.getPrototypeOf(await fsSafeRoot(base)) as Root;
          // oxlint-disable-next-line typescript/unbound-method -- Called below with the intercepted Root receiver to preserve its path and mutation authority.
          const copy = prototype.copyIn;
          let injections = 0;
          const copySpy = vi.spyOn(prototype, "copyIn").mockImplementation(async function (
            this: Root,
            destination,
            source,
            options,
          ) {
            await copy.call(this, destination, source, options);
            injections += 1;
            revoke();
          });
          try {
            await expectRevoked(retained!, assertCurrent);
            expect(injections).toBe(1);
          } finally {
            copySpy.mockRestore();
          }
          await expectVersion(activeRoot, "2.0.0");
          await expectPresent(retained!.backupRoot);
          await expectText(launcher, "old launcher\n");
          expect(await fs.readdir(binDir)).toEqual(["openclaw"]);
          return;
        }
        if (siblingChange === "before") {
          // Exercise normal confirmation too: a stale project swap must not hide
          // the sibling in a backup that successful cleanup subsequently deletes.
          await retained?.complete({ activationVerified: false }, () => {});
          await expectText(siblingEntry, "concurrent sibling package\n");
          await expectText(siblingManifest, concurrentManifest);
          expect(result.failedStep).toMatchObject({ name: "package-swap", exitCode: 1 });
          expect(result.failedStep?.stderrTail).toContain("native global installation changed");
          expect(result.afterVersion).toBe("1.0.0");
          expect(result.recovery).toEqual({ serviceRestartSafe: true, version: "1.0.0" });
          expect(retained).toBeUndefined();
          expect(phases).toEqual(["probe root", "probe bin", "validate", "stop"]);
          await expectText(launcher, "old launcher\n");
          expect(
            (await fs.readdir(path.dirname(project))).filter((entry) => entry.startsWith(".")),
          ).toEqual([]);
          return;
        }
        expect(result).toMatchObject({ failedStep: null, afterVersion: "2.0.0" });
        expect(phases).toEqual(["probe root", "probe bin", "validate", "stop"]);
        await expectText(metadata, "candidate metadata\n");
        await expectText(sibling, "unrelated package\n");
        await expect(fs.realpath(launcher)).resolves.toBe(
          await fs.realpath(path.join(result.activePackageRoot!, "dist", "index.js")),
        );
        assert(retained, "transaction missing");
        if (siblingChange === "after") {
          const lateSiblingEntry = path.join(
            path.dirname(result.activePackageRoot!),
            "sibling/index.js",
          );
          await writeText(lateSiblingEntry, "late sibling package\n");
          const candidateLauncher = await fs.readlink(launcher);
          const rollback = await retained.rollback(() => {});
          expect(rollback).toMatchObject({
            exitCode: 1,
            reason: "rollback-project-changed",
            activePackageRoot: result.activePackageRoot,
          });
          expect(rollback.stderrTail).toContain("sibling");
          expect(rollback.stderrTail).not.toContain(base);
          await retained.complete({ activationVerified: false }, () => {});
          await expectText(lateSiblingEntry, "late sibling package\n");
          await expectText(metadata, "candidate metadata\n");
          await expect(fs.readlink(launcher)).resolves.toBe(candidateLauncher);
          await expectVersion(result.activePackageRoot!, "2.0.0");
          await expectPresent(retained.backupRoot);
          return;
        }
        // Verification may repair only the candidate payload without changing sibling ownership.
        await fs.writeFile(
          path.join(result.activePackageRoot!, "package.json"),
          '{"name":"openclaw","version":"2.0.1"}',
        );
        if (rollbackFailure.startsWith("copy-")) {
          const backupRoot = retained.backupRoot;
          const backupEntries = (await fs.readdir(backupRoot, { recursive: true })).toSorted();
          const { revoke, assertCurrent } = executorAuthority();
          let published = false;
          const rename = fs.rename.bind(fs);
          const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
            if (String(args[0]) === backupRoot) {
              throw Object.assign(new Error("cross-device restore"), { code: "EXDEV" });
            }
            await rename(...args);
            if (String(args[1]) === project) {
              published = true;
              if (rollbackFailure === "copy-publication") {
                revoke();
              }
            }
          });
          const lstat = fsSync.lstatSync.bind(fsSync);
          const observation = vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
            const copyResult = lstat(...args);
            if (rollbackFailure === "copy-cleanup" && published && String(args[0]) === backupRoot) {
              revoke();
            }
            return copyResult;
          });
          const unlink = vi.spyOn(fs, "unlink");
          const rmdir = vi.spyOn(fs, "rmdir");
          try {
            await expectRevoked(retained, assertCurrent);
            expect(() => assertCurrent()).toThrow("native executor lost");
            const protectedRemovals = [...unlink.mock.calls, ...rmdir.mock.calls].filter(
              ([entry]) =>
                String(entry) === backupRoot ||
                String(entry).startsWith(`${backupRoot}${path.sep}`),
            );
            expect(protectedRemovals).toEqual([]);
            const publicationOrder =
              renameSpy.mock.invocationCallOrder[
                renameSpy.mock.calls.findIndex(([, destination]) => String(destination) === project)
              ];
            const cleanupBeforePublication = rmdir.mock.calls
              .filter((_, index) => {
                const cleanupOrder = rmdir.mock.invocationCallOrder[index];
                return (
                  cleanupOrder !== undefined &&
                  publicationOrder !== undefined &&
                  cleanupOrder < publicationOrder
                );
              })
              .map(([entry]) => String(entry));
            // Launcher staging and the candidate are removed before restoration;
            // neither gives a revoked executor authority to retire its backup.
            expect(
              cleanupBeforePublication.filter(
                (entry) =>
                  entry === project ||
                  (path.dirname(entry) === binDir &&
                    path.basename(entry).startsWith(".openclaw-shim-stage-")),
              ),
            ).toEqual([
              expect.stringContaining(path.join(binDir, ".openclaw-shim-stage-")),
              project,
            ]);
            expect((await fs.readdir(backupRoot, { recursive: true })).toSorted()).toEqual(
              backupEntries,
            );
            await expectText(path.join(backupRoot, "manager-metadata"), "original metadata\n");
            expect(published).toBe(true);
            await expectVersion(packageRoot, "1.0.0");
            await expectText(launcher, "old launcher\n");
          } finally {
            renameSpy.mockRestore();
            observation.mockRestore();
            unlink.mockRestore();
            rmdir.mockRestore();
          }
          return;
        }
        const publishedLauncher = await fs.readlink(launcher);
        const prototype = Object.getPrototypeOf(await fsSafeRoot(base)) as Root;
        // oxlint-disable-next-line typescript/unbound-method -- Called below with the intercepted Root receiver to preserve its path and mutation authority.
        const copy = prototype.copyIn;
        const canonicalBin = await fs.realpath(binDir);
        const rename = fs.rename.bind(fs);
        const backupRoot = retained.backupRoot;
        let copyRefusals = 0;
        let renameRefusals = 0;
        const copySpy = vi.spyOn(prototype, "copyIn").mockImplementation(async function (
          this: Root,
          destination,
          source,
          options,
        ) {
          if (
            rollbackFailure === "shim" &&
            path.dirname(this.rootReal) === canonicalBin &&
            path.basename(this.rootReal).startsWith(".openclaw-shim-stage-")
          ) {
            copyRefusals += 1;
            throw Object.assign(new Error("launcher restoration failed"), { code: "EACCES" });
          }
          await copy.call(this, destination, source, options);
        });
        const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
          if (rollbackFailure === "package" && String(args[0]) === backupRoot) {
            renameRefusals += 1;
            throw Object.assign(new Error("package restoration failed"), { code: "EACCES" });
          }
          return rename(...args);
        });
        try {
          expect(await retained.rollback(() => {})).toMatchObject({
            exitCode: 1,
            activePackageRoot: rollbackFailure === "package" ? null : packageRoot,
          });
          expect(copyRefusals).toBe(rollbackFailure === "shim" ? 1 : 0);
          expect(renameRefusals).toBe(rollbackFailure === "package" ? 1 : 0);
        } finally {
          copySpy.mockRestore();
          renameSpy.mockRestore();
        }
        await retained.complete({ activationVerified: false }, () => {});
        if (rollbackFailure === "package") {
          await expectMissing(packageRoot);
          await expectPresent(retained.backupRoot);
        } else {
          await expectVersion(packageRoot, "1.0.0");
          // Failed staging leaves the previously published launcher unchanged.
          await expect(fs.readlink(launcher)).resolves.toBe(publishedLauncher);
        }
      });
    },
  );

  it.each(["root", "bin", "probe-error"] as const)(
    "refuses pnpm staging before install when the effective destination fails (%s)",
    async (failure) => {
      await withTestDir({ prefix: "openclaw-pnpm-stage-destination-" }, async (base) => {
        const project = path.join(base, "global");
        const globalRoot = path.join(project, "5", "node_modules");
        const packageRoot = path.join(globalRoot, "openclaw");
        const binDir = path.join(base, "bin");
        await writePackageRoot(packageRoot, "1.0.0");
        await fs.mkdir(binDir);
        await fs.writeFile(path.join(binDir, "openclaw"), "live launcher\n");
        const beforeActivate = vi.fn(async () => {});
        const runStep = vi.fn(async () => {
          throw new Error("installation must not run after a refused destination probe");
        });
        let stageRoot: string | undefined;
        let stageBin: string | undefined;
        const result = await runGlobalPackageUpdateSteps({
          installTarget: { manager: "pnpm", command: "pnpm", globalRoot, packageRoot },
          packageName: "openclaw",
          installSpec: "openclaw@2.0.0",
          runCommand: async (argv, options) => {
            const stage = readPnpmStageArgs(argv);
            if (!stage.projectRoot) {
              return { code: 0, stdout: `${binDir}\n`, stderr: "" };
            }
            stageRoot = stage.projectRoot;
            stageBin = stage.binDir;
            expect(options.cwd).toBe(stageRoot);
            if (failure === "probe-error") {
              return { code: 1, stdout: "", stderr: "pnpm destination configuration rejected" };
            }
            return {
              code: 0,
              stdout:
                argv[1] === "root"
                  ? `${failure === "root" ? globalRoot : path.join(stageRoot, "5", "node_modules")}\n`
                  : `${failure === "bin" ? binDir : stageBin}\n`,
              stderr: "",
            };
          },
          runStep,
          beforeActivate,
          timeoutMs: 1000,
        });
        expect(result.failedStep).toMatchObject({ name: "pnpm-staging-preflight", exitCode: 1 });
        expect(result.failedStep?.stderrTail).toContain(
          failure === "probe-error" ? "configuration rejected" : `pnpm ${failure} selected`,
        );
        expect(result.recovery).toEqual({ serviceRestartSafe: true, version: "1.0.0" });
        expect(runStep).not.toHaveBeenCalled();
        expect(beforeActivate).not.toHaveBeenCalled();
        await expectVersion(packageRoot, "1.0.0");
        await expectText(path.join(binDir, "openclaw"), "live launcher\n");
        expect(stageRoot).toBeDefined();
        expect(stageBin).toBeDefined();
        await expectMissing(stageRoot!);
        await expectMissing(stageBin!);
      });
    },
  );
});

it("gives actionable Windows Bun recovery before stopping or installing", async () => {
  await withTestDir({ prefix: "openclaw-windows-bun-refusal-" }, async (base) => {
    const project = path.join(base, "global");
    const globalRoot = path.join(project, "node_modules");
    const packageRoot = path.join(globalRoot, "openclaw");
    const binDir = path.join(base, "bin");
    await writePackageRoot(packageRoot, "1.0.0");
    const beforeActivate = vi.fn(async () => {});
    const runStep = vi.fn(async () => {
      throw new Error("A refused Windows Bun update must not install a package");
    });
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      const result = await runGlobalPackageUpdateSteps({
        installTarget: { manager: "bun", command: "bun", globalRoot, packageRoot },
        packageName: "openclaw",
        installSpec: "openclaw@2.0.0",
        env: { BUN_INSTALL_GLOBAL_DIR: project, BUN_INSTALL_BIN: binDir },
        runCommand: async () => ({ code: 0, stdout: binDir, stderr: "" }),
        runStep,
        beforeActivate,
        timeoutMs: 1000,
      });
      expect(result.failedStep).toMatchObject({ name: "package-stage", exitCode: 1 });
      expect(result.failedStep?.stderrTail).toContain("bun add -g --trust openclaw@2.0.0");
      expect(result.failedStep?.stderrTail).toContain("openclaw gateway restart");
      expect(result.failedStep?.stderrTail).toContain("openclaw update status");
      expect(result.recovery).toEqual({ serviceRestartSafe: true, version: "1.0.0" });
      expect(runStep).not.toHaveBeenCalled();
      expect(beforeActivate).not.toHaveBeenCalled();
    } finally {
      platform.mockRestore();
    }
  });
});
