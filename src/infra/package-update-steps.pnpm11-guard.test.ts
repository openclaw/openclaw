import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PACKAGE_LIFECYCLE_MARKER_CONTRACT_RELATIVE_PATH } from "../../scripts/lib/package-lifecycle-marker.mjs";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { runGlobalPackageUpdateSteps } from "./package-update-steps.js";
import {
  createPnpmTarget,
  packageUpdateStepResult,
  writePackageRoot,
} from "./package-update-steps.test-support.js";
import type { CommandRunner } from "./update-global-command-runner.js";

type PackageUpdateStepResult = Awaited<
  ReturnType<typeof runGlobalPackageUpdateSteps>
>["steps"][number];
type UpdateOptions = Parameters<typeof runGlobalPackageUpdateSteps>[0];
const installArgs = ["pnpm", "add", "-g", "--allow-build=openclaw"];

function runPnpmUpdate(
  globalRoot: string,
  packageRoot: string,
  runCommand: CommandRunner,
  runStep: UpdateOptions["runStep"],
  options: Partial<UpdateOptions> = {},
) {
  return runGlobalPackageUpdateSteps({
    installTarget: createPnpmTarget(globalRoot, packageRoot),
    installSpec: "openclaw@2.0.0",
    packageName: "openclaw",
    packageRoot,
    runCommand,
    runStep,
    timeoutMs: 1000,
    ...options,
  });
}

function writeManifest(installRoot: string, version = "1.0.0", dependencies = {}) {
  return fs.writeFile(
    path.join(installRoot, "package.json"),
    JSON.stringify({ private: true, dependencies: { openclaw: version, ...dependencies } }),
    "utf8",
  );
}

async function writePnpmIsolatedPackage(
  globalRoot: string,
  installName: string,
  dependencies?: Record<string, string>,
): Promise<{ activeLink: string; packageRoot: string }> {
  const installRoot = path.join(globalRoot, installName);
  const packageRoot = path.join(installRoot, "node_modules", "openclaw");
  await writePackageRoot(packageRoot, "1.0.0");
  await writeManifest(installRoot, "1.0.0", dependencies);
  const activeLink = path.join(globalRoot, `hash-${installName}`);
  await fs.symlink(installRoot, activeLink, "dir");
  return { activeLink, packageRoot };
}

function stagedPnpmPaths(argv: string[], globalRoot: string) {
  const projectRoot = argv
    .find((arg) => arg.startsWith("--config.global-dir="))
    ?.slice("--config.global-dir=".length);
  const binDir = argv
    .find((arg) => arg.startsWith("--config.global-bin-dir="))
    ?.slice("--config.global-bin-dir=".length);
  return {
    projectRoot,
    binDir,
    globalRoot: projectRoot ? path.join(projectRoot, path.basename(globalRoot)) : globalRoot,
  };
}

function createPnpmRunner(globalRoot: string, binDir: string): CommandRunner {
  return async (argv, options) => {
    const stage = stagedPnpmPaths(argv, globalRoot);
    expect(options.cwd).toBe(stage.projectRoot ?? globalRoot);
    if (argv[1] === "root") {
      return { stdout: stage.globalRoot, stderr: "", code: 0 };
    }
    if (argv[1] === "bin") {
      return { stdout: stage.binDir ?? binDir, stderr: "", code: 0 };
    }
    throw new Error(`unexpected command: ${argv.join(" ")}`);
  };
}

async function expectPathMissing(filePath: string): Promise<void> {
  await expect(fs.access(filePath)).rejects.toMatchObject({ code: "ENOENT" });
}

