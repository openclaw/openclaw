// Covers package update step orchestration.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { writePackageDistInventory } from "../../scripts/lib/package-dist-inventory.ts";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  markPackagePostInstallDoctorAdvisory,
  runGlobalPackageUpdateSteps,
} from "./package-update-steps.js";
import {
  createDeferredConfiguredPluginRepairDoctorResult,
  UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE,
} from "./update-doctor-result.js";
import {
  resolveNpmGlobalPrefixLayoutFromPrefix,
  type CommandRunner,
  type ResolvedGlobalInstallTarget,
} from "./update-global.js";

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

async function addHardlinkedPackageFile(packageRoot: string, linkRoot: string): Promise<void> {
  const packageFile = path.join(packageRoot, "dist", "index.js");
  await fs.mkdir(linkRoot, { recursive: true });
  await fs.link(packageFile, path.join(linkRoot, `${path.basename(packageRoot)}-index.js`));
}

function createNpmTarget(globalRoot: string): ResolvedGlobalInstallTarget {
  return {
    manager: "npm",
    command: "npm",
    globalRoot,
    packageRoot: path.join(globalRoot, "openclaw"),
  };
}

function createFsError(code: string, message = code): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

function createPnpmTarget(globalRoot: string): ResolvedGlobalInstallTarget {
  return {
    manager: "pnpm",
    command: "pnpm",
    globalRoot,
    packageRoot: path.join(globalRoot, "openclaw"),
  };
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

async function expectPathMissing(filePath: string): Promise<void> {
  try {
    await fs.access(filePath);
  } catch (error) {
    expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
    return;
  }
  throw new Error(`Expected missing path: ${filePath}`);
}

function createRootRunner(globalRoot: string): CommandRunner {
  return async (argv) => {
    if (argv.join(" ") === "npm root -g") {
      return { stdout: `${globalRoot}\n`, stderr: "", code: 0 };
    }
    throw new Error(`unexpected command: ${argv.join(" ")}`);
  };
}

describe("markPackagePostInstallDoctorAdvisory", () => {
  it("marks only explicit post-install doctor advisory exits", () => {
    const step = markPackagePostInstallDoctorAdvisory(
      {
        exitCode: UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE,
        stderrTail: "doctor deferred repair",
        signal: null,
        killed: false,
        termination: "exit" as const,
      },
      createDeferredConfiguredPluginRepairDoctorResult(["deferred configured plugin repair"]),
    );

    expect(step.advisory).toEqual({
      kind: "package-post-install-doctor",
      message: expect.stringContaining("recoverable update-time repair warning"),
    });
    expect(step.stderrTail).toContain("doctor deferred repair");
    expect(step.stderrTail).toContain("deferred configured plugin repair");
  });

  it("keeps advisory diagnostics bounded after appending deferred repair details", () => {
    const step = markPackagePostInstallDoctorAdvisory(
      {
        exitCode: UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE,
        stderrTail: "doctor deferred repair",
        signal: null,
        killed: false,
        termination: "exit" as const,
      },
      createDeferredConfiguredPluginRepairDoctorResult([
        `deferred configured plugin repair ${"x".repeat(10_000)}`,
      ]),
    );

    expect(step.stderrTail).toHaveLength(8_001);
    expect(step.stderrTail).toMatch(/^…/u);
    expect(step.stderrTail).toContain("recoverable update-time repair warning");
  });

  it("does not mark unknown nonzero doctor exits as advisory", () => {
    const step = markPackagePostInstallDoctorAdvisory(
      {
        exitCode: 1,
        stderrTail: "doctor refused migration",
        signal: null,
        killed: false,
        termination: "exit" as const,
      },
      null,
    );

    expect(step.advisory).toBeUndefined();
    expect(step.stderrTail).toBe("doctor refused migration");
  });

  it("does not mark timed-out doctor exits as advisory when they report a code", () => {
    const step = markPackagePostInstallDoctorAdvisory(
      {
        exitCode: 124,
        stderrTail: "doctor timed out",
        signal: null,
        killed: true,
        termination: "timeout" as const,
      },
      createDeferredConfiguredPluginRepairDoctorResult(["deferred configured plugin repair"]),
    );

    expect(step.advisory).toBeUndefined();
    expect(step.stderrTail).toBe("doctor timed out");
  });
});

describe("runGlobalPackageUpdateSteps", () => {
  it("installs npm updates into a clean staged prefix before swapping the global package", async () => {
    await withTempDir({ prefix: "openclaw-package-update-staged-" }, async (base) => {
      const prefix = path.join(base, "prefix");
      const globalRoot = path.join(prefix, "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      await writePackageRoot(packageRoot, "1.0.0");
      await fs.mkdir(path.join(packageRoot, "dist", "extensions", "qa-channel"), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(packageRoot, "dist", "extensions", "qa-channel", "runtime-api.js"),
        "export {};\n",
        "utf8",
      );

      const runStep = vi.fn(
        async ({ name, argv, cwd, timeoutMs }): Promise<PackageUpdateStepResult> => {
          expect(timeoutMs).toBe(1000);
          if (name !== "global update") {
            throw new Error(`unexpected step ${name}`);
          }
          const prefixIndex = argv.indexOf("--prefix");
          expect(prefixIndex).toBeGreaterThan(0);
          const stagePrefix = argv[prefixIndex + 1];
          if (!stagePrefix) {
            throw new Error("missing staged prefix");
          }
          expect(path.dirname(stagePrefix)).toBe(globalRoot);
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
        },
      );

      const result = await runGlobalPackageUpdateSteps({
        installTarget: createNpmTarget(globalRoot),
        installSpec: "openclaw@2.0.0",
        packageName: "openclaw",
        packageRoot,
        runCommand: createRootRunner(globalRoot),
        runStep,
        timeoutMs: 1000,
      });

      expect(result.failedStep).toBeNull();
      expect(result.verifiedPackageRoot).toBe(packageRoot);
      expect(result.afterVersion).toBe("2.0.0");
      expect(result.steps.map((step) => step.name)).toEqual([
        "global update",
        "global install swap",
      ]);
      await expect(fs.readFile(path.join(packageRoot, "package.json"), "utf8")).resolves.toContain(
        '"version":"2.0.0"',
      );
      await expectPathMissing(
        path.join(packageRoot, "dist", "extensions", "qa-channel", "runtime-api.js"),
      );
      await expect(fs.readlink(path.join(prefix, "bin", "openclaw"))).resolves.toBe(
        "../lib/node_modules/openclaw/dist/index.js",
      );
    });
  });

  it.runIf(process.platform !== "win32")(
    "swaps npm package roots that contain package-manager hardlinks",
    async () => {
      await withTempDir({ prefix: "openclaw-package-update-hardlinks-" }, async (base) => {
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
            if (name !== "global update") {
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
        expect(result.steps.map((step) => step.name)).toEqual([
          "global update",
          "global install swap",
        ]);
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
    await withTempDir({ prefix: "openclaw-package-update-direct-root-" }, async (base) => {
      const managedRoot = path.join(base, ".openclaw", "npm", "node_modules");
      const packageRoot = path.join(managedRoot, "openclaw");
      await writePackageRoot(packageRoot, "1.0.0");

      const runStep = vi.fn(async ({ name, argv, cwd }): Promise<PackageUpdateStepResult> => {
        if (name !== "global update") {
          throw new Error(`unexpected step ${name}`);
        }
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
      expect(result.verifiedPackageRoot).toBe(packageRoot);
      expect(result.afterVersion).toBe("2.0.0");
      await expect(fs.readFile(path.join(packageRoot, "package.json"), "utf8")).resolves.toContain(
        '"version":"2.0.0"',
      );
      await expectPathMissing(path.join(managedRoot, ".bin", "openclaw"));
    });
  });

  it("accepts v-prefixed exact npm specs when verifying staged installs", async () => {
    await withTempDir({ prefix: "openclaw-package-update-v-prefix-" }, async (base) => {
      const prefix = path.join(base, "prefix");
      const globalRoot = path.join(prefix, "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      await writePackageRoot(packageRoot, "1.0.0");

      const runStep = vi.fn(async ({ name, argv, cwd }): Promise<PackageUpdateStepResult> => {
        if (name !== "global update") {
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
      expect(result.steps.map((step) => step.name)).toEqual([
        "global update",
        "global install swap",
      ]);
    });
  });

  it("packs npm GitHub specs before installing into the staged prefix", async () => {
    await withTempDir({ prefix: "openclaw-package-update-npm-pack-" }, async (base) => {
      const prefix = path.join(base, "prefix");
      const globalRoot = path.join(prefix, "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      const sourceSpec = "OpenClaw@github:openclaw/openclaw#release/2026.5.12";
      await writePackageRoot(packageRoot, "1.0.0");

      let packDir: string | undefined;
      const runStep = vi.fn(async ({ name, argv, cwd }): Promise<PackageUpdateStepResult> => {
        if (name === "global update pack") {
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
          };
        }
        if (name !== "global update") {
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
          "--allow-scripts=./openclaw-2.0.0.tgz",
          "--prefix",
          stagePrefix,
          path.join(packDir, "openclaw-2.0.0.tgz"),
          "--no-fund",
          "--no-audit",
          "--loglevel=error",
          "--min-release-age=0",
        ]);
        expect(cwd).toBe(packDir);
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
        "global update pack",
        "global update",
        "global install swap",
      ]);
      if (!packDir) {
        throw new Error("expected npm pack directory");
      }
      await expectPathMissing(packDir);
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
      await withTempDir({ prefix: "openclaw-package-update-npm-pack-variant-" }, async (base) => {
        const globalRoot = path.join(base, "prefix", "lib", "node_modules");
        const packageRoot = path.join(globalRoot, "openclaw");
        await writePackageRoot(packageRoot, "1.0.0");

        let tarball: string | undefined;
        const runStep = vi.fn(async ({ name, argv, cwd }): Promise<PackageUpdateStepResult> => {
          if (name === "global update pack") {
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
          if (name !== "global update" || !tarball) {
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
          "global update pack",
          "global update",
          "global install swap",
        ]);
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
        if (name !== "global update") {
          throw new Error(`unexpected step ${name}`);
        }
        expect(argv[0]).toBe("npm");
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
          expect(argv).toEqual([
            "pnpm",
            "add",
            "-g",
            "--global-dir",
            globalDir,
            "--allow-build=openclaw",
            "openclaw@2.0.0",
          ]);
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

  it("uses the owner-reported custom bin without changing pnpm command resolution", async () => {
    await withTempDir({ prefix: "openclaw-package-update-pnpm-isolated-" }, async (base) => {
      const globalDir = path.join(base, "pnpm-home", "global");
      const globalRoot = path.join(globalDir, "v11");
      const ownerBinDir = path.join(base, "custom-global-bin");
      const pathBinDir = path.join(base, "path-pnpm-home", "bin");
      const oldPackageRoot = path.join(globalRoot, "old", "node_modules", "openclaw");
      const newPackageRoot = path.join(globalRoot, "new", "node_modules", "openclaw");
      await fs.mkdir(ownerBinDir, { recursive: true });
      await writePackageRoot(oldPackageRoot, "1.0.0");
      await fs.writeFile(
        path.join(globalRoot, "old", "package.json"),
        JSON.stringify({ private: true, dependencies: { openclaw: "1.0.0" } }),
        "utf8",
      );
      await fs.symlink(path.join(globalRoot, "old"), path.join(globalRoot, "hash-openclaw"), "dir");

      const pnpmWarning = "[WARN] Using --global skips the package manager check for this project";
      const runCommand: CommandRunner = async (argv, options) => {
        const command = argv.join(" ");
        expect(options.cwd).toBe(globalRoot);
        if (command === "pnpm root -g") {
          return { stdout: `${pnpmWarning}\n${globalRoot}\n`, stderr: "", code: 0 };
        }
        if (command === "pnpm bin -g") {
          expect(options.env?.PATH?.split(path.delimiter)[0]).toBe(pathBinDir);
          return { stdout: `${pnpmWarning}\n${ownerBinDir}\n`, stderr: "", code: 0 };
        }
        if (command === "pnpm --version") {
          expect(options.env?.PATH?.split(path.delimiter)[0]).toBe(pathBinDir);
          return { stdout: `${pnpmWarning}\n11.4.0\n`, stderr: "", code: 0 };
        }
        throw new Error(`unexpected command: ${command}`);
      };
      const runStep = vi.fn(async ({ name, argv, cwd, env }): Promise<PackageUpdateStepResult> => {
        if (name === "global update") {
          expect(env?.PATH?.split(path.delimiter)[0]).toBe(pathBinDir);
          expect(argv).toEqual([
            "pnpm",
            "add",
            "-g",
            "--global-dir",
            globalDir,
            "--global-bin-dir",
            ownerBinDir,
            "--allow-build=openclaw",
            "openclaw@2.0.0",
          ]);
          await fs.rm(path.join(globalRoot, "hash-openclaw"), { force: true });
          await fs.rm(path.join(globalRoot, "old"), { recursive: true, force: true });
          await writePackageRoot(newPackageRoot, "2.0.0");
          await fs.mkdir(path.join(newPackageRoot, "scripts"), { recursive: true });
          await Promise.all([
            fs.writeFile(
              path.join(newPackageRoot, "dist", "openclaw-install-guard"),
              "pending\n",
              "utf8",
            ),
            fs.writeFile(
              path.join(newPackageRoot, "scripts", "preinstall-package-manager-warning.mjs"),
              "export {};\n",
              "utf8",
            ),
            fs.writeFile(
              path.join(newPackageRoot, "scripts", "postinstall-bundled-plugins.mjs"),
              "export {};\n",
              "utf8",
            ),
            fs.writeFile(
              path.join(globalRoot, "new", "package.json"),
              JSON.stringify({ private: true, dependencies: { openclaw: "2.0.0" } }),
              "utf8",
            ),
          ]);
          await fs.symlink(
            path.join(globalRoot, "new"),
            path.join(globalRoot, "hash-openclaw"),
            "dir",
          );
        } else if (name === "pnpm package preinstall") {
          expect(argv).toEqual([
            process.execPath,
            path.join(newPackageRoot, "scripts", "preinstall-package-manager-warning.mjs"),
          ]);
          await expect(
            fs.readFile(path.join(newPackageRoot, ".openclaw-lifecycle-pending"), "utf8"),
          ).resolves.toBe("pending\n");
          await fs.rm(path.join(newPackageRoot, "dist", "openclaw-install-guard"));
        } else if (name === "pnpm package postinstall") {
          expect(argv).toEqual([
            process.execPath,
            path.join(newPackageRoot, "scripts", "postinstall-bundled-plugins.mjs"),
          ]);
          await expect(
            fs.readFile(path.join(newPackageRoot, ".openclaw-lifecycle-pending"), "utf8"),
          ).resolves.toBe("pending\n");
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
      });
      const postVerifyStep = vi.fn(async (packageRoot: string) => {
        expect(packageRoot).toBe(newPackageRoot);
        return null;
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
        env: { PATH: `${pathBinDir}${path.delimiter}${ownerBinDir}` },
        postVerifyStep,
      });

      expect(result.failedStep).toBeNull();
      expect(result.afterVersion).toBe("2.0.0");
      expect(result.verifiedPackageRoot).toBe(newPackageRoot);
      expect(result.steps.map((step) => step.name)).toEqual([
        "global update",
        "pnpm package preinstall",
        "pnpm package postinstall",
      ]);
      await expectPathMissing(path.join(newPackageRoot, ".openclaw-lifecycle-pending"));
      expect(postVerifyStep).toHaveBeenCalledOnce();
    });
  });

  it("accepts a replacement pnpm project that reuses the same shared-store package", async () => {
    await withTempDir(
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
        const runCommand: CommandRunner = async (argv, options) => {
          expect(options.cwd).toBe(globalRoot);
          const command = argv.join(" ");
          if (command === "pnpm root -g") {
            return { stdout: `${globalRoot}\n`, stderr: "", code: 0 };
          }
          if (command === "pnpm bin -g") {
            return { stdout: `${globalBinDir}\n`, stderr: "", code: 0 };
          }
          if (command === "pnpm --version") {
            return { stdout: "11.4.0\n", stderr: "", code: 0 };
          }
          throw new Error(`unexpected command: ${command}`);
        };
        const runStep = vi.fn(async ({ name, argv, cwd }): Promise<PackageUpdateStepResult> => {
          expect(name).toBe("global update");
          await fs.rm(activeLink);
          await fs.mkdir(path.dirname(newPackageRoot), { recursive: true });
          await Promise.all([
            fs.writeFile(
              path.join(newInstallRoot, "package.json"),
              JSON.stringify({ private: true, dependencies: { openclaw: "1.0.0" } }),
              "utf8",
            ),
            fs.symlink(sharedPackageRoot, newPackageRoot, "dir"),
            fs.symlink(newInstallRoot, activeLink, "dir"),
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
          packageName: "openclaw",
          packageRoot: oldPackageRoot,
          runCommand,
          runStep,
          timeoutMs: 1000,
        });

        expect(result.failedStep).toBeNull();
        expect(result.afterVersion).toBe("1.0.0");
        expect(result.verifiedPackageRoot).toBe(newPackageRoot);
        expect(runStep).toHaveBeenCalledOnce();
      },
    );
  });

  it("probes pnpm from its owner root before rejecting a mismatched major", async () => {
    await withTempDir({ prefix: "openclaw-package-update-pnpm-major-" }, async (base) => {
      const globalRoot = path.join(base, "pnpm-home", "global", "v11");
      const globalBinDir = path.join(base, "pnpm-home", "bin");
      const { packageRoot } = await writePnpmIsolatedPackage({
        globalRoot,
        installName: "install",
        version: "1.0.0",
      });
      const runStep = vi.fn();
      const runCommand: CommandRunner = async (argv, options) => {
        const command = argv.join(" ");
        expect(options.cwd).toBe(globalRoot);
        expect(options.env?.PATH?.split(path.delimiter)[0]).toBe(globalBinDir);
        if (command === "pnpm root -g") {
          return { stdout: `${globalRoot}\n`, stderr: "", code: 0 };
        }
        if (command === "pnpm bin -g") {
          return { stdout: `${globalBinDir}\n`, stderr: "", code: 0 };
        }
        if (command === "pnpm --version") {
          return { stdout: "10.32.1\n", stderr: "", code: 0 };
        }
        throw new Error(`unexpected command: ${command}`);
      };

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
        env: { PATH: `${globalBinDir}${path.delimiter}${path.join(base, "pnpm-10", "bin")}` },
      });

      expect(result.failedStep?.name).toBe("pnpm isolated install preflight");
      expect(result.failedStep?.stderrTail).toContain("reports pnpm 10.32.1");
      expect(runStep).not.toHaveBeenCalled();
      await expect(fs.readFile(path.join(packageRoot, "package.json"), "utf8")).resolves.toContain(
        '"version":"1.0.0"',
      );
    });
  });

  it("rejects a pnpm command that owns another global root", async () => {
    await withTempDir({ prefix: "openclaw-package-update-pnpm-root-" }, async (base) => {
      const globalRoot = path.join(base, "owner", "global", "v11");
      const otherGlobalRoot = path.join(base, "other", "global", "v11");
      const { packageRoot } = await writePnpmIsolatedPackage({
        globalRoot,
        installName: "install",
        version: "1.0.0",
      });
      const runCommand = vi.fn<CommandRunner>(async (argv) => {
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
      });

      expect(result.failedStep?.name).toBe("pnpm isolated install preflight");
      expect(result.failedStep?.stderrTail).toContain("owns");
      expect(result.failedStep?.stderrTail).toContain("not the invoking OpenClaw install");
      expect(runCommand).toHaveBeenCalledOnce();
      expect(runStep).not.toHaveBeenCalled();
    });
  });

  it("rejects a pnpm update that leaves only an orphaned old package root", async () => {
    await withTempDir({ prefix: "openclaw-package-update-pnpm-orphan-" }, async (base) => {
      const globalRoot = path.join(base, "pnpm-home", "global", "v11");
      const globalBinDir = path.join(base, "pnpm-home", "bin");
      const { activeLink, packageRoot } = await writePnpmIsolatedPackage({
        globalRoot,
        installName: "old",
        version: "1.0.0",
      });
      const runCommand: CommandRunner = async (argv) => {
        const command = argv.join(" ");
        if (command === "pnpm root -g") {
          return { stdout: `${globalRoot}\n`, stderr: "", code: 0 };
        }
        if (command === "pnpm bin -g") {
          return { stdout: `${globalBinDir}\n`, stderr: "", code: 0 };
        }
        if (command === "pnpm --version") {
          return { stdout: "11.4.0\n", stderr: "", code: 0 };
        }
        throw new Error(`unexpected command: ${command}`);
      };
      const runStep = vi.fn(async ({ name, argv, cwd }): Promise<PackageUpdateStepResult> => {
        expect(name).toBe("global update");
        await fs.rm(activeLink);
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

      expect(result.failedStep?.name).toBe("global install verify");
      expect(result.failedStep?.stderrTail).toContain("unique active pnpm replacement");
      expect(runStep).toHaveBeenCalledOnce();
      await expect(fs.readFile(path.join(packageRoot, "package.json"), "utf8")).resolves.toContain(
        '"version":"1.0.0"',
      );
    });
  });

  it("rejects grouped pnpm isolated installs before dropping sibling packages", async () => {
    await withTempDir({ prefix: "openclaw-package-update-pnpm-group-" }, async (base) => {
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

      expect(result.failedStep?.name).toBe("pnpm isolated install preflight");
      expect(result.failedStep?.stderrTail).toContain("with cowsay");
      expect(result.failedStep?.stderrTail).toContain("stopped before mutation");
      expect(runCommand).not.toHaveBeenCalled();
      expect(runStep).not.toHaveBeenCalled();
    });
  });

  it("rejects multiple standalone pnpm installs before an alias-wide update", async () => {
    await withTempDir({ prefix: "openclaw-package-update-pnpm-multiple-" }, async (base) => {
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

      expect(result.failedStep?.name).toBe("pnpm isolated install preflight");
      expect(result.failedStep?.stderrTail).toContain("found 2");
      expect(result.failedStep?.stderrTail).toContain("stopped before mutation");
      expect(runCommand).not.toHaveBeenCalled();
      expect(runStep).not.toHaveBeenCalled();
    });
  });

  it("rejects an orphaned invoking pnpm install before manager probes", async () => {
    await withTempDir({ prefix: "openclaw-package-update-pnpm-invoking-orphan-" }, async (base) => {
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

      expect(result.failedStep?.name).toBe("pnpm isolated install preflight");
      expect(result.failedStep?.stderrTail).toContain("found 0");
      expect(runCommand).not.toHaveBeenCalled();
      expect(runStep).not.toHaveBeenCalled();
    });
  });

  it("rejects an orphan whose package symlink shares the active project's store target", async () => {
    await withTempDir({ prefix: "openclaw-package-update-pnpm-shared-store-" }, async (base) => {
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

      expect(result.failedStep?.name).toBe("pnpm isolated install preflight");
      expect(result.failedStep?.stderrTail).toContain(
        "found 1 active installs and 0 owner matches",
      );
      expect(runCommand).not.toHaveBeenCalled();
      expect(runStep).not.toHaveBeenCalled();
    });
  });

  it("retries interrupted pnpm package lifecycle repair", async () => {
    await withTempDir({ prefix: "openclaw-package-update-pnpm-lifecycle-" }, async (base) => {
      const globalRoot = path.join(base, "global");
      const packageRoot = path.join(globalRoot, "openclaw");
      await writePackageRoot(packageRoot, "1.0.0");
      let firstAttempt = true;

      const runStep = vi.fn(async ({ name, argv, cwd }): Promise<PackageUpdateStepResult> => {
        if (name === "global update" && firstAttempt) {
          await writePackageRoot(packageRoot, "2.0.0");
          await fs.mkdir(path.join(packageRoot, "scripts"), { recursive: true });
          await Promise.all([
            fs.writeFile(
              path.join(packageRoot, "dist", "openclaw-install-guard"),
              "pending\n",
              "utf8",
            ),
            fs.writeFile(
              path.join(packageRoot, "scripts", "preinstall-package-manager-warning.mjs"),
              "export {};\n",
              "utf8",
            ),
            fs.writeFile(
              path.join(packageRoot, "scripts", "postinstall-bundled-plugins.mjs"),
              "export {};\n",
              "utf8",
            ),
          ]);
        } else if (name === "pnpm package preinstall") {
          await fs.rm(path.join(packageRoot, "dist", "openclaw-install-guard"));
        }
        const exitCode = name === "pnpm package postinstall" && firstAttempt ? 1 : 0;
        return {
          name,
          command: argv.join(" "),
          cwd: cwd ?? process.cwd(),
          durationMs: 1,
          exitCode,
        };
      });
      const updateParams = {
        installTarget: createPnpmTarget(globalRoot),
        installSpec: "openclaw@2.0.0",
        packageName: "openclaw",
        packageRoot,
        runCommand: async (argv: string[]) => {
          if (argv.join(" ") === "pnpm root -g") {
            return { stdout: `${globalRoot}\n`, stderr: "", code: 0 };
          }
          throw new Error(`unexpected command: ${argv.join(" ")}`);
        },
        runStep,
        timeoutMs: 1000,
      };

      const failed = await runGlobalPackageUpdateSteps(updateParams);
      expect(failed.failedStep?.name).toBe("pnpm package postinstall");
      await expect(
        fs.readFile(path.join(packageRoot, ".openclaw-lifecycle-pending"), "utf8"),
      ).resolves.toBe("pending\n");

      firstAttempt = false;
      runStep.mockClear();
      const recovered = await runGlobalPackageUpdateSteps(updateParams);
      expect(recovered.failedStep).toBeNull();
      expect(recovered.afterVersion).toBe("2.0.0");
      expect(runStep.mock.calls.map(([call]) => call.name)).toEqual([
        "global update",
        "pnpm package postinstall",
      ]);
      await expectPathMissing(path.join(packageRoot, ".openclaw-lifecycle-pending"));
    });
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
