import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { writePackageDistInventory } from "../../../scripts/lib/package-dist-inventory.ts";
import { createPackageActivationLifetimeFixture } from "../../infra/package-update-activation-lifetime.test-support.js";
import { readPackageActivationReceipt } from "../../infra/package-update-activation.js";
import {
  createNpmTarget,
  writePackageRoot,
} from "../../infra/package-update-steps.test-support.js";
import type { PackageUpdateTransaction } from "../../infra/package-update-swap-contract.js";
import { runPackagePostInstallVerification } from "../../infra/package-update-verification-step.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import {
  UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV,
  writeUpdatePostInstallDoctorResult,
  type UpdatePostInstallDoctorResult,
} from "../../infra/update-doctor-result.js";
import { prepareUpdateFailureReport } from "../../infra/update-failure-report-prepare.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import {
  renderUpdateRunReport,
  updateRunReportInputFromResult,
} from "../../infra/update-run-report.js";
import { DEFAULT_UPDATE_STEP_TIMEOUT_MS } from "../../infra/update-run-timeouts.js";
import * as gitRunner from "../../infra/update-runner-git.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import type { UpdateStepResult } from "../../infra/update-step-result.js";
import {
  CommandProcessCleanupError,
  hasCommandProcessCleanupError,
} from "../../process/exec-result.js";
import * as processRunner from "../../process/exec.js";
import { defaultRuntime } from "../../runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createSuiteTempRootTracker } from "../../test-helpers/temp-dir.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { createCommandResult } from "../../test-utils/npm-spec-install-test-helpers.js";
import { quoteCliArg } from "../quote-cli-arg.js";
import * as shared from "./shared.js";
import { reportPreMutationUpdateResult } from "./update-command-admission-report.js";
import * as doctorChild from "./update-command-doctor-child.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import { resultFixture } from "./update-command-fixtures.test-support.js";
import { updateGitInstall } from "./update-command-git.js";
import { createPackageUpdateActivationOptions } from "./update-command-package-activation.js";
import * as packageUpdate from "./update-command-package.js";
import { runPackageInstallUpdate, stagePackageInstallUpdate } from "./update-command-package.js";
import { UpdateCommandFailure, UnreportedUpdateAdmissionOutcome } from "./update-command-result.js";
import { resolvePackageRuntimePreflight } from "./update-command-runtime-preflight.js";
import { resolveUpdateResultNextAction } from "./update-recovery-guidance.js";

let base: string;
const dirs = createSuiteTempRootTracker({ prefix: "update-package-" });
const transactions: PackageUpdateTransaction[] = [];
beforeEach(async () => {
  base = await dirs.setup();
});
afterEach(async () => {
  try {
    await restoreTransactions();
  } finally {
    vi.restoreAllMocks();
    await dirs.cleanup();
  }
});

const activationHooks = {
  validateCandidate: async () => [],
  beforeActivate: async () => {},
};
function activationGate(validate: (root: string) => Promise<UpdateStepResult[]>) {
  const stopped = new Error("pause at owned pre-activation boundary");
  const gate = {
    stopped,
    validateCandidate: vi.fn(validate),
    beforeActivate: vi.fn(async () => {
      throw stopped;
    }),
    onTransaction: vi.fn(),
  };
  return {
    ...gate,
    expectCalls(validation: number, activation: number) {
      expect(gate.validateCandidate).toHaveBeenCalledTimes(validation);
      expect(gate.beforeActivate).toHaveBeenCalledTimes(activation);
      expect(gate.onTransaction).not.toHaveBeenCalled();
    },
  };
}
const readManifest = async (root: string) =>
  JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
const stepsNamed = (result: UpdateRunResult, name: string) =>
  result.steps.filter((step) => step.name === name);
