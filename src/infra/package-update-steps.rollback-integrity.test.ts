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

describe("package rollback tree integrity", () => {
  it("rejects an oversized package file without reading it", async () => {
    await withTestDir({ prefix: "openclaw-package-recovery-byte-cap-" }, async (base) => {
      const globalRoot = path.join(base, "prefix", "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      const oversizedEntry = path.join(packageRoot, "oversized.bin");
      await writePackageRoot(packageRoot, "1.0.0");
      await fs.writeFile(oversizedEntry, "");
      await fs.truncate(oversizedEntry, 1024 * 1024 * 1024 + 1);
      const open = fs.open.bind(fs);
      let oversizedEntryOpenCount = 0;
      const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        if (String(args[0]) === oversizedEntry) {
          oversizedEntryOpenCount += 1;
        }
        return await open(...args);
      });

      try {
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

        expect(oversizedEntryOpenCount).toBe(0);
        expect(result.recovery).toMatchObject({
          serviceRestartSafe: false,
          packageRollbackVerified: false,
        });
        expect(result.failedStep?.stderrTail).toContain(
          "rollback verification failed: restored package tree does not match backup",
        );
      } finally {
        openSpy.mockRestore();
      }
    });
  });

  it("rejects a package inventory above the entry cap before child traversal", async () => {
    await withTestDir({ prefix: "openclaw-package-recovery-entry-cap-" }, async (base) => {
      const globalRoot = path.join(base, "prefix", "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      await writePackageRoot(packageRoot, "1.0.0");
      let doctorRejected = false;
      let suppliedSyntheticInventory = false;
      const opendir = fs.opendir.bind(fs);
      const opendirSpy = vi.spyOn(fs, "opendir").mockImplementation(async (...args) => {
        if (doctorRejected && !suppliedSyntheticInventory && String(args[0]) === packageRoot) {
          suppliedSyntheticInventory = true;
          return {
            async *[Symbol.asyncIterator]() {
              for (let index = 0; index < 50_000; index += 1) {
                yield { name: `synthetic-${index}` };
              }
            },
          } as Awaited<ReturnType<typeof fs.opendir>>;
        }
        return await opendir(...args);
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

        expect(suppliedSyntheticInventory).toBe(true);
        expect(result.recovery).toMatchObject({
          serviceRestartSafe: false,
          packageRollbackVerified: false,
        });
        expect(result.failedStep?.stderrTail).toContain(
          "rollback verification failed: restored package tree does not match backup",
        );
      } finally {
        opendirSpy.mockRestore();
      }
    });
  });

  it("does not verify rollback when candidate Doctor alters a parked linked package", async () => {
    await withTestDir({ prefix: "openclaw-package-recovery-altered-link-" }, async (base) => {
      const globalRoot = path.join(base, "prefix", "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      const linkedRoot = path.join(base, "linked-openclaw");
      const linkedEntry = path.join(linkedRoot, "dist", "index.js");
      await writePackageRoot(linkedRoot, "1.0.0");
      await fs.writeFile(linkedEntry, "original linked package\n", "utf8");
      await fs.mkdir(globalRoot, { recursive: true });
      await fs.symlink(linkedRoot, packageRoot, process.platform === "win32" ? "junction" : "dir");

      let externalFingerprintOpens = 0;
      const open = fs.open.bind(fs);
      const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        if (String(args[0]).startsWith(linkedRoot)) {
          externalFingerprintOpens += 1;
        }
        return await open(...args);
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
          postVerifyStep: async (candidateRoot) => {
            expect(candidateRoot).toBe(packageRoot);
            await fs.writeFile(linkedEntry, "altered linked package\n", "utf8");
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
      } finally {
        openSpy.mockRestore();
      }

      expect(externalFingerprintOpens).toBe(0);
      expect(result.afterVersion).toBe("1.0.0");
      expect(result.recovery).toMatchObject({
        serviceRestartSafe: false,
        packageRollbackVerified: false,
      });
      expect(result.failedStep?.stderrTail).toContain(
        "rollback verification failed: restored package tree does not match backup",
      );
      await expect(fs.realpath(packageRoot)).resolves.toBe(linkedRoot);
      await expect(fs.readFile(linkedEntry, "utf8")).resolves.toBe("altered linked package\n");
    });
  });

  it.runIf(process.platform !== "win32")(
    "does not verify rollback when candidate Doctor alters special package mode bits",
    async () => {
      await withTestDir({ prefix: "openclaw-package-recovery-altered-mode-" }, async (base) => {
        const globalRoot = path.join(base, "prefix", "lib", "node_modules");
        const packageRoot = path.join(globalRoot, "openclaw");
        const packageEntry = path.join(packageRoot, "dist", "index.js");
        await writePackageRoot(packageRoot, "1.0.0");
        await fs.chmod(packageEntry, 0o755);

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
            await fs.chmod(path.join(globalRoot, backupName, "dist", "index.js"), 0o4755);
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
        expect((await fs.stat(packageEntry)).mode & 0o7777).toBe(0o4755);
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "verifies a stable rollback with a dangling non-directory symlink target",
    async () => {
      await withTestDir({ prefix: "openclaw-package-recovery-dangling-link-" }, async (base) => {
        const globalRoot = path.join(base, "prefix", "lib", "node_modules");
        const packageRoot = path.join(globalRoot, "openclaw");
        const packageEntry = path.join(packageRoot, "dist", "index.js");
        const danglingLink = path.join(packageRoot, "dist", "dangling.js");
        await writePackageRoot(packageRoot, "1.0.0");
        await fs.symlink(`${packageEntry}/child`, danglingLink);

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

        expect(result.afterVersion).toBe("1.0.0");
        expect(result.recovery).toMatchObject({
          serviceRestartSafe: false,
          packageRollbackVerified: true,
        });
        await expect(fs.readlink(danglingLink)).resolves.toBe(`${packageEntry}/child`);
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not verify rollback when candidate Doctor splits an old-package hardlink",
    async () => {
      await withTestDir({ prefix: "openclaw-package-recovery-altered-hardlink-" }, async (base) => {
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
          postVerifyStep: async (candidateRoot) => {
            expect(candidateRoot).toBe(packageRoot);
            const backupName = (await fs.readdir(globalRoot)).find((entry) =>
              entry.startsWith(".openclaw.package-backup-"),
            );
            if (!backupName) {
              throw new Error("missing old-package backup during candidate Doctor");
            }
            const backupPeer = path.join(globalRoot, backupName, "dist", "hardlink-peer.js");
            const contents = await fs.readFile(backupPeer);
            const mode = (await fs.stat(backupPeer)).mode;
            await fs.unlink(backupPeer);
            await fs.writeFile(backupPeer, contents);
            await fs.chmod(backupPeer, mode);
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
        expect((await fs.stat(packageEntry)).ino).not.toBe((await fs.stat(hardlinkPeer)).ino);
        await expect(fs.readFile(hardlinkPeer, "utf8")).resolves.toBe("export {};\n");
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not verify rollback when candidate Doctor replaces an identical descendant inode",
    async () => {
      await withTestDir({ prefix: "openclaw-package-recovery-replaced-inode-" }, async (base) => {
        const globalRoot = path.join(base, "prefix", "lib", "node_modules");
        const packageRoot = path.join(globalRoot, "openclaw");
        const packageDirectory = path.join(packageRoot, "dist");
        const packageEntry = path.join(packageDirectory, "index.js");
        await writePackageRoot(packageRoot, "1.0.0");
        const originalDirectoryStat = await fs.lstat(packageDirectory, { bigint: true });
        const originalEntryStat = await fs.lstat(packageEntry, { bigint: true });
        let doctorRejected = false;
        let replacementInode: bigint | null = null;
        const lstat = fs.lstat.bind(fs);
        const lstatSpy = vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
          const stat = await lstat(...args);
          if (!doctorRejected || !("ctimeNs" in stat)) {
            return stat;
          }
          const entryPath = String(args[0]);
          if (entryPath.endsWith(`${path.sep}dist${path.sep}index.js`)) {
            Object.assign(stat, {
              mtimeNs: originalEntryStat.mtimeNs,
              ctimeNs: originalEntryStat.ctimeNs,
            });
          } else if (entryPath.endsWith(`${path.sep}dist`)) {
            Object.assign(stat, {
              mtimeNs: originalDirectoryStat.mtimeNs,
              ctimeNs: originalDirectoryStat.ctimeNs,
            });
          }
          return stat;
        });
        const open = fs.open.bind(fs);
        const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
          const handle = await open(...args);
          if (doctorRejected && String(args[0]).endsWith(`${path.sep}dist${path.sep}index.js`)) {
            const stat = handle.stat.bind(handle);
            vi.spyOn(handle, "stat").mockImplementation(async () => {
              const openedStat = await stat({ bigint: true });
              Object.assign(openedStat, {
                mtimeNs: originalEntryStat.mtimeNs,
                ctimeNs: originalEntryStat.ctimeNs,
              });
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
            runStep: stageCandidatePackage,
            postVerifyStep: async (candidateRoot) => {
              expect(candidateRoot).toBe(packageRoot);
              const backupName = (await fs.readdir(globalRoot)).find((entry) =>
                entry.startsWith(".openclaw.package-backup-"),
              );
              if (!backupName) {
                throw new Error("missing old-package backup during candidate Doctor");
              }
              const backupEntry = path.join(globalRoot, backupName, "dist", "index.js");
              const replacementEntry = path.join(globalRoot, backupName, "dist", "replacement.js");
              doctorRejected = true;
              await fs.copyFile(backupEntry, replacementEntry);
              await fs.chmod(replacementEntry, Number(originalEntryStat.mode & 0o7777n));
              await fs.utimes(replacementEntry, originalEntryStat.atime, originalEntryStat.mtime);
              await fs.unlink(backupEntry);
              await fs.rename(replacementEntry, backupEntry);
              replacementInode = (await lstat(backupEntry, { bigint: true })).ino;
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

          expect(replacementInode).not.toBe(originalEntryStat.ino);
          expect(result.afterVersion).toBe("1.0.0");
          expect(result.recovery).toMatchObject({
            serviceRestartSafe: false,
            packageRollbackVerified: false,
          });
          expect(result.failedStep?.stderrTail).toContain(
            "rollback verification failed: restored package tree does not match backup",
          );
          await expect(fs.readFile(packageEntry, "utf8")).resolves.toBe("export {};\n");
        } finally {
          openSpy.mockRestore();
          lstatSpy.mockRestore();
        }
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not verify rollback when candidate Doctor changes a descendant mtime",
    async () => {
      await withTestDir({ prefix: "openclaw-package-recovery-altered-mtime-" }, async (base) => {
        const globalRoot = path.join(base, "prefix", "lib", "node_modules");
        const packageRoot = path.join(globalRoot, "openclaw");
        const packageEntry = path.join(packageRoot, "dist", "index.js");
        await writePackageRoot(packageRoot, "1.0.0");
        const originalEntryStat = await fs.lstat(packageEntry, { bigint: true });
        let doctorRejected = false;
        const lstat = fs.lstat.bind(fs);
        const lstatSpy = vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
          const stat = await lstat(...args);
          if (
            doctorRejected &&
            "ctimeNs" in stat &&
            String(args[0]).endsWith(`${path.sep}dist${path.sep}index.js`)
          ) {
            Object.assign(stat, { ctimeNs: originalEntryStat.ctimeNs });
          }
          return stat;
        });
        const open = fs.open.bind(fs);
        const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
          const handle = await open(...args);
          if (doctorRejected && String(args[0]).endsWith(`${path.sep}dist${path.sep}index.js`)) {
            const stat = handle.stat.bind(handle);
            vi.spyOn(handle, "stat").mockImplementation(async () => {
              const openedStat = await stat({ bigint: true });
              Object.assign(openedStat, { ctimeNs: originalEntryStat.ctimeNs });
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
            runStep: stageCandidatePackage,
            postVerifyStep: async (candidateRoot) => {
              expect(candidateRoot).toBe(packageRoot);
              const backupName = (await fs.readdir(globalRoot)).find((entry) =>
                entry.startsWith(".openclaw.package-backup-"),
              );
              if (!backupName) {
                throw new Error("missing old-package backup during candidate Doctor");
              }
              const backupEntry = path.join(globalRoot, backupName, "dist", "index.js");
              doctorRejected = true;
              await fs.utimes(backupEntry, originalEntryStat.atime, new Date(1));
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

          expect((await lstat(packageEntry, { bigint: true })).mtimeNs).not.toBe(
            originalEntryStat.mtimeNs,
          );
          expect(result.afterVersion).toBe("1.0.0");
          expect(result.recovery).toMatchObject({
            serviceRestartSafe: false,
            packageRollbackVerified: false,
          });
          expect(result.failedStep?.stderrTail).toContain(
            "rollback verification failed: restored package tree does not match backup",
          );
        } finally {
          openSpy.mockRestore();
          lstatSpy.mockRestore();
        }
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not verify rollback when a parked symlink link count changes without ctime",
    async () => {
      await withTestDir({ prefix: "openclaw-package-recovery-symlink-nlink-" }, async (base) => {
        const globalRoot = path.join(base, "prefix", "lib", "node_modules");
        const packageRoot = path.join(globalRoot, "openclaw");
        const packageLink = path.join(packageRoot, "dist", "entry-link.js");
        await writePackageRoot(packageRoot, "1.0.0");
        await fs.symlink("index.js", packageLink);
        const originalLinkStat = await fs.lstat(packageLink, { bigint: true });
        let doctorRejected = false;
        let changedLinkCountObserved = false;
        const lstat = fs.lstat.bind(fs);
        const lstatSpy = vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
          const stat = await lstat(...args);
          if (
            doctorRejected &&
            "ctimeNs" in stat &&
            String(args[0]).endsWith(`${path.sep}dist${path.sep}entry-link.js`)
          ) {
            changedLinkCountObserved = true;
            Object.assign(stat, {
              nlink: originalLinkStat.nlink + 1n,
              ctimeNs: originalLinkStat.ctimeNs,
            });
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
              expect(candidateRoot).toBe(packageRoot);
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

          expect(changedLinkCountObserved).toBe(true);
          expect(result.afterVersion).toBe("1.0.0");
          expect(result.recovery).toMatchObject({
            serviceRestartSafe: false,
            packageRollbackVerified: false,
          });
          expect(result.failedStep?.stderrTail).toContain(
            "rollback verification failed: restored package tree does not match backup",
          );
        } finally {
          lstatSpy.mockRestore();
        }
      });
    },
  );

  it("does not fail a successful candidate when the rollback metadata probe is unavailable", async () => {
    await withTestDir({ prefix: "openclaw-package-recovery-probe-unavailable-" }, async (base) => {
      const globalRoot = path.join(base, "prefix", "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      await writePackageRoot(packageRoot, "1.0.0");
      const mkdtemp = fs.mkdtemp.bind(fs);
      const mkdtempSpy = vi.spyOn(fs, "mkdtemp").mockImplementation(async (...args) => {
        if (args[0].endsWith(".openclaw-update-stage-ctime-")) {
          throw Object.assign(new Error("metadata probe unavailable"), { code: "EACCES" });
        }
        // openclaw-temp-dir: allow forwarding production-owned temp creation through this spy
        return await mkdtemp(...args);
      });

      try {
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
            exitCode: 0,
          }),
          timeoutMs: 1000,
        });

        expect(result.failedStep).toBeNull();
        expect(result.afterVersion).toBe("2.0.0");
        expect(result.recovery).toEqual({ serviceRestartSafe: true, version: "2.0.0" });
      } finally {
        mkdtempSpy.mockRestore();
      }
    });
  });

  it("keeps rollback unverified when the package tree spans filesystem devices", async () => {
    await withTestDir({ prefix: "openclaw-package-recovery-mounted-tree-" }, async (base) => {
      const globalRoot = path.join(base, "prefix", "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      await writePackageRoot(packageRoot, "1.0.0");
      const lstat = fs.lstat.bind(fs);
      const lstatSpy = vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
        const stat = await lstat(...args);
        if (
          typeof stat.dev === "bigint" &&
          String(args[0]).endsWith(`${path.sep}openclaw${path.sep}dist`)
        ) {
          Object.assign(stat, { dev: stat.dev + 1n });
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

        expect(result.afterVersion).toBe("1.0.0");
        expect(result.recovery).toMatchObject({
          serviceRestartSafe: false,
          packageRollbackVerified: false,
        });
        expect(result.failedStep?.stderrTail).toContain(
          "rollback verification failed: restored package tree does not match backup",
        );
      } finally {
        lstatSpy.mockRestore();
      }
    });
  });

  it("does not fail a successful candidate when the source package spans filesystem devices", async () => {
    await withTestDir({ prefix: "openclaw-package-success-mounted-tree-" }, async (base) => {
      const globalRoot = path.join(base, "prefix", "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      await writePackageRoot(packageRoot, "1.0.0");
      const lstat = fs.lstat.bind(fs);
      const lstatSpy = vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
        const stat = await lstat(...args);
        if (
          typeof stat.dev === "bigint" &&
          String(args[0]).endsWith(`${path.sep}openclaw${path.sep}dist`)
        ) {
          Object.assign(stat, { dev: stat.dev + 1n });
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
          postVerifyStep: async (candidateRoot) => ({
            name: "openclaw doctor",
            command: "openclaw doctor --non-interactive --fix",
            cwd: candidateRoot,
            durationMs: 0,
            exitCode: 0,
          }),
          timeoutMs: 1000,
        });

        expect(result.failedStep).toBeNull();
        expect(result.afterVersion).toBe("2.0.0");
        expect(result.recovery).toEqual({ serviceRestartSafe: true, version: "2.0.0" });
      } finally {
        lstatSpy.mockRestore();
      }
    });
  });

  it("keeps rollback unverified when filesystem inode identity is unavailable", async () => {
    await withTestDir({ prefix: "openclaw-package-recovery-no-inode-" }, async (base) => {
      const globalRoot = path.join(base, "prefix", "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      await writePackageRoot(packageRoot, "1.0.0");
      const lstat = fs.lstat.bind(fs);
      const lstatSpy = vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
        const stat = await lstat(...args);
        if (
          typeof stat.ino === "bigint" &&
          path.basename(String(args[0])).startsWith(".openclaw.package-backup-")
        ) {
          Object.assign(stat, { birthtimeNs: 1n, ino: 0n });
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

        expect(result.afterVersion).toBe("1.0.0");
        expect(result.recovery).toMatchObject({
          serviceRestartSafe: false,
          packageRollbackVerified: false,
        });
        expect(result.failedStep?.stderrTail).toContain(
          "package backup did not preserve filesystem identity",
        );
      } finally {
        lstatSpy.mockRestore();
      }
    });
  });

  it("keeps rollback unverified when the restored tree changes during fingerprinting", async () => {
    await withTestDir({ prefix: "openclaw-package-recovery-racy-tree-" }, async (base) => {
      const globalRoot = path.join(base, "prefix", "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      const earlyEntry = path.join(packageRoot, "dist", "a-early.js");
      const lateEntry = path.join(packageRoot, "dist", "z-late.js");
      await writePackageRoot(packageRoot, "1.0.0");
      await fs.writeFile(earlyEntry, "original early file\n");
      await fs.writeFile(lateEntry, "original late file\n");
      let doctorRejected = false;
      let changedAfterVisit = false;
      const open = fs.open.bind(fs);
      const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        if (doctorRejected && !changedAfterVisit && String(args[0]) === lateEntry) {
          changedAfterVisit = true;
          await fs.writeFile(earlyEntry, "changed after fingerprint visit\n");
        }
        return await open(...args);
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

        expect(changedAfterVisit).toBe(true);
        expect(result.afterVersion).toBe("1.0.0");
        expect(result.recovery).toMatchObject({
          serviceRestartSafe: false,
          packageRollbackVerified: false,
        });
        expect(result.failedStep?.stderrTail).toContain(
          "rollback verification failed: restored package tree does not match backup",
        );
        await expect(fs.readFile(earlyEntry, "utf8")).resolves.toBe(
          "changed after fingerprint visit\n",
        );
      } finally {
        openSpy.mockRestore();
      }
    });
  });

  it.runIf(process.platform !== "win32")(
    "keeps rollback unverified for an external package-tree symlink",
    async () => {
      await withTestDir({ prefix: "openclaw-package-recovery-bounded-link-" }, async (base) => {
        const globalRoot = path.join(base, "prefix", "lib", "node_modules");
        const packageRoot = path.join(globalRoot, "openclaw");
        const externalRoot = path.join(base, "external-tree");
        await writePackageRoot(packageRoot, "1.0.0");
        await fs.mkdir(externalRoot);
        await fs.writeFile(path.join(externalRoot, "outside.txt"), "external\n", "utf8");
        await fs.symlink(externalRoot, path.join(packageRoot, "dist", "external-tree"));

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
    "keeps rollback unverified for parent traversal after an internal symlink",
    async () => {
      await withTestDir({ prefix: "openclaw-package-recovery-chained-link-" }, async (base) => {
        const globalRoot = path.join(base, "prefix", "lib", "node_modules");
        const packageRoot = path.join(globalRoot, "openclaw");
        const externalEntry = path.join(globalRoot, "outside.txt");
        await writePackageRoot(packageRoot, "1.0.0");
        await fs.writeFile(externalEntry, "external before Doctor\n", "utf8");
        await fs.symlink(".", path.join(packageRoot, "pivot"));
        await fs.symlink("pivot/../outside.txt", path.join(packageRoot, "escape"));

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
              path.join(globalRoot, backupName, "escape"),
              "external changed by Doctor\n",
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
        expect(result.recovery).toMatchObject({
          serviceRestartSafe: false,
          packageRollbackVerified: false,
        });
        expect(result.failedStep?.stderrTail).toContain(
          "rollback verification failed: restored package tree does not match backup",
        );
        await expect(fs.readFile(externalEntry, "utf8")).resolves.toBe(
          "external changed by Doctor\n",
        );
      });
    },
  );

  it("uses locale-independent ordering for package rollback fingerprints", async () => {
    await withTestDir({ prefix: "openclaw-package-recovery-stable-order-" }, async (base) => {
      const globalRoot = path.join(base, "prefix", "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      await writePackageRoot(packageRoot, "1.0.0");
      await fs.writeFile(path.join(packageRoot, "dist", "alpha.js"), "alpha\n", "utf8");
      await fs.writeFile(path.join(packageRoot, "dist", "zeta.js"), "zeta\n", "utf8");
      const localeCompareSpy = vi
        .spyOn(String.prototype, "localeCompare")
        .mockImplementation(() => {
          throw new Error("rollback fingerprint used locale collation");
        });

      try {
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

        expect(result.afterVersion).toBe("1.0.0");
        expect(result.recovery).toMatchObject({
          serviceRestartSafe: false,
          packageRollbackVerified: true,
        });
      } finally {
        localeCompareSpy.mockRestore();
      }
    });
  });
});
