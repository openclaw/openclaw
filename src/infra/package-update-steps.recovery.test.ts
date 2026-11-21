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

const readText = (...parts: string[]) => fs.readFile(path.join(...parts), "utf8");
const expectText = (...parts: string[]) => expect(readText(...parts)).resolves;

async function npmPackage(base: string, root = path.join(base, "prefix", "lib", "node_modules")) {
  const packageRoot = path.join(root, "openclaw");
  await writePackageRoot(packageRoot, "1.0.0");
  return {
    globalRoot: root,
    packageRoot,
    binDir: path.join(path.dirname(path.dirname(root)), "bin"),
  };
}

async function writeShims(binDir: string, names: readonly string[], label: string) {
  await fs.mkdir(binDir, { recursive: true });
  await Promise.all(
    names.map((name) => fs.writeFile(path.join(binDir, name), `${label} ${name}\n`, "utf8")),
  );
}

async function stagePackage(argv: string[], version = "2.0.0", shims: readonly string[] = []) {
  const prefix = stagedNpmPrefix(argv);
  const layout = resolveNpmGlobalPrefixLayoutFromPrefix(prefix);
  const root = path.join(layout.globalRoot, "openclaw");
  await writePackageRoot(root, version);
  if (shims.length) {
    await writeShims(layout.binDir, shims, "new");
  }
  return { prefix, root };
}

