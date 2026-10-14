import fs from "node:fs/promises";
import path from "node:path";
import { root as fsSafeRoot, type Root } from "@openclaw/fs-safe/root";
import { describe, expect, it, vi } from "vitest";
import { writePackageDistInventory } from "../../scripts/lib/package-dist-inventory.ts";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { PACKAGE_DIST_INVENTORY_RELATIVE_PATH } from "./package-dist-inventory.js";
import { runGlobalPackageUpdateSteps } from "./package-update-steps.js";
import {
  createNpmUpdateOptions,
  createNpmTarget,
  createRootRunner,
  packageUpdateStepResult,
  stagedNpmPrefix,
  writePackageRoot,
} from "./package-update-steps.test-support.js";
import { resolveNpmGlobalPrefixLayoutFromPrefix } from "./update-npm-prefix.js";

describe("npm-lifecycle-policy-preflight", () => {
  it("verifies the original package before recovery from preflight refusal", async () => {
    await withTestDir({ prefix: "openclaw-recovery-preflight-" }, async (base) => {
      const globalRoot = path.join(base, "lib", "node_modules");
      const target = createNpmTarget(globalRoot);
      const packageRoot = path.join(globalRoot, "openclaw");
      await writePackageRoot(packageRoot, "1.0.0");
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
      expect(result.failedStep?.stderrTail).toContain("Unable to determine the owning npm version");
      expect(result.failedStep).toMatchObject({
        failureFacts: [
          expect.objectContaining({
            check: "npm-lifecycle-policy-preflight",
            code: "global-install-failed",
            message: expect.stringContaining("Unable to determine the owning npm version"),
          }),
        ],
      });
      expect(runCommand).not.toHaveBeenCalled();
      expect(runStep).not.toHaveBeenCalled();
      expect(result.recovery).toEqual({ serviceRestartSafe: true, version: "1.0.0" });
    });
  });
});

