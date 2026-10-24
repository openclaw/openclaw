import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  CommandProcessCleanupError,
  hasCommandProcessCleanupError,
} from "../process/exec-result.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { PACKAGE_DIST_INVENTORY_RELATIVE_PATH } from "./package-dist-inventory.js";
import { runGlobalPackageUpdateSteps } from "./package-update-steps.js";
import {
  createNpmUpdateOptions,
  packageUpdateStepResult,
  stagedNpmPrefix,
  writePackageRoot,
} from "./package-update-steps.test-support.js";
import type { PackageUpdateTransaction } from "./package-update-swap-contract.js";
import { resolveNpmGlobalPrefixLayoutFromPrefix } from "./update-npm-prefix.js";
import type { UpdateStepResult } from "./update-step-result.js";

const readText = (file: string) => fs.readFile(file, "utf8");
const expectText = async (file: string, expected: string) =>
  expect(await readText(file)).toBe(expected);
const expectMissing = async (file: string) =>
  expect(fs.access(file)).rejects.toMatchObject({ code: "ENOENT" });
const hiddenEntries = async (root: string) =>
  (await fs.readdir(root)).filter((entry) => entry.startsWith("."));
async function expectPackageVersion(packageRoot: string, version: string) {
  expect(await readText(path.join(packageRoot, "package.json"))).toContain(
    `"version":"${version}"`,
  );
}
const stepResult = (
  name: string,
  cwd: string,
  command: string,
  exitCode = 0,
): UpdateStepResult => ({
  name,
  cwd,
  command,
  exitCode,
  durationMs: 1,
});