const packageEnv = (directory: string) => ({
  OPENCLAW_STATE_DIR: path.join(directory, "state"),
  OPENCLAW_CONFIG_PATH: path.join(directory, "openclaw.json"),
});
async function doctorEnvironment() {
  vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(base);
  const env = packageEnv(base);
  await fs.writeFile(env.OPENCLAW_CONFIG_PATH, "{}\n");
  return { installEnv: env, managedServiceEnv: env };
}
const outcome = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );
async function restorePackage(
  transaction: PackageUpdateTransaction | undefined,
  assertCurrent = () => {},
) {
  if (!transaction) {
    return;
  }
  expect((await transaction.rollback(assertCurrent)).exitCode).toBe(0);
  await expect(
    transaction.complete({ activationVerified: false }, assertCurrent),
  ).resolves.toBeUndefined();
}
async function restoreTransactions() {
  for (const transaction of transactions.splice(0)) {
    await restorePackage(transaction);
  }
}
function mockDoctor(doctor: typeof processRunner.runCommandWithTimeout) {
  const run = vi.mocked(processRunner.runCommandWithTimeout);
  const install = run.getMockImplementation();
  assert(install);
  return run.mockImplementation((argv, options) =>
    argv[2] === "doctor" ? doctor(argv, options) : install(argv, options),
  );
}

async function packageFixture(
  directory: string,
  candidateVersion = "1.0.0",
  { buildId, installedVersion = "1.0.0" }: { buildId?: string; installedVersion?: string } = {},
) {
  const globalRoot = path.join(directory, "prefix", "lib", "node_modules");
  const target = createNpmTarget(globalRoot);
  const root = path.join(globalRoot, "openclaw");
  const writeInstall = async (packageRoot: string, version: string) => {
    await writePackageRoot(packageRoot, version);
    if (buildId) {
      await fs.writeFile(
        path.join(packageRoot, "dist/build-info.json"),
        JSON.stringify({ buildId }),
      );
      await writePackageDistInventory(packageRoot);
    }
  };
  await writeInstall(root, installedVersion);
  const launcher = path.join(directory, "prefix", "bin", "openclaw");
  await fs.mkdir(path.dirname(launcher), { recursive: true });
  await fs.writeFile(launcher, "previous launcher\n");
  const installedPrefixes: string[] = [];
  vi.spyOn(processRunner, "runCommandWithTimeout").mockImplementation(async (argv) => {
    if (argv.join(" ") === "npm --version") {
      return createCommandResult({ stdout: "12.0.0\n" });
    }
    if (argv.join(" ") === "npm root -g") {
      return createCommandResult({ stdout: `${globalRoot}\n` });
    }
    assert(argv.includes("--prefix") && (argv.includes("install") || argv.includes("i")));
    const prefix = argv[argv.indexOf("--prefix") + 1];
    assert(prefix, "Missing actual staged prefix");
    installedPrefixes.push(prefix);
    await writeInstall(path.join(prefix, "lib", "node_modules", "openclaw"), candidateVersion);
    await fs.mkdir(path.join(prefix, "bin"), { recursive: true });
    await fs.writeFile(path.join(prefix, "bin", "openclaw"), "candidate launcher\n");
    return createCommandResult();
  });
  const expectOriginal = async () => {
    expect(await fs.readFile(launcher, "utf8")).toBe("previous launcher\n");
    expect((await readManifest(root)).version).toBe(installedVersion);
  };
  const params = {
    root,
    installKind: "package" as const,
    tag: candidateVersion,
    timeoutMs: 1000,
    startedAt: Date.now(),
    progress: {},
    installEnv: {},
    installTarget: target,
    ...activationHooks,
    onTransaction: (transaction: PackageUpdateTransaction) => {
      transactions.push(transaction);
    },
  };
  return { params, root, launcher, installedPrefixes, expectOriginal };
}