describe("npm-lifecycle-policy-preflight", () => {
  it("verifies the original package before recovery from preflight refusal", async () => {
    await withTestDir({ prefix: "openclaw-recovery-preflight-" }, async (base) => {
      const { globalRoot } = await npmPackage(base, path.join(base, "lib", "node_modules"));
      const runStep = vi.fn();
      const runCommand = vi.fn(createRootRunner(globalRoot));
      const result = await runGlobalPackageUpdateSteps({
        ...createNpmUpdateOptions(globalRoot),
        installTarget: {
          ...createNpmTarget(globalRoot),
          npmOwner: { version: null, lifecyclePolicy: null, probeError: "version probe failed" },
        },
        runCommand,
        runStep,
      });
      expect(result.failedStep).toMatchObject({
        stderrTail: expect.stringContaining("Unable to determine the owning npm version"),
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
        const globalRoot = path.join(base, "prefix", "lib", "node_modules");
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
          return packageUpdateStepResult({ name, argv, cwd: stagePrefix }, { durationMs: 0 });
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
      });
    },
  );

  it("refuses an unsupported layout before validation or mutation", async () => {
    await withTestDir({ prefix: "openclaw-package-unsupported-stage-" }, async (base) => {
      const { globalRoot, packageRoot } = await npmPackage(
        base,
        path.join(base, "unsupported-global-root"),
      );
      const validateCandidate = vi.fn(async () => []);
      const runStep = vi.fn(async ({ name, argv }: { name: string; argv: string[] }) => {
        await writePackageRoot(packageRoot, "2.0.0");
        return packageUpdateStepResult({ name, argv, cwd: globalRoot }, { durationMs: 0 });
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
      await expectText(packageRoot, "package.json").toContain('"version":"1.0.0"');
    });
  });

  it("replaces equal-version package bytes and rolls them back after verification fails", async () => {
    await withTestDir({ prefix: "openclaw-package-equal-version-replacement-" }, async (base) => {
      const { globalRoot, packageRoot, binDir } = await npmPackage(base);
      const launcher = path.join(binDir, "openclaw");
      await fs.writeFile(path.join(packageRoot, "dist", "index.js"), "old runtime\n");
      await fs.mkdir(path.dirname(launcher), { recursive: true });
      await fs.writeFile(launcher, "old launcher\n");

      const result = await runGlobalPackageUpdateSteps({
        ...createNpmUpdateOptions(globalRoot, "openclaw@1.0.0"),
        packageRoot,
        requirePackageReplacement: true,
        runStep: async ({ name, argv }) => {
          const { prefix: stagePrefix, root: stageRoot } = await stagePackage(argv, "1.0.0");
          await fs.writeFile(path.join(stageRoot, "dist", "index.js"), "new runtime\n");
          await writePackageDistInventory(stageRoot);
          const layout = resolveNpmGlobalPrefixLayoutFromPrefix(stagePrefix);
          await fs.mkdir(layout.binDir, { recursive: true });
          await fs.writeFile(path.join(layout.binDir, "openclaw"), "new launcher\n");
          return packageUpdateStepResult({ name, argv, cwd: stagePrefix }, { durationMs: 0 });
        },
        validateCandidate: async (candidateRoot) => {
          await expectText(candidateRoot, "dist", "index.js").toBe("new runtime\n");
          await expectText(packageRoot, "dist", "index.js").toBe("old runtime\n");
          return [];
        },
        beforeActivate: async () => {},
        postVerifyStep: async (candidateRoot) => {
          await expectText(candidateRoot, "dist", "index.js").toBe("new runtime\n");
          return packageUpdateStepResult(
            { name: "doctor", argv: ["doctor", "--fix"], cwd: candidateRoot },
            { durationMs: 0, exitCode: 1 },
          );
        },
      });

      expect(result.reason).toBeUndefined();
      expect(result.failedStep?.name).toBe("doctor");
      expect(result.recovery).toEqual({
        serviceRestartSafe: false,
        reason: "runtime-verification-failed",
        packageRollbackVerified: true,
      });
      await expectText(packageRoot, "dist", "index.js").toBe("old runtime\n");
      await expectText(launcher).toBe("old launcher\n");
    });
  });

  it("recovers the verified original when staging preparation fails before hooks run", async () => {
    await withTestDir({ prefix: "openclaw-package-stage-recovery-" }, async (base) => {
      const { globalRoot, packageRoot } = await npmPackage(
        base,
        path.join(base, "lib", "node_modules"),
      );
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
        expect(await readText(packageRoot, "dist", "index.js")).toBe("export {};\n");
      } finally {
        stage.mockRestore();
      }
    });
  });

  it("rejects npm recovery after a failed install corrupts the original package", async () => {
    await withTestDir({ prefix: "openclaw-package-recovery-" }, async (base) => {
      const { globalRoot, packageRoot } = await npmPackage(
        base,
        path.join(base, "lib", "node_modules"),
      );
      const result = await runGlobalPackageUpdateSteps({
        ...createNpmUpdateOptions(globalRoot),
        packageRoot,
        runStep: async ({ name, argv }: { name: string; argv: string[] }) => {
          await stagePackage(argv);
          await fs.rm(path.join(packageRoot, "dist", "index.js"), { force: true });
          return packageUpdateStepResult(
            { name, argv, cwd: globalRoot },
            { durationMs: 0, exitCode: 1 },
          );
        },
        postVerifyStep: async () => {
          throw new Error("doctor interrupted after replacement");
        },
      });

      expect(result.failedStep).not.toBeNull();
      expect(result.recovery).toEqual({
        serviceRestartSafe: false,
        reason: "runtime-verification-failed",
      });
      expect(await readText(packageRoot, "package.json")).toContain('"version":"1.0.0"');
    });
  });

  it.each(["throwing", "missing"] as const)(
    "commits staged npm only after a %s Doctor outcome",
    async (outcome) => {
      await withTestDir({ prefix: "openclaw-package-recovery-swap-" }, async (base) => {
        const { globalRoot, packageRoot, binDir } = await npmPackage(base);
        const shimNames = ["openclaw", "openclaw.cmd", "openclaw.ps1"];
        const stateCanary = path.join(base, "candidate-doctor-state");
        await writeShims(binDir, shimNames, "old");

        const result = await runGlobalPackageUpdateSteps({
          ...createNpmUpdateOptions(globalRoot),
          packageRoot,
          runStep: async ({ name, argv }) => {
            const { prefix: cwd } = await stagePackage(argv, "2.0.0", shimNames);
            return packageUpdateStepResult({ name, argv, cwd }, { durationMs: 0 });
          },
          postVerifyStep: async (candidateRoot) => {
            expect(candidateRoot).toBe(packageRoot);
            await expectText(candidateRoot, "package.json").toContain('"version":"2.0.0"');
            for (const shimName of shimNames) {
              await expectText(binDir, shimName).toBe(`new ${shimName}\n`);
            }
            await fs.writeFile(stateCanary, "mutated by candidate Doctor\n", "utf8");
            if (outcome === "throwing") {
              throw new Error("doctor interrupted after swap");
            }
            return null;
          },
        });

        expect(result.afterVersion).toBe("1.0.0");
        await expect(readText(stateCanary), JSON.stringify(result.failedStep)).resolves.toBe(
          "mutated by candidate Doctor\n",
        );
        await expectText(packageRoot, "package.json").toContain('"version":"1.0.0"');
        for (const shimName of shimNames) {
          await expectText(binDir, shimName).toBe(`old ${shimName}\n`);
        }
        expect((await fs.readdir(globalRoot)).filter((entry) => entry.startsWith("."))).toEqual([]);
        expect(result.failedStep).not.toBeNull();
        expect(result.recovery).toEqual({
          serviceRestartSafe: false,
          reason: "runtime-verification-failed",
          packageRollbackVerified: true,
        });
        const swapOutput = result.steps.find((step) => step.name === "package-swap")?.stdoutTail;
        expect(swapOutput).toContain("restored previous openclaw package and affected launchers");
        expect(swapOutput).toContain("Update Doctor may have changed persistent state");
      });
    },
  );

  it("retains launcher backup evidence when post-Doctor rollback fails", async () => {
    await withTestDir({ prefix: "openclaw-package-recovery-failed-rollback-" }, async (base) => {
      const { globalRoot, packageRoot, binDir } = await npmPackage(base);
      const targetShim = path.join(binDir, "openclaw");
      const targetCmdShim = path.join(binDir, "openclaw.cmd");
      await writeShims(binDir, ["openclaw", "openclaw.cmd"], "old");
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
            const { prefix: cwd } = await stagePackage(argv, "2.0.0", ["openclaw", "openclaw.cmd"]);
            return packageUpdateStepResult({ name, argv, cwd }, { durationMs: 0 });
          },
          postVerifyStep: async (cwd) =>
            packageUpdateStepResult(
              {
                name: "openclaw doctor",
                argv: ["openclaw", "doctor", "--non-interactive", "--fix"],
                cwd,
              },
              { durationMs: 0, exitCode: 1, stderrTail: "doctor rejected candidate" },
            ),
        });
      } finally {
        copySpy.mockRestore();
      }

      expect(injections).toBe(1);
      expect(result.failedStep).toMatchObject({
        name: "package-swap",
        exitCode: 1,
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
      await expectText(targetShim).toBe("old openclaw\n");
      await expectText(targetCmdShim).toBe("new openclaw.cmd\n");
      const backupDirs = (await fs.readdir(globalRoot)).filter((entry) =>
        entry.startsWith(".openclaw.shim-backup-"),
      );
      expect(backupDirs).toHaveLength(1);
      expect(result.failedStep?.stderrTail).toContain(
        path.join(globalRoot, backupDirs[0] ?? "", "openclaw.cmd"),
      );
      await expectText(globalRoot, backupDirs[0] ?? "", "openclaw.cmd").toBe("old openclaw.cmd\n");
    });
  });
});
