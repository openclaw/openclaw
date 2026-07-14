import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  PACKAGE_INSTALL_GUARD_RELATIVE_PATH,
  writePackageDistInventory,
} from "../../scripts/lib/package-dist-inventory.ts";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { runBunGlobalPackageUpdateSteps } from "./bun-package-update.js";
import { readPackageVersion } from "./package-json.js";
import type { PackageUpdateStepResult } from "./package-update-types.js";

async function writePackageRoot(params: {
  packageRoot: string;
  version: string;
  engine?: string;
  guard?: boolean;
}): Promise<void> {
  const scriptsDir = path.join(params.packageRoot, "scripts");
  await fs.mkdir(path.join(params.packageRoot, "dist"), { recursive: true });
  await fs.mkdir(scriptsDir, { recursive: true });
  await Promise.all([
    fs.writeFile(
      path.join(params.packageRoot, "package.json"),
      JSON.stringify({
        name: "openclaw",
        version: params.version,
        engines: { node: params.engine ?? ">=0.0.0" },
        scripts: { postinstall: "node scripts/postinstall-bundled-plugins.mjs" },
      }),
      "utf8",
    ),
    fs.writeFile(path.join(params.packageRoot, "dist", "index.js"), "export {};\n", "utf8"),
    fs.writeFile(
      path.join(scriptsDir, "postinstall-bundled-plugins.mjs"),
      "// test postinstall\n",
      "utf8",
    ),
  ]);
  await writePackageDistInventory(params.packageRoot);
  if (params.guard) {
    await fs.writeFile(
      path.join(params.packageRoot, PACKAGE_INSTALL_GUARD_RELATIVE_PATH),
      "preinstall incomplete\n",
      "utf8",
    );
  }
}

function stepResult(name: string, argv: string[], cwd?: string): PackageUpdateStepResult {
  return { name, command: argv.join(" "), cwd: cwd ?? process.cwd(), durationMs: 1, exitCode: 0 };
}

function bunRoots(base: string) {
  const bunInstall = path.join(base, ".bun");
  const globalProjectRoot = path.join(bunInstall, "install", "global");
  const globalRoot = path.join(globalProjectRoot, "node_modules");
  return {
    bunInstall,
    binRoot: path.join(bunInstall, "bin"),
    globalRoot,
    packageRoot: path.join(globalRoot, "openclaw"),
    globalProjectRoot,
  };
}

function liveEnv(roots: ReturnType<typeof bunRoots>): NodeJS.ProcessEnv {
  return {
    BUN_INSTALL: roots.bunInstall,
    BUN_INSTALL_GLOBAL_DIR: roots.globalProjectRoot,
    BUN_INSTALL_BIN: roots.binRoot,
  };
}

function stagedPackageRoot(env?: NodeJS.ProcessEnv): string {
  return path.join(env?.BUN_INSTALL_GLOBAL_DIR ?? "", "node_modules", "openclaw");
}

async function seedLiveInstall(roots: ReturnType<typeof bunRoots>): Promise<void> {
  await writePackageRoot({ packageRoot: roots.packageRoot, version: "1.0.0" });
  await fs.writeFile(
    path.join(roots.globalProjectRoot, "package.json"),
    JSON.stringify({ dependencies: { openclaw: "1.0.0" } }),
    "utf8",
  );
  await fs.writeFile(path.join(roots.globalProjectRoot, "bun.lock"), "old lock\n", "utf8");
  await fs.mkdir(roots.binRoot, { recursive: true });
  await fs.writeFile(path.join(roots.binRoot, "openclaw"), "old bin\n", "utf8");
}

