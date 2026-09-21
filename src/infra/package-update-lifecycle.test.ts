import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH } from "../../scripts/lib/package-lifecycle-marker.mjs";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as pidAlive from "../shared/pid-alive.js";
import { PACKAGE_DIST_INVENTORY_RELATIVE_PATH } from "./package-dist-inventory.js";
import {
  completePendingPackageLifecycle,
  PackageLifecycleOwnershipError,
} from "./package-lifecycle.js";
import { runGlobalPackageUpdateSteps } from "./package-update-steps.js";
import {
  createNpmTarget,
  createRootRunner,
  writePackageRoot,
} from "./package-update-steps.test-support.js";
import { resolveNpmGlobalPrefixLayoutFromPrefix } from "./update-npm-prefix.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const lockName = ".openclaw-lifecycle-lock";
const pendingBytes = "pending candidate lifecycle\n";
const malformedLockBytes = '{"kind":"openclaw-package-lifecycle",';
type UpdateParams = Parameters<typeof runGlobalPackageUpdateSteps>[0];
type StepParams = Parameters<UpdateParams["runStep"]>[0];

async function readPackageBytes(packageRoot: string): Promise<string[]> {
  return await Promise.all(
    ["package.json", "dist/index.js", PACKAGE_DIST_INVENTORY_RELATIVE_PATH].map((file) =>
      fs.readFile(path.join(packageRoot, file), "utf8"),
    ),
  );
}

async function createFixture() {
  const base = tempDirs.make("openclaw-package-lifecycle-owner-");
  const { globalRoot } = resolveNpmGlobalPrefixLayoutFromPrefix(path.join(base, "prefix"));
  const packageRoot = path.join(globalRoot, "openclaw");
  await writePackageRoot(packageRoot, "1.0.0");
  const originalBytes = await readPackageBytes(packageRoot);
  const siblingRoot = path.join(globalRoot, ".openclaw.update-stage-sibling");
  await fs.mkdir(siblingRoot);
  await fs.writeFile(path.join(siblingRoot, "evidence"), "unrelated candidate\n");
  const validateCandidate = vi.fn(async () => []);
  const beforeActivate = vi.fn(async () => {});
  const onTransaction = vi.fn();
  return {
    globalRoot,
    packageRoot,
    originalBytes,
    siblingRoot,
    params: {
      installTarget: createNpmTarget(globalRoot),
      installSpec: "openclaw@2.0.0",
      packageName: "openclaw",
      packageRoot,
      runCommand: createRootRunner(globalRoot),
      validateCandidate,
      beforeActivate,
      onTransaction,
      postVerifyStep: undefined as UpdateParams["postVerifyStep"],
      timeoutMs: 1000,
    },
  };
}

type Fixture = Awaited<ReturnType<typeof createFixture>>;

async function runUpdate(
  fixture: Fixture,
  prepareCandidate: (packageRoot: string) => Promise<void>,
  runLifecycleStep?: UpdateParams["runStep"],
) {
  const stages: { prefix: string; packageRoot: string; bytes: string[] }[] = [];
  const lifecycleCalls: string[] = [];
  const success = ({ name, argv, cwd }: StepParams) => ({
    name,
    command: argv.join(" "),
    cwd: cwd ?? fixture.packageRoot,
    durationMs: 0,
    exitCode: 0,
  });
  const result = await runGlobalPackageUpdateSteps({
    ...fixture.params,
    runStep: async (step) => {
      if (step.name === "package-install") {
        const prefixIndex = step.argv.indexOf("--prefix");
        const prefix = step.argv[prefixIndex + 1];
        if (prefixIndex < 0 || !prefix) {
          throw new Error("expected the updater's staged npm prefix");
        }
        const { globalRoot } = resolveNpmGlobalPrefixLayoutFromPrefix(prefix);
        const packageRoot = path.join(globalRoot, "openclaw");
        await writePackageRoot(packageRoot, "2.0.0");
        await fs.writeFile(
          path.join(packageRoot, PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH),
          pendingBytes,
        );
        await prepareCandidate(packageRoot);
        stages.push({ prefix, packageRoot, bytes: await readPackageBytes(packageRoot) });
        return success(step);
      }
      lifecycleCalls.push(step.name);
      if (runLifecycleStep) {
        return await runLifecycleStep(step);
      }
      if (step.name === "npm-package-postinstall" && step.cwd) {
        await fs.rm(path.join(step.cwd, PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH));
      }
      return success(step);
    },
  });
  expect(stages).toHaveLength(1);
  const stage = stages[0];
  if (!stage) {
    throw new Error("the updater did not create a candidate");
  }
  return { result, stage, lifecycleCalls };
}

