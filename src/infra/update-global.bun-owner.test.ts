import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import * as exec from "../process/exec.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import * as gitExec from "./git-exec.js";
import * as openclawRoot from "./openclaw-root.js";
import { runGlobalPackageUpdateSteps } from "./package-update-steps.js";
import { writePackageRoot, createRootRunner } from "./package-update-steps.test-support.js";
import * as restartSentinel from "./restart-sentinel.js";
import { createGatewayUpdateLifecycle } from "./update-check-lifecycle.js";
import { pkgQueryResult } from "./update-freebsd-pkg-ownership.test-support.js";
import type { CommandRunner } from "./update-global-command-runner.js";
import {
  detectGlobalInstallManagerForRoot,
  listActivePnpmIsolatedGlobalPackages,
  resolveGlobalInstallTarget,
  cleanupGlobalRenameDirs,
} from "./update-global.js";
import { resolvePnpmGlobalDirFromGlobalRoot } from "./update-native-package-owner.js";
import { resolveUpdateInstallSurface } from "./update-runner-install-surface.js";
import { createGatewayUpdateCheck } from "./update-startup.js";

const runHostCommandBuffered = exec.runCommandBuffered;
beforeEach(() => {
  vi.spyOn(exec, "runCommandBuffered").mockImplementation((argv, options) =>
    argv[0] === "pacman" || argv[0] === "/usr/sbin/pkg"
      ? Promise.resolve(pkgQueryResult())
      : runHostCommandBuffered(argv, options),
  );
});
afterEach(() => vi.restoreAllMocks());

async function writeGlobalPackageJson(packageRoot: string, version: string): Promise<void> {
  await fs.writeFile(
    path.join(packageRoot, "package.json"),
    JSON.stringify({ name: "openclaw", version }),
    "utf8",
  );
}

async function writePnpmIsolatedPackage(params: {
  globalRoot: string;
  installName: string;
  version: string;
  dependencies?: Record<string, string>;
}): Promise<string> {
  const installDir = path.join(params.globalRoot, params.installName);
  const packageRoot = path.join(installDir, "node_modules", "openclaw");
  await fs.mkdir(packageRoot, { recursive: true });
  await Promise.all([
    writeGlobalPackageJson(packageRoot, params.version),
    fs.writeFile(
      path.join(installDir, "package.json"),
      JSON.stringify({
        private: true,
        dependencies: { openclaw: params.version, ...params.dependencies },
      }),
      "utf8",
    ),
  ]);
  await fs.symlink(installDir, path.join(params.globalRoot, `hash-${params.installName}`), "dir");
  return packageRoot;
}

