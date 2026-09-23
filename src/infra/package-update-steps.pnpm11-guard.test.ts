import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { writePackageDistInventory } from "../../scripts/lib/package-dist-inventory.ts";
import { PACKAGE_LIFECYCLE_MARKER_CONTRACT_RELATIVE_PATH } from "../../scripts/lib/package-lifecycle-marker.mjs";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { runGlobalPackageUpdateSteps } from "./package-update-steps.js";
import type { CommandRunner } from "./update-global-command-runner.js";

type PackageUpdateStepResult = Awaited<
  ReturnType<typeof runGlobalPackageUpdateSteps>
>["steps"][number];

async function writePackageRoot(packageRoot: string, version: string): Promise<void> {
  await fs.mkdir(path.join(packageRoot, "dist"), { recursive: true });
  await Promise.all([
    fs.writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version }),
      "utf8",
    ),
    fs.writeFile(path.join(packageRoot, "dist", "index.js"), "export {};\n", "utf8"),
  ]);
  await writePackageDistInventory(packageRoot);
}

async function writePnpmIsolatedPackage(params: {
  globalRoot: string;
  installName: string;
  version: string;
  dependencies?: Record<string, string>;
}): Promise<{ activeLink: string; packageRoot: string }> {
  const installRoot = path.join(params.globalRoot, params.installName);
  const packageRoot = path.join(installRoot, "node_modules", "openclaw");
  await writePackageRoot(packageRoot, params.version);
  await fs.writeFile(
    path.join(installRoot, "package.json"),
    JSON.stringify({
      private: true,
      dependencies: { openclaw: params.version, ...params.dependencies },
    }),
    "utf8",
  );
  const activeLink = path.join(params.globalRoot, `hash-${params.installName}`);
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
  try {
    await fs.access(filePath);
  } catch (error) {
    expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
    return;
  }
  throw new Error(`Expected missing path: ${filePath}`);
}