function expectNoActivation(fixture: Fixture) {
  expect(fixture.params.validateCandidate).not.toHaveBeenCalled();
  expect(fixture.params.beforeActivate).not.toHaveBeenCalled();
  expect(fixture.params.onTransaction).not.toHaveBeenCalled();
}

async function expectSiblingUntouched(fixture: Fixture) {
  await expect(fs.readdir(fixture.siblingRoot)).resolves.toEqual(["evidence"]);
  await expect(fs.readFile(path.join(fixture.siblingRoot, "evidence"), "utf8")).resolves.toBe(
    "unrelated candidate\n",
  );
}

async function writeUncertainLock(
  packageRoot: string,
  shape: "legacy directory" | "malformed file",
) {
  const lockPath = path.join(packageRoot, lockName);
  if (shape === "legacy directory") {
    await fs.mkdir(lockPath);
  } else {
    await fs.writeFile(lockPath, malformedLockBytes);
  }
  const oldTime = new Date(0);
  await fs.utimes(lockPath, oldTime, oldTime);
}

describe("runGlobalPackageUpdateSteps lifecycle ownership", () => {
  it.each(["legacy directory", "malformed file"] as const)(
    "retains the exact pending candidate with an uncertain %s lock",
    async (shape) => {
      const fixture = await createFixture();
      const { result, stage, lifecycleCalls } = await runUpdate(fixture, async (packageRoot) => {
        await writeUncertainLock(packageRoot, shape);
      });

      expect(result).toMatchObject({
        activePackageRoot: fixture.packageRoot,
        afterVersion: null,
        failedStep: { name: "npm-package-lifecycle", exitCode: 1, cwd: stage.packageRoot },
        recovery: { serviceRestartSafe: true, version: "1.0.0" },
      });
      expect(result.failedStep?.stderrTail).toContain("ownership is uncertain");
      expect(result.failedStep?.stderrTail).toContain(stage.packageRoot);
      expect(result.failedStep?.stderrTail).toContain(path.join(stage.packageRoot, lockName));
      expect(result.steps.map((step) => step.name)).toEqual([
        "package-install",
        "npm-package-lifecycle",
      ]);
      expect(lifecycleCalls).toEqual([]);
      expectNoActivation(fixture);
      expect(await readPackageBytes(fixture.packageRoot)).toEqual(fixture.originalBytes);
      expect(await readPackageBytes(stage.packageRoot)).toEqual(stage.bytes);
      await expect(
        fs.readFile(path.join(stage.packageRoot, PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH), "utf8"),
      ).resolves.toBe(pendingBytes);
      const lockPath = path.join(stage.packageRoot, lockName);
      expect((await fs.stat(lockPath)).isDirectory()).toBe(shape === "legacy directory");
      if (shape === "malformed file") {
        await expect(fs.readFile(lockPath, "utf8")).resolves.toBe(malformedLockBytes);
      }
      expect((await fs.readdir(fixture.globalRoot)).toSorted()).toEqual(
        ["openclaw", path.basename(stage.prefix), path.basename(fixture.siblingRoot)].toSorted(),
      );
      await expectSiblingUntouched(fixture);
    },
  );

  it("retains an uncertain candidate even when postinstall already removed its marker", async () => {
    const fixture = await createFixture();
    const { result, stage, lifecycleCalls } = await runUpdate(fixture, async (packageRoot) => {
      await writeUncertainLock(packageRoot, "malformed file");
      await fs.rm(path.join(packageRoot, PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH));
    });
    expect(result).toMatchObject({
      failedStep: { name: "npm-package-lifecycle", exitCode: 1 },
      recovery: { serviceRestartSafe: true, version: "1.0.0" },
    });
    expect(lifecycleCalls).toEqual([]);
    expectNoActivation(fixture);
    expect(await readPackageBytes(stage.packageRoot)).toEqual(stage.bytes);
    expect(await readPackageBytes(fixture.packageRoot)).toEqual(fixture.originalBytes);
    expect(await fs.readFile(path.join(stage.packageRoot, lockName), "utf8")).toBe(
      malformedLockBytes,
    );
    await expectSiblingUntouched(fixture);
  });

  it.each([
    ["already-current", "active"],
    ["already-current", "completed"],
    ["already-current", "absent"],
    ["blocking-version", "active"],
    ["blocking-version", "completed"],
    ["blocking-version", "absent"],
  ] as const)("disposes %s candidates only after a %s owner settles", async (scenario, state) => {
    const fixture = await createFixture();
    if (scenario === "already-current") {
      fixture.params.installSpec = "openclaw@1.0.0";
    }
    const entered = createDeferred();
    const finish = createDeferred();
    let owner: Promise<unknown> | undefined;
    let lockBytes: string | undefined;
    try {
      const { result, stage, lifecycleCalls } = await runUpdate(fixture, async (packageRoot) => {
        await writePackageRoot(packageRoot, scenario === "already-current" ? "1.0.0" : "3.0.0");
        if (state === "absent") {
          return;
        }
        owner = completePendingPackageLifecycle({
          packageRoot,
          runScript: async (script) => {
            if (script.name === "preinstall") {
              entered.resolve();
              await finish.promise;
            } else {
              await fs.rm(path.join(packageRoot, PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH));
            }
          },
        }).catch((error: unknown) => error);
        await entered.promise;
        lockBytes = await fs.readFile(path.join(packageRoot, lockName), "utf8");
        if (state === "completed") {
          finish.resolve();
          expect(await owner).toBe(true);
        }
      });
      expect(lifecycleCalls).toEqual([]);
      expectNoActivation(fixture);
      expect(result.activePackageRoot).toBe(fixture.packageRoot);
      expect(result.recovery).toEqual({ serviceRestartSafe: true, version: "1.0.0" });
      expect(await readPackageBytes(fixture.packageRoot)).toEqual(fixture.originalBytes);
      await expectSiblingUntouched(fixture);
      if (state === "active") {
        expect(result.reason).toBeUndefined();
        expect(result.failedStep?.stderrTail).toContain("ownership is uncertain");
        expect(await readPackageBytes(stage.packageRoot)).toEqual(stage.bytes);
        expect(await fs.readFile(path.join(stage.packageRoot, lockName), "utf8")).toBe(lockBytes);
        await expect(
          fs.readFile(
            path.join(stage.packageRoot, PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH),
            "utf8",
          ),
        ).resolves.toBe(pendingBytes);
      } else {
        await expect(fs.access(stage.prefix)).rejects.toMatchObject({ code: "ENOENT" });
        if (scenario === "already-current") {
          expect(result.reason).toBe("already-current");
          expect(result.failedStep).toBeNull();
        } else {
          expect(result.failedStep?.name).toBe("package-verify");
        }
      }
    } finally {
      finish.resolve();
      await owner;
    }
  });

  it.each(["absent", "orphan-lock"] as const)(
    "cleans a failed isolated pnpm stage only when lifecycle ownership is %s",
    async (state) => {
      const base = tempDirs.make("openclaw-pnpm-disposal-");
      const project = path.join(base, "pnpm/global");
      const globalRoot = path.join(project, "v11");
      const oldOwner = path.join(globalRoot, "old");
      const packageRoot = path.join(oldOwner, "node_modules/openclaw");
      const binDir = path.join(base, "bin");
      await writePackageRoot(packageRoot, "1.0.0");
      const originalBytes = await readPackageBytes(packageRoot);
      await fs.mkdir(binDir);
      await fs.writeFile(
        path.join(oldOwner, "package.json"),
        JSON.stringify({ dependencies: { openclaw: "1.0.0" } }),
      );
      await fs.writeFile(path.join(oldOwner, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      await fs.symlink("old", path.join(globalRoot, "hash-openclaw"));
      const stageArgs = (argv: string[]) => ({
        project: argv
          .find((arg) => arg.startsWith("--config.global-dir="))
          ?.slice("--config.global-dir=".length),
        bin: argv
          .find((arg) => arg.startsWith("--config.global-bin-dir="))
          ?.slice("--config.global-bin-dir=".length),
      });
      const observed: { stage?: string; oldPending?: string; orphan?: string } = {};
      const runStep = vi.fn<UpdateParams["runStep"]>(async (step) => {
        expect(step.name).toBe("package-install");
        const stage = stageArgs(step.argv).project;
        if (!stage) {
          throw new Error("missing native stage");
        }
        observed.stage = stage;
        observed.oldPending = path.join(
          stage,
          "v11/old/node_modules/openclaw",
          PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH,
        );
        await fs.writeFile(observed.oldPending, pendingBytes);
        if (state === "orphan-lock") {
          // No hash link or group manifest: activation discovery must not hide this writer.
          observed.orphan = path.join(stage, "v11/orphan/node_modules/openclaw");
          await writePackageRoot(observed.orphan, "2.0.0");
          await fs.writeFile(
            path.join(observed.orphan, PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH),
            pendingBytes,
          );
          await fs.mkdir(path.join(observed.orphan, lockName));
        }
        return {
          name: step.name,
          command: step.argv.join(" "),
          cwd: step.cwd ?? packageRoot,
          durationMs: 0,
          exitCode: 1,
          stderrTail: "ordinary settled install failure",
        };
      });
      const validateCandidate = vi.fn(async () => []);
      const beforeActivate = vi.fn(async () => {});
      const result = await runGlobalPackageUpdateSteps({
        installTarget: {
          manager: "pnpm",
          command: "pnpm",
          globalRoot,
          packageRoot,
          pnpmIsolated: { layoutVersion: 11 },
        },
        installSpec: "openclaw@2.0.0",
        packageName: "openclaw",
        packageRoot,
        timeoutMs: 1000,
        env: {
          PATH: process.env.PATH,
          PNPM_HOME: path.dirname(project),
          pnpm_config_global_dir: project,
          pnpm_config_global_bin_dir: binDir,
        },
        validateCandidate,
        beforeActivate,
        runStep,
        runCommand: async (argv) => {
          const args = stageArgs(argv);
          return {
            code: 0,
            stderr: "",
            stdout: argv.includes("--version")
              ? "11.0.0\n"
              : argv.includes("root")
                ? `${args.project ? path.join(args.project, "v11") : globalRoot}\n`
                : `${args.bin ?? binDir}\n`,
          };
        },
      });
      expect(runStep).toHaveBeenCalledTimes(1);
      expect(validateCandidate).not.toHaveBeenCalled();
      expect(beforeActivate).not.toHaveBeenCalled();
      expect(result.activePackageRoot).toBe(packageRoot);
      expect(result.recovery).toEqual({ serviceRestartSafe: true, version: "1.0.0" });
      expect(await readPackageBytes(packageRoot)).toEqual(originalBytes);
      if (!observed.stage || !observed.oldPending) {
        throw new Error("missing stage observation");
      }
      if (state === "absent") {
        expect(result.failedStep?.name).toBe("package-install");
        await expect(fs.access(observed.stage)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        expect(result.failedStep?.stderrTail).toContain("ownership is uncertain");
        expect(result.failedStep?.stderrTail).toContain(observed.orphan);
        expect(await fs.readFile(observed.oldPending, "utf8")).toBe(pendingBytes);
        expect(
          await fs.readFile(
            path.join(observed.orphan!, PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH),
            "utf8",
          ),
        ).toBe(pendingBytes);
        await expect(fs.readdir(path.join(observed.orphan!, lockName))).resolves.toEqual([]);
      }
    },
  );

  it.each(["committed", "pre-commit"] as const)(
    "classifies disposable prefix cleanup refusal after %s verification",
    async (phase) => {
      const fixture = await createFixture();
      const rm = fs.rm;
      let retainedPrefix: string | undefined;
      let removalAttempts = 0;
      try {
        const { result, stage, lifecycleCalls } = await runUpdate(fixture, async (packageRoot) => {
          if (phase === "pre-commit") {
            await writePackageRoot(packageRoot, "3.0.0");
          }
          retainedPrefix = path.resolve(packageRoot, "../../..");
          vi.spyOn(fs, "rm").mockImplementation(async (file, options) => {
            if (file === retainedPrefix) {
              removalAttempts++;
              throw Object.assign(new Error("disposable prefix cleanup denied"), {
                code: "EACCES",
              });
            }
            return rm(file, options);
          });
        });
        expect(removalAttempts).toBeGreaterThan(0);
        await expect(fs.access(stage.prefix)).resolves.toBeUndefined();
        await expectSiblingUntouched(fixture);
        if (phase === "pre-commit") {
          expectNoActivation(fixture);
          expect(lifecycleCalls).toEqual([]);
          expect(await readPackageBytes(fixture.packageRoot)).toEqual(fixture.originalBytes);
          expect(result.failedStep?.stderrTail).toContain(
            "Unable to remove discarded package stage",
          );
          expect(result.failedStep?.advisory).toBeUndefined();
          expect(result.recovery).toEqual({ serviceRestartSafe: true, version: "1.0.0" });
          await expect(
            fs.access(path.join(stage.packageRoot, PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH)),
          ).resolves.toBeUndefined();
        } else {
          expect(fixture.params.beforeActivate).toHaveBeenCalledOnce();
          expect(fixture.params.onTransaction).toHaveBeenCalledOnce();
          expect(
            await fs.readFile(path.join(fixture.packageRoot, "package.json"), "utf8"),
          ).toContain("2.0.0");
          await expect(fs.access(stage.packageRoot)).rejects.toMatchObject({ code: "ENOENT" });
          expect(result.afterVersion).toBe("2.0.0");
          expect(result.failedStep).toBeNull();
          expect(result.recovery).toEqual({ serviceRestartSafe: true, version: "2.0.0" });
          expect(result.steps).toContainEqual(
            expect.objectContaining({
              name: "package-stage-cleanup",
              stderrTail: expect.stringContaining(stage.prefix),
              advisory: expect.objectContaining({ kind: "recoverable-maintenance" }),
            }),
          );
        }
      } finally {
        vi.restoreAllMocks();
      }
    },
  );

  it("keeps post-commit uncertain stage ownership strict", async () => {
    const fixture = await createFixture();
    let candidate: string | undefined;
    fixture.params.postVerifyStep = async () => {
      if (!candidate) {
        throw new Error("candidate was not prepared");
      }
      await fs.mkdir(candidate, { recursive: true });
      await writeUncertainLock(candidate, "malformed file");
      return {
        name: "post-activation verification",
        command: "verify installed candidate",
        cwd: fixture.packageRoot,
        durationMs: 0,
        exitCode: 0,
      };
    };
    const { result, stage } = await runUpdate(fixture, async (packageRoot) => {
      candidate = packageRoot;
    });
    expect(fixture.params.onTransaction).toHaveBeenCalledOnce();
    expect(result.afterVersion).toBe("2.0.0");
    expect(result.failedStep?.stderrTail).toContain("ownership is uncertain");
    expect(result.failedStep?.advisory).toBeUndefined();
    expect(result.recovery.serviceRestartSafe).toBe(false);
    await expect(fs.readFile(path.join(stage.packageRoot, lockName), "utf8")).resolves.toBe(
      malformedLockBytes,
    );
    await expectSiblingUntouched(fixture);
  });

  it("reverifies the candidate after another lifecycle owner completes", async () => {
    const fixture = await createFixture();
    const entered = createDeferred();
    const finish = createDeferred();
    let owner: Promise<boolean> | undefined;
    let waitedForOwner = false;
    const isPidAlive = pidAlive.isPidAlive;
    const safetyRelease = setTimeout(() => finish.resolve(), 5000);
    try {
      const { result, stage, lifecycleCalls } = await runUpdate(fixture, async (packageRoot) => {
        owner = completePendingPackageLifecycle({
          packageRoot,
          runScript: async (script) => {
            if (script.name === "preinstall") {
              entered.resolve();
              await finish.promise;
            } else {
              await fs.writeFile(
                path.join(packageRoot, "package.json"),
                JSON.stringify({ name: "openclaw", version: "3.0.0" }),
              );
              await fs.rm(path.join(packageRoot, PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH));
            }
          },
        });
        await entered.promise;
        vi.spyOn(pidAlive, "isPidAlive").mockImplementation((pid) => {
          // Initial candidate verification has finished before admission checks its owner.
          waitedForOwner = true;
          finish.resolve();
          return isPidAlive(pid);
        });
      });
      expect(waitedForOwner).toBe(true);
      expect(await owner).toBe(true);
      expect(lifecycleCalls).toEqual([]);
      expect(result).toMatchObject({
        activePackageRoot: fixture.packageRoot,
        failedStep: { name: "package-verify", exitCode: 1 },
        recovery: { serviceRestartSafe: true, version: "1.0.0" },
      });
      expect(result.failedStep?.stderrTail).toContain("3.0.0");
      expectNoActivation(fixture);
      expect(await readPackageBytes(fixture.packageRoot)).toEqual(fixture.originalBytes);
      await expect(fs.access(stage.prefix)).rejects.toMatchObject({ code: "ENOENT" });
      await expectSiblingUntouched(fixture);
    } finally {
      clearTimeout(safetyRelease);
      vi.restoreAllMocks();
      finish.resolve();
      await owner;
    }
  });

  it("retains a replacement generation when the former owner's script fails", async () => {
    const fixture = await createFixture();
    const { result, stage, lifecycleCalls } = await runUpdate(
      fixture,
      async () => {},
      async ({ name, argv, cwd }) => {
        if (!cwd) {
          throw new Error("expected the staged package root");
        }
        await fs.rename(path.join(cwd, lockName), path.join(cwd, "original-generation"));
        await fs.writeFile(path.join(cwd, lockName), "replacement generation\n");
        return {
          name,
          command: argv.join(" "),
          cwd,
          durationMs: 0,
          exitCode: 1,
          stderrTail: "former owner's script failed",
        };
      },
    );
    expect(result).toMatchObject({
      activePackageRoot: fixture.packageRoot,
      failedStep: { name: "npm-package-lifecycle", exitCode: 1 },
      recovery: { serviceRestartSafe: true, version: "1.0.0" },
    });
    expect(result.failedStep?.stderrTail).toContain("lock generation changed");
    expect(lifecycleCalls).toEqual(["npm-package-preinstall"]);
    expectNoActivation(fixture);
    expect(await fs.readFile(path.join(stage.packageRoot, lockName), "utf8")).toBe(
      "replacement generation\n",
    );
    expect(
      await fs.readFile(
        path.join(stage.packageRoot, PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH),
        "utf8",
      ),
    ).toBe(pendingBytes);
    expect(await readPackageBytes(fixture.packageRoot)).toEqual(fixture.originalBytes);
    await expectSiblingUntouched(fixture);
  });

  it("does not declare the previous runtime restart-safe after its dist entry disappears", async () => {
    const fixture = await createFixture();
    const { result, stage } = await runUpdate(fixture, async (packageRoot) => {
      await writeUncertainLock(packageRoot, "legacy directory");
      await fs.rm(path.join(fixture.packageRoot, "dist", "index.js"));
    });

    expect(result).toMatchObject({
      activePackageRoot: fixture.packageRoot,
      afterVersion: null,
      failedStep: { name: "npm-package-lifecycle", exitCode: 1 },
      recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
    });
    expectNoActivation(fixture);
    await expect(
      fs.access(path.join(fixture.packageRoot, "dist", "index.js")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readPackageBytes(stage.packageRoot)).toEqual(stage.bytes);
    await expect(
      fs.readFile(path.join(stage.packageRoot, PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH), "utf8"),
    ).resolves.toBe(pendingBytes);
    await expectSiblingUntouched(fixture);
  });

  it.each(["settled script failure", "ownership error for another root"] as const)(
    "cleans only its stage after a %s",
    async (failure) => {
      const fixture = await createFixture();
      const { result, stage, lifecycleCalls } = await runUpdate(
        fixture,
        async () => {},
        async ({ name, argv, cwd }) => {
          if (failure === "ownership error for another root") {
            throw new PackageLifecycleOwnershipError(fixture.siblingRoot, "unrelated owner");
          }
          return {
            name,
            command: argv.join(" "),
            cwd: cwd ?? fixture.packageRoot,
            durationMs: 0,
            exitCode: 1,
            stderrTail: "preinstall exited with a settled failure",
          };
        },
      );

      expect(result).toMatchObject({
        activePackageRoot: fixture.packageRoot,
        afterVersion: null,
        failedStep: {
          name:
            failure === "settled script failure"
              ? "npm-package-preinstall"
              : "npm-package-lifecycle",
          exitCode: 1,
        },
        recovery: { serviceRestartSafe: true, version: "1.0.0" },
      });
      expect(lifecycleCalls).toEqual(["npm-package-preinstall"]);
      expectNoActivation(fixture);
      expect(await readPackageBytes(fixture.packageRoot)).toEqual(fixture.originalBytes);
      await expect(fs.access(stage.prefix)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await fs.readdir(fixture.globalRoot)).toSorted()).toEqual(
        ["openclaw", path.basename(fixture.siblingRoot)].toSorted(),
      );
      await expectSiblingUntouched(fixture);
    },
  );
});