describe("package update recovery safety", () => {
  it.each([
    { spec: "./candidate.tgz", before: "same-build", after: "same-build", noop: true },
    { spec: "openclaw@file:./candidate", before: "old-build", after: "new-build", noop: false },
    { spec: "openclaw@npm:@scope/fork@^1", before: "old-build", after: "new-build", noop: false },
    { spec: "openclaw@npm:openclaw@1.0.0", before: "old-build", after: "new-build", noop: false },
  ])(
    "honors staged identity for $spec ($before -> $after)",
    async ({ spec, before, after, noop }) => {
      await withTestDir({ prefix: "openclaw-artifact-identity-" }, async (base) => {
        const prefix = path.join(base, "prefix");
        const globalRoot = path.join(prefix, "lib", "node_modules");
        const packageRoot = path.join(globalRoot, "openclaw");
        const writeIdentity = async (root: string, buildId: string) => {
          await writePackageRoot(root, "1.0.0");
          await fs.writeFile(
            path.join(root, "dist", "build-info.json"),
            JSON.stringify({ buildId }),
          );
          await writePackageDistInventory(root);
        };
        await writeIdentity(packageRoot, before);
        const installedPaths = [
          "package.json",
          "dist/index.js",
          "dist/build-info.json",
          PACKAGE_DIST_INVENTORY_RELATIVE_PATH,
        ];
        const installedBytesBefore = await Promise.all(
          installedPaths.map((relativePath) =>
            fs.readFile(path.join(packageRoot, relativePath)).catch(() => null),
          ),
        );
        const validateCandidate = vi.fn(async () => [
          { name: "canary", command: "canary", cwd: base, durationMs: 0, exitCode: 1 },
        ]);
        const beforeActivate = vi.fn(async () => {});
        const runStep = vi.fn(async ({ name, argv }: { name: string; argv: string[] }) => {
          const stagePrefix = stagedNpmPrefix(argv);
          const stageLayout = resolveNpmGlobalPrefixLayoutFromPrefix(stagePrefix);
          const stageRoot = path.join(stageLayout.globalRoot, "openclaw");
          await writeIdentity(stageRoot, after);
          return { name, command: argv.join(" "), cwd: stagePrefix, durationMs: 0, exitCode: 0 };
        });
        const result = await runGlobalPackageUpdateSteps({
          ...createNpmUpdateOptions(globalRoot, spec),
          runStep,
          validateCandidate,
          beforeActivate,
        });
        if (noop) {
          expect(result.reason).toBe("already-current");
          expect(validateCandidate).not.toHaveBeenCalled();
        } else {
          expect(result.reason).toBeUndefined();
          expect(validateCandidate).toHaveBeenCalledOnce();
          expect(result.failedStep?.name).toBe("canary");
        }
        expect(beforeActivate).not.toHaveBeenCalled();
        expect(runStep.mock.calls.flatMap(([call]) => call.argv)).not.toContain("--force");
        await expect(
          Promise.all(
            installedPaths.map((relativePath) =>
              fs.readFile(path.join(packageRoot, relativePath)).catch(() => null),
            ),
          ),
        ).resolves.toEqual(installedBytesBefore);
        expect(await fs.readFile(path.join(packageRoot, "package.json"), "utf8")).toContain(
          '"version":"1.0.0"',
        );
        expect(
          JSON.parse(await fs.readFile(path.join(packageRoot, "dist", "build-info.json"), "utf8"))
            .buildId,
        ).toBe(before);
      });
    },
  );

  it("refuses an unsupported layout before validation or mutation", async () => {
    await withTestDir({ prefix: "openclaw-package-unsupported-stage-" }, async (base) => {
      const globalRoot = path.join(base, "unsupported-global-root");
      const packageRoot = path.join(globalRoot, "openclaw");
      await writePackageRoot(packageRoot, "1.0.0");
      const validateCandidate = vi.fn(async () => []);
      const runStep = vi.fn(async ({ name, argv }: { name: string; argv: string[] }) => {
        await writePackageRoot(packageRoot, "2.0.0");
        return { name, command: argv.join(" "), cwd: globalRoot, durationMs: 0, exitCode: 0 };
      });
      const result = await runGlobalPackageUpdateSteps({
        ...createNpmUpdateOptions(globalRoot),
        runStep,
        validateCandidate,
      });
      expect(result.failedStep).toMatchObject({ name: "package-stage", exitCode: 1 });
      expect(runStep).not.toHaveBeenCalled();
      expect(validateCandidate).not.toHaveBeenCalled();
      expect(result.recovery).toEqual({ serviceRestartSafe: true, version: "1.0.0" });
      await expect(fs.readFile(path.join(packageRoot, "package.json"), "utf8")).resolves.toContain(
        '"version":"1.0.0"',
      );
    });
  });

  it("replaces equal-version package bytes and rolls them back after verification fails", async () => {
    await withTestDir({ prefix: "openclaw-package-equal-version-replacement-" }, async (base) => {
      const prefix = path.join(base, "prefix");
      const globalRoot = path.join(prefix, "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      const launcher = path.join(prefix, "bin", "openclaw");
      await writePackageRoot(packageRoot, "1.0.0");
      await fs.writeFile(path.join(packageRoot, "dist", "index.js"), "old runtime\n");
      await fs.mkdir(path.dirname(launcher), { recursive: true });
      await fs.writeFile(launcher, "old launcher\n");

      const result = await runGlobalPackageUpdateSteps({
        ...createNpmUpdateOptions(globalRoot, "openclaw@1.0.0"),
        packageRoot,
        requirePackageReplacement: true,
        runStep: async ({ name, argv }) => {
          const stagePrefix = stagedNpmPrefix(argv);
          const stageLayout = resolveNpmGlobalPrefixLayoutFromPrefix(stagePrefix);
          const stageRoot = path.join(stageLayout.globalRoot, "openclaw");
          await writePackageRoot(stageRoot, "1.0.0");
          await fs.writeFile(path.join(stageRoot, "dist", "index.js"), "new runtime\n");
          await writePackageDistInventory(stageRoot);
          await fs.mkdir(stageLayout.binDir, { recursive: true });
          await fs.writeFile(path.join(stageLayout.binDir, "openclaw"), "new launcher\n");
          return { name, command: argv.join(" "), cwd: stagePrefix, durationMs: 0, exitCode: 0 };
        },
        validateCandidate: async (candidateRoot) => {
          await expect(
            fs.readFile(path.join(candidateRoot, "dist", "index.js"), "utf8"),
          ).resolves.toBe("new runtime\n");
          await expect(
            fs.readFile(path.join(packageRoot, "dist", "index.js"), "utf8"),
          ).resolves.toBe("old runtime\n");
          return [];
        },
        beforeActivate: async () => {},
        postVerifyStep: async (candidateRoot) => {
          await expect(
            fs.readFile(path.join(candidateRoot, "dist", "index.js"), "utf8"),
          ).resolves.toBe("new runtime\n");
          return {
            name: "doctor",
            command: "doctor --fix",
            cwd: candidateRoot,
            durationMs: 0,
            exitCode: 1,
          };
        },
      });

      expect(result.reason).toBeUndefined();
      expect(result.failedStep?.name).toBe("doctor");
      expect(result.recovery).toEqual({
        serviceRestartSafe: false,
        reason: "runtime-verification-failed",
        packageRollbackVerified: true,
      });
      await expect(fs.readFile(path.join(packageRoot, "dist", "index.js"), "utf8")).resolves.toBe(
        "old runtime\n",
      );
      await expect(fs.readFile(launcher, "utf8")).resolves.toBe("old launcher\n");
    });
  });

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
          ...createNpmUpdateOptions(globalRoot),
          packageRoot,
          runStep,
        });
        expect(result.failedStep?.name).toBe("package-stage");
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

  it("rejects npm recovery after a failed install corrupts the original package", async () => {
    await withTestDir({ prefix: "openclaw-package-recovery-" }, async (base) => {
      const globalRoot = path.join(base, "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      await writePackageRoot(packageRoot, "1.0.0");
      const params = {
        ...createNpmUpdateOptions(globalRoot),
        packageRoot,
        runStep: async ({ name, argv }: { name: string; argv: string[] }) => {
          const prefix = stagedNpmPrefix(argv);
          const stageLayout = resolveNpmGlobalPrefixLayoutFromPrefix(prefix);
          const installRoot = path.join(stageLayout.globalRoot, "openclaw");
          await writePackageRoot(installRoot, "2.0.0");
          await fs.rm(path.join(packageRoot, "dist", "index.js"), { force: true });
          return packageUpdateStepResult(
            { name, argv, cwd: globalRoot },
            {
              durationMs: 0,
              exitCode: 1,
            },
          );
        },
        postVerifyStep: async () => {
          throw new Error("doctor interrupted after replacement");
        },
      };
      const result = await runGlobalPackageUpdateSteps(params);

      expect(result.failedStep).not.toBeNull();
      expect(result.recovery).toEqual({
        serviceRestartSafe: false,
        reason: "runtime-verification-failed",
      });
      expect(await fs.readFile(path.join(packageRoot, "package.json"), "utf8")).toContain(
        '"version":"1.0.0"',
      );
    });
  });

  it.each(["throwing", "missing"] as const)(
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
          ...createNpmUpdateOptions(globalRoot),
          packageRoot,
          runStep: async ({ name, argv }) => {
            const stagePrefix = stagedNpmPrefix(argv);
            const stageLayout = resolveNpmGlobalPrefixLayoutFromPrefix(stagePrefix);
            await writePackageRoot(path.join(stageLayout.globalRoot, "openclaw"), "2.0.0");
            const stagedBinDir = stageLayout.binDir;
            await fs.mkdir(stagedBinDir, { recursive: true });
            await Promise.all(
              shimNames.map((shimName) =>
                fs.writeFile(path.join(stagedBinDir, shimName), `new ${shimName}\n`, "utf8"),
              ),
            );
            return packageUpdateStepResult(
              { name, argv, cwd: stagePrefix },
              {
                durationMs: 0,
              },
            );
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
            return null;
          },
        });

        const expectedVersion = "1.0.0";
        expect(result.afterVersion).toBe(expectedVersion);
        await expect(
          fs.readFile(stateCanary, "utf8"),
          JSON.stringify(result.failedStep),
        ).resolves.toBe("mutated by candidate Doctor\n");
        await expect(
          fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
        ).resolves.toContain(`"version":"${expectedVersion}"`);
        for (const shimName of shimNames) {
          await expect(fs.readFile(path.join(binDir, shimName), "utf8")).resolves.toBe(
            `old ${shimName}\n`,
          );
        }
        expect((await fs.readdir(globalRoot)).filter((entry) => entry.startsWith("."))).toEqual([]);
        expect(result.failedStep).not.toBeNull();
        expect(result.recovery).toEqual({
          serviceRestartSafe: false,
          reason: "runtime-verification-failed",
          packageRollbackVerified: true,
        });
        expect(result.steps.find((step) => step.name === "package-swap")?.stdoutTail).toContain(
          "restored previous openclaw package and affected launchers",
        );
        expect(result.steps.find((step) => step.name === "package-swap")?.stdoutTail).toContain(
          "Update Doctor may have changed persistent state",
        );
      });
    },
  );

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
        if (
          typeof source === "string" &&
          path.basename(source) === "openclaw.cmd" &&
          path.basename(path.dirname(source)).startsWith(".openclaw.shim-backup-")
        ) {
          injections += 1;
          throw Object.assign(new Error("launcher restoration denied"), { code: "EACCES" });
        }
        await copy.call(this, destination, source, options);
      });
      let result: Awaited<ReturnType<typeof runGlobalPackageUpdateSteps>>;
      try {
        result = await runGlobalPackageUpdateSteps({
          ...createNpmUpdateOptions(globalRoot),
          packageRoot,
          runStep: async ({ name, argv }) => {
            const stagePrefix = stagedNpmPrefix(argv);
            const stageLayout = resolveNpmGlobalPrefixLayoutFromPrefix(stagePrefix);
            await writePackageRoot(path.join(stageLayout.globalRoot, "openclaw"), "2.0.0");
            const stagedBinDir = stageLayout.binDir;
            await fs.mkdir(stagedBinDir, { recursive: true });
            await fs.writeFile(path.join(stagedBinDir, "openclaw"), "new openclaw\n", "utf8");
            await fs.writeFile(
              path.join(stagedBinDir, "openclaw.cmd"),
              "new openclaw.cmd\n",
              "utf8",
            );
            return packageUpdateStepResult(
              { name, argv, cwd: stagePrefix },
              {
                durationMs: 0,
              },
            );
          },
          postVerifyStep: async (candidateRoot) => ({
            name: "openclaw doctor",
            command: "openclaw doctor --non-interactive --fix",
            cwd: candidateRoot,
            durationMs: 0,
            exitCode: 1,
            stderrTail: "doctor rejected candidate",
          }),
        });
      } finally {
        copySpy.mockRestore();
      }

      expect(injections).toBe(1);
      expect(result.failedStep).toMatchObject({ name: "package-swap", exitCode: 1 });
      expect(result.failedStep).toMatchObject({
        failureFacts: [expect.objectContaining({ check: "package-swap", code: "swap-failed" })],
      });
      expect(result.failedStep?.stderrTail).toContain("launcher restoration denied");
      expect(result.failedStep?.stderrTail).toContain(targetCmdShim);
      expect(result.recovery).toEqual({
        serviceRestartSafe: false,
        reason: "runtime-verification-failed",
        packageRollbackVerified: false,
      });
      expect(result.afterVersion).toBe("1.0.0");
      await expect(fs.readFile(targetShim, "utf8")).resolves.toBe("old openclaw\n");
      await expect(fs.readFile(targetCmdShim, "utf8")).resolves.toBe("new openclaw.cmd\n");
      const backupDirs = (await fs.readdir(globalRoot)).filter((entry) =>
        entry.startsWith(".openclaw.shim-backup-"),
      );
      expect(backupDirs).toHaveLength(1);
      await expect(
        fs.readFile(path.join(globalRoot, backupDirs[0] ?? "", "openclaw.cmd"), "utf8"),
      ).resolves.toBe("old openclaw.cmd\n");
    });
  });
});

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
        ...createNpmUpdateOptions(globalRoot, candidateRoot),
        expectedGitCheckout: { root: candidateRoot, sha: SOURCE_SHA },
        activateGitRoot: publishedRoot,
        runStep: async ({ name, argv }) => {
          const stagePrefix = stagedNpmPrefix(argv);
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
    it.each(
      [
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
        {
          name: "missing UI index",
          remove: "dist/control-ui/index.html",
          error: "ui=missing-index",
        },
        {
          name: "incomplete UI",
          remove: "dist/control-ui/assets/startup.js",
          error: "ui=incomplete",
        },
        { name: "missing launcher", remove: "openclaw.mjs", error: "missing" },
      ].filter(({ name }) =>
        manager === "npm"
          ? name !== "prepared checkout" && name !== "wrong checkout"
          : manager === "pnpm"
            ? name === "wrong checkout"
            : name === "prepared checkout",
      ),
    )("verifies $name before finalization", async ({ name: caseName, error, remove, stale }) => {
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
              const stagePrefix = stagedNpmPrefix(argv);
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
            return packageUpdateStepResult({ name, argv, cwd });
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