describe("pnpm isolated install preflight (v11 layout)", () => {
  it("rejects grouped installs before dropping sibling packages", async () => {
    await withTestDir({ prefix: "openclaw-package-update-pnpm-group-" }, async (base) => {
      const globalRoot = path.join(base, "pnpm-home", "global", "v11");
      await writePnpmIsolatedPackage(globalRoot, "grouped", { cowsay: "1.6.0" });
      const { packageRoot } = await writePnpmIsolatedPackage(globalRoot, "invoking");
      const runCommand = vi.fn<CommandRunner>();
      const runStep = vi.fn();

      const result = await runPnpmUpdate(globalRoot, packageRoot, runCommand, runStep);

      expect(result.failedStep?.name).toBe("pnpm-isolated-install-preflight");
      expect(result.failedStep?.stderrTail).toContain("with cowsay");
      expect(result.failedStep?.stderrTail).toContain("stopped before mutation");
      expect(runCommand).not.toHaveBeenCalled();
      expect(runStep).not.toHaveBeenCalled();
    });
  });

  it("rejects an orphan whose package symlink shares the active store target", async () => {
    await withTestDir({ prefix: "openclaw-package-update-pnpm-shared-store-" }, async (base) => {
      const globalRoot = path.join(base, "pnpm-home", "global", "v11");
      const activeInstallRoot = path.join(globalRoot, "active");
      const orphanInstallRoot = path.join(globalRoot, "orphan");
      const activePackageRoot = path.join(activeInstallRoot, "node_modules", "openclaw");
      const orphanPackageRoot = path.join(orphanInstallRoot, "node_modules", "openclaw");
      const sharedPackageRoot = path.join(base, "store", "openclaw");
      await Promise.all([
        fs.mkdir(path.dirname(activePackageRoot), { recursive: true }),
        fs.mkdir(path.dirname(orphanPackageRoot), { recursive: true }),
        writePackageRoot(sharedPackageRoot, "1.0.0"),
      ]);
      await Promise.all([
        writeManifest(activeInstallRoot),
        writeManifest(orphanInstallRoot),
        fs.symlink(sharedPackageRoot, activePackageRoot, "dir"),
        fs.symlink(sharedPackageRoot, orphanPackageRoot, "dir"),
        fs.symlink(activeInstallRoot, path.join(globalRoot, "hash-active"), "dir"),
      ]);
      const runCommand = vi.fn<CommandRunner>();
      const runStep = vi.fn();

      const result = await runPnpmUpdate(globalRoot, orphanPackageRoot, runCommand, runStep);

      expect(result.failedStep?.name).toBe("pnpm-isolated-install-preflight");
      expect(result.failedStep?.stderrTail).toContain(
        "found 1 active installs and 0 owner matches",
      );
      expect(runCommand).not.toHaveBeenCalled();
      expect(runStep).not.toHaveBeenCalled();
    });
  });

  it("uses the owning v11 layout and custom bin without pnpm config aliases", async () => {
    await withTestDir({ prefix: "openclaw-package-update-pnpm-isolated-" }, async (base) => {
      const globalDir = path.join(base, "pnpm-home", "global");
      const globalRoot = path.join(globalDir, "v11");
      const ownerBinDir = path.join(base, "custom-global-bin");
      const pathBinDir = path.join(base, "path-pnpm-home", "bin");
      const callerProjectDir = path.join(base, "caller-project");
      const oldPackageRoot = path.join(globalRoot, "old", "node_modules", "openclaw");
      const newPackageRoot = path.join(globalRoot, "hash-openclaw", "node_modules", "openclaw");
      await fs.mkdir(ownerBinDir, { recursive: true });
      await writePackageRoot(oldPackageRoot, "1.0.0");
      await writeManifest(path.join(globalRoot, "old"));
      await fs.symlink(path.join(globalRoot, "old"), path.join(globalRoot, "hash-openclaw"), "dir");

      const originalEnv: NodeJS.ProcessEnv = {
        PATH: `${pathBinDir}${path.delimiter}${ownerBinDir}`,
      };
      const envBefore = { ...originalEnv };
      const pnpmWarning = "[WARN] Using --global skips the package manager check for this project";
      let stagedPackageRoot = "";
      const runCommand: CommandRunner = async (argv, options) => {
        const stage = stagedPnpmPaths(argv, globalRoot);
        if (stage.projectRoot) {
          expect(options.cwd).toBe(stage.projectRoot);
          expect(options.env?.pnpm_config_global_bin_dir).toBe(stage.binDir);
          return {
            stdout: argv[1] === "root" ? stage.globalRoot : (stage.binDir ?? ""),
            stderr: "",
            code: 0,
          };
        }
        const command = argv.join(" ");
        expect(options.cwd).toBe(globalRoot);
        expect(options.env).toBe(originalEnv);
        expect(options.env).toEqual(envBefore);
        if (command === "pnpm root -g") {
          return { stdout: `${pnpmWarning}\n${globalRoot}\n`, stderr: "", code: 0 };
        }
        if (command === "pnpm bin -g" || command === "pnpm --version") {
          expect(options.env?.PATH?.split(path.delimiter)[0]).toBe(pathBinDir);
          const value = command === "pnpm bin -g" ? ownerBinDir : "12.0.0";
          return { stdout: `${pnpmWarning}\n${value}\n`, stderr: "", code: 0 };
        }
        throw new Error(`unexpected command: ${command}`);
      };
      const runStep = vi.fn(
        async ({ name, argv, cwd, env, input }): Promise<PackageUpdateStepResult> => {
          if (name === "package-install") {
            expect(input).toBe("");
            const stage = stagedPnpmPaths(argv, globalRoot);
            if (!stage.projectRoot || !stage.binDir) {
              throw new Error("missing private pnpm stage");
            }
            expect(cwd).toBe(stage.projectRoot);
            expect(stage.projectRoot).not.toBe(globalDir);
            expect(env?.PATH?.split(path.delimiter)[0]).toBe(stage.binDir);
            const stageGlobalRoot = stage.globalRoot;
            const newInstallRoot = path.join(stageGlobalRoot, "new");
            const activeLink = path.join(stageGlobalRoot, "hash-openclaw");
            stagedPackageRoot = path.join(newInstallRoot, "node_modules", "openclaw");
            await expect(
              fs.readFile(path.join(oldPackageRoot, "package.json"), "utf8"),
            ).resolves.toContain('"version":"1.0.0"');
            expect(env).toMatchObject({
              pnpm_config_global_dir: globalDir,
              PNPM_CONFIG_GLOBAL_DIR: globalDir,
              npm_config_global_dir: globalDir,
              NPM_CONFIG_GLOBAL_DIR: globalDir,
              pnpm_config_global_bin_dir: stage.binDir,
              PNPM_CONFIG_GLOBAL_BIN_DIR: stage.binDir,
              npm_config_global_bin_dir: ownerBinDir,
              NPM_CONFIG_GLOBAL_BIN_DIR: ownerBinDir,
            });
            expect(argv).toEqual([
              ...installArgs,
              "openclaw@2.0.0",
              `--config.global-dir=${stage.projectRoot}`,
              `--config.global-bin-dir=${stage.binDir}`,
            ]);
            await fs.rm(activeLink, { force: true });
            await fs.rm(path.join(stageGlobalRoot, "old"), { recursive: true, force: true });
            await writePackageRoot(stagedPackageRoot, "2.0.0");
            await fs.mkdir(path.join(stagedPackageRoot, "scripts", "lib"), { recursive: true });
            await Promise.all([
              ...[
                PACKAGE_LIFECYCLE_MARKER_CONTRACT_RELATIVE_PATH,
                "scripts/preinstall-package-manager-warning.mjs",
                "scripts/postinstall-bundled-plugins.mjs",
              ].map((file) => fs.writeFile(path.join(stagedPackageRoot, file), "export {};\n")),
              fs.writeFile(
                path.join(stagedPackageRoot, ".openclaw-lifecycle-pending"),
                "pending\n",
              ),
              writeManifest(newInstallRoot, "2.0.0"),
            ]);
            await fs.symlink(newInstallRoot, activeLink, "dir");
            stagedPackageRoot = path.join(activeLink, "node_modules", "openclaw");
          } else if (name === "pnpm-package-preinstall" || name === "pnpm-package-postinstall") {
            expect(input).toBeUndefined();
            expect(argv).toEqual([
              process.execPath,
              path.join(
                stagedPackageRoot,
                "scripts",
                name === "pnpm-package-preinstall"
                  ? "preinstall-package-manager-warning.mjs"
                  : "postinstall-bundled-plugins.mjs",
              ),
            ]);
            const marker = path.join(stagedPackageRoot, ".openclaw-lifecycle-pending");
            await expect(fs.readFile(marker, "utf8")).resolves.toBe("pending\n");
            if (name === "pnpm-package-postinstall") {
              await fs.rm(marker);
            }
          } else {
            throw new Error(`unexpected step: ${name}`);
          }
          return packageUpdateStepResult({ name, argv, cwd });
        },
      );
      const postVerifyStep = vi.fn(async (packageRoot: string) => {
        expect(packageRoot).toBe(newPackageRoot);
        return packageUpdateStepResult(
          { name: "candidate doctor", argv: ["doctor"], cwd: packageRoot },
          { durationMs: 0 },
        );
      });

      const result = await runPnpmUpdate(globalRoot, oldPackageRoot, runCommand, runStep, {
        env: originalEnv,
        installCwd: callerProjectDir,
        postVerifyStep,
      });

      expect(originalEnv).toEqual(envBefore);
      expect(result.failedStep).toBeNull();
      expect(result.afterVersion).toBe("2.0.0");
      expect(result.activePackageRoot).toBe(newPackageRoot);
      expect(result.steps.map((step) => step.name)).toEqual([
        "package-install",
        "pnpm-package-preinstall",
        "pnpm-package-postinstall",
        "package-swap",
        "candidate doctor",
      ]);
      await expectPathMissing(path.join(newPackageRoot, ".openclaw-lifecycle-pending"));
      expect(postVerifyStep).toHaveBeenCalledOnce();
      expect(await fs.realpath(path.join(globalRoot, "hash-openclaw"))).toBe(
        path.join(globalRoot, "new"),
      );
      await expectPathMissing(path.join(globalRoot, "old"));
    });
  });

  it("preserves caller-relative pnpm specs before installing in the private stage", async () => {
    await withTestDir({ prefix: "openclaw-package-update-pnpm-relative-spec-" }, async (base) => {
      const globalDir = path.join(base, "pnpm-home", "global");
      const globalRoot = path.join(globalDir, "v11");
      const globalBinDir = path.join(base, "pnpm-home", "bin");
      const callerProjectDir = path.join(base, "caller-project");
      const candidateTarball = path.join(callerProjectDir, "candidate.tgz");
      const candidateTar = path.join(callerProjectDir, "candidate.tar");
      const cases: Array<[spec: string, expected: string, cwd?: string]> = [
        ["file:./candidate.tgz", `openclaw@file:${candidateTarball}`],
        [candidateTarball, `openclaw@file:${candidateTarball}`],
        ["candidate.tgz", `openclaw@file:${candidateTarball}`],
        [callerProjectDir, `openclaw@link:${callerProjectDir}`],
        [".", `openclaw@link:${callerProjectDir}`],
        ["../checkout", `openclaw@link:${path.join(base, "checkout")}`],
        ["file:./candidate", `openclaw@file:${path.join(callerProjectDir, "candidate")}`],
        ["openclaw@link:./candidate", `openclaw@link:${path.join(callerProjectDir, "candidate")}`],
        ["git+file:./candidate#main", "git+file:///C:/caller/candidate#main", "C:\\caller"],
        ["./candidate.tar", `openclaw@file:${candidateTar}`],
        ["openclaw@file:./candidate.tar", `openclaw@file:${candidateTar}`],
        ["candidate.tar", "candidate.tar"],
        ["openclaw@candidate.tar", "openclaw@candidate.tar"],
        ["file:~/candidate.tgz", "openclaw@file:~/candidate.tgz"],
        ["~/candidate.tgz", "openclaw@file:~/candidate.tgz"],
        ["~/checkout", "openclaw@link:~/checkout"],
        ["openclaw@latest", "openclaw@latest"],
        ["other-package@candidate.tgz", "other-package@candidate.tgz"],
        ["@scope/candidate.tgz", "@scope/candidate.tgz"],
        [
          "./package@1.0.0.tgz",
          `openclaw@file:${path.join(callerProjectDir, "package@1.0.0.tgz")}`,
        ],
        ["openclaw@npm:other@1.0.0", "openclaw@npm:other@1.0.0"],
        ["https://example.com/source.git", "https://example.com/source.git"],
        ["https://example.com/candidate.tgz", "https://example.com/candidate.tgz"],
        ["C:\\checkout", "openclaw@link:C:\\checkout"],
        ["C:\\candidate.tgz", "openclaw@file:C:\\candidate.tgz"],
        ["\\\\server\\checkout", "openclaw@link:\\\\server\\checkout"],
        [".\\checkout", "openclaw@link:C:\\caller\\checkout", "C:\\caller"],
      ];
      const { packageRoot } = await writePnpmIsolatedPackage(globalRoot, "install");
      await fs.mkdir(callerProjectDir, { recursive: true });
      await fs.writeFile(candidateTarball, "fixture", "utf8");
      await fs.writeFile(candidateTar, "fixture", "utf8");
      const runCommand = createPnpmRunner(globalRoot, globalBinDir);
      let expectedInstallSpec = "";
      const runStep = vi.fn(async ({ name, argv, cwd, env }): Promise<PackageUpdateStepResult> => {
        expect(name).toBe("package-install");
        const stage = stagedPnpmPaths(argv, globalRoot);
        expect(cwd).toBe(stage.projectRoot);
        expect(stage.projectRoot).not.toBe(globalDir);
        expect(env).toMatchObject({
          pnpm_config_global_dir: globalDir,
          pnpm_config_global_bin_dir: stage.binDir,
        });
        expect(argv).toEqual([
          ...installArgs,
          expectedInstallSpec,
          `--config.global-dir=${stage.projectRoot}`,
          `--config.global-bin-dir=${stage.binDir}`,
        ]);
        return packageUpdateStepResult(
          { name, argv, cwd },
          { exitCode: 1, stderrTail: "fixture stop" },
        );
      });

      for (const [installSpec, expected, installCwd = callerProjectDir] of cases) {
        expectedInstallSpec = expected;
        const result = await runPnpmUpdate(globalRoot, packageRoot, runCommand, runStep, {
          installSpec,
          installCwd,
        });
        expect(result.failedStep).toMatchObject({
          name: "package-install",
          stderrTail: "fixture stop",
          failureFacts: [
            expect.objectContaining({ check: "package-install", code: "global-install-failed" }),
          ],
        });
        expect(result.recovery).toEqual({ serviceRestartSafe: true, version: "1.0.0" });
      }
      expect(runStep).toHaveBeenCalledTimes(cases.length);
    });
  });

  it("rejects a pnpm command that owns another global root", async () => {
    await withTestDir({ prefix: "openclaw-package-update-pnpm-root-" }, async (base) => {
      const globalRoot = path.join(base, "owner", "global", "v11");
      const otherGlobalRoot = path.join(base, "other", "global", "v11");
      const { packageRoot } = await writePnpmIsolatedPackage(globalRoot, "install");
      const originalEnv = { pnpm_config_global_dir: path.dirname(otherGlobalRoot) };
      const runCommand = vi.fn<CommandRunner>(async (argv, options) => {
        expect(options.cwd).toBe(globalRoot);
        expect(options.env).toBe(originalEnv);
        expect(options.env?.pnpm_config_global_dir).toBe(path.dirname(otherGlobalRoot));
        expect(argv).toEqual(["pnpm", "root", "-g"]);
        return { stdout: `${otherGlobalRoot}\n`, stderr: "", code: 0 };
      });
      const runStep = vi.fn();

      const result = await runPnpmUpdate(globalRoot, packageRoot, runCommand, runStep, {
        env: originalEnv,
      });

      expect(result.failedStep?.name).toBe("pnpm-isolated-install-preflight");
      expect(result.failedStep?.stderrTail).toContain("owns");
      expect(result.failedStep?.stderrTail).toContain("not the invoking OpenClaw install");
      expect(runCommand).toHaveBeenCalledOnce();
      expect(runStep).not.toHaveBeenCalled();
    });
  });

  it("rejects an orphaned staged pnpm replacement without changing the live package", async () => {
    await withTestDir({ prefix: "openclaw-package-update-pnpm-orphan-" }, async (base) => {
      const globalRoot = path.join(base, "pnpm-home", "global", "v11");
      const globalBinDir = path.join(base, "pnpm-home", "bin");
      const { activeLink, packageRoot } = await writePnpmIsolatedPackage(globalRoot, "old");
      const runCommand = createPnpmRunner(globalRoot, globalBinDir);
      const runStep = vi.fn(async ({ name, argv, cwd }): Promise<PackageUpdateStepResult> => {
        expect(name).toBe("package-install");
        const stage = stagedPnpmPaths(argv, globalRoot);
        await fs.rm(path.join(stage.globalRoot, path.basename(activeLink)));
        return packageUpdateStepResult({ name, argv, cwd });
      });

      const result = await runPnpmUpdate(globalRoot, packageRoot, runCommand, runStep);

      expect(result.failedStep?.name).toBe("package-verify");
      expect(result.failedStep?.stderrTail).toContain("unique active staged pnpm replacement");
      expect(runStep).toHaveBeenCalledOnce();
      expect(result.activePackageRoot).toBe(packageRoot);
      expect(result.recovery).toEqual({ serviceRestartSafe: true, version: "1.0.0" });
      await expect(fs.realpath(activeLink)).resolves.toBe(path.dirname(path.dirname(packageRoot)));
      await expect(fs.readFile(path.join(packageRoot, "package.json"), "utf8")).resolves.toContain(
        '"version":"1.0.0"',
      );
    });
  });
});
