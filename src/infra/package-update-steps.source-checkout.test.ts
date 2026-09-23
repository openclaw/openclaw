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
import { resolveNpmGlobalPrefixLayoutFromPrefix } from "./update-npm-prefix.js";

const SOURCE_VERSION = "2026.8.1";
const SOURCE_SHA = "a".repeat(40);

async function writeSourceCheckout(checkoutRoot: string): Promise<void> {
  await fs.mkdir(checkoutRoot, { recursive: true });
  for (const dir of [".git", "src", "extensions", "dist/control-ui/assets"]) {
    await fs.mkdir(path.join(checkoutRoot, dir), { recursive: true });
  }
  for (const [file, contents] of Object.entries({
    "package.json": JSON.stringify({ name: "openclaw", version: SOURCE_VERSION }),
    "pnpm-workspace.yaml": "packages: []\n",
    "dist/entry.js": "export {};\n",
    "dist/build-info.json": JSON.stringify({ commit: SOURCE_SHA }),
    "dist/.buildstamp": JSON.stringify({ head: SOURCE_SHA }),
    "dist/.runtime-postbuildstamp": JSON.stringify({ head: SOURCE_SHA }),
    "dist/control-ui/index.html": '<script src="./assets/startup.js"></script>',
    "dist/control-ui/assets/startup.js": "export {};\n",
  })) {
    await fs.writeFile(path.join(checkoutRoot, file), contents);
  }
  await fs.writeFile(path.join(checkoutRoot, "openclaw.mjs"), "#!/usr/bin/env node\n", {
    mode: 0o755,
  });
}

