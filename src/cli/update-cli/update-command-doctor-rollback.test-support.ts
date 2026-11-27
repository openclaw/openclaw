import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi, type Mock } from "vitest";
import { createConfigIO } from "../../config/io.js";
import { writePackageRoot } from "../../infra/package-update-steps.test-support.js";
import type { PackageUpdateTransaction } from "../../infra/package-update-swap-contract.js";
import { swapStagedPackageInstall } from "../../infra/package-update-swap.js";
import { createPackageSwapFixture } from "../../infra/package-update-swap.test-support.js";
import * as stateSchemas from "../../infra/update-candidate-state.js";
import { UpdateDoctorError } from "../../infra/update-doctor-result.js";
import {
  createUpdateRun,
  getUpdateRun,
  recordUpdateRunVerification,
} from "../../infra/update-run-ledger.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { finishUpdate } from "./update-command-post-update.js";
import { createReadinessRollbackFixture } from "./update-command-readiness-rollback.test-support.js";
import { UpdateCommandFailure } from "./update-command-result.js";
import type { PreManagedServiceStop } from "./update-command-service.js";

type FreshProcess =
  typeof import("./update-command-post-core.js").continuePostCoreUpdateInFreshProcess;
type Restart = typeof import("./update-command-service.js").maybeRestartService;
type VerifyGateway = typeof import("./update-command-verification.js").verifyUpdatedGateway;