it.each(["guidance", "staging"])(
  "carries the owner's permission retry outcome through %s",
  async (consumer) => {
    const { root, params: defaults, expectOriginal } = await packageFixture(base);
    const globalRoot = path.dirname(root);
    let attempts = 0;
    vi.mocked(processRunner.runCommandWithTimeout).mockImplementation(async (argv) => {
      expect(argv.slice(0, 3)).toEqual(["npm", "i", "-g"]);
      attempts++;
      expect(argv.includes("--omit=optional")).toBe(attempts === 2);
      return createCommandResult({
        stderr:
          attempts === 1
            ? "npm error code ERESOLVE\nInitial dependency resolution failed"
            : `npm error code EACCES\nnpm error syscall rename\nnpm error path ${root}\nnpm error EACCES: permission denied, rename '${root}'`,
        code: attempts === 1 ? 1 : 243,
      });
    });
    const env = packageEnv(base);
    const params = {
      ...defaults,
      tag: "2.0.0",
      workTimeoutMs: null,
      installEnv: env,
      managedServiceEnv: env,
    };
    const permissionFacts = [
      {
        check: "package-install",
        code: "global-install-permission-denied",
        message: "Package update cannot write [redacted-path]",
      },
      ...[
        "npm error code EACCES",
        "npm error syscall rename",
        "npm error path [redacted-path]",
        "npm error EACCES: permission denied, rename [redacted-path]",
      ].map((message, index) =>
        Object.assign(
          { check: "npm", code: "EACCES", message },
          index === 0 ? { npmErrorCode: "EACCES" as const } : {},
        ),
      ),
    ];
    if (consumer === "staging") {
      const error = await outcome(stagePackageInstallUpdate(params));
      assert(error instanceof shared.UpdatePreMutationError);
      expect(error).toMatchObject({
        reason: "global-install-permission-denied",
        message: expect.stringContaining(globalRoot),
        failureFacts: permissionFacts,
      });
      const run = { runId: createUpdateRun({ trigger: "cli" }, { env }).runId, env };
      vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
      vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
      const report = {
        root,
        mode: "npm" as const,
        installKind: "package" as const,
        opts: { json: true, run },
        controlPlaneUpdateSentinelMeta: null,
        reason: error.reason,
        message: error.message,
        failureFacts: error.failureFacts,
        stepResult: error.stepResult,
      };
      try {
        const terminal = await reportPreMutationUpdateResult(report).catch(
          (cause: unknown) => cause,
        );
        assert(terminal instanceof UpdateCommandFailure);
        const recorded = getUpdateRun(run.runId, { env });
        expect(recorded?.steps, "Both npm attempts must survive staging failure").toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              step: "global update",
              status: "failed",
              exitCode: 1,
              failureFacts: expect.arrayContaining([expect.objectContaining({ code: "ERESOLVE" })]),
            }),
            expect.objectContaining({
              step: "global update (omit optional)",
              status: "failed",
              exitCode: 243,
              failureFacts: permissionFacts,
            }),
          ]),
        );
        const preview = await prepareUpdateFailureReport(
          { attemptId: run.runId, result: terminal.result, recordedRun: recorded },
          { env },
        );
        expect(preview.body).toContain("package-install");
        expect(preview.body).toContain("package-install-omit-optional");
        expect(preview.body).toContain("ERESOLVE");
        expect(preview.body).toContain("EACCES");
        expect(preview.body).not.toContain(root);
        for (const failure of [error, new UnreportedUpdateAdmissionOutcome(report)]) {
          const serialized = JSON.stringify(failure);
          expect(serialized).not.toContain("stdoutTail");
          expect(serialized).not.toContain("stderrTail");
          expect(serialized).not.toContain("stepResult");
        }
      } finally {
        closeOpenClawStateDatabaseForTest();
      }
    } else {
      const result = await runPackageInstallUpdate({
        ...params,
        validateCandidate: vi.fn(),
        beforeActivate: vi.fn(),
        onTransaction: vi.fn(),
      });
      const nextAction = resolveUpdateResultNextAction({ result, env });
      expect(nextAction).toContain(globalRoot);
      expect(nextAction).toContain("rerun `openclaw update`");
      expect(nextAction).not.toContain("Initial dependency resolution failed");
      expect(result).toMatchObject({
        reason: "global-install-permission-denied",
        failedStep: { name: "package-install-omit-optional", failureFacts: permissionFacts },
        recovery: { serviceRestartSafe: true, version: "1.0.0" },
      });
    }
    expect(attempts).toBe(2);
    for (const [argv, options] of vi.mocked(processRunner.runCommandWithTimeout).mock.calls) {
      expect(options, argv.join(" ")).toMatchObject({ timeoutMs: undefined });
    }
    expect(await fs.readdir(globalRoot)).toEqual(["openclaw"]);
    await expectOriginal();
  },
);