describe("pnpm isolated install preflight (v11 layout)", () => {
  it("rejects grouped installs before dropping sibling packages", async () => {
    await withTestDir({ prefix: "openclaw-package-update-pnpm-group-" }, async (base) => {
      const globalRoot = path.join(base, "pnpm-home", "global", "v11");
      await writePnpmIsolatedPackage({
        globalRoot,
        installName: "grouped",
        version: "1.0.0",
        dependencies: { cowsay: "1.6.0" },
      });
      const { packageRoot } = await writePnpmIsolatedPackage({
        globalRoot,
        installName: "invoking",
        version: "1.0.0",
      });
      const runCommand = vi.fn<CommandRunner>();
      const runStep = vi.fn();

      const result = await runGlobalPackageUpdateSteps({
        installTarget: {
          manager: "pnpm",
          command: "pnpm",
          pnpmIsolated: { layoutVersion: 11 },
          globalRoot,
          packageRoot,
        },
        installSpec: "openclaw@2.0.0",
        packageName: "openclaw",
        packageRoot,
        runCommand,
        runStep,
        timeoutMs: 1000,
      });

      expect(result.failedStep?.name).toBe("pnpm-isolated-install-preflight");
      expect(result.failedStep?.stderrTail).toContain("with cowsay");
      expect(result.failedStep?.stderrTail).toContain("stopped before mutation");
      expect(runCommand).not.toHaveBeenCalled();
      expect(runStep).not.toHaveBeenCalled();
    });
  });

  it("rejects multiple standalone installs before an alias-wide update", async () => {
    await withTestDir({ prefix: "openclaw-package-update-pnpm-multiple-" }, async (base) => {
      const globalRoot = path.join(base, "pnpm-home", "global", "v11");
      await writePnpmIsolatedPackage({
        globalRoot,
        installName: "other",
        version: "9.0.0",
      });
      const { packageRoot } = await writePnpmIsolatedPackage({
        globalRoot,
        installName: "invoking",
        version: "1.0.0",
      });
      const runCommand = vi.fn<CommandRunner>();
      const runStep = vi.fn();

      const result = await runGlobalPackageUpdateSteps({
        installTarget: {
          manager: "pnpm",
          command: "pnpm",
          pnpmIsolated: { layoutVersion: 11 },
          globalRoot,
          packageRoot,
        },
        installSpec: "openclaw@2.0.0",
        packageName: "openclaw",
        packageRoot,
        runCommand,
        runStep,
        timeoutMs: 1000,
      });

      expect(result.failedStep?.name).toBe("pnpm-isolated-install-preflight");
      expect(result.failedStep?.stderrTail).toContain("found 2");
      expect(result.failedStep?.stderrTail).toContain("stopped before mutation");
      expect(runCommand).not.toHaveBeenCalled();
      expect(runStep).not.toHaveBeenCalled();
    });
  });

  it("rejects an orphaned invoking install before manager probes", async () => {
    await withTestDir({ prefix: "openclaw-package-update-pnpm-invoking-orphan-" }, async (base) => {
      const globalRoot = path.join(base, "pnpm-home", "global", "v11");
      const packageRoot = path.join(globalRoot, "orphan", "node_modules", "openclaw");
      await writePackageRoot(packageRoot, "1.0.0");
      const runCommand = vi.fn<CommandRunner>();
      const runStep = vi.fn();

      const result = await runGlobalPackageUpdateSteps({
        installTarget: {
          manager: "pnpm",
          command: "pnpm",
          pnpmIsolated: { layoutVersion: 11 },
          globalRoot,
          packageRoot,
        },
        installSpec: "openclaw@2.0.0",
        packageName: "openclaw",
        packageRoot,
        runCommand,
        runStep,
        timeoutMs: 1000,
      });

      expect(result.failedStep?.name).toBe("pnpm-isolated-install-preflight");
      expect(result.failedStep?.stderrTail).toContain("found 0");
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
        fs.writeFile(
          path.join(activeInstallRoot, "package.json"),
          JSON.stringify({ private: true, dependencies: { openclaw: "1.0.0" } }),
          "utf8",
        ),
        fs.writeFile(
          path.join(orphanInstallRoot, "package.json"),
          JSON.stringify({ private: true, dependencies: { openclaw: "1.0.0" } }),
          "utf8",
        ),
        fs.symlink(sharedPackageRoot, activePackageRoot, "dir"),
        fs.symlink(sharedPackageRoot, orphanPackageRoot, "dir"),
        fs.symlink(activeInstallRoot, path.join(globalRoot, "hash-active"), "dir"),
      ]);
      const runCommand = vi.fn<CommandRunner>();
      const runStep = vi.fn();

      const result = await runGlobalPackageUpdateSteps({
        installTarget: {
          manager: "pnpm",
          command: "pnpm",
          pnpmIsolated: { layoutVersion: 11 },
          globalRoot,
          packageRoot: orphanPackageRoot,
        },
        installSpec: "openclaw@2.0.0",
        packageName: "openclaw",
        packageRoot: orphanPackageRoot,
        runCommand,
        runStep,
        timeoutMs: 1000,
      });

      expect(result.failedStep?.name).toBe("pnpm-isolated-install-preflight");
      expect(result.failedStep?.stderrTail).toContain(
        "found 1 active installs and 0 owner matches",
      );
      expect(runCommand).not.toHaveBeenCalled();
      expect(runStep).not.toHaveBeenCalled();
    });
  });

  it.each(["unset", "conflicting", "empty"] as const)(
    "uses the owning v11 layout and custom bin with %s pnpm config aliases",
    async (aliases) => {
      await withTestDir({ prefix: "openclaw-package-update-pnpm-isolated-" }, async (base) => {
        const globalDir = path.join(base, "pnpm-home", "global");
        const globalRoot = path.join(globalDir, "v11");
        const ownerBinDir = path.join(base, "custom-global-bin");
        const pathBinDir = path.join(base, "path-pnpm-home", "bin");
        const callerProjectDir = path.join(base, "caller-project");
        const oldPackageRoot = path.join(globalRoot, "old", "node_modules", "openclaw");
        const newPackageRoot = path.join(globalRoot, "new", "node_modules", "openclaw");
        await fs.mkdir(ownerBinDir, { recursive: true });
        await writePackageRoot(oldPackageRoot, "1.0.0");
        await fs.writeFile(
          path.join(globalRoot, "old", "package.json"),
          JSON.stringify({ private: true, dependencies: { openclaw: "1.0.0" } }),
          "utf8",
        );
        await fs.symlink(
          path.join(globalRoot, "old"),
          path.join(globalRoot, "hash-openclaw"),
          "dir",
        );

        const originalEnv: NodeJS.ProcessEnv = {
          PATH: `${pathBinDir}${path.delimiter}${ownerBinDir}`,
          ...(aliases === "unset"
            ? {}
            : {
                pnpm_config_global_dir: aliases === "empty" ? "" : globalDir,
                pnpm_config_global_bin_dir: aliases === "empty" ? "" : ownerBinDir,
                PNPM_CONFIG_GLOBAL_DIR: path.join(base, "other-global"),
                PNPM_CONFIG_GLOBAL_BIN_DIR: pathBinDir,
                npm_config_global_dir: aliases === "empty" ? "" : path.join(base, "npm-global"),
                NPM_CONFIG_GLOBAL_DIR: path.join(base, "other-npm-global"),
                npm_config_global_bin_dir: aliases === "empty" ? "" : pathBinDir,
                NPM_CONFIG_GLOBAL_BIN_DIR: pathBinDir,
              }),
        };
        const envBefore = { ...originalEnv };
        const pnpmWarning =
          "[WARN] Using --global skips the package manager check for this project";
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
          if (command === "pnpm bin -g") {
            expect(options.env?.PATH?.split(path.delimiter)[0]).toBe(pathBinDir);
            return { stdout: `${pnpmWarning}\n${ownerBinDir}\n`, stderr: "", code: 0 };
          }
          if (command === "pnpm --version") {
            expect(options.env?.PATH?.split(path.delimiter)[0]).toBe(pathBinDir);
            return { stdout: `${pnpmWarning}\n12.0.0\n`, stderr: "", code: 0 };
          }
          throw new Error(`unexpected command: ${command}`);
        };
        const runStep = vi.fn(
          async ({ name, argv, cwd, env }): Promise<PackageUpdateStepResult> => {
            if (name === "package-install") {
              const stage = stagedPnpmPaths(argv, globalRoot);
              if (!stage.projectRoot || !stage.binDir) {
                throw new Error("missing private pnpm stage");
              }
              expect(cwd).toBe(stage.projectRoot);
              expect(stage.projectRoot).not.toBe(globalDir);
              expect(env?.PATH?.split(path.delimiter)[0]).toBe(stage.binDir);
              const stageGlobalRoot = stage.globalRoot;
              stagedPackageRoot = path.join(stageGlobalRoot, "new", "node_modules", "openclaw");
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
                "pnpm",
                "add",
                "-g",
                "--allow-build=openclaw",
                "openclaw@2.0.0",
                `--config.global-dir=${stage.projectRoot}`,
                `--config.global-bin-dir=${stage.binDir}`,
              ]);
              await fs.rm(path.join(stageGlobalRoot, "hash-openclaw"), { force: true });
              await fs.rm(path.join(stageGlobalRoot, "old"), { recursive: true, force: true });
              await writePackageRoot(stagedPackageRoot, "2.0.0");
              await fs.mkdir(path.join(stagedPackageRoot, "scripts", "lib"), { recursive: true });
              await Promise.all([
                fs.writeFile(
                  path.join(stagedPackageRoot, PACKAGE_LIFECYCLE_MARKER_CONTRACT_RELATIVE_PATH),
                  "export {};\n",
                ),
                fs.writeFile(
                  path.join(stagedPackageRoot, ".openclaw-lifecycle-pending"),
                  "pending\n",
                  "utf8",
                ),
                fs.writeFile(
                  path.join(stagedPackageRoot, "scripts", "preinstall-package-manager-warning.mjs"),
                  "export {};\n",
                  "utf8",
                ),
                fs.writeFile(
                  path.join(stagedPackageRoot, "scripts", "postinstall-bundled-plugins.mjs"),
                  "export {};\n",
                  "utf8",
                ),
                fs.writeFile(
                  path.join(stageGlobalRoot, "new", "package.json"),
                  JSON.stringify({ private: true, dependencies: { openclaw: "2.0.0" } }),
                  "utf8",
                ),
              ]);
              await fs.symlink(
                path.join(stageGlobalRoot, "new"),
                path.join(stageGlobalRoot, "hash-openclaw"),
                "dir",
              );
            } else if (name === "pnpm-package-preinstall") {
              expect(argv).toEqual([
                process.execPath,
                path.join(stagedPackageRoot, "scripts", "preinstall-package-manager-warning.mjs"),
              ]);
              await expect(
                fs.readFile(path.join(stagedPackageRoot, ".openclaw-lifecycle-pending"), "utf8"),
              ).resolves.toBe("pending\n");
            } else if (name === "pnpm-package-postinstall") {
              expect(argv).toEqual([
                process.execPath,
                path.join(stagedPackageRoot, "scripts", "postinstall-bundled-plugins.mjs"),
              ]);
              await expect(
                fs.readFile(path.join(stagedPackageRoot, ".openclaw-lifecycle-pending"), "utf8"),
              ).resolves.toBe("pending\n");
              await fs.rm(path.join(stagedPackageRoot, ".openclaw-lifecycle-pending"));
            } else {
              throw new Error(`unexpected step: ${name}`);
            }
            return {
              name,
              command: argv.join(" "),
              cwd: cwd ?? process.cwd(),
              durationMs: 1,
              exitCode: 0,
            };
          },
        );
        const postVerifyStep = vi.fn(async (packageRoot: string) => {
          expect(packageRoot).toBe(newPackageRoot);
          return {
            name: "candidate doctor",
            command: "doctor",
            cwd: packageRoot,
            durationMs: 0,
            exitCode: 0,
          };
        });

        const result = await runGlobalPackageUpdateSteps({
          installTarget: {
            manager: "pnpm",
            command: "pnpm",
            pnpmIsolated: {
              layoutVersion: 11,
            },
            globalRoot,
            packageRoot: oldPackageRoot,
          },
          installSpec: "openclaw@2.0.0",
          packageName: "openclaw",
          packageRoot: oldPackageRoot,
          runCommand,
          runStep,
          timeoutMs: 1000,
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
    },
  );

  it("accepts a replacement pnpm project that reuses the same shared-store package", async () => {
    await withTestDir(
      { prefix: "openclaw-package-update-pnpm-shared-replacement-" },
      async (base) => {
        const globalDir = path.join(base, "pnpm-home", "global");
        const globalRoot = path.join(globalDir, "v11");
        const globalBinDir = path.join(base, "pnpm-home", "bin");
        const oldInstallRoot = path.join(globalRoot, "old");
        const newInstallRoot = path.join(globalRoot, "new");
        const oldPackageRoot = path.join(oldInstallRoot, "node_modules", "openclaw");
        const newPackageRoot = path.join(newInstallRoot, "node_modules", "openclaw");
        const sharedPackageRoot = path.join(base, "store", "openclaw");
        const activeLink = path.join(globalRoot, "hash-openclaw");
        await Promise.all([
          fs.mkdir(path.dirname(oldPackageRoot), { recursive: true }),
          writePackageRoot(sharedPackageRoot, "1.0.0"),
        ]);
        await Promise.all([
          fs.writeFile(
            path.join(oldInstallRoot, "package.json"),
            JSON.stringify({ private: true, dependencies: { openclaw: "1.0.0" } }),
            "utf8",
          ),
          fs.symlink(sharedPackageRoot, oldPackageRoot, "dir"),
          fs.symlink(oldInstallRoot, activeLink, "dir"),
        ]);
        const runCommand = createPnpmRunner(globalRoot, globalBinDir);
        const runStep = vi.fn(async ({ name, argv, cwd }): Promise<PackageUpdateStepResult> => {
          expect(name).toBe("package-install");
          const stage = stagedPnpmPaths(argv, globalRoot);
          expect(cwd).toBe(stage.projectRoot);
          const stagedOwner = path.join(stage.globalRoot, "new");
          const stagedPackage = path.join(stagedOwner, "node_modules", "openclaw");
          const stagedLink = path.join(stage.globalRoot, "hash-openclaw");
          await fs.rm(stagedLink);
          await fs.mkdir(path.dirname(stagedPackage), { recursive: true });
          await Promise.all([
            fs.writeFile(
              path.join(stagedOwner, "package.json"),
              JSON.stringify({ private: true, dependencies: { openclaw: "1.0.0" } }),
              "utf8",
            ),
            fs.symlink(sharedPackageRoot, stagedPackage, "dir"),
            fs.symlink(stagedOwner, stagedLink, "dir"),
          ]);
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
            manager: "pnpm",
            command: "pnpm",
            pnpmIsolated: { layoutVersion: 11 },
            globalRoot,
            packageRoot: oldPackageRoot,
          },
          installSpec: "openclaw@1.0.0",
          requirePackageReplacement: true,
          packageName: "openclaw",
          packageRoot: oldPackageRoot,
          runCommand,
          runStep,
          timeoutMs: 1000,
        });

        expect(result.failedStep).toBeNull();
        expect(result.afterVersion).toBe("1.0.0");
        expect(result.activePackageRoot).toBe(newPackageRoot);
        expect(runStep).toHaveBeenCalledOnce();
      },
    );
  });

  it("preserves caller-relative pnpm specs before installing in the private stage", async () => {
    await withTestDir({ prefix: "openclaw-package-update-pnpm-relative-spec-" }, async (base) => {
      const globalDir = path.join(base, "pnpm-home", "global");
      const globalRoot = path.join(globalDir, "v11");
      const globalBinDir = path.join(base, "pnpm-home", "bin");
      const callerProjectDir = path.join(base, "caller-project");
      const candidateTarball = path.join(callerProjectDir, "candidate.tgz");
      const candidateTar = path.join(callerProjectDir, "candidate.tar");
      const cases: Array<{
        installSpec: string;
        expectedInstallSpec: string;
        installCwd?: string;
      }> = [
        {
          installSpec: "file:./candidate.tgz",
          expectedInstallSpec: `openclaw@file:${candidateTarball}`,
        },
        { installSpec: candidateTarball, expectedInstallSpec: `openclaw@file:${candidateTarball}` },
        { installSpec: "candidate.tgz", expectedInstallSpec: `openclaw@file:${candidateTarball}` },
        { installSpec: callerProjectDir, expectedInstallSpec: `openclaw@link:${callerProjectDir}` },
        { installSpec: ".", expectedInstallSpec: `openclaw@link:${callerProjectDir}` },
        {
          installSpec: "../checkout",
          expectedInstallSpec: `openclaw@link:${path.join(base, "checkout")}`,
        },
        {
          installSpec: "file:./candidate",
          expectedInstallSpec: `openclaw@file:${path.join(callerProjectDir, "candidate")}`,
        },
        {
          installSpec: "openclaw@link:./candidate",
          expectedInstallSpec: `openclaw@link:${path.join(callerProjectDir, "candidate")}`,
        },
        {
          installSpec: "git+file:./candidate#main",
          expectedInstallSpec: "git+file:///C:/caller/candidate#main",
          installCwd: "C:\\caller",
        },
        { installSpec: "./candidate.tar", expectedInstallSpec: `openclaw@file:${candidateTar}` },
        {
          installSpec: "openclaw@file:./candidate.tar",
          expectedInstallSpec: `openclaw@file:${candidateTar}`,
        },
        { installSpec: "candidate.tar", expectedInstallSpec: "candidate.tar" },
        { installSpec: "openclaw@candidate.tar", expectedInstallSpec: "openclaw@candidate.tar" },
        {
          installSpec: "file:~/candidate.tgz",
          expectedInstallSpec: "openclaw@file:~/candidate.tgz",
        },
        { installSpec: "~/candidate.tgz", expectedInstallSpec: "openclaw@file:~/candidate.tgz" },
        { installSpec: "~/checkout", expectedInstallSpec: "openclaw@link:~/checkout" },
        { installSpec: "openclaw@latest", expectedInstallSpec: "openclaw@latest" },
        {
          installSpec: "other-package@candidate.tgz",
          expectedInstallSpec: "other-package@candidate.tgz",
        },
        { installSpec: "@scope/candidate.tgz", expectedInstallSpec: "@scope/candidate.tgz" },
        {
          installSpec: "./package@1.0.0.tgz",
          expectedInstallSpec: `openclaw@file:${path.join(callerProjectDir, "package@1.0.0.tgz")}`,
        },
        {
          installSpec: "openclaw@npm:other@1.0.0",
          expectedInstallSpec: "openclaw@npm:other@1.0.0",
        },
        {
          installSpec: "https://example.com/source.git",
          expectedInstallSpec: "https://example.com/source.git",
        },
        {
          installSpec: "https://example.com/candidate.tgz",
          expectedInstallSpec: "https://example.com/candidate.tgz",
        },
        { installSpec: "C:\\checkout", expectedInstallSpec: "openclaw@link:C:\\checkout" },
        {
          installSpec: "C:\\candidate.tgz",
          expectedInstallSpec: "openclaw@file:C:\\candidate.tgz",
        },
        {
          installSpec: "\\\\server\\checkout",
          expectedInstallSpec: "openclaw@link:\\\\server\\checkout",
        },
        {
          installSpec: ".\\checkout",
          expectedInstallSpec: "openclaw@link:C:\\caller\\checkout",
          installCwd: "C:\\caller",
        },
      ];
      const { packageRoot } = await writePnpmIsolatedPackage({
        globalRoot,
        installName: "install",
        version: "1.0.0",
      });
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
          "pnpm",
          "add",
          "-g",
          "--allow-build=openclaw",
          expectedInstallSpec,
          `--config.global-dir=${stage.projectRoot}`,
          `--config.global-bin-dir=${stage.binDir}`,
        ]);
        return {
          name,
          command: argv.join(" "),
          cwd: cwd ?? process.cwd(),
          durationMs: 1,
          exitCode: 1,
          stderrTail: "fixture stop",
        };
      });

      for (const testCase of cases) {
        expectedInstallSpec = testCase.expectedInstallSpec;
        const result = await runGlobalPackageUpdateSteps({
          installTarget: {
            manager: "pnpm",
            command: "pnpm",
            pnpmIsolated: { layoutVersion: 11 },
            globalRoot,
            packageRoot,
          },
          installSpec: testCase.installSpec,
          packageName: "openclaw",
          packageRoot,
          runCommand,
          runStep,
          timeoutMs: 1000,
          installCwd: testCase.installCwd ?? callerProjectDir,
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
      const { packageRoot } = await writePnpmIsolatedPackage({
        globalRoot,
        installName: "install",
        version: "1.0.0",
      });
      const originalEnv = { pnpm_config_global_dir: path.dirname(otherGlobalRoot) };
      const runCommand = vi.fn<CommandRunner>(async (argv, options) => {
        expect(options.cwd).toBe(globalRoot);
        expect(options.env).toBe(originalEnv);
        expect(options.env?.pnpm_config_global_dir).toBe(path.dirname(otherGlobalRoot));
        expect(argv).toEqual(["pnpm", "root", "-g"]);
        return { stdout: `${otherGlobalRoot}\n`, stderr: "", code: 0 };
      });
      const runStep = vi.fn();

      const result = await runGlobalPackageUpdateSteps({
        installTarget: {
          manager: "pnpm",
          command: "pnpm",
          pnpmIsolated: { layoutVersion: 11 },
          globalRoot,
          packageRoot,
        },
        installSpec: "openclaw@2.0.0",
        packageName: "openclaw",
        packageRoot,
        runCommand,
        runStep,
        timeoutMs: 1000,
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
      const { activeLink, packageRoot } = await writePnpmIsolatedPackage({
        globalRoot,
        installName: "old",
        version: "1.0.0",
      });
      const runCommand = createPnpmRunner(globalRoot, globalBinDir);
      const runStep = vi.fn(async ({ name, argv, cwd }): Promise<PackageUpdateStepResult> => {
        expect(name).toBe("package-install");
        const stage = stagedPnpmPaths(argv, globalRoot);
        await fs.rm(path.join(stage.globalRoot, path.basename(activeLink)));
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
          manager: "pnpm",
          command: "pnpm",
          pnpmIsolated: {
            layoutVersion: 11,
          },
          globalRoot,
          packageRoot,
        },
        installSpec: "openclaw@2.0.0",
        packageName: "openclaw",
        packageRoot,
        runCommand,
        runStep,
        timeoutMs: 1000,
      });

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
