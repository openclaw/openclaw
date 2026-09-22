import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createConfigIO } from "../../config/io.js";
import { writePackageRoot } from "../../infra/package-update-steps.test-support.js";
import {
  swapStagedPackageInstall,
  type PackageUpdateTransaction,
} from "../../infra/package-update-swap.js";
import { createPackageSwapFixture } from "../../infra/package-update-swap.test-support.js";
import * as stateSchemas from "../../infra/update-candidate-state.js";
import { UpdateDoctorError } from "../../infra/update-doctor-result.js";
import {
  createUpdateRun,
  getUpdateRun,
  recordUpdateRunVerification,
} from "../../infra/update-run-ledger.js";
import { renderUpdateRunReport } from "../../infra/update-run-report.js";
import { finishUpdate } from "./update-command-post-update.js";
import { UpdateCommandFailure } from "./update-command-result.js";
import type { PreManagedServiceStop } from "./update-command-service.js";

type FreshProcess =
  typeof import("./update-command-post-core.js").continuePostCoreUpdateInFreshProcess;
type Restart = typeof import("./update-command-service.js").maybeRestartService;

export function registerDoctorRestorationRollbackTests(
  harness: {
    freshProcess: { mockImplementationOnce: (implementation: FreshProcess) => unknown };
    stopCandidate: { mockResolvedValueOnce: (result: PreManagedServiceStop) => unknown };
    restartCandidate: { mockImplementationOnce: (implementation: Restart) => unknown };
  },
  makeTempDir: (prefix: string) => string,
) {
  it.each([
    { transport: "exception", differentService: false },
    { transport: "child-result", differentService: false },
    { transport: "exception", differentService: true },
  ] as const)(
    "restores and verifies the previous package after typed Doctor restoration failure ($transport, differentService=$differentService)",
    async ({ transport, differentService }) => {
      const base = makeTempDir("update-doctor-restoration-");
      const fixture = await createPackageSwapFixture(base);
      await writePackageRoot(fixture.params.stage.packageRoot, "9999.1.1");
      const serviceRoot = differentService ? path.join(base, "service-a") : fixture.packageRoot;
      const serviceVersion = differentService ? "0.9.0" : "1.0.0";
      if (differentService) {
        await writePackageRoot(serviceRoot, serviceVersion);
      }
      let transaction: PackageUpdateTransaction | undefined;
      const swap = await swapStagedPackageInstall({
        ...fixture.params,
        onTransaction: (retained) => {
          transaction = retained;
        },
      });
      expect(swap.status).toBe("committed");
      if (!transaction) {
        throw new Error("Expected a retained package transaction");
      }
      const rollback = vi.spyOn(transaction, "rollback");
      // The synthetic package omits workers; keep real schema inspection in source.
      const readSchemas = stateSchemas.readUpdateStateSchemaVersions;
      vi.spyOn(stateSchemas, "readUpdateStateSchemaVersions").mockImplementation((params) =>
        readSchemas(params.root === fixture.packageRoot ? { ...params, root: undefined } : params),
      );
      const stateDir = path.join(base, "state");
      await fs.mkdir(stateDir);
      const configPath = path.join(stateDir, "openclaw.json");
      await fs.writeFile(configPath, "{}\n");
      const env = {
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
      };
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
      const facts = [
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
        if (transport === "exception") {
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
        serviceIdentity: { version: serviceVersion },
        serviceUpdateVerdict: {
          kind: "owned",
          root: serviceRoot,
          fingerprint: "fixture",
          refreshDefinition: false,
          requiresInstallRootRefresh: differentService,
        },
      };
      harness.stopCandidate.mockResolvedValueOnce(before);
      harness.restartCandidate.mockImplementationOnce(async (params) => {
        expect(params.requireRunningServiceAfterRestart).toBe(true);
        expect(params.result.after?.version).toBe("1.0.0");
        expect(params.expectedGatewayIdentity).toEqual({ version: serviceVersion });
        expect(
          JSON.parse(await fs.readFile(path.join(fixture.packageRoot, "package.json"), "utf8"))
            .version,
        ).toBe("1.0.0");
        expect(await fs.readFile(fixture.launcher, "utf8")).toBe("old launcher\n");
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
      let failure: UpdateCommandFailure | undefined;
      try {
        await finishUpdate({
          mutationStarted: true,
          result: {
            status: "ok",
            mode: "npm",
            root: fixture.packageRoot,
            before: { version: "1.0.0" },
            after: { version: "9999.1.1" },
            steps: [],
            durationMs: 1,
          },
          root: fixture.packageRoot,
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
      } catch (caught) {
        if (!(caught instanceof UpdateCommandFailure)) {
          throw caught;
        }
        failure = caught;
      }
      expect(failure?.exitCode).toBe(1);
      expect(rollback).toHaveBeenCalledOnce();
      expect(harness.stopCandidate).toHaveBeenCalledOnce();
      expect(harness.restartCandidate).toHaveBeenCalledOnce();
      expect(failure?.result.root).toBe(fixture.packageRoot);
      expect(failure?.result.after?.version).toBe("1.0.0");
      expect(failure?.result.recovery).toMatchObject({
        serviceRestartSafe: true,
        packageRollbackVerified: true,
        service: "healthy",
        version: serviceVersion,
      });
      expect(failure?.result.steps.flatMap((step) => step.failureFacts ?? [])).toEqual(facts);
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
      const report = renderUpdateRunReport(recorded);
      expect(report.headline).toContain("rolled back to 1.0.0");
      expect(report.markdown).toContain("rpc-verification");
      expect(report.markdown).toContain("openclaw gateway status --deep");
      expect(await fs.readFile(configPath, "utf8")).toBe("{}\n");
    },
  );
}