it.each([
  "activation rejected",
  "backup failed",
  "doctor receipt throw",
  "doctor success receipt throw",
  "doctor cleanup uncertain",
  "confirm",
] as const)(
  "keeps the original serving through validation and retains recovery until %s",
  (outcome) =>
    withTestDir({ prefix: "openclaw-package-transaction-" }, async (base) => {
      const prefix = path.join(base, "prefix");
      const globalRoot = path.join(prefix, "lib", "node_modules");
      const packageRoot = path.join(globalRoot, "openclaw");
      const launcher = path.join(prefix, "bin", "openclaw");
      await writePackageRoot(packageRoot, "1.0.0");
      await fs.mkdir(path.dirname(launcher), { recursive: true });
      await fs.writeFile(launcher, "old launcher\n");
      let transaction: PackageUpdateTransaction | undefined;
      let stageRoot: string | undefined;
      let stageLauncher: string | undefined;
      let serving = true;
      const phases: string[] = [];
      const activationError = new Error("service did not stop");
      const doctorFailure = new Error("Doctor failed after receipt");
      const uncertainFailure = new Error("Doctor cleanup remains pending", {
        cause: new CommandProcessCleanupError(),
      });
      const receiptThrow = outcome.endsWith("receipt throw");
      const doctorReceipt = stepResult(
        "openclaw doctor",
        packageRoot,
        "doctor --fix",
        outcome === "doctor success receipt throw" ? 0 : 1,
      );
      doctorReceipt.configChanges = [{ kind: "migration", message: "Moved model allowlist." }];
      if (outcome === "doctor receipt throw") {
        doctorReceipt.stderrTail = "Doctor refused config writes";
        doctorReceipt.configWriteRefusal = {
          reason: "include-ownership",
          message: "Include is not owned",
          keys: ["agents"],
        };
        doctorReceipt.failureFacts = [
          { check: "config", code: "include-ownership", affectedKey: "agents" },
        ];
      } else if (outcome === "doctor success receipt throw") {
        doctorReceipt.advisory = {
          kind: "package-post-install-doctor",
          message: "Deferred repair",
        };
      }
      const update = runGlobalPackageUpdateSteps({
        ...createNpmUpdateOptions(globalRoot, "openclaw@2.0.0"),
        runStep: async ({ name, argv }) => {
          const stagePrefix = stagedNpmPrefix(argv);
          stageRoot = path.join(stagePrefix, "lib", "node_modules", "openclaw");
          await writePackageRoot(stageRoot, "2.0.0");
          await fs.mkdir(path.join(stagePrefix, "bin"), { recursive: true });
          stageLauncher = path.join(stagePrefix, "bin", "openclaw");
          await fs.writeFile(stageLauncher, "new launcher\n");
          return packageUpdateStepResult(
            { name, argv, cwd: stagePrefix },
            { durationMs: 0, exitCode: 0 },
          );
        },
        validateCandidate: async (candidateRoot) => {
          phases.push("validate");
          expect(serving).toBe(true);
          expect(candidateRoot).toBe(stageRoot);
          await expectPackageVersion(packageRoot, "1.0.0");
          await expectText(launcher, "old launcher\n");
          return [
            { ...stepResult("candidate canary", candidateRoot, "canary"), termination: "exit" },
          ];
        },
        beforeActivate: async () => {
          phases.push("stop");
          if (outcome === "activation rejected") {
            throw activationError;
          }
          serving = false;
        },
        onTransaction: (retained) => {
          transaction = retained;
          if (outcome === "backup failed") {
            writeFileSync(retained.backupRoot, "blocked backup destination");
          }
        },
        postVerifyStep: async (candidateRoot, results?: UpdateStepResult[]) => {
          phases.push("migrate");
          expect(serving).toBe(false);
          expect(candidateRoot).toBe(packageRoot);
          if (outcome === "doctor cleanup uncertain") {
            throw uncertainFailure;
          }
          if (receiptThrow) {
            results?.push(doctorReceipt);
            throw doctorFailure;
          }
          return { ...stepResult("doctor", candidateRoot, "doctor --fix"), durationMs: 0 };
        },
      });
      if (outcome === "activation rejected") {
        await expect(update).rejects.toBe(activationError);
        expect(phases).toEqual(["validate", "stop"]);
        expect(transaction).toBeUndefined();
        await expectText(launcher, "old launcher\n");
        await expectPackageVersion(packageRoot, "1.0.0");
        expect(await hiddenEntries(globalRoot)).toEqual([]);
        await expect(fs.stat(stageRoot!)).rejects.toMatchObject({ code: "ENOENT" });
        return;
      }
      if (outcome === "doctor cleanup uncertain") {
        const failure = await update.catch((cause: unknown) => cause);
        expect(failure).toBe(uncertainFailure);
        expect(hasCommandProcessCleanupError(failure)).toBe(true);
        expect(phases).toEqual(["validate", "stop", "migrate"]);
        assert(transaction && stageLauncher);
        await expectPackageVersion(packageRoot, "2.0.0");
        await expectPackageVersion(transaction.backupRoot, "1.0.0");
        const shimBackups = (await fs.readdir(globalRoot)).filter((entry) =>
          entry.startsWith(".openclaw.shim-backup-"),
        );
        expect(shimBackups).toHaveLength(1);
        const [shimBackup] = shimBackups;
        assert(shimBackup);
        const shims = [launcher, stageLauncher, path.join(globalRoot, shimBackup, "openclaw")];
        expect(await Promise.all(shims.map(readText))).toEqual([
          "new launcher\n",
          "new launcher\n",
          "old launcher\n",
        ]);
        return;
      }
      const result = await update;
      if (receiptThrow) {
        const failedDoctor = result.failedStep;
        assert(failedDoctor);
        expect(failedDoctor).toMatchObject({
          name: "openclaw doctor",
          exitCode: doctorReceipt.exitCode,
          configChanges: doctorReceipt.configChanges,
        });
        expect(failedDoctor.configWriteRefusal).toEqual(doctorReceipt.configWriteRefusal);
        expect(failedDoctor.advisory).toBeUndefined();
        expect(failedDoctor.stderrTail).toContain(doctorFailure.message);
        expect(failedDoctor.failureFacts).toEqual(
          expect.arrayContaining([
            ...(doctorReceipt.failureFacts ?? []),
            expect.objectContaining({
              check: "openclaw doctor",
              code: "Error",
              message: doctorFailure.message,
            }),
          ]),
        );
        expect(result.steps.filter((step) => step.name === "openclaw doctor")).toEqual([
          failedDoctor,
        ]);
        expect(result.recovery).toEqual({
          serviceRestartSafe: false,
          reason: "runtime-verification-failed",
        });
      }
      const activationFailed = outcome === "backup failed";
      expect(phases, JSON.stringify(result.failedStep)).toEqual(
        activationFailed ? ["validate", "stop"] : ["validate", "stop", "migrate"],
      );
      expect(result.failedStep?.name ?? null).toBe(
        activationFailed ? "package-swap" : receiptThrow ? "openclaw doctor" : null,
      );
      expect(result.activePackageRoot).toBe(packageRoot);
      expect(result.afterVersion).toBe(outcome === "backup failed" ? "1.0.0" : "2.0.0");
      assert(transaction, "transaction missing");
      if (outcome === "backup failed") {
        await expectPackageVersion(packageRoot, "1.0.0");
      } else {
        await expectPackageVersion(transaction.backupRoot, "1.0.0");
      }
      await expectText(launcher, activationFailed ? "old launcher\n" : "new launcher\n");
      if (outcome !== "confirm") {
        const restored = await transaction.rollback(() => {});
        expect(restored).toMatchObject({ exitCode: 0, activePackageRoot: packageRoot });
        expect(await transaction.rollback(() => {})).toEqual(restored);
        await expectText(launcher, "old launcher\n");
      }
      await transaction.complete({ activationVerified: outcome === "confirm" }, () => {});
      await transaction.complete({ activationVerified: outcome === "confirm" }, () => {});
      await expectPackageVersion(packageRoot, outcome === "confirm" ? "2.0.0" : "1.0.0");
      expect((await transaction.rollback(() => {})).exitCode).toBe(1);
      expect(await hiddenEntries(globalRoot)).toEqual([]);
    }),
);