describe("pnpm isolated global install discovery", () => {
  it.each([11])("detects pnpm %s isolated installs", async (layoutVersion) => {
    await withTestDir({ prefix: "openclaw-update-pnpm-isolated-root-" }, async (base) => {
      const npmRoot = path.join(base, "npm", "lib", "node_modules");
      const pnpmGlobalDir = path.join(base, "pnpm-home", "global");
      const pnpmGlobalRoot = path.join(pnpmGlobalDir, `v${layoutVersion}`);
      const pkgRoot = await writePnpmIsolatedPackage({
        globalRoot: pnpmGlobalRoot,
        installName: "a1b2",
        version: "2026.7.1",
      });
      const hashLinkedPkgRoot = path.join(pnpmGlobalRoot, "hash-a1b2", "node_modules", "openclaw");
      const pnpmHomeAlias = path.join(base, "pnpm-home-alias");
      await fs.symlink(path.join(base, "pnpm-home"), pnpmHomeAlias, "dir");
      const aliasedPkgRoot = path.join(
        pnpmHomeAlias,
        "global",
        `v${layoutVersion}`,
        "a1b2",
        "node_modules",
        "openclaw",
      );
      await fs.mkdir(path.join(npmRoot, "openclaw"), { recursive: true });

      const runCommand = vi.fn<CommandRunner>(async (argv) => {
        const command = argv.join(" ");
        if (command === "npm root -g") {
          return { stdout: `${npmRoot}\n`, stderr: "", code: 0 };
        }
        if (command === "pnpm root -g") {
          return {
            stdout: `[WARN] Using --global skips the package manager check for this project\n${pnpmGlobalRoot}\n`,
            stderr: "",
            code: 0,
          };
        }
        throw new Error(`unexpected command: ${command}`);
      });

      await expect(detectGlobalInstallManagerForRoot(runCommand, pkgRoot, 1000)).resolves.toBe(
        "pnpm",
      );
      await expect(
        detectGlobalInstallManagerForRoot(runCommand, hashLinkedPkgRoot, 1000),
      ).resolves.toBe("pnpm");
      await expect(
        detectGlobalInstallManagerForRoot(runCommand, aliasedPkgRoot, 1000),
      ).resolves.toBe("pnpm");
      runCommand.mockClear();
      const expectedTarget = {
        manager: "pnpm",
        command: "pnpm",
        pnpmIsolated: { layoutVersion },
        globalRoot: pnpmGlobalRoot,
        packageRoot: pkgRoot,
      };
      await expect(
        resolveGlobalInstallTarget({
          manager: "pnpm",
          runCommand,
          timeoutMs: 1000,
          pkgRoot,
          honorPackageRoot: true,
        }),
      ).resolves.toEqual(expectedTarget);
      expect(runCommand).not.toHaveBeenCalled();
      await expect(
        resolveGlobalInstallTarget({ manager: "pnpm", runCommand, timeoutMs: 1000 }),
      ).resolves.toEqual(expectedTarget);
      expect(runCommand.mock.calls.map(([argv]) => argv)).toEqual([["pnpm", "root", "-g"]]);
      expect(resolvePnpmGlobalDirFromGlobalRoot(pnpmGlobalRoot)).toBe(pnpmGlobalDir);
    });
  });

  it("prefers the invoking project when multiple installs are active", async () => {
    await withTestDir({ prefix: "openclaw-update-pnpm-isolated-owner-" }, async (base) => {
      const pnpmGlobalRoot = path.join(base, "pnpm-home", "global", "v11");
      const otherPackageRoot = await writePnpmIsolatedPackage({
        globalRoot: pnpmGlobalRoot,
        installName: "a-other",
        version: "2026.7.1",
      });
      const invokingPackageRoot = await writePnpmIsolatedPackage({
        globalRoot: pnpmGlobalRoot,
        installName: "z-invoking",
        version: "2026.7.2",
        dependencies: { cowsay: "1.6.0" },
      });
      const runCommand: CommandRunner = async (argv) => {
        if (argv.join(" ") === "pnpm root -g") {
          return { stdout: `${pnpmGlobalRoot}\n`, stderr: "", code: 0 };
        }
        throw new Error(`unexpected command: ${argv.join(" ")}`);
      };

      await expect(
        listActivePnpmIsolatedGlobalPackages({
          globalRoot: pnpmGlobalRoot,
          packageName: "openclaw",
        }),
      ).resolves.toEqual([
        { packageRoot: otherPackageRoot, packageNames: ["openclaw"] },
        { packageRoot: invokingPackageRoot, packageNames: ["cowsay", "openclaw"] },
      ]);
      await expect(
        resolveGlobalInstallTarget({
          manager: "pnpm",
          runCommand,
          timeoutMs: 1000,
          pkgRoot: invokingPackageRoot,
          packageName: "openclaw",
        }),
      ).resolves.toEqual({
        manager: "pnpm",
        command: "pnpm",
        pnpmIsolated: { layoutVersion: 11 },
        globalRoot: pnpmGlobalRoot,
        packageRoot: invokingPackageRoot,
      });
    });
  });

  it("does not adopt another pnpm project through a shared-store package symlink", async () => {
    await withTestDir({ prefix: "openclaw-update-pnpm-shared-store-owner-" }, async (base) => {
      const globalRoot = path.join(base, "pnpm-home", "global", "v11");
      const activeInstallRoot = path.join(globalRoot, "active");
      const orphanInstallRoot = path.join(globalRoot, "orphan");
      const activePackageRoot = path.join(activeInstallRoot, "node_modules", "openclaw");
      const orphanPackageRoot = path.join(orphanInstallRoot, "node_modules", "openclaw");
      const sharedPackageRoot = path.join(base, "store", "openclaw");
      await Promise.all([
        fs.mkdir(path.dirname(activePackageRoot), { recursive: true }),
        fs.mkdir(path.dirname(orphanPackageRoot), { recursive: true }),
        fs.mkdir(sharedPackageRoot, { recursive: true }),
      ]);
      await Promise.all([
        writeGlobalPackageJson(sharedPackageRoot, "2026.7.1"),
        fs.writeFile(
          path.join(activeInstallRoot, "package.json"),
          JSON.stringify({ private: true, dependencies: { openclaw: "2026.7.1" } }),
          "utf8",
        ),
        fs.writeFile(
          path.join(orphanInstallRoot, "package.json"),
          JSON.stringify({ private: true, dependencies: { openclaw: "2026.7.1" } }),
          "utf8",
        ),
        fs.writeFile(path.join(orphanInstallRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n"),
      ]);
      await Promise.all([
        fs.symlink(sharedPackageRoot, activePackageRoot, "dir"),
        fs.symlink(sharedPackageRoot, orphanPackageRoot, "dir"),
        fs.symlink(activeInstallRoot, path.join(globalRoot, "hash-active"), "dir"),
      ]);
      const runCommand: CommandRunner = async (argv) => {
        if (argv.join(" ") === "npm root -g") {
          return { stdout: "", stderr: "", code: 1 };
        }
        if (argv.join(" ") === "pnpm root -g") {
          return { stdout: `${globalRoot}\n`, stderr: "", code: 0 };
        }
        throw new Error(`unexpected command: ${argv.join(" ")}`);
      };

      await expect(
        detectGlobalInstallManagerForRoot(runCommand, sharedPackageRoot, 1000),
      ).resolves.toBeNull();
      await expect(
        resolveGlobalInstallTarget({
          manager: "pnpm",
          runCommand,
          timeoutMs: 1000,
          pkgRoot: orphanPackageRoot,
          packageName: "openclaw",
        }),
      ).resolves.toEqual({
        manager: "pnpm",
        command: "pnpm",
        pnpmIsolated: { layoutVersion: 11 },
        globalRoot,
        packageRoot: orphanPackageRoot,
      });
    });
  });

  it("preserves pnpm 11 ownership when the invoking project is orphaned", async () => {
    await withTestDir({ prefix: "openclaw-update-pnpm-isolated-orphan-" }, async (base) => {
      const pnpmGlobalRoot = path.join(base, "pnpm-home", "global", "v11");
      const orphanPackageRoot = path.join(pnpmGlobalRoot, "orphan", "node_modules", "openclaw");
      await fs.mkdir(orphanPackageRoot, { recursive: true });
      const orphanInstallRoot = path.join(pnpmGlobalRoot, "orphan");
      await Promise.all([
        writeGlobalPackageJson(orphanPackageRoot, "2026.7.1"),
        fs.writeFile(
          path.join(orphanInstallRoot, "package.json"),
          JSON.stringify({ private: true, dependencies: { openclaw: "2026.7.1" } }),
          "utf8",
        ),
        fs.writeFile(path.join(orphanInstallRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n"),
      ]);
      const detectRunner = vi.fn<CommandRunner>().mockResolvedValue({
        stdout: "",
        stderr: "not active",
        code: 1,
      });

      await expect(
        detectGlobalInstallManagerForRoot(detectRunner, orphanPackageRoot, 1000),
      ).resolves.toBe("pnpm");
      expect(detectRunner).toHaveBeenCalledTimes(2);

      const runCommand: CommandRunner = async (argv) => {
        if (argv.join(" ") === "pnpm root -g") {
          return {
            stdout: `${path.join(base, "other-pnpm-home", "global", "v11")}\n`,
            stderr: "",
            code: 0,
          };
        }
        throw new Error(`unexpected command: ${argv.join(" ")}`);
      };
      await expect(
        resolveGlobalInstallTarget({
          manager: "npm",
          runCommand,
          timeoutMs: 1000,
          pkgRoot: orphanPackageRoot,
          packageName: "openclaw",
        }),
      ).resolves.toEqual({
        manager: "pnpm",
        command: "pnpm",
        pnpmIsolated: { layoutVersion: 11 },
        globalRoot: pnpmGlobalRoot,
        packageRoot: orphanPackageRoot,
      });
    });
  });

  it("keeps npm ownership when its prefix is named like a pnpm layout", async () => {
    await withTestDir({ prefix: "openclaw-update-npm-v11-prefix-" }, async (base) => {
      const npmPrefix = path.join(base, "v11");
      const npmGlobalRoot = path.join(npmPrefix, "lib", "node_modules");
      const packageRoot = path.join(npmGlobalRoot, "openclaw");
      await fs.mkdir(packageRoot, { recursive: true });
      await writeGlobalPackageJson(packageRoot, "2026.7.1");
      const runCommand: CommandRunner = async (argv) => {
        const command = argv.join(" ");
        if (command === "npm root -g") {
          return { stdout: `${npmGlobalRoot}\n`, stderr: "", code: 0 };
        }
        if (command === "npm --version") {
          return { stdout: "12.0.0\n", stderr: "", code: 0 };
        }
        if (command === "pnpm root -g") {
          return {
            stdout: `${path.join(base, "pnpm-home", "global", "v11")}\n`,
            stderr: "",
            code: 0,
          };
        }
        throw new Error(`unexpected command: ${command}`);
      };

      await expect(detectGlobalInstallManagerForRoot(runCommand, packageRoot, 1000)).resolves.toBe(
        "npm",
      );
      await expect(
        resolveGlobalInstallTarget({
          manager: "npm",
          runCommand,
          timeoutMs: 1000,
          pkgRoot: packageRoot,
          packageName: "openclaw",
          honorPackageRoot: true,
        }),
      ).resolves.toEqual({
        manager: "npm",
        command: "npm",
        globalRoot: npmGlobalRoot,
        packageRoot,
        npmOwner: {
          version: "12.0.0",
          lifecyclePolicy: "allow-scripts",
        },
      });
    });
  });

  it.each([false])("keeps fallback without metadata (%s)", async (probeSucceeds) => {
    await withTestDir({ prefix: "openclaw-update-pnpm-shape-only-" }, async (base) => {
      const customGlobalDir = path.join(base, "custom-pnpm");
      const customGlobalRoot = path.join(customGlobalDir, "5", "node_modules");
      const pkgRoot = path.join(customGlobalRoot, "openclaw");
      const defaultPnpmRoot = path.join(base, "default-pnpm", "5", "node_modules");
      const pnpmCommand = path.join(base, "bin", "pnpm");
      await fs.mkdir(pkgRoot, { recursive: true });
      await fs.writeFile(
        path.join(customGlobalDir, "5", "pnpm-lock.yaml"),
        "lockfileVersion: '9.0'\n",
        "utf8",
      );

      const runCommand = vi.fn<CommandRunner>(async (argv) => {
        if (argv[0] === "npm") {
          return { stdout: "", stderr: "", code: 1 };
        }
        if (argv[0] === "pnpm" || argv[0] === pnpmCommand) {
          return { stdout: `${defaultPnpmRoot}\n`, stderr: "", code: probeSucceeds ? 0 : 1 };
        }
        throw new Error(`unexpected command: ${argv.join(" ")}`);
      });

      await expect(
        detectGlobalInstallManagerForRoot(runCommand, pkgRoot, 1000),
      ).resolves.toBeNull();
      runCommand.mockClear();
      const resolution = resolveGlobalInstallTarget({
        manager: { manager: "pnpm", command: pnpmCommand },
        runCommand,
        timeoutMs: 1000,
        pkgRoot,
      });
      await expect(resolution).resolves.toEqual({
        manager: "pnpm",
        command: pnpmCommand,
        globalRoot: probeSucceeds ? defaultPnpmRoot : null,
        packageRoot: probeSucceeds ? path.join(defaultPnpmRoot, "openclaw") : null,
      });
      expect(runCommand.mock.calls.map(([argv]) => argv)).toEqual([[pnpmCommand, "root", "-g"]]);
    });
  });
});

describe("custom Bun global installation ownership", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("preserves ownership when the original BUN_INSTALL is unavailable", async () => {
    await withTestDir({ prefix: "openclaw-update-custom-bun-root-" }, async (base) => {
      await withEnvAsync(
        { BUN_INSTALL: undefined, BUN_INSTALL_GLOBAL_DIR: undefined },
        async () => {
          const bunRoot = path.join(base, "custom-bun", "install", "global", "node_modules");
          const pkgRoot = path.join(bunRoot, "openclaw");
          const npmRoot = path.join(base, "shell", "lib", "node_modules");
          await fs.mkdir(pkgRoot, { recursive: true });
          const runCommand = vi.fn<CommandRunner>(async () => ({
            stdout: `${npmRoot}\n`,
            stderr: "",
            code: 0,
          }));

          await expect(detectGlobalInstallManagerForRoot(runCommand, pkgRoot, 1000)).resolves.toBe(
            "bun",
          );
          await expect(
            resolveGlobalInstallTarget({
              manager: "bun",
              runCommand,
              timeoutMs: 1000,
              pkgRoot,
              honorPackageRoot: true,
            }),
          ).resolves.toMatchObject({ manager: "bun", globalRoot: bunRoot, packageRoot: pkgRoot });
        },
      );
    });
  });

  it.each([
    { runtime: "pinned", pathBun: "missing", supplyEnv: true, installFails: false },
    { runtime: "current", pathBun: "missing", supplyEnv: false, installFails: false },
    { runtime: "pinned", pathBun: "missing", supplyEnv: true, installFails: true },
  ] as const)(
    "uses $runtime Bun with $pathBun PATH Bun (install fails: $installFails)",
    async ({ runtime, pathBun, supplyEnv, installFails }) => {
      await withTestDir({ prefix: "openclaw-package-update-bun-owner-" }, async (base) => {
        const bunInstall = path.join(base, "owning-bun");
        const globalProject = path.join(bunInstall, "install", "global");
        const globalRoot = path.join(globalProject, "node_modules");
        const packageRoot = path.join(globalRoot, "openclaw");
        const conflictingInstall = path.join(base, "unrelated-bun");
        const conflictingGlobalProject = path.join(base, "unrelated-global");
        const owningBin = path.join(base, "custom-bun-bin");
        const currentBun = path.join(base, "current-runtime", "fork-bun");
        const command =
          runtime === "pinned" ? path.join(base, "service-runtime", "fork-bun") : currentBun;
        vi.stubGlobal(
          "process",
          Object.create(process, {
            execPath: { value: currentBun },
            versions: { value: { ...process.versions, bun: "1.4.3" } },
          }),
        );
        await writePackageRoot(packageRoot, "1.0.0");
        await fs.mkdir(owningBin);
        await fs.writeFile(path.join(owningBin, "openclaw"), "original launcher\n");

        await withEnvAsync(
          {
            BUN_INSTALL: conflictingInstall,
            BUN_INSTALL_GLOBAL_DIR: conflictingGlobalProject,
            BUN_INSTALL_BIN: owningBin,
            PATH: pathBun === "missing" ? "" : path.join(conflictingInstall, "bin"),
          },
          async () => {
            const callerEnv: NodeJS.ProcessEnv = {
              BUN_INSTALL: conflictingInstall,
              BUN_INSTALL_GLOBAL_DIR: conflictingGlobalProject,
              BUN_INSTALL_BIN: owningBin,
              PATH: process.env.PATH,
            };
            const originalCallerEnv = { ...callerEnv };
            const runCommand = vi.fn<CommandRunner>(async (argv, { env }) => {
              expect(argv).toEqual([command, "pm", "bin", "-g"]);
              expect(env).toMatchObject({
                BUN_INSTALL: bunInstall,
                BUN_INSTALL_GLOBAL_DIR: globalProject,
                BUN_INSTALL_BIN: owningBin,
              });
              return { code: 0, stdout: `${owningBin}\n`, stderr: "" };
            });
            const runStep = vi.fn(async ({ name, argv, cwd, env }) => {
              expect(argv).toEqual([command, "add", "-g", "--trust", "openclaw@2.0.0"]);
              const stageProject = env?.BUN_INSTALL_GLOBAL_DIR;
              const stageBin = env?.BUN_INSTALL_BIN;
              if (!stageProject || !stageBin) {
                throw new Error("Bun staging destinations missing");
              }
              expect(env?.BUN_INSTALL).toBe(bunInstall);
              expect(path.dirname(stageProject)).toBe(path.dirname(globalProject));
              expect(stageProject).not.toBe(globalProject);
              expect(stageBin).not.toBe(owningBin);
              expect(cwd).toBe(stageProject);
              await expect(
                fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
              ).resolves.toContain('"version":"1.0.0"');
              const stagedPackageRoot = path.join(stageProject, "node_modules", "openclaw");
              await writePackageRoot(stagedPackageRoot, "2.0.0");
              await fs.symlink(
                path.relative(stageBin, path.join(stagedPackageRoot, "dist", "index.js")),
                path.join(stageBin, "openclaw"),
              );
              return {
                name,
                command: argv.join(" "),
                cwd: cwd ?? base,
                durationMs: 1,
                exitCode: installFails ? 1 : 0,
                ...(installFails ? { stderrTail: "staged Bun install failed" } : {}),
              };
            });

            const installTarget = await resolveGlobalInstallTarget({
              manager: runtime === "pinned" ? { manager: "bun", command } : "bun",
              runCommand,
              timeoutMs: 1000,
              pkgRoot: packageRoot,
              honorPackageRoot: true,
            });
            const beforeActivate = vi.fn(async () => {});
            const result = await runGlobalPackageUpdateSteps({
              installTarget,
              installSpec: "openclaw@2.0.0",
              packageName: "openclaw",
              packageRoot,
              runCommand,
              runStep,
              beforeActivate,
              timeoutMs: 1000,
              ...(supplyEnv ? { env: callerEnv } : {}),
            });

            expect(runCommand).toHaveBeenCalledOnce();
            if (process.platform === "win32") {
              expect(result.failedStep?.stderrTail).toContain("Bun Windows binary launchers");
              expect(runStep).not.toHaveBeenCalled();
              expect(beforeActivate).not.toHaveBeenCalled();
            } else if (installFails) {
              expect(result.failedStep).toMatchObject({
                name: "package-install",
                stderrTail: "staged Bun install failed",
              });
              expect(result.recovery).toMatchObject({
                serviceRestartSafe: true,
                version: "1.0.0",
              });
              expect(beforeActivate).not.toHaveBeenCalled();
              expect(runStep).toHaveBeenCalledOnce();
              await expect(fs.readdir(path.dirname(globalProject))).resolves.toEqual(["global"]);
              await expect(fs.readFile(path.join(owningBin, "openclaw"), "utf8")).resolves.toBe(
                "original launcher\n",
              );
            } else {
              expect(result.failedStep).toBeNull();
              expect(result.afterVersion).toBe("2.0.0");
              expect(runStep).toHaveBeenCalledOnce();
              expect(beforeActivate).toHaveBeenCalledOnce();
              await expect(fs.realpath(path.join(owningBin, "openclaw"))).resolves.toBe(
                await fs.realpath(path.join(packageRoot, "dist", "index.js")),
              );
            }
            await expect(
              fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
            ).resolves.toContain(
              `"version":"${process.platform === "win32" || installFails ? "1.0.0" : "2.0.0"}"`,
            );
            await expect(fs.stat(conflictingInstall)).rejects.toMatchObject({ code: "ENOENT" });
            await expect(fs.stat(conflictingGlobalProject)).rejects.toMatchObject({
              code: "ENOENT",
            });
            expect(callerEnv).toEqual(originalCallerEnv);
            expect(process.env.BUN_INSTALL).toBe(conflictingInstall);
            expect(process.env.BUN_INSTALL_GLOBAL_DIR).toBe(conflictingGlobalProject);
            expect(process.env.BUN_INSTALL_BIN).toBe(owningBin);
          },
        );
      });
    },
  );
});

describe("FreeBSD package-manager admission", () => {
  afterEach(() => vi.restoreAllMocks());
  it.each(["unknown database", "exhausted budget"])(
    "keeps inconclusive ownership best effort within the cleanup budget: %s",
    async (failure) => {
      await withTestDir({ prefix: "openclaw-pkg-cleanup-budget-" }, async (base) => {
        await fs.mkdir(path.join(base, ".openclaw-first"));
        await fs.mkdir(path.join(base, ".openclaw-second"));
        const entries = await fs.readdir(base);
        const now = Date.now();
        const clock = vi.spyOn(Date, "now").mockReturnValue(now);
        const query = vi.spyOn(exec, "runCommandBuffered").mockImplementation(async () => {
          if (failure === "exhausted budget") {
            clock.mockReturnValue(now + 30_001);
          }
          return pkgQueryResult("", failure === "unknown database" ? { code: 1 } : {});
        });
        await withMockedPlatform("freebsd", async () => {
          await expect(
            cleanupGlobalRenameDirs({ globalRoot: base, packageName: "openclaw" }),
          ).resolves.toEqual({ removed: failure === "unknown database" ? entries : [] });
        });
        expect(query).toHaveBeenCalledTimes(failure === "unknown database" ? 2 : 1);
        expect(await fs.readdir(base)).toHaveLength(failure === "unknown database" ? 0 : 2);
      });
    },
  );

  it("refreshes pkg ownership separately before each cleanup deletion", async () => {
    await withTestDir({ prefix: "openclaw-pkg-cleanup-refresh-" }, async (base) => {
      await fs.mkdir(path.join(base, ".openclaw-first"));
      await fs.mkdir(path.join(base, ".openclaw-second"));
      const [firstName, secondName] = await fs.readdir(base);
      const first = path.join(base, firstName!);
      const second = path.join(base, secondName!);
      const retained = path.join(second, "marker");
      await fs.writeFile(retained, "retained");
      let claimed = false;
      const remove = fs.rm.bind(fs);
      vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
        await remove(target, options);
        if (target === first) {
          claimed = true;
        }
      });
      const query = vi
        .spyOn(exec, "runCommandBuffered")
        .mockImplementation(async () => pkgQueryResult(claimed ? `${retained}\n` : ""));
      await withMockedPlatform("freebsd", async () => {
        await expect(
          cleanupGlobalRenameDirs({ globalRoot: base, packageName: "openclaw" }),
        ).resolves.toEqual({ removed: [firstName] });
      });
      expect(query).toHaveBeenCalledTimes(2);
      await expect(fs.readFile(retained, "utf8")).resolves.toBe("retained");
    });
  });

  it("skips a cleanup directory replaced during ownership inspection", async () => {
    await withTestDir({ prefix: "openclaw-pkg-cleanup-replaced-" }, async (base) => {
      const candidate = path.join(base, ".openclaw-interrupted");
      await fs.mkdir(candidate);
      vi.spyOn(exec, "runCommandBuffered").mockImplementationOnce(async () => {
        await fs.rename(candidate, path.join(base, "saved"));
        await fs.mkdir(candidate);
        await fs.writeFile(path.join(candidate, "marker"), "replacement");
        return pkgQueryResult();
      });
      await withMockedPlatform("freebsd", async () => {
        await expect(
          cleanupGlobalRenameDirs({ globalRoot: base, packageName: "openclaw" }),
        ).resolves.toEqual({ removed: [] });
      });
      await expect(fs.readFile(path.join(candidate, "marker"), "utf8")).resolves.toBe(
        "replacement",
      );
    });
  });
  it.each(["rpc surface", "startup"])(
    "keeps %s discovery read-only for a pkg installation",
    async (route) => {
      await withTestDir({ prefix: "openclaw-pkg-discovery-" }, async (base) => {
        const globalRoot = path.join(base, "lib", "node_modules");
        const root = path.join(globalRoot, "openclaw");
        await writePackageRoot(root, "1.0.0");
        const runCommand = createRootRunner(globalRoot);
        const query = vi
          .spyOn(exec, "runCommandBuffered")
          .mockResolvedValue(pkgQueryResult(`${root}/package.json\n`));
        vi.spyOn(exec, "runCommandWithTimeout").mockImplementation(async (argv) => ({
          ...(await runCommand(argv, { timeoutMs: 1000 })),
          signal: null,
          killed: false,
          termination: "exit",
        }));
        vi.spyOn(gitExec, "executeGitCommand").mockResolvedValue({
          stdout: "",
          stderr: "not a git repository",
          code: 128,
          signal: null,
          killed: false,
          termination: "exit",
          timeoutMs: 1000,
        });
        vi.spyOn(openclawRoot, "resolveOpenClawPackageRoot").mockResolvedValue(root);
        vi.spyOn(restartSentinel, "readVerifiedGitUpdateReceipt").mockResolvedValue(null);
        await withMockedPlatform("freebsd", async () => {
          if (route === "rpc surface") {
            await expect(
              resolveUpdateInstallSurface({
                root,
                installKind: "package",
                runCommand: (argv, options) =>
                  runCommand(argv, { ...options, timeoutMs: options.timeoutMs ?? 1000 }),
                timeoutMs: 1000,
              }),
            ).resolves.toMatchObject({ kind: "global", mode: "npm", root });
          } else {
            const startup = createGatewayUpdateCheck({
              lifecycle: createGatewayUpdateLifecycle(createTestGatewayScheduler()),
              getConfig: () => ({}),
              applyRemoteCatalogUpdate: async () => "unchanged",
              log: { info: vi.fn() },
              isNixMode: false,
            });
            try {
              const first = await startup.initialize();
              expect(first.status).toMatchObject({
                root,
                installKind: "package",
                packageManager: "npm",
              });
              await expect(startup.initialize()).resolves.toBe(first);
            } finally {
              await startup.stop();
            }
          }
        });
        expect(query).not.toHaveBeenCalled();
      });
    },
  );

  it("checks the actual manager-selected destination before selecting its npm runtime", async () => {
    await withTestDir({ prefix: "openclaw-pkg-target-" }, async (base) => {
      const requested = path.join(base, "source");
      const globalRoot = path.join(base, "package prefix", "lib", "node_modules");
      const target = path.join(globalRoot, "openclaw");
      await writePackageRoot(requested, "1.0.0");
      await writePackageRoot(target, "1.0.0");
      const rootRunner = createRootRunner(globalRoot);
      const runCommand = vi.fn(async (...args: Parameters<typeof rootRunner>) => {
        const result = await rootRunner(...args);
        vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
        return result;
      });
      const query = vi
        .spyOn(exec, "runCommandBuffered")
        .mockResolvedValueOnce(pkgQueryResult())
        .mockResolvedValue(pkgQueryResult(`${target}/package.json\n`));
      await withMockedPlatform("freebsd", async () => {
        await expect(
          resolveGlobalInstallTarget({
            manager: "npm",
            pkgRoot: requested,
            runCommand,
            timeoutMs: 1000,
          }),
        ).rejects.toMatchObject({ reason: "pkg-owned-install" });
      });
      expect(runCommand.mock.calls.some(([argv]) => argv.includes("--version"))).toBe(false);
      expect(query).toHaveBeenCalledTimes(2);
    });
  });
});