describe("runBunGlobalPackageUpdateSteps", () => {
  it("isolates configured Bun global and bin roots during staging", async () => {
    await withTempDir({ prefix: "openclaw-bun-update-" }, async (base) => {
      const roots = bunRoots(base);
      await seedLiveInstall(roots);
      let stageRoot = "";
      const runStep = vi.fn(async ({ name, argv, cwd, env }) => {
        if (name === "global update stage") {
          stageRoot = env?.BUN_INSTALL ?? "";
          expect(env?.BUN_INSTALL_GLOBAL_DIR).not.toBe(roots.globalProjectRoot);
          expect(env?.BUN_INSTALL_BIN).not.toBe(roots.binRoot);
          await writePackageRoot({
            packageRoot: stagedPackageRoot(env),
            version: "2.0.0",
            guard: true,
          });
          await fs.mkdir(env?.BUN_INSTALL_BIN ?? "", { recursive: true });
          await fs.writeFile(path.join(env?.BUN_INSTALL_BIN ?? "", "openclaw"), "stage bin\n");
        } else if (name === "global update") {
          expect(env?.BUN_INSTALL_BIN).toBe(roots.binRoot);
          await writePackageRoot({
            packageRoot: roots.packageRoot,
            version: "2.0.0",
            guard: true,
          });
          await fs.writeFile(
            path.join(roots.globalProjectRoot, "package.json"),
            JSON.stringify({ dependencies: { openclaw: "2.0.0" } }),
            "utf8",
          );
          await fs.writeFile(path.join(roots.globalProjectRoot, "bun.lock"), "new lock\n", "utf8");
          await fs.writeFile(path.join(roots.binRoot, "openclaw"), "new bin\n", "utf8");
        } else if (name === "global install postinstall") {
          expect(argv[0]).toBe(process.execPath);
        } else {
          throw new Error(`unexpected step ${name}`);
        }
        return stepResult(name, argv, cwd);
      });

      const result = await runBunGlobalPackageUpdateSteps({
        installTarget: {
          manager: "bun",
          command: "bun",
          globalRoot: roots.globalRoot,
          packageRoot: roots.packageRoot,
        },
        installSpec: "openclaw@2.0.0",
        packageName: "openclaw",
        packageRoot: roots.packageRoot,
        binRoot: roots.binRoot,
        runStep,
        timeoutMs: 1000,
        env: {
          BUN_INSTALL: roots.bunInstall,
          BUN_INSTALL_GLOBAL_DIR: roots.globalProjectRoot,
        },
      });

      expect(result.failedStep).toBeNull();
      expect(result.afterVersion).toBe("2.0.0");
      expect(result.steps.map((step) => step.name)).toEqual([
        "global update stage",
        "global update stage runtime guard",
        "global update",
        "global install runtime guard",
        "global install postinstall",
      ]);
      const liveArgv = runStep.mock.calls.filter(([call]) => call.name === "global update")[0]?.[0]
        .argv;
      expect(liveArgv).toEqual([
        "bun",
        "add",
        "-g",
        "--ignore-scripts",
        "--force",
        "openclaw@2.0.0",
      ]);
      expect(runStep.mock.calls.some(([call]) => call.argv[1] === "pm")).toBe(false);
      await expect(
        fs.readFile(path.join(roots.globalProjectRoot, "bun.lock"), "utf8"),
      ).resolves.toBe("new lock\n");
      await expect(fs.readFile(path.join(roots.binRoot, "openclaw"), "utf8")).resolves.toBe(
        "new bin\n",
      );
      await expect(fs.access(stageRoot)).rejects.toHaveProperty("code", "ENOENT");
    });
  });

  it("preserves live roots when the staged candidate rejects Node", async () => {
    await withTempDir({ prefix: "openclaw-bun-update-guard-" }, async (base) => {
      const roots = bunRoots(base);
      await seedLiveInstall(roots);
      const runStep = vi.fn(async ({ name, argv, cwd, env }) => {
        if (name === "global update stage") {
          await writePackageRoot({
            packageRoot: stagedPackageRoot(env),
            version: "2.0.0",
            engine: ">=999.0.0",
            guard: true,
          });
          await fs.mkdir(env?.BUN_INSTALL_BIN ?? "", { recursive: true });
          await fs.writeFile(path.join(env?.BUN_INSTALL_BIN ?? "", "openclaw"), "stage bin\n");
        } else {
          throw new Error(`unexpected step ${name}`);
        }
        return stepResult(name, argv, cwd);
      });

      const result = await runBunGlobalPackageUpdateSteps({
        installTarget: {
          manager: "bun",
          command: "bun",
          globalRoot: roots.globalRoot,
          packageRoot: roots.packageRoot,
        },
        installSpec: "openclaw@2.0.0",
        packageName: "openclaw",
        packageRoot: roots.packageRoot,
        binRoot: roots.binRoot,
        runStep,
        timeoutMs: 1000,
        env: liveEnv(roots),
      });

      expect(result.failedStep?.name).toBe("global update stage runtime guard");
      expect(runStep).toHaveBeenCalledOnce();
      await expect(readPackageVersion(roots.packageRoot)).resolves.toBe("1.0.0");
      await expect(fs.readFile(path.join(roots.binRoot, "openclaw"), "utf8")).resolves.toBe(
        "old bin\n",
      );
    });
  });

  it("restores the complete Bun project and bin roots when live validation fails", async () => {
    await withTempDir({ prefix: "openclaw-bun-update-rollback-" }, async (base) => {
      const roots = bunRoots(base);
      await seedLiveInstall(roots);
      const sharedDependency = path.join(roots.globalRoot, "shared-dependency", "index.js");
      await fs.mkdir(path.dirname(sharedDependency), { recursive: true });
      await fs.writeFile(sharedDependency, "old dependency\n", "utf8");
      const runStep = vi.fn(async ({ name, argv, cwd, env }) => {
        if (name === "global update stage") {
          await writePackageRoot({
            packageRoot: stagedPackageRoot(env),
            version: "2.0.0",
            guard: true,
          });
        } else if (name === "global update") {
          await writePackageRoot({
            packageRoot: roots.packageRoot,
            version: "2.0.0",
            guard: true,
          });
          await fs.writeFile(path.join(roots.packageRoot, "dist", "index.js"), "different\n");
          await fs.writeFile(
            path.join(roots.globalProjectRoot, "package.json"),
            JSON.stringify({ dependencies: { openclaw: "2.0.0" } }),
            "utf8",
          );
          await fs.writeFile(path.join(roots.globalProjectRoot, "bun.lock"), "new lock\n", "utf8");
          await fs.writeFile(sharedDependency, "new dependency\n", "utf8");
          await fs.writeFile(path.join(roots.binRoot, "openclaw"), "new bin\n", "utf8");
        } else {
          throw new Error(`unexpected step ${name}`);
        }
        return stepResult(name, argv, cwd);
      });

      const result = await runBunGlobalPackageUpdateSteps({
        installTarget: {
          manager: "bun",
          command: "bun",
          globalRoot: roots.globalRoot,
          packageRoot: roots.packageRoot,
        },
        installSpec: "openclaw@2.0.0",
        packageName: "openclaw",
        packageRoot: roots.packageRoot,
        binRoot: roots.binRoot,
        runStep,
        timeoutMs: 1000,
        env: liveEnv(roots),
      });

      expect(result.steps.at(-1)?.name).toBe("global install rollback");
      expect(result.steps.at(-1)?.stderrTail).toBeNull();
      expect(result.steps.at(-1)?.exitCode).toBe(0);
      expect(result.failedStep?.name).toBe("global install candidate match");
      await expect(readPackageVersion(roots.packageRoot)).resolves.toBe("1.0.0");
      await expect(
        fs.readFile(path.join(roots.globalProjectRoot, "bun.lock"), "utf8"),
      ).resolves.toBe("old lock\n");
      await expect(fs.readFile(sharedDependency, "utf8")).resolves.toBe("old dependency\n");
      await expect(fs.readFile(path.join(roots.binRoot, "openclaw"), "utf8")).resolves.toBe(
        "old bin\n",
      );
    });
  });

  it("rolls back a valid candidate when final verification fails", async () => {
    await withTempDir({ prefix: "openclaw-bun-update-doctor-" }, async (base) => {
      const roots = bunRoots(base);
      await seedLiveInstall(roots);
      const runStep = vi.fn(async ({ name, argv, cwd, env }) => {
        if (name === "global update stage") {
          await writePackageRoot({
            packageRoot: stagedPackageRoot(env),
            version: "2.0.0",
            guard: true,
          });
        } else if (name === "global update") {
          await writePackageRoot({
            packageRoot: roots.packageRoot,
            version: "2.0.0",
            guard: true,
          });
          await fs.writeFile(path.join(roots.binRoot, "openclaw"), "new bin\n", "utf8");
        } else if (name !== "global install postinstall") {
          throw new Error(`unexpected step ${name}`);
        }
        return stepResult(name, argv, cwd);
      });
      const doctorStep: PackageUpdateStepResult = {
        name: "openclaw doctor",
        command: "openclaw doctor --non-interactive",
        cwd: roots.packageRoot,
        durationMs: 1,
        exitCode: 1,
        stderrTail: "doctor failed",
      };

      const result = await runBunGlobalPackageUpdateSteps({
        installTarget: {
          manager: "bun",
          command: "bun",
          globalRoot: roots.globalRoot,
          packageRoot: roots.packageRoot,
        },
        installSpec: "openclaw@2.0.0",
        packageName: "openclaw",
        packageRoot: roots.packageRoot,
        binRoot: roots.binRoot,
        runStep,
        timeoutMs: 1000,
        env: liveEnv(roots),
        postVerifyStep: async () => doctorStep,
      });

      expect(result.failedStep).toBe(doctorStep);
      expect(result.steps.at(-1)?.name).toBe("global install rollback");
      await expect(readPackageVersion(roots.packageRoot)).resolves.toBe("1.0.0");
      await expect(fs.readFile(path.join(roots.binRoot, "openclaw"), "utf8")).resolves.toBe(
        "old bin\n",
      );
    });
  });
});