describe("runGlobalPackageUpdateSteps", () => {
  it("validates a temporary source checkout then exposes its published root", async () => {
    await withTestDir({ prefix: "openclaw-source-publication-" }, async (base) => {
      const globalRoot = path.join(base, "prefix", "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      const candidateRoot = path.join(base, "candidate");
      const publishedRoot = path.join(base, "checkout");
      await writePackageRoot(packageRoot, "1.0.0");
      await writeSourceCheckout(candidateRoot);
      await writeSourceCheckout(publishedRoot);
      const phases: string[] = [];
      const result = await runGlobalPackageUpdateSteps({
        installTarget: createNpmTarget(globalRoot),
        installSpec: candidateRoot,
        packageName: "openclaw",
        expectedGitCheckout: { root: candidateRoot, sha: SOURCE_SHA },
        activateGitRoot: publishedRoot,
        runCommand: createRootRunner(globalRoot),
        runStep: async ({ name, argv }) => {
          const stagePrefix = argv[argv.indexOf("--prefix") + 1];
          if (!stagePrefix) {
            throw new Error("missing stage prefix");
          }
          const layout = resolveNpmGlobalPrefixLayoutFromPrefix(stagePrefix);
          await fs.mkdir(layout.globalRoot, { recursive: true });
          await fs.mkdir(layout.binDir, { recursive: true });
          await fs.symlink(
            candidateRoot,
            path.join(layout.globalRoot, "openclaw"),
            process.platform === "win32" ? "junction" : undefined,
          );
          await fs.symlink(
            "../lib/node_modules/openclaw/openclaw.mjs",
            path.join(layout.binDir, "openclaw"),
          );
          return { name, command: argv.join(" "), cwd: stagePrefix, durationMs: 0, exitCode: 0 };
        },
        validateCandidate: async (root) => {
          phases.push("validate");
          expect(await fs.realpath(root)).toBe(candidateRoot);
          return [];
        },
        beforeActivate: async () => {
          phases.push("publish");
          await fs.rename(publishedRoot, `${publishedRoot}.previous`);
          await fs.rename(candidateRoot, publishedRoot);
        },
        postVerifyStep: async (root) => {
          phases.push("doctor");
          expect(await fs.realpath(root)).toBe(publishedRoot);
          return { name: "doctor", command: "doctor --fix", cwd: root, durationMs: 0, exitCode: 0 };
        },
        timeoutMs: 1000,
      });
      expect(result.failedStep).toBeNull();
      expect(phases).toEqual(["validate", "publish", "doctor"]);
      expect(await fs.realpath(packageRoot)).toBe(publishedRoot);
      expect(result.afterVersion).toBe(SOURCE_VERSION);
    });
  });

  it("refuses a prepared checkout before install when its native owner is unknown", async () => {
    const postVerifyStep = vi.fn();
    const runStep = vi.fn();
    const result = await runGlobalPackageUpdateSteps({
      installTarget: { manager: "pnpm", command: "pnpm", globalRoot: null, packageRoot: null },
      installSpec: "/prepared-checkout",
      packageName: "openclaw",
      expectedGitCheckout: { root: "/prepared-checkout", sha: SOURCE_SHA },
      runCommand: async () => ({ code: 0, stdout: "", stderr: "" }),
      runStep,
      timeoutMs: 1000,
      postVerifyStep,
    });
    expect(result.failedStep).toMatchObject({
      name: "package-stage",
      stderrTail: "Cannot resolve the native package manager's staging owner.",
    });
    expect(runStep).not.toHaveBeenCalled();
    expect(postVerifyStep).not.toHaveBeenCalled();
  });

  it("preserves the old global package when source exposure refuses before activation", async () => {
    await withTestDir({ prefix: "openclaw-git-exposure-recovery-" }, async (base) => {
      const globalRoot = path.join(base, "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      await writePackageRoot(packageRoot, "1.0.0");
      await writeSourceCheckout(path.join(base, "prepared-checkout"));
      const runStep = vi.fn();
      const result = await runGlobalPackageUpdateSteps({
        installTarget: {
          ...createNpmTarget(globalRoot),
          npmOwner: { version: null, lifecyclePolicy: null },
        },
        installSpec: path.join(base, "prepared-checkout"),
        expectedGitCheckout: { root: path.join(base, "prepared-checkout"), sha: SOURCE_SHA },
        packageName: "openclaw",
        packageRoot,
        runCommand: createRootRunner(globalRoot),
        runStep,
        timeoutMs: 1000,
      });
      expect(result.recovery).toEqual({
        serviceRestartSafe: true,
        version: "1.0.0",
      });
      expect(runStep).not.toHaveBeenCalled();
    });
  });

  describe.each(["npm", "pnpm", "bun"] as const)("%s source checkout activation", (manager) => {
    it.each([
      { name: "prepared checkout", error: null },
      { name: "wrong checkout", error: "expected checkout" },
      { name: "accidental source link", error: "source checkout" },
      { name: "missing build entry", remove: "dist/entry.js", error: "entry=false" },
      {
        name: "missing runtime stamp",
        remove: "dist/.runtime-postbuildstamp",
        error: "runtimeStamp=missing",
      },
      {
        name: "stale build identity",
        stale: "dist/build-info.json",
        error: "git runtime mismatch",
      },
      { name: "stale build stamp", stale: "dist/.buildstamp", error: "git runtime mismatch" },
      { name: "missing build identity", remove: "dist/build-info.json", error: "build=missing" },
      { name: "missing built SHA", error: "expected=missing" },
      { name: "missing UI index", remove: "dist/control-ui/index.html", error: "ui=missing-index" },
      {
        name: "incomplete UI",
        remove: "dist/control-ui/assets/startup.js",
        error: "ui=incomplete",
      },
      { name: "missing launcher", remove: "openclaw.mjs", error: "missing" },
    ])("verifies $name before finalization", async ({ name: caseName, error, remove, stale }) => {
      await withTestDir({ prefix: "openclaw-package-update-source-" }, async (base) => {
        const prefix = path.join(base, "prefix");
        const globalRoot =
          manager === "npm"
            ? path.join(prefix, "lib", "node_modules")
            : manager === "pnpm"
              ? path.join(prefix, "global", "5", "node_modules")
              : path.join(prefix, ".bun", "install", "global", "node_modules");
        const packageRoot = path.join(globalRoot, "openclaw");
        const projectRoot =
          manager === "pnpm" ? path.dirname(path.dirname(globalRoot)) : path.dirname(globalRoot);
        const binDir = path.join(prefix, "bin");
        const checkoutRoot = path.join(base, "checkout");
        const linkedRoot =
          caseName === "wrong checkout" ? path.join(base, "other-checkout") : checkoutRoot;
        await writePackageRoot(packageRoot, "1.0.0");
        await writeSourceCheckout(checkoutRoot);
        if (linkedRoot !== checkoutRoot) {
          await writeSourceCheckout(linkedRoot);
        }
        if (remove) {
          await fs.rm(path.join(checkoutRoot, remove));
        }
        if (stale) {
          await fs.writeFile(
            path.join(checkoutRoot, stale),
            JSON.stringify({ commit: "b".repeat(40), head: "b".repeat(40) }),
          );
        }
        const postVerifyStep = vi.fn(async () => ({
          name: "candidate doctor",
          command: "doctor",
          cwd: packageRoot,
          durationMs: 0,
          exitCode: 0,
        }));
        const result = await runGlobalPackageUpdateSteps({
          installTarget:
            manager === "npm"
              ? createNpmTarget(globalRoot)
              : { manager, command: manager, globalRoot, packageRoot },
          installSpec: checkoutRoot,
          expectedGitCheckout:
            caseName === "accidental source link"
              ? undefined
              : { root: checkoutRoot, sha: caseName === "missing built SHA" ? null : SOURCE_SHA },
          packageName: "openclaw",
          packageRoot,
          installCwd: checkoutRoot,
          env:
            manager === "bun"
              ? { BUN_INSTALL_GLOBAL_DIR: projectRoot, BUN_INSTALL_BIN: binDir }
              : undefined,
          runCommand: async (argv) => {
            const stagedProject = argv
              .find((arg) => arg.startsWith("--config.global-dir="))
              ?.slice("--config.global-dir=".length);
            const stagedBin = argv
              .find((arg) => arg.startsWith("--config.global-bin-dir="))
              ?.slice("--config.global-bin-dir=".length);
            return {
              code: 0,
              stderr: "",
              stdout:
                argv.includes("root") && stagedProject
                  ? path.join(stagedProject, path.relative(projectRoot, globalRoot))
                  : (stagedBin ?? binDir),
            };
          },
          runStep: async ({ name, argv, cwd, env }) => {
            expect(name).toBe("package-install");
            let targetRoot: string;
            if (manager === "npm") {
              const stagePrefix = argv[argv.indexOf("--prefix") + 1];
              if (!stagePrefix) {
                throw new Error("missing staged prefix");
              }
              expect(path.dirname(stagePrefix)).toBe(globalRoot);
              const stageLayout = resolveNpmGlobalPrefixLayoutFromPrefix(stagePrefix);
              targetRoot = path.join(stageLayout.globalRoot, "openclaw");
              await fs.mkdir(stageLayout.binDir, { recursive: true });
              await fs.symlink(
                "../lib/node_modules/openclaw/openclaw.mjs",
                path.join(stageLayout.binDir, "openclaw"),
              );
            } else {
              if (!cwd || cwd === projectRoot) {
                throw new Error("missing private native stage");
              }
              targetRoot = path.join(cwd, path.relative(projectRoot, packageRoot));
              const stagedBin =
                manager === "bun"
                  ? env?.BUN_INSTALL_BIN
                  : argv
                      .find((arg) => arg.startsWith("--config.global-bin-dir="))
                      ?.slice("--config.global-bin-dir=".length);
              if (!stagedBin) {
                throw new Error("missing staged native bin");
              }
              await fs.rm(targetRoot, { recursive: true });
              await fs.symlink(
                path.relative(stagedBin, path.join(targetRoot, "openclaw.mjs")),
                path.join(stagedBin, "openclaw"),
              );
            }
            await expect(
              fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
            ).resolves.toContain('"version":"1.0.0"');
            await fs.mkdir(path.dirname(targetRoot), { recursive: true });
            await fs.symlink(
              process.platform === "win32"
                ? linkedRoot
                : path.relative(path.dirname(targetRoot), linkedRoot),
              targetRoot,
              process.platform === "win32" ? "junction" : undefined,
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
        if (manager === "bun" && process.platform === "win32") {
          expect(result.failedStep).toMatchObject({ name: "package-stage", exitCode: 1 });
          expect(result.failedStep?.stderrTail).toContain(
            "Bun Windows binary launchers cannot be relocated",
          );
          expect(postVerifyStep).not.toHaveBeenCalled();
          await expect(
            fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
          ).resolves.toContain('"version":"1.0.0"');
        } else if (error) {
          expect(result.failedStep).toMatchObject({
            name: "package-verify",
            stderrTail: expect.stringContaining(error),
          });
          expect(postVerifyStep).not.toHaveBeenCalled();
          expect(result.afterVersion).toBe("1.0.0");
          expect(result.steps.some((step) => step.name === "package-swap")).toBe(false);
          await expect(
            fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
          ).resolves.toContain('"version":"1.0.0"');
        } else {
          expect(result.failedStep).toBeNull();
          expect(result.activePackageRoot).toBe(packageRoot);
          expect(result.afterVersion).toBe(SOURCE_VERSION);
          expect(postVerifyStep).toHaveBeenCalledWith(packageRoot, expect.any(Array));
          await expect(fs.realpath(packageRoot)).resolves.toBe(checkoutRoot);
          expect(result.steps.map((step) => step.name)).toEqual([
            "package-install",
            "package-swap",
            "candidate doctor",
          ]);
          await expect(fs.realpath(path.join(binDir, "openclaw"))).resolves.toBe(
            path.join(checkoutRoot, "openclaw.mjs"),
          );
          if (manager === "npm") {
            await expect(fs.readlink(path.join(prefix, "bin", "openclaw"))).resolves.toBe(
              "../lib/node_modules/openclaw/openclaw.mjs",
            );
            expect(
              (await fs.readdir(globalRoot)).filter((entry) =>
                entry.startsWith(".openclaw.update-stage-"),
              ),
            ).toEqual([]);
          }
        }
      });
    });
  });
});