it.each([
  ["https://example.invalid/candidate.tgz", "package"],
  ["openclaw@file:../candidate", "package"],
  ["https://example.invalid/candidate.tgz", "git"],
] as const)(
  "honors artifact %s from %s without skipping method-switch validation",
  async (tag, installKind) => {
    // Swap bounds tests own deadline progression; artifact selection keeps real filesystem work.
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    const { params, root, launcher, expectOriginal } = await packageFixture(base, "1.0.0", {
      buildId: installKind === "git" ? "same-build" : undefined,
    });
    const gate = activationGate(async (candidate) => {
      expect(candidate).not.toBe(root);
      expect(await fs.readFile(launcher, "utf8")).toBe("previous launcher\n");
      return installKind === "git"
        ? [{ name: "canary", command: "canary", cwd: base, durationMs: 0, exitCode: 1 }]
        : [];
    });
    const update = runPackageInstallUpdate({
      ...params,
      installKind,
      tag: tag.startsWith("openclaw@") ? "latest" : tag,
      installEnv: tag.startsWith("openclaw@") ? { OPENCLAW_UPDATE_PACKAGE_SPEC: tag } : {},
      invocationCwd: base,
      ...gate,
    });
    if (installKind === "git") {
      const result = await update;
      expect(result).toMatchObject({ status: "error", reason: "unexpected-error" });
      expect(result.steps).toContainEqual(expect.objectContaining({ name: "canary", exitCode: 1 }));
      gate.expectCalls(1, 0);
    } else {
      await expect(update).rejects.toBe(gate.stopped);
      gate.expectCalls(1, 1);
    }
    if (tag === "openclaw@file:../candidate") {
      const install = vi
        .mocked(processRunner.runCommandWithTimeout)
        .mock.calls.find(([argv]) => argv.includes(tag));
      expect(install?.[1]).toMatchObject({ cwd: base });
    }
    await expectOriginal();
  },
);

it.skipIf(process.platform === "win32" || process.platform === "freebsd").each([
  { admission: "candidate", pauseBeforeVerification: true, runtime: "PATH" },
  { admission: "fresh profile", pauseBeforeVerification: false, runtime: "absolute" },
])(
  "journals the resumed $admission package publication and retires its verified rollback",
  async ({ pauseBeforeVerification, runtime }) => {
    const fixtures = createPackageActivationLifetimeFixture();
    const { root: activationBase } = fixtures.setup();
    try {
      const {
        params: defaults,
        root,
        launcher,
        expectOriginal,
      } = await packageFixture(activationBase, "2.0.0");
      const runtimeDir = path.join(activationBase, "runtime");
      const runtimePath = path.join(runtimeDir, process.versions.bun ? "bun" : "node");
      await fs.mkdir(runtimeDir);
      await fs.writeFile(runtimePath, `#!/bin/sh\nexec ${quoteCliArg(process.execPath)} "$@"\n`, {
        mode: 0o755,
      });
      const env = packageEnv(activationBase);
      mockDoctor(async () => createCommandResult());
      vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
      const params = {
        ...defaults,
        installEnv: env,
        managedServiceEnv: env,
      };
      const staged = await stagePackageInstallUpdate({ ...params, pauseBeforeVerification });
      try {
        await fixtures.writePostCoreCapability(staged.root);
        await writePackageDistInventory(staged.root);
        await expectOriginal();
        expect(readPackageActivationReceipt(root)).toBeUndefined();
        const runId = randomUUID();
        await withUpdateCommandExecutor(runId, async (executor) => {
          const fence = await executor.enter(root);
          let transaction: PackageUpdateTransaction | undefined;
          try {
            const result = await withEnvAsync(
              { PATH: `${runtimeDir}${path.delimiter}${process.env.PATH ?? ""}` },
              async () => {
                const preflight = await resolvePackageRuntimePreflight({
                  target: { version: "2.0.0", nodeEngine: null },
                  nodeRunner: runtime === "PATH" ? path.basename(runtimePath) : process.execPath,
                });
                assert(preflight.ok);
                assert(preflight.value.activationRuntime);
                return staged.run({
                  ...params,
                  ...createPackageUpdateActivationOptions({
                    run: { runId, env, executorFence: fence },
                    runtime: preflight.value.activationRuntime,
                    assertCurrent: fence.assertCurrent,
                  }),
                  assertCurrent: fence.assertCurrent,
                  onTransaction: (retained) => {
                    transaction = retained;
                  },
                });
              },
            );
            expect(result, JSON.stringify(result)).toMatchObject({
              status: "ok",
              after: { version: "2.0.0" },
            });
            expect(readPackageActivationReceipt(root)).toMatchObject({
              phase: "publication-complete",
              installKey: root,
              recoveryCommand: expect.stringContaining(
                runtime === "PATH" ? runtimePath : await fs.realpath(process.execPath),
              ),
            });
            expect(await readManifest(root)).toMatchObject({ version: "2.0.0" });
            expect(await fs.readFile(launcher, "utf8")).toBe("candidate launcher\n");
            assert(transaction);
          } finally {
            await restorePackage(transaction, fence.assertCurrent);
          }
          await expectOriginal();
          expect(readPackageActivationReceipt(root)).toMatchObject({ phase: "complete" });
        });
      } finally {
        await staged.close();
      }
    } finally {
      await fixtures.lifetime.cleanup();
    }
  },
);

