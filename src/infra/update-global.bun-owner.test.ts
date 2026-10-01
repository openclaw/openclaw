import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { runGlobalPackageUpdateSteps } from "./package-update-steps.js";
import { writePackageRoot } from "./package-update-steps.test-support.js";
import type { CommandRunner } from "./update-global-command-runner.js";
import { detectGlobalInstallManagerForRoot, resolveGlobalInstallTarget } from "./update-global.js";

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
    { runtime: "pinned", pathBun: "conflicting", supplyEnv: false, installFails: false },
    { runtime: "current", pathBun: "missing", supplyEnv: false, installFails: false },
    { runtime: "current", pathBun: "conflicting", supplyEnv: true, installFails: false },
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
              expect(result.recovery).toMatchObject({ serviceRestartSafe: true, version: "1.0.0" });
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
