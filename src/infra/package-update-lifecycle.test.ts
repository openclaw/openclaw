import fs from "node:fs/promises";
import path from "node:path";
import { root as fsSafeRoot, type Root } from "@openclaw/fs-safe/root";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  createNpmUpdateOptions,
  createPnpmTarget,
  stagedNpmPrefix,
  writePackageRoot,
} from "./package-update-steps.test-support.js";
import { resolveNpmGlobalPrefixLayoutFromPrefix } from "./update-npm-prefix.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const lockName = ".openclaw-lifecycle-lock";
const pendingName = PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH;
const pendingBytes = "pending candidate lifecycle\n";
const malformedLockBytes = '{"kind":"openclaw-package-lifecycle",';
type UpdateParams = Parameters<typeof runGlobalPackageUpdateSteps>[0];
type StepParams = Parameters<UpdateParams["runStep"]>[0];
const readText = (root: string, file: string) => fs.readFile(path.join(root, file), "utf8");
const writeText = (root: string, file: string, text: string) =>
  fs.writeFile(path.join(root, file), text);
const writeJson = (root: string, file: string, value: unknown) =>
  writeText(root, file, JSON.stringify(value));
const expectMissing = async (file: string) => {
  await expect(fs.access(file)).rejects.toMatchObject({ code: "ENOENT" });
};

function successfulStep({ name, argv, cwd }: StepParams, packageRoot = fixture.packageRoot) {
  return { name, command: argv.join(" "), cwd: cwd ?? packageRoot, durationMs: 0, exitCode: 0 };
}

function failedStep(step: StepParams, stderrTail: string, packageRoot = fixture.packageRoot) {
  return { ...successfulStep(step, packageRoot), exitCode: 1, stderrTail };
}

async function completeLifecycleStep(step: StepParams) {
  if (step.name === "npm-package-postinstall" && step.cwd) {
    await fs.rm(path.join(step.cwd, pendingName));
  }
  return successfulStep(step);
}