it.each(["run", "close", "admitted"] as const)(
  "retains the matching staged artifact without replacing the active installation before %s",
  async (action) => {
    const {
      params: defaults,
      root,
      installedPrefixes,
      expectOriginal,
    } = await packageFixture(base, "1.0.0", { buildId: "same-build" });
    const params = {
      ...defaults,
      tag: "https://example.invalid/candidate.tgz",
    };
    const staged = await stagePackageInstallUpdate({
      ...params,
      pauseBeforeVerification: action === "admitted",
    });
    try {
      expect(installedPrefixes).toHaveLength(1);
      expect(staged.root).not.toBe(root);
      expect((await readManifest(staged.root)).version).toBe("1.0.0");
      await expectOriginal();
      if (action !== "close") {
        const runtimeIdentity = await fs.stat(path.join(staged.root, "dist", "index.js"));
        const gate = activationGate(async (candidate) => {
          expect(candidate).toBe(staged.root);
          expect(await fs.stat(path.join(candidate, "dist", "index.js"))).toMatchObject({
            ino: runtimeIdentity.ino,
            dev: runtimeIdentity.dev,
          });
          await expectOriginal();
          return [];
        });
        const running = staged.run({ ...params, ...gate });
        if (action === "admitted") {
          expect(await running).toMatchObject({
            status: "skipped",
            reason: "already-current",
            after: { version: "1.0.0" },
          });
          gate.expectCalls(0, 0);
        } else {
          await expect(running).rejects.toBe(gate.stopped);
          gate.expectCalls(1, 1);
        }
      } else {
        await expect(staged.close()).resolves.toBeUndefined();
      }
      expect(installedPrefixes).toHaveLength(1);
      await expectOriginal();
      for (const prefix of installedPrefixes) {
        await expect(fs.stat(prefix)).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally {
      await staged.close();
    }
  },
);

it.each([false, true])(
  "joins a concurrent stage close while preserving cleanup uncertainty=%s",
  async (uncertain) => {
    const { params, installedPrefixes, expectOriginal } = await packageFixture(base, "2.0.0");
    const staged = await stagePackageInstallUpdate(params);
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const refused = uncertain
      ? new CommandProcessCleanupError()
      : new Error("fixture publication refused");
    const running = staged.run({
      ...params,
      beforeActivate: async () => {
        entered.resolve();
        await release.promise;
        throw refused;
      },
      onTransaction: vi.fn(),
    });
    const runOutcome = outcome(running);
    await Promise.race([
      entered.promise,
      runOutcome.then((cause) => {
        throw new Error("Staged update completed before activation", { cause });
      }),
    ]);
    let closeSettled = false;
    const closing = staged.close().finally(() => {
      closeSettled = true;
    });
    const closeOutcome = outcome(closing);
    await Promise.resolve();
    const waitedForOperation = !closeSettled;
    release.resolve();
    const [failure, cleanupFailure] = await Promise.all([runOutcome, closeOutcome]);
    expect(waitedForOperation).toBe(true);
    if (uncertain) {
      expect(hasCommandProcessCleanupError(failure)).toBe(true);
      expect(cleanupFailure).toBe(failure);
      await expect(staged.close()).rejects.toBe(failure);
    } else {
      expect(failure).toBe(refused);
      expect(cleanupFailure).toBeUndefined();
    }
    await expectOriginal();
    for (const prefix of installedPrefixes) {
      if (uncertain) {
        expect((await fs.stat(prefix)).isDirectory()).toBe(true);
      } else {
        await expect(fs.stat(prefix)).rejects.toMatchObject({ code: "ENOENT" });
      }
    }
  },
);

it.each([
  { label: "explicit", workTimeoutMs: 2000, expectedTimeout: 2000 },
  { label: "unbounded", workTimeoutMs: null, expectedTimeout: undefined },
  { label: "legacy", workTimeoutMs: undefined, expectedTimeout: 1000 },
])(
  "runs staged install and Doctor with a $label work budget",
  async ({ workTimeoutMs, expectedTimeout }) => {
    const { root, params } = await packageFixture(base, "2026.5.14", {
      installedVersion: "2026.4.21",
    });
    const entryPath = path.join(root, "dist", "index.js");
    const commands = mockDoctor(async (argv, options) => {
      expect(argv.slice(1)).toEqual([entryPath, "doctor", "--non-interactive", "--fix"]);
      expect(options).toMatchObject({
        cwd: root,
        env: {
          OPENCLAW_SERVICE_REPAIR_POLICY: "external",
          OPENCLAW_COMPATIBILITY_HOST_VERSION: "2026.5.14",
        },
      });
      expect(await readManifest(root)).toMatchObject({ version: "2026.5.14" });
      return createCommandResult();
    });
    const result = await runPackageInstallUpdate({
      ...params,
      installSpec: "openclaw@2026.5.14",
      managedServiceEnv: packageEnv(base),
      workTimeoutMs,
    });
    expect(result).toMatchObject({ status: "ok", root, after: { version: "2026.5.14" } });
    expect(commands.mock.calls.filter(([argv]) => argv[2] === "doctor")).toHaveLength(1);
    for (const [argv, options] of commands.mock.calls) {
      if (argv[2] === "doctor" && expectedTimeout !== undefined) {
        assert(typeof options !== "number");
        // Preparation spends the same allowance before the Doctor command is admitted.
        expect(options.timeoutMs).toBeGreaterThan(0);
        expect(options.timeoutMs).toBeLessThanOrEqual(expectedTimeout);
      } else {
        expect(options, argv.join(" ")).toMatchObject({ timeoutMs: expectedTimeout });
      }
    }
  },
);

it.each(["settlement", "database writes", "reporting failure"] as const)(
  "retains Doctor %s warnings through the package activation result",
  async (receiptKind) => {
    const { params, root, expectOriginal } = await packageFixture(base, "2.0.0");
    const doctorEnv = await doctorEnvironment();
    const migration = receiptKind !== "settlement";
    const warning = migration
      ? "Automatic database restoration unavailable: databases changed after snapshot capture; the writer is unknown."
      : "Doctor timed out, but every tracked process group stopped. Run `openclaw update repair`.";
    const settlement: UpdateStepResult = {
      name: "doctor process settlement",
      command: "settle doctor process groups",
      cwd: root,
      durationMs: 1,
      exitCode: 0,
      advisory: { kind: "recoverable-maintenance", message: warning },
    };
    // Native settlement has process-boundary coverage; this test owns the package
    // verifier's auxiliary-step transport and its public warning consumer.
    vi.spyOn(doctorChild, "withUpdateDoctorChild").mockImplementation(
      async ({ context }, operation) => {
        const value = await operation(async (_argv, options) => {
          if (migration) {
            assert(typeof options === "object");
            const resultPath = options.env?.[UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV];
            assert(resultPath);
            await writeUpdatePostInstallDoctorResult({
              resultPath,
              result: {
                status: "ok",
                warnings: ["Unrelated Doctor warning"],
                databaseWrites: {
                  unchanged: false,
                  fromGenerations: { "database.sqlite": "foreign-write" },
                  generations: { "database.sqlite": "after" },
                },
              },
            });
            return createCommandResult();
          }
          return createCommandResult({
            stdout: "Doctor busy",
            stderr: "",
            code: null,
            signal: "SIGKILL",
            killed: true,
            cleanup: "forced",
            termination: "timeout",
          });
        });
        if (!migration) {
          context.onProcessSettlement?.(settlement);
        }
        return value;
      },
    );
    const result = await runPackageInstallUpdate({
      ...params,
      ...doctorEnv,
      progress: {
        onStepComplete: (step) => {
          if (receiptKind === "reporting failure" && step.name === "database migration writes") {
            throw new Error("Doctor progress could not be recorded.");
          }
        },
      },
      getDoctorContext: () => ({
        runId: "doctor-settlement-transport",
        executorFence: { assertCurrent: () => {} },
        inputHash: "fixture-input",
        changes: [],
        ...(migration
          ? {
              databaseBackup: {
                directory: path.join(base, "backup"),
                databases: [],
                missingPaths: [],
                sourcePaths: ["database.sqlite"],
                sourceGenerations: { "database.sqlite": "before" },
                warnings: [],
              },
            }
          : {}),
        assertCurrent: () => {},
        assertBoundChildCurrent: () => {},
      }),
    });
    if (migration) {
      expect(result.status).toBe(receiptKind === "reporting failure" ? "error" : "ok");
      if (receiptKind === "reporting failure") {
        expect(result.failedStep).toMatchObject({
          name: "openclaw doctor",
          failureFacts: expect.arrayContaining([
            expect.objectContaining({
              check: "openclaw doctor",
              message: expect.stringContaining("Doctor progress could not be recorded."),
            }),
          ]),
        });
      }
      expect(stepsNamed(result, "database migration writes")).toEqual([
        expect.objectContaining({
          warnings: expect.arrayContaining([expect.stringContaining(warning)]),
        }),
      ]);
    } else {
      expect(result).toMatchObject({
        status: "error",
        root,
        failedStep: { termination: "timeout" },
      });
      expect(stepsNamed(result, "doctor process settlement")).toEqual([settlement]);
    }
    expect(renderUpdateRunReport(updateRunReportInputFromResult(result)).markdown).toContain(
      warning,
    );
    await restoreTransactions();
    await expectOriginal();
  },
);

it.each([
  { method: "package", reason: "requester-revoked" },
  { method: "package-to-git", reason: "include-ownership" },
] as const)(
  "retains the $reason Doctor receipt when $method verification throws after settlement",
  async ({ method, reason }) => {
    const expectedDoctorTimeoutMs = method === "package-to-git" ? undefined : 1000;
    const { params: defaults, root, expectOriginal } = await packageFixture(base, "2.0.0");
    const doctorEnv = await doctorEnvironment();
    const env = doctorEnv.installEnv;
    const receiptDetails = {
      configChanges: [{ kind: "migration", message: "Moved model allowlist." }],
      configWriteRefusal: { reason, message: "Config writer refused.", keys: ["agents"] },
      failureFacts: [{ check: "config", code: reason, affectedKey: "agents" }],
      warnings: ["Review the migrated model allowlist."],
    } satisfies Omit<UpdatePostInstallDoctorResult, "status">;
    const receipt: UpdatePostInstallDoctorResult = { status: "error", ...receiptDetails };
    let resultPath: string | undefined;
    mockDoctor(async (_argv, options) => {
      assert(typeof options === "object");
      if (expectedDoctorTimeoutMs === undefined) {
        expect(options.timeoutMs).toBeUndefined();
      } else {
        expect(options.timeoutMs).toBeGreaterThan(0);
        expect(options.timeoutMs).toBeLessThanOrEqual(expectedDoctorTimeoutMs);
      }
      resultPath = options.env?.[UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV];
      assert(resultPath);
      await writeUpdatePostInstallDoctorResult({ resultPath, result: receipt });
      throw new Error("Doctor transport failed after the child settled.");
    });

    let result: UpdateRunResult;
    if (method === "package") {
      result = await runPackageInstallUpdate({
        ...defaults,
        ...doctorEnv,
      });
    } else {
      const gitRoot = path.join(base, "checkout");
      await writePackageRoot(gitRoot, "2.0.0");
      vi.spyOn(shared, "resolveGitInstallDir").mockReturnValue(gitRoot);
      vi.spyOn(shared, "resolveGlobalManager").mockResolvedValue("npm");
      vi.spyOn(shared, "ensureGitCheckout").mockResolvedValue({
        checkoutDir: gitRoot,
        step: null,
      });
      vi.spyOn(gitRunner, "updateGitCheckout").mockImplementation(async ({ opts }) => {
        assert(opts.prepareGitExposure);
        await opts.prepareGitExposure(gitRoot, "a".repeat(40), env);
        return resultFixture(gitRoot, { mode: "git" });
      });
      vi.spyOn(packageUpdate, "prepareGitPackageExposure").mockImplementation(async (params) => {
        assert(params.postVerifyStep);
        expect(params).toMatchObject({
          timeoutMs: expectedDoctorTimeoutMs ?? DEFAULT_UPDATE_STEP_TIMEOUT_MS,
          workTimeoutMs: expectedDoctorTimeoutMs ?? null,
        });
        const verify = params.postVerifyStep;
        return {
          activate: async () => {
            const failedStep = await runPackagePostInstallVerification(gitRoot, verify);
            return {
              steps: [failedStep],
              failedStep,
              activePackageRoot: root,
              afterVersion: "2.0.0",
              recovery: { serviceRestartSafe: false, reason: "state-migration-started" },
            };
          },
          cancel: async () => ({
            steps: [],
            recovery: { serviceRestartSafe: true, version: "1.0.0" },
          }),
        };
      });
      result = await updateGitInstall({
        root,
        switchToGit: true,
        installKind: "package",
        timeoutMs: expectedDoctorTimeoutMs,
        startedAt: Date.now(),
        progress: {},
        channel: "dev",
        inspectGitTarget: async () => {},
        beforeGitMutation: async () => {},
        validateCandidate: async () => {},
        getManagedServiceEnv: () => env,
        getSnapshotSource: async () => ({ config: {}, env }),
        jsonMode: true,
      });
    }
    expect(result).toMatchObject({
      status: "error",
      reason: reason === "requester-revoked" ? reason : "repair-requires-config-change",
      failedStep: {
        name: "openclaw doctor",
        exitCode: 1,
        ...receiptDetails,
        failureFacts: expect.arrayContaining([
          ...receiptDetails.failureFacts,
          expect.objectContaining({
            check: "openclaw doctor",
            code: "Error",
            message: "Doctor transport failed after the child settled.",
          }),
        ]),
      },
    });
    expect(result.failedStep?.advisory).toBeUndefined();
    expect(
      result.failedStep?.stderrTail?.match(/Doctor transport failed after the child settled\./gu),
    ).toHaveLength(1);
    expect(stepsNamed(result, "openclaw doctor")).toEqual([result.failedStep]);
    assert(resultPath, "Doctor must write its receipt through the production callback");
    await expect(fs.access(resultPath)).rejects.toMatchObject({ code: "ENOENT" });
    await restoreTransactions();
    await expectOriginal();
  },
);
