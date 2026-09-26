import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writePackageDistInventory } from "../../scripts/lib/package-dist-inventory.ts";
import {
  CommandProcessCleanupError,
  hasCommandProcessCleanupError,
} from "../process/exec-result.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import {
  runGlobalPackageUpdateSteps,
  type PackageUpdateTransaction,
} from "./package-update-steps.js";
import {
  createNpmTarget,
  createRootRunner,
  writePackageRoot,
} from "./package-update-steps.test-support.js";
import type { UpdateStepResult } from "./update-step-result.js";

describe("retained package update transactions", () => {
  it.each([
    "already current",
    "wrong target",
    "install timed out",
    "install killed",
    "install output exceeded",
    "fallback install timed out",
    "validation rejected",
    "validation timed out",
    "validation output exceeded",
    "activation rejected",
    "backup failed",
    "activation failed",
    "doctor rejected",
    "doctor receipt throw",
    "doctor success receipt throw",
    "doctor advisory receipt throw",
    "doctor cleanup uncertain",
    "rollback",
    "confirm",
  ] as const)(
    "keeps the original serving through validation and retains recovery until %s",
    async (outcome) => {
      const failedInstall =
        outcome.startsWith("install ") || outcome === "fallback install timed out";
      await withTestDir({ prefix: "openclaw-package-transaction-" }, async (base) => {
        const prefix = path.join(base, "prefix");
        const globalRoot = path.join(prefix, "lib", "node_modules");
        const packageRoot = path.join(globalRoot, "openclaw");
        const launcher = path.join(prefix, "bin", "openclaw");
        await writePackageRoot(packageRoot, "1.0.0");
        if (outcome === "already current") {
          await fs.writeFile(
            path.join(packageRoot, "dist", "build-info.json"),
            JSON.stringify({ buildId: "same-build" }),
          );
          await writePackageDistInventory(packageRoot);
        }
        await fs.mkdir(path.dirname(launcher), { recursive: true });
        await fs.writeFile(launcher, "old launcher\n");
        let transaction: PackageUpdateTransaction | undefined;
        let stageRoot: string | undefined;
        let stageLauncher: string | undefined;
        let serving = true;
        const phases: string[] = [];
        const activationError = new Error("service did not stop");
        const doctorFailure = new Error("Doctor command failed after writing its receipt");
        const uncertainFailure = new Error("Doctor cleanup remains pending", {
          cause: new CommandProcessCleanupError(),
        });
        const receiptThrow = outcome.endsWith("receipt throw");
        const doctorReceipt: UpdateStepResult = {
          name: "openclaw doctor",
          command: "doctor --fix",
          cwd: packageRoot,
          durationMs: 1,
          exitCode: outcome === "doctor success receipt throw" ? 0 : 1,
          configChanges: [{ kind: "migration", message: "Moved model allowlist." }],
          ...(outcome === "doctor receipt throw"
            ? {
                stderrTail: "Doctor refused config writes",
                configWriteRefusal: {
                  reason: "include-ownership",
                  message: "Include is not owned",
                  keys: ["agents"],
                },
                failureFacts: [
                  { check: "config", code: "include-ownership", affectedKey: "agents" },
                ],
              }
            : {}),
          ...(outcome === "doctor advisory receipt throw"
            ? {
                exitCode: 86,
                advisory: { kind: "package-post-install-doctor", message: "Deferred repair" },
              }
            : {}),
        };
        const update = runGlobalPackageUpdateSteps({
          installTarget: createNpmTarget(globalRoot),
          installSpec: outcome === "already current" ? "./candidate.tgz" : "openclaw@2.0.0",
          packageName: "openclaw",
          runCommand: createRootRunner(globalRoot),
          timeoutMs: 1000,
          runStep: async ({ name, argv }) => {
            const fallback = argv.includes("--omit=optional");
            const stagePrefix = argv[argv.indexOf("--prefix") + 1];
            if (!stagePrefix) {
              throw new Error("missing stage prefix");
            }
            stageRoot = path.join(stagePrefix, "lib", "node_modules", "openclaw");
            await writePackageRoot(
              stageRoot,
              outcome === "already current" || outcome === "wrong target" ? "1.0.0" : "2.0.0",
            );
            if (outcome === "already current") {
              await fs.writeFile(
                path.join(stageRoot, "dist", "build-info.json"),
                JSON.stringify({ buildId: "same-build" }),
              );
              await writePackageDistInventory(stageRoot);
            }
            await fs.mkdir(path.join(stagePrefix, "bin"), { recursive: true });
            stageLauncher = path.join(stagePrefix, "bin", "openclaw");
            await fs.writeFile(stageLauncher, "new launcher\n");
            return {
              name,
              command: argv.join(" "),
              cwd: stagePrefix,
              durationMs: 0,
              exitCode: outcome === "fallback install timed out" && !fallback ? 1 : 0,
              termination:
                outcome === "install timed out" ||
                (outcome === "fallback install timed out" && fallback)
                  ? "timeout"
                  : "exit",
              killed: outcome === "install killed",
              outputLimitExceeded: outcome === "install output exceeded",
            };
          },
          validateCandidate: async (candidateRoot) => {
            phases.push("validate");
            expect(serving).toBe(true);
            expect(candidateRoot).toBe(stageRoot);
            await expect(
              fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
            ).resolves.toContain('"version":"1.0.0"');
            await expect(fs.readFile(launcher, "utf8")).resolves.toBe("old launcher\n");
            return [
              {
                name: "candidate canary",
                command: "canary",
                cwd: candidateRoot,
                durationMs: 1,
                exitCode: outcome === "validation rejected" ? 1 : 0,
                termination: outcome === "validation timed out" ? "timeout" : "exit",
                outputLimitExceeded: outcome === "validation output exceeded",
              },
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
            if (outcome === "activation failed" && stageLauncher) {
              rmSync(stageLauncher);
            } else if (outcome === "backup failed") {
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
            return {
              name: "doctor",
              command: "doctor --fix",
              cwd: candidateRoot,
              durationMs: 0,
              exitCode: outcome === "doctor rejected" ? 1 : 0,
            };
          },
        });
        if (outcome === "activation rejected") {
          await expect(update).rejects.toBe(activationError);
          expect(phases).toEqual(["validate", "stop"]);
          expect(transaction).toBeUndefined();
          await expect(fs.readFile(launcher, "utf8")).resolves.toBe("old launcher\n");
          await expect(
            fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
          ).resolves.toContain('"version":"1.0.0"');
          expect((await fs.readdir(globalRoot)).filter((entry) => entry.startsWith("."))).toEqual(
            [],
          );
          await expect(fs.stat(stageRoot!)).rejects.toMatchObject({ code: "ENOENT" });
          return;
        }
        if (outcome === "doctor cleanup uncertain") {
          const failure = await update.catch((cause: unknown) => cause);
          expect(failure).toBe(uncertainFailure);
          expect(hasCommandProcessCleanupError(failure)).toBe(true);
          expect(phases).toEqual(["validate", "stop", "migrate"]);
          assert(transaction && stageLauncher);
          await expect(
            fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
          ).resolves.toContain('"version":"2.0.0"');
          await expect(
            fs.readFile(path.join(transaction.backupRoot, "package.json"), "utf8"),
          ).resolves.toContain('"version":"1.0.0"');
          const shimBackups = (await fs.readdir(globalRoot)).filter((entry) =>
            entry.startsWith(".openclaw.shim-backup-"),
          );
          expect(shimBackups).toHaveLength(1);
          const [shimBackup] = shimBackups;
          assert(shimBackup);
          await expect(
            Promise.all([
              fs.readFile(launcher, "utf8"),
              fs.readFile(stageLauncher, "utf8"),
              fs.readFile(path.join(globalRoot, shimBackup, "openclaw"), "utf8"),
            ]),
          ).resolves.toEqual(["new launcher\n", "new launcher\n", "old launcher\n"]);
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
          if (outcome === "doctor receipt throw") {
            expect(failedDoctor.failureFacts).toEqual(
              expect.arrayContaining(doctorReceipt.failureFacts ?? []),
            );
          }
          expect(failedDoctor.stderrTail).toContain(doctorFailure.message);
          expect(failedDoctor.failureFacts).toEqual(
            expect.arrayContaining([
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
        if (outcome === "already current" || outcome === "wrong target") {
          expect(phases).toEqual([]);
          expect(transaction).toBeUndefined();
          if (outcome === "wrong target") {
            expect(result.reason).toBeUndefined();
            expect(result.failedStep).toMatchObject({
              name: "package-verify",
              stderrTail: "expected installed version 2.0.0, found 1.0.0",
            });
          } else {
            expect(result.reason).toBe("already-current");
            expect(result.failedStep).toBeNull();
          }
          expect(result.afterVersion).toBe("1.0.0");
          await expect(fs.readFile(launcher, "utf8")).resolves.toBe("old launcher\n");
        } else if (failedInstall || outcome.startsWith("validation ")) {
          expect(phases).toEqual(failedInstall ? [] : ["validate"]);
          expect(transaction).toBeUndefined();
          expect(result.failedStep).toMatchObject({
            name: failedInstall
              ? outcome === "fallback install timed out"
                ? "package-install-omit-optional"
                : "package-install"
              : "candidate canary",
            exitCode: outcome === "validation rejected" ? 1 : 0,
          });
          expect(result.recovery).toEqual({ serviceRestartSafe: true, version: "1.0.0" });
          await expect(
            fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
          ).resolves.toContain('"version":"1.0.0"');
          await expect(fs.readFile(launcher, "utf8")).resolves.toBe("old launcher\n");
        } else {
          const activationFailed = outcome === "activation failed" || outcome === "backup failed";
          expect(phases, JSON.stringify(result.failedStep)).toEqual(
            activationFailed ? ["validate", "stop"] : ["validate", "stop", "migrate"],
          );
          expect(result.failedStep?.name ?? null).toBe(
            activationFailed
              ? "package-swap"
              : outcome === "doctor rejected"
                ? "doctor"
                : receiptThrow
                  ? "openclaw doctor"
                  : null,
          );
          expect(result.activePackageRoot).toBe(packageRoot);
          expect(result.afterVersion).toBe(outcome === "backup failed" ? "1.0.0" : "2.0.0");
          if (!transaction) {
            throw new Error("activated package did not retain a transaction");
          }
          if (outcome === "backup failed") {
            await expect(
              fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
            ).resolves.toContain('"version":"1.0.0"');
          } else {
            await expect(
              fs.readFile(path.join(transaction.backupRoot, "package.json"), "utf8"),
            ).resolves.toContain('"version":"1.0.0"');
          }
          await expect(fs.readFile(launcher, "utf8")).resolves.toBe(
            activationFailed ? "old launcher\n" : "new launcher\n",
          );
          if (outcome !== "confirm") {
            const restored = await transaction.rollback(() => {});
            expect(restored).toMatchObject({ exitCode: 0, activePackageRoot: packageRoot });
            expect(await transaction.rollback(() => {})).toEqual(restored);
            await expect(fs.readFile(launcher, "utf8")).resolves.toBe("old launcher\n");
          }
          await transaction.complete({ activationVerified: outcome === "confirm" }, () => {});
          await transaction.complete({ activationVerified: outcome === "confirm" }, () => {});
          await expect(
            fs.readFile(path.join(packageRoot, "package.json"), "utf8"),
          ).resolves.toContain(`"version":"${outcome === "confirm" ? "2.0.0" : "1.0.0"}"`);
          expect((await transaction.rollback(() => {})).exitCode).toBe(1);
        }
        expect((await fs.readdir(globalRoot)).filter((entry) => entry.startsWith("."))).toEqual([]);
      });
    },
  );
});