async function readPackageBytes(packageRoot: string): Promise<string[]> {
  return await Promise.all(
    ["package.json", "dist/index.js", PACKAGE_DIST_INVENTORY_RELATIVE_PATH].map((file) =>
      readText(packageRoot, file),
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
  await writeText(siblingRoot, "evidence", "unrelated candidate\n");
  return {
    globalRoot,
    packageRoot,
    originalBytes,
    siblingRoot,
    params: {
      ...createNpmUpdateOptions(globalRoot),
      packageRoot,
      validateCandidate: vi.fn(async () => []),
      beforeActivate: vi.fn(async () => {}),
      onTransaction: vi.fn(),
      postVerifyStep: undefined as UpdateParams["postVerifyStep"],
      workTimeoutMs: undefined as UpdateParams["workTimeoutMs"],
    },
  };
}

type Fixture = Awaited<ReturnType<typeof createFixture>>;
let fixture: Fixture;
beforeEach(async () => {
  fixture = await createFixture();
});
afterEach(() => vi.restoreAllMocks());

async function runUpdate(
  prepareCandidate: (packageRoot: string, prefix: string) => Promise<void> = async () => {},
  runLifecycleStep?: UpdateParams["runStep"],
  admission: Pick<UpdateParams, "beforeVerifyCandidate" | "resolveLifecycleNodeRunner"> = {},
) {
  const stages: { prefix: string; packageRoot: string; bytes: string[] }[] = [];
  const lifecycleCalls: string[] = [];
  const result = await runGlobalPackageUpdateSteps({
    ...fixture.params,
    ...admission,
    runStep: async (step) => {
      if (step.name === "package-install") {
        const prefix = stagedNpmPrefix(step.argv);
        const { globalRoot } = resolveNpmGlobalPrefixLayoutFromPrefix(prefix);
        const packageRoot = path.join(globalRoot, "openclaw");
        await writePackageRoot(packageRoot, "2.0.0");
        await writeText(packageRoot, pendingName, pendingBytes);
        await prepareCandidate(packageRoot, prefix);
        stages.push({ prefix, packageRoot, bytes: await readPackageBytes(packageRoot) });
        return successfulStep(step);
      }
      lifecycleCalls.push(step.name);
      return await (runLifecycleStep ?? completeLifecycleStep)(step);
    },
  });
  expect(stages).toHaveLength(1);
  const stage = stages[0];
  if (!stage) {
    throw new Error("the updater did not create a candidate");
  }
  return { result, stage, lifecycleCalls };
}

function expectNoActivation() {
  const { validateCandidate, beforeActivate, onTransaction } = fixture.params;
  for (const hook of [validateCandidate, beforeActivate, onTransaction]) {
    expect(hook).not.toHaveBeenCalled();
  }
}

async function expectSiblingUntouched() {
  await expect(fs.readdir(fixture.siblingRoot)).resolves.toEqual(["evidence"]);
  await expect(readText(fixture.siblingRoot, "evidence")).resolves.toBe("unrelated candidate\n");
}

async function expectUnchanged(
  result: Awaited<ReturnType<typeof runGlobalPackageUpdateSteps>>,
  runtime = true,
) {
  expect(result.activePackageRoot).toBe(fixture.packageRoot);
  expect(result.recovery).toEqual(
    runtime
      ? { serviceRestartSafe: true, version: "1.0.0" }
      : { serviceRestartSafe: false, reason: "runtime-verification-failed" },
  );
  expectNoActivation();
  if (runtime) {
    expect(await readPackageBytes(fixture.packageRoot)).toEqual(fixture.originalBytes);
  } else {
    await expectMissing(path.join(fixture.packageRoot, "dist/index.js"));
  }
  await expectSiblingUntouched();
}

function createLifecycleOwner() {
  const entered = createDeferred();
  const finish = createDeferred();
  return {
    entered: entered.promise,
    finish: finish.resolve,
    start: (packageRoot: string, postinstall?: () => Promise<void>) =>
      completePendingPackageLifecycle({
        packageRoot,
        runScript: async (script) => {
          if (script.name === "preinstall") {
            entered.resolve();
            await finish.promise;
          } else {
            await postinstall?.();
            await fs.rm(path.join(packageRoot, pendingName));
          }
        },
      }),
  };
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
  it.each([
    ["legacy", undefined, 1000],
    ["unbounded", null, undefined],
    ["explicit", 5000, 5000],
  ] as const)(
    "carries %s admission settings and the selected Node to both lifecycle scripts",
    async (_, workTimeoutMs, expectedTimeout) => {
      fixture.params.workTimeoutMs = workTimeoutMs;
      const scriptTimeouts: Array<number | undefined> = [];
      const selectedNode = path.join(fixture.globalRoot, "selected-node");
      let nodeRunner: string | undefined;
      let admitted = false;
      const { result, lifecycleCalls } = await runUpdate(
        async () => {},
        async (step) => {
          scriptTimeouts.push(step.timeoutMs);
          expect(admitted).toBe(true);
          expect(step.argv[0]).toBe(selectedNode);
          expect(step.env?.PATH?.split(path.delimiter)[0]).toBe(path.dirname(selectedNode));
          return completeLifecycleStep(step);
        },
        {
          beforeVerifyCandidate: async (root) => {
            await expect(readText(root, pendingName)).resolves.toBe(pendingBytes);
            nodeRunner = selectedNode;
            admitted = true;
          },
          resolveLifecycleNodeRunner: () => nodeRunner,
        },
      );
      expect(result).toMatchObject({ failedStep: null, afterVersion: "2.0.0" });
      expect(lifecycleCalls).toEqual(["npm-package-preinstall", "npm-package-postinstall"]);
      expect(scriptTimeouts).toEqual([expectedTimeout, expectedTimeout]);
    },
  );
  it("does not activate after a zero-exit output-limited postinstall", async () => {
    const { result } = await runUpdate(undefined, async (step) => {
      return {
        ...(await completeLifecycleStep(step)),
        outputLimitExceeded: step.name === "npm-package-postinstall",
      };
    });
    expect(result.failedStep).toMatchObject({
      name: "npm-package-postinstall",
      exitCode: 0,
      outputLimitExceeded: true,
    });
    await expectUnchanged(result);
  });

  it.each([
    { shape: "legacy directory", marker: true, runtime: true },
    { shape: "malformed file", marker: true, runtime: true },
    { shape: "malformed file", marker: false, runtime: true },
    { shape: "legacy directory", marker: true, runtime: false },
  ] as const)(
    "retains an uncertain $shape candidate (marker=$marker, previous runtime=$runtime)",
    async ({ shape, marker, runtime }) => {
      fixture.params.workTimeoutMs = null;
      const { result, stage, lifecycleCalls } = await runUpdate(async (packageRoot) => {
        await writeUncertainLock(packageRoot, shape);
        if (!marker) {
          await fs.rm(path.join(packageRoot, pendingName));
        }
        if (!runtime) {
          await fs.rm(path.join(fixture.packageRoot, "dist/index.js"));
        }
      });

      expect(result).toMatchObject({
        afterVersion: null,
        failedStep: { name: "npm-package-lifecycle", exitCode: 1, cwd: stage.packageRoot },
      });
      expect(result.failedStep?.stderrTail).toContain("ownership is uncertain");
      expect(result.failedStep?.stderrTail).toContain(stage.packageRoot);
      expect(result.failedStep?.stderrTail).toContain(path.join(stage.packageRoot, lockName));
      expect(result.steps.map((step) => step.name)).toEqual([
        "package-install",
        "npm-package-lifecycle",
      ]);
      expect(lifecycleCalls).toEqual([]);
      await expectUnchanged(result, runtime);
      expect(await readPackageBytes(stage.packageRoot)).toEqual(stage.bytes);
      if (marker) {
        await expect(readText(stage.packageRoot, pendingName)).resolves.toBe(pendingBytes);
      }
      const lockPath = path.join(stage.packageRoot, lockName);
      expect((await fs.stat(lockPath)).isDirectory()).toBe(shape === "legacy directory");
      if (shape === "malformed file") {
        await expect(fs.readFile(lockPath, "utf8")).resolves.toBe(malformedLockBytes);
      }
      expect((await fs.readdir(fixture.globalRoot)).toSorted()).toEqual(
        ["openclaw", path.basename(stage.prefix), path.basename(fixture.siblingRoot)].toSorted(),
      );
    },
  );

  it.each([
    ["already-current", "active"],
    ["already-current", "completed"],
    ["blocking-version", "active"],
    ["blocking-version", "absent"],
  ] as const)("disposes %s candidates only after a %s owner settles", async (scenario, state) => {
    if (scenario === "already-current") {
      fixture.params.installSpec = "openclaw@1.0.0";
    }
    const lifecycle = createLifecycleOwner();
    let owner: Promise<unknown> | undefined;
    let lockBytes: string | undefined;
    try {
      const { result, stage, lifecycleCalls } = await runUpdate(async (packageRoot) => {
        await writePackageRoot(packageRoot, scenario === "already-current" ? "1.0.0" : "3.0.0");
        if (state === "absent") {
          return;
        }
        owner = lifecycle.start(packageRoot).catch((error: unknown) => error);
        await lifecycle.entered;
        lockBytes = await readText(packageRoot, lockName);
        if (state === "completed") {
          lifecycle.finish();
          expect(await owner).toBeUndefined();
        }
      });
      expect(lifecycleCalls).toEqual([]);
      await expectUnchanged(result);
      if (state === "active") {
        expect(result.reason).toBeUndefined();
        expect(result.failedStep?.stderrTail).toContain("ownership is uncertain");
        expect(await readPackageBytes(stage.packageRoot)).toEqual(stage.bytes);
        expect(await readText(stage.packageRoot, lockName)).toBe(lockBytes);
        await expect(readText(stage.packageRoot, pendingName)).resolves.toBe(pendingBytes);
      } else {
        await expectMissing(stage.prefix);
        if (scenario === "already-current") {
          expect(result.reason).toBe("already-current");
          expect(result.failedStep).toBeNull();
        } else {
          expect(result.failedStep?.name).toBe("package-verify");
        }
      }
    } finally {
      lifecycle.finish();
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
      await writeJson(oldOwner, "package.json", { dependencies: { openclaw: "1.0.0" } });
      await writeText(oldOwner, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
      await fs.symlink("old", path.join(globalRoot, "hash-openclaw"));
      const configArg = (argv: string[], key: string) =>
        argv
          .find((arg) => arg.startsWith(`--config.${key}=`))
          ?.split("=")
          .slice(1)
          .join("=");
      const stageArgs = (argv: string[]) => ({
        project: configArg(argv, "global-dir"),
        bin: configArg(argv, "global-bin-dir"),
      });
      const observed: { stage?: string; oldPending?: string; orphan?: string } = {};
      const runStep = vi.fn<UpdateParams["runStep"]>(async (step) => {
        expect(step.name).toBe("package-install");
        const stage = stageArgs(step.argv).project;
        if (!stage) {
          throw new Error("missing native stage");
        }
        observed.stage = stage;
        observed.oldPending = path.join(stage, "v11/old/node_modules/openclaw", pendingName);
        await fs.writeFile(observed.oldPending, pendingBytes);
        if (state === "orphan-lock") {
          // No hash link or group manifest: activation discovery must not hide this writer.
          observed.orphan = path.join(stage, "v11/orphan/node_modules/openclaw");
          await writePackageRoot(observed.orphan, "2.0.0");
          await writeText(observed.orphan, pendingName, pendingBytes);
          await fs.mkdir(path.join(observed.orphan, lockName));
        }
        return failedStep(step, "ordinary settled install failure", packageRoot);
      });
      const result = await runGlobalPackageUpdateSteps({
        ...fixture.params,
        installTarget: createPnpmTarget(globalRoot, packageRoot),
        packageRoot,
        env: {
          PATH: process.env.PATH,
          PNPM_HOME: path.dirname(project),
          pnpm_config_global_dir: project,
          pnpm_config_global_bin_dir: binDir,
        },
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
      expectNoActivation();
      expect(result.activePackageRoot).toBe(packageRoot);
      expect(result.recovery).toEqual({ serviceRestartSafe: true, version: "1.0.0" });
      expect(await readPackageBytes(packageRoot)).toEqual(originalBytes);
      if (!observed.stage || !observed.oldPending) {
        throw new Error("missing stage observation");
      }
      if (state === "absent") {
        expect(result.failedStep?.name).toBe("package-install");
        await expectMissing(observed.stage);
      } else {
        expect(result.failedStep?.stderrTail).toContain("ownership is uncertain");
        expect(result.failedStep?.stderrTail).toContain(observed.orphan);
        expect(await fs.readFile(observed.oldPending, "utf8")).toBe(pendingBytes);
        expect(await readText(observed.orphan!, pendingName)).toBe(pendingBytes);
        await expect(fs.readdir(path.join(observed.orphan!, lockName))).resolves.toEqual([]);
      }
    },
  );

  it.each(["committed", "pre-commit"] as const)(
    "classifies disposable prefix cleanup refusal after %s verification",
    async (phase) => {
      const disposalRoot = await fsSafeRoot(fixture.globalRoot);
      const prototype = Object.getPrototypeOf(disposalRoot) as Root;
      // oxlint-disable-next-line typescript/unbound-method -- Called below with the intercepted Root receiver to preserve its path and mutation authority.
      const removeEntry = prototype.remove;
      let removalAttempts = 0;
      const { result, stage, lifecycleCalls } = await runUpdate(async (packageRoot, prefix) => {
        if (phase === "pre-commit") {
          await writePackageRoot(packageRoot, "3.0.0");
        }
        const retainedPrefix = await fs.realpath(prefix);
        vi.spyOn(prototype, "remove").mockImplementation(async function (
          this: Root,
          relativePath,
          options,
        ) {
          const target = path.resolve(this.rootReal, relativePath);
          // Refuse disposal before its first leaf removal so pending evidence survives.
          if (
            this.rootReal === disposalRoot.rootReal &&
            (target === retainedPrefix || target.startsWith(`${retainedPrefix}${path.sep}`))
          ) {
            removalAttempts++;
            throw Object.assign(new Error("disposable prefix cleanup denied"), {
              code: "EACCES",
            });
          }
          return removeEntry.call(this, relativePath, options);
        });
      });
      expect(removalAttempts).toBeGreaterThan(0);
      await fs.access(stage.prefix);
      await expectSiblingUntouched();
      if (phase === "pre-commit") {
        expect(lifecycleCalls).toEqual([]);
        expect(result.failedStep?.stderrTail).toContain("Unable to remove discarded package stage");
        expect(result.failedStep?.advisory).toBeUndefined();
        await expectUnchanged(result);
        await fs.access(path.join(stage.packageRoot, pendingName));
      } else {
        expect(fixture.params.beforeActivate).toHaveBeenCalledOnce();
        expect(fixture.params.onTransaction).toHaveBeenCalledOnce();
        expect(await readText(fixture.packageRoot, "package.json")).toContain("2.0.0");
        await expectMissing(stage.packageRoot);
        expect(result).toMatchObject({ afterVersion: "2.0.0", failedStep: null });
        expect(result.recovery).toEqual({ serviceRestartSafe: true, version: "2.0.0" });
        expect(result.steps).toContainEqual(
          expect.objectContaining({
            name: "package-stage-cleanup",
            stderrTail: expect.stringContaining(stage.prefix),
            advisory: expect.objectContaining({ kind: "recoverable-maintenance" }),
          }),
        );
      }
    },
  );

  it("keeps post-commit uncertain stage ownership strict", async () => {
    let candidate: string | undefined;
    fixture.params.postVerifyStep = async () => {
      if (!candidate) {
        throw new Error("candidate was not prepared");
      }
      await fs.mkdir(candidate, { recursive: true });
      await writeUncertainLock(candidate, "malformed file");
      return successfulStep({
        name: "post-activation verification",
        argv: ["verify", "installed", "candidate"],
      });
    };
    const { result, stage } = await runUpdate(async (packageRoot) => {
      candidate = packageRoot;
    });
    expect(fixture.params.onTransaction).toHaveBeenCalledOnce();
    expect(result.afterVersion).toBe("2.0.0");
    expect(result.failedStep?.stderrTail).toContain("ownership is uncertain");
    expect(result.failedStep?.advisory).toBeUndefined();
    expect(result.recovery.serviceRestartSafe).toBe(false);
    await expect(readText(stage.packageRoot, lockName)).resolves.toBe(malformedLockBytes);
    await expectSiblingUntouched();
  });

  it("reverifies the candidate after another lifecycle owner completes", async () => {
    const lifecycle = createLifecycleOwner();
    let owner: Promise<void> | undefined;
    let waitedForOwner = false;
    const isPidAlive = pidAlive.isPidAlive;
    const safetyRelease = setTimeout(() => lifecycle.finish(), 5000);
    try {
      const { result, stage, lifecycleCalls } = await runUpdate(async (packageRoot) => {
        owner = lifecycle.start(packageRoot, async () => {
          await writeJson(packageRoot, "package.json", { name: "openclaw", version: "3.0.0" });
        });
        await lifecycle.entered;
        vi.spyOn(pidAlive, "isPidAlive").mockImplementation((pid) => {
          // Initial candidate verification has finished before admission checks its owner.
          waitedForOwner = true;
          lifecycle.finish();
          return isPidAlive(pid);
        });
      });
      expect(waitedForOwner).toBe(true);
      await owner;
      expect(lifecycleCalls).toEqual([]);
      expect(result.failedStep).toMatchObject({ name: "package-verify", exitCode: 1 });
      expect(result.failedStep?.stderrTail).toContain("3.0.0");
      await expectUnchanged(result);
      await expectMissing(stage.prefix);
    } finally {
      clearTimeout(safetyRelease);
      lifecycle.finish();
      await owner;
    }
  });

  it("retains a replacement generation when the former owner's script fails", async () => {
    const { result, stage, lifecycleCalls } = await runUpdate(undefined, async (step) => {
      const { cwd } = step;
      if (!cwd) {
        throw new Error("expected the staged package root");
      }
      await fs.rename(path.join(cwd, lockName), path.join(cwd, "original-generation"));
      await writeText(cwd, lockName, "replacement generation\n");
      return failedStep(step, "former owner's script failed");
    });
    expect(result.failedStep).toMatchObject({ name: "npm-package-lifecycle", exitCode: 1 });
    expect(result.failedStep?.stderrTail).toContain("package lifecycle ownership is uncertain");
    expect(lifecycleCalls).toEqual(["npm-package-preinstall"]);
    expect(await readText(stage.packageRoot, lockName)).toBe("replacement generation\n");
    expect(await readText(stage.packageRoot, pendingName)).toBe(pendingBytes);
    await expectUnchanged(result);
  });

  it.each(["settled script failure", "ownership error for another root"] as const)(
    "cleans only its stage after a %s",
    async (failure) => {
      const { result, stage, lifecycleCalls } = await runUpdate(undefined, async (step) => {
        if (failure === "ownership error for another root") {
          throw new PackageLifecycleOwnershipError(fixture.siblingRoot, "unrelated owner");
        }
        return failedStep(step, "preinstall exited with a settled failure");
      });

      expect(result).toMatchObject({
        afterVersion: null,
        failedStep: {
          name:
            failure === "settled script failure"
              ? "npm-package-preinstall"
              : "npm-package-lifecycle",
          exitCode: 1,
        },
      });
      expect(lifecycleCalls).toEqual(["npm-package-preinstall"]);
      await expectUnchanged(result);
      await expectMissing(stage.prefix);
      expect((await fs.readdir(fixture.globalRoot)).toSorted()).toEqual(
        ["openclaw", path.basename(fixture.siblingRoot)].toSorted(),
      );
    },
  );
});