export function registerDoctorRestorationRollbackTests(
  harness: {
    freshProcess: { mockImplementationOnce: (implementation: FreshProcess) => unknown };
    stopCandidate: { mockResolvedValueOnce: (result: PreManagedServiceStop) => unknown };
    restartCandidate: { mockImplementationOnce: (implementation: Restart) => unknown };
    verifyGateway: { mockImplementation: (implementation: VerifyGateway) => unknown };
    gatewayCommand: Mock<
      typeof import("./update-command-service-command.js").runUpdatedInstallGatewayCommand
    >;
  },
  makeTempDir: (prefix: string) => string,
) {
  it.each([
    { transport: "exception", differentService: false },
    { transport: "child-result", differentService: false },
    { transport: "exception", differentService: true },
    { transport: "readiness-deadline", differentService: false },
  ] as const)(
    "restores and verifies the previous package after post-update verification failure ($transport, differentService=$differentService)",
    async ({ transport, differentService }) => {
      const base = makeTempDir("update-doctor-restoration-");
      const fixture = await createPackageSwapFixture(base);
      const { packageRoot, launcher } = fixture;
      let transaction: PackageUpdateTransaction | undefined;
      await writePackageRoot(fixture.params.stage.packageRoot, "9999.1.1");
      const swap = await swapStagedPackageInstall({
        ...fixture.params,
        onTransaction: (retained) => {
          transaction = retained;
        },
      });
      expect(swap.status).toBe("committed");
      const updateResult: UpdateRunResult = {
        status: "ok",
        mode: "npm",
        root: packageRoot,
        before: { version: "1.0.0" },
        after: { version: "9999.1.1" },
        steps: [],
        durationMs: 1,
      };
      const serviceRoot = differentService ? path.join(base, "service-a") : packageRoot;
      const installedVersion = "1.0.0";
      const serviceVersion = differentService ? "0.9.0" : installedVersion;
      if (differentService) {
        await writePackageRoot(serviceRoot, serviceVersion);
      }
      if (!transaction) {
        throw new Error("Expected a retained package transaction");
      }
      const rollback = vi.spyOn(transaction, "rollback");
      // The synthetic package omits workers; keep real schema inspection in source.
      const readSchemas = stateSchemas.readUpdateStateSchemaVersions;
      vi.spyOn(stateSchemas, "readUpdateStateSchemaVersions").mockImplementation((params) =>
        readSchemas(params.root === packageRoot ? { ...params, root: undefined } : params),
      );
      const stateDir = path.join(base, transport === "readiness-deadline" ? ".openclaw" : "state");
      await fs.mkdir(stateDir);
      const configPath = path.join(stateDir, "openclaw.json");
      const env = {
        ...process.env,
        ...(transport === "readiness-deadline"
          ? {
              HOME: base,
              USERPROFILE: base,
              OPENCLAW_HOME: undefined,
              OPENCLAW_PROFILE: undefined,
              OPENCLAW_SUPERVISOR_MODE: undefined,
            }
          : {}),
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
      };
      const readiness =
        transport === "readiness-deadline" && launcher
          ? await createReadinessRollbackFixture({
              packageRoot,
              launcher,
              env: { ...env, HOME: base, USERPROFILE: base },
              harness,
            })
          : undefined;
      const configRaw = readiness
        ? `${JSON.stringify({ gateway: { port: readiness.port } })}\n`
        : "{}\n";
      await fs.writeFile(configPath, configRaw);
      const configSnapshot = await createConfigIO({
        env,
        observe: false,
        pluginValidation: "core-only",
      }).readConfigFileSnapshot();
      const run = { runId: createUpdateRun({ trigger: "cli" }, { env }).runId, env };
      const schemaVersions = await stateSchemas.readUpdateStateSchemaVersions({
        stateDir,
        config: {},
        env,
      });
      const facts =
        transport === "readiness-deadline"
          ? []
          : [
              {
                check: "gateway-restoration",
                code: "doctor-gateway-rpc-verification-failed",
                message: "rpc-verification: candidate build did not answer",
              },
              {
                check: "gateway-restoration",
                code: "stale-gateway-recovery-command",
                message: "openclaw gateway status --deep",
              },
            ];
      const error = new UpdateDoctorError(
        "Doctor Gateway restoration failed during rpc-verification. Run openclaw gateway status --deep.",
        facts,
      );
      harness.freshProcess.mockImplementationOnce(async () => {
        if (transport === "readiness-deadline") {
          return { resumed: true };
        }
        if (transport !== "child-result") {
          throw error;
        }
        return { resumed: false, exitCode: 1, error: error.message, failureFacts: facts };
      });
      const before: PreManagedServiceStop = {
        stopped: true,
        inspected: true,
        runtimeInspected: true,
        running: true,
        serviceEnv: env,
        serviceIdentity: {
          version: serviceVersion,
        },
        serviceUpdateVerdict: {
          kind: "owned",
          root: serviceRoot,
          fingerprint: "fixture",
          refreshDefinition: false,
          requiresInstallRootRefresh: differentService,
        },
      };
      harness.stopCandidate.mockResolvedValueOnce(before);
      const finishWithDeadline = readiness
        ? (finishing: Promise<UpdateRunResult>) => readiness.finish(finishing, run)
        : undefined;
      if (!finishWithDeadline) {
        harness.restartCandidate.mockImplementationOnce(async (params) => {
          expect(params.requireRunningServiceAfterRestart).toBe(true);
          expect(params.result.after?.version).toBe(installedVersion);
          expect(params.expectedGatewayIdentity).toEqual(before.serviceIdentity);
          expect(
            JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8")).version,
          ).toBe(installedVersion);
          expect(await fs.readFile(launcher, "utf8")).toBe("old launcher\n");
          recordUpdateRunVerification(
            run.runId,
            {
              serviceRunning: true,
              runningVersion: serviceVersion,
              versionMatch: true,
              settled: true,
              readyz: true,
            },
            { env },
          );
          params.onVerified?.(Date.now());
          return "ok";
        });
      }
      let failure: UpdateCommandFailure | undefined;
      try {
        const finishing = finishUpdate({
          mutationStarted: true,
          result: updateResult,
          root: packageRoot,
          packageTransaction: transaction,
          schemaVersions,
          previousVerified: true,
          installKindChanged: false,
          configSnapshot,
          requestedChannel: null,
          storedChannel: "stable",
          channel: "stable",
          downgradeRisk: false,
          shouldRestart: true,
          preManagedServiceStop: before,
          preUpdatePluginInstallRecords: {},
          updateStepTimeoutMs: 1000,
          opts: { json: true, run },
          startedAt: Date.now(),
          controlPlaneUpdateSentinelMeta: null,
        });
        await (finishWithDeadline ? finishWithDeadline(finishing) : finishing);
      } catch (caught) {
        if (!(caught instanceof UpdateCommandFailure)) {
          throw caught;
        }
        failure = caught;
      }
      expect(failure?.exitCode).toBe(1);
      expect(rollback).toHaveBeenCalledOnce();
      expect(harness.stopCandidate).toHaveBeenCalledOnce();
      expect(harness.restartCandidate).toHaveBeenCalledTimes(finishWithDeadline ? 2 : 1);
      expect(failure?.result.root).toBe(packageRoot);
      expect(failure?.result.after?.version).toBe(installedVersion);
      expect(failure?.result.recovery).toMatchObject({
        serviceRestartSafe: true,
        packageRollbackVerified: true,
        service: "healthy",
        version: serviceVersion,
      });
      if (finishWithDeadline) {
        expect(failure?.result.steps).toContainEqual(
          expect.objectContaining({
            name: "gateway verification",
            exitCode: 1,
            failureFacts: expect.arrayContaining([expect.objectContaining({ code: "timeout" })]),
          }),
        );
      } else {
        expect(failure?.result.steps.flatMap((step) => step.failureFacts ?? [])).toEqual([
          ...facts,
          { check: "update", code: "update-failed" },
        ]);
      }
      const recorded = getUpdateRun(run.runId, { env });
      expect(recorded?.status).toBe("rolled-back");
      expect(recorded?.verification).toMatchObject({
        serviceRunning: true,
        runningVersion: serviceVersion,
        versionMatch: true,
      });
      if (!recorded) {
        throw new Error("Expected terminal rollback report");
      }
      if (finishWithDeadline) {
        expect(recorded.verification).toMatchObject({ readyz: true, settled: true });
        expect(recorded.steps).toContainEqual(
          expect.objectContaining({
            failureFacts: expect.arrayContaining([expect.objectContaining({ code: "timeout" })]),
          }),
        );
      } else {
        expect(recorded.steps).toContainEqual(
          expect.objectContaining({
            failureFacts: expect.arrayContaining(facts),
          }),
        );
      }
      expect(await fs.readFile(configPath, "utf8")).toBe(configRaw);
    },
  );
}