// Package-owner boundary interleaving with injected package-manager steps;
// this does not reproduce overlapping public CLI invocations or a triage incident.
it("preserves an active recreated omit-optional npm candidate through another owner's cleanup", () =>
  withTestDir({ prefix: "openclaw-package-stage-interleaving-" }, async (base) => {
    const { globalRoot } = resolveNpmGlobalPrefixLayoutFromPrefix(path.join(base, "prefix"));
    const packageRoot = path.join(globalRoot, "openclaw");
    const packageFiles = ["package.json", "dist/index.js", PACKAGE_DIST_INVENTORY_RELATIVE_PATH];
    const readPackageBytes = (root: string) =>
      packageFiles.map((relativePath) => fs.readFile(path.join(root, relativePath), "utf8"));
    await writePackageRoot(packageRoot, "1.0.0");
    const staleStage = path.join(globalRoot, ".openclaw.update-stage-abandoned");
    await fs.mkdir(staleStage);
    await fs.writeFile(path.join(staleStage, "evidence"), "earlier candidate bytes\n");
    const originalBytes = await Promise.all(readPackageBytes(packageRoot));
    const params = {
      ...createNpmUpdateOptions(globalRoot),
      packageRoot,
    };
    const aPrefixes: string[] = [];
    let candidateBytes: string[] = [];
    const protectedBackup = path.join(globalRoot, ".openclaw.package-backup-recovery");

    const result = await runGlobalPackageUpdateSteps({
      ...params,
      runStep: async ({ name, argv, cwd }) => {
        const stagePrefix = stagedNpmPrefix(argv);
        expect((await fs.stat(stagePrefix)).isDirectory()).toBe(true);
        aPrefixes.push(stagePrefix);
        const { globalRoot: stageGlobal } = resolveNpmGlobalPrefixLayoutFromPrefix(stagePrefix);
        const candidateRoot = path.join(stageGlobal, "openclaw");
        await writePackageRoot(candidateRoot, "2.0.0");
        const step = { name, command: argv.join(" "), cwd: cwd ?? base, durationMs: 0 };
        if (aPrefixes.length === 1) {
          return { ...step, exitCode: 1, stderrTail: "injected optional dependency failure" };
        }
        expect(argv).toContain("--omit=optional");
        const firstPrefix = aPrefixes[0]!;
        expect(stagePrefix).not.toBe(firstPrefix);
        await expectMissing(firstPrefix);
        candidateBytes = await Promise.all(readPackageBytes(candidateRoot));

        // Seed after A's initial cleanup so only the nested B can remove these.
        const obsoleteDirs = [
          ".openclaw-a1b2c3d4",
          ".openclaw-package-backup-retired",
          ".openclaw-shim-backup-retired",
        ].map((entry) => path.join(globalRoot, entry));
        for (const directory of [...obsoleteDirs, protectedBackup]) {
          await fs.mkdir(directory);
          await fs.writeFile(path.join(directory, "evidence"), "existing backup bytes\n");
        }

        let bPrefix: string | undefined;
        const stoppedB = await runGlobalPackageUpdateSteps({
          ...params,
          runStep: async ({ argv: bArgv }) => {
            bPrefix = stagedNpmPrefix(bArgv);
            expect(bPrefix).not.toBe(stagePrefix);
            expect((await fs.stat(bPrefix)).isDirectory()).toBe(true);
            throw new Error("injected B stop before live mutation");
          },
        });
        expect(stoppedB).toMatchObject({
          failedStep: { exitCode: 1, stderrTail: "injected B stop before live mutation" },
          afterVersion: null,
          recovery: { serviceRestartSafe: true, version: "1.0.0" },
        });
        assert(bPrefix, "B did not reach its package-manager step");
        for (const removed of [bPrefix, ...obsoleteDirs]) {
          await expectMissing(removed);
        }
        await expectText(path.join(protectedBackup, "evidence"), "existing backup bytes\n");
        expect(await Promise.all(readPackageBytes(packageRoot))).toEqual(originalBytes);
        const survivingCandidate = await Promise.allSettled(readPackageBytes(candidateRoot));
        // Keep A running after this diagnostic so real verification and cleanup also settle.
        expect
          .soft(survivingCandidate, "B cleanup must preserve A's existing candidate bytes")
          .toEqual(candidateBytes.map((value) => ({ status: "fulfilled", value })));
        return { ...step, exitCode: 0 };
      },
    });

    expect(aPrefixes).toHaveLength(2);
    for (const prefix of aPrefixes) {
      await expectMissing(prefix);
    }
    expect((await fs.readdir(globalRoot)).toSorted()).toEqual(
      [path.basename(protectedBackup), path.basename(staleStage), "openclaw"].toSorted(),
    );
    await expectText(path.join(staleStage, "evidence"), "earlier candidate bytes\n");
    expect(result).toMatchObject({
      failedStep: null,
      afterVersion: "2.0.0",
      activePackageRoot: packageRoot,
      recovery: { serviceRestartSafe: true, version: "2.0.0" },
    });
    expect(result.steps).toContainEqual(
      expect.objectContaining({ name: "package-swap", exitCode: 0 }),
    );
    expect(await Promise.all(readPackageBytes(packageRoot))).toEqual(candidateBytes);
  }));
