import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, type Mock } from "vitest";
import { readConfigFileSnapshot } from "../../config/config.js";
import { ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS_ENV } from "../../config/future-version-guard.js";
import { readUpdateStateSchemaVersions } from "../../infra/update-candidate-state.js";
import {
  createUpdateRun,
  getUpdateRun,
  recordUpdateRunVerification,
} from "../../infra/update-run-ledger.js";
import { renderUpdateRunReport } from "../../infra/update-run-report.js";
import { createCommandResult as commandResult } from "../../test-utils/npm-spec-install-test-helpers.js";
import { VERSION } from "../../version.js";
import { runDaemonRestart } from "../daemon-cli/lifecycle.js";
import { readUpdateConfigSnapshot } from "./update-command-config-snapshot.js";
import { createUpdateCommandExecutionGuards } from "./update-command-execution-guards.js";
import { verificationFixture } from "./update-command-fixtures.test-support.js";
import { finishUpdate } from "./update-command-post-update.js";
import { UpdateCommandFailure } from "./update-command-result.js";
import { withOwnedManagedUpdateEnv } from "./update-command-service-env.js";
import { serviceUpdateResult } from "./update-command-service-recovery.test-support.js";
import { maybeStopManagedServiceBeforeMutableUpdate } from "./update-command-service.js";

export function registerGenerationRecoveryTests(
  fixture: () => {
    root: string;
    configPath: string;
    mocks: {
      child: Mock<typeof import("../../process/exec.js").runCommandWithTimeout>;
      health: Mock<typeof import("../daemon-cli/restart-health.js").waitForGatewayHealthyRestart>;
      running: boolean;
      stopAllowances: Array<string | undefined>;
      writeJson: Mock;
    };
  },
) {
  it.each([false, true])(
    "restores the previous running generation after candidate stamp advancement (content changed=%s)",
    async (contentChanged) => {
      const { root, configPath, mocks } = fixture();
      const readConfig = async () => JSON.parse(await fs.readFile(configPath, "utf8"));
      const entryPath = path.join(root, "dist/index.js");
      const readEntry = () => fs.readFile(entryPath);
      const writeConfig = (config: unknown) => fs.writeFile(configPath, JSON.stringify(config));
      process.env.OPENCLAW_UPDATE_RUN_HANDOFF = "1";
      const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, ".openclaw") };
      const run = {
        runId: createUpdateRun({ trigger: "cli", before: { version: VERSION } }, { env }).runId,
        env,
      };
      const { recordPhase } = createUpdateCommandExecutionGuards({ run }, root);
      const configSnapshot = await readConfigFileSnapshot({ skipPluginValidation: true });
      const schemas = await readUpdateStateSchemaVersions({
        stateDir: env.OPENCLAW_STATE_DIR,
        config: configSnapshot.config,
        env,
      });
      recordUpdateRunVerification(run.runId, verificationFixture(VERSION), { env });
      const before = await maybeStopManagedServiceBeforeMutableUpdate({
        root,
        updateInstallKind: "package",
        shouldRestart: true,
        jsonMode: true,
        updateRun: run,
        recordPhase,
      });
      const previousBytes = await readEntry();
      await fs.writeFile(entryPath, "throw new Error('candidate activation');\n");
      const candidateConfig = await readConfig();
      candidateConfig.meta.lastTouchedVersion = "9999.1.1";
      await writeConfig(candidateConfig);
      const activationConfig = {
        ...(await readUpdateConfigSnapshot(configPath)),
        raw: configSnapshot.raw,
      };
      if (contentChanged) {
        candidateConfig.gateway.port = 19306;
      }
      await writeConfig(candidateConfig);
      let restores = 0;
      mocks.child.mockImplementation(async (_args, options) => {
        const childEnv = typeof options === "object" ? options.env : undefined;
        const allowance =
          typeof options === "object" && childEnv?.[ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS_ENV];
        if (restores === 0) {
          expect(allowance).toBeUndefined();
          mocks.running = false;
          throw new Error("candidate gateway exited 70");
        }
        expect(allowance).toBe("1");
        expect((await readConfig()).meta.lastTouchedVersion).toBe(VERSION);
        expect(await readEntry()).toEqual(previousBytes);
        // Exercise the previous binary's real lifecycle/version guard with the child env.
        const healthy = await withOwnedManagedUpdateEnv(childEnv, () =>
          runDaemonRestart({ json: true, preserveDefinition: true }),
        );
        return commandResult({
          code: healthy ? 0 : 1,
          stdout: JSON.stringify(mocks.writeJson.mock.lastCall?.[0]),
        });
      });
      mocks.health.mockImplementation(async ({ port, expectedVersion }) => ({
        outcome: mocks.running ? "ready" : "failed",
        healthy: mocks.running,
        staleGatewayPids: [],
        runtime: {
          status: mocks.running ? "running" : "stopped",
          pid: mocks.running ? 4242 : undefined,
        },
        gatewayBootId: "service-boot",
        gatewayVersion: mocks.running ? VERSION : undefined,
        expectedVersion: expectedVersion ?? undefined,
        portUsage: { port, status: mocks.running ? "busy" : "free", listeners: [], hints: [] },
      }));
      const result = serviceUpdateResult(root, {
        before: { version: VERSION },
        after: { version: "9999.1.1" },
      });
      let completedStatus: string | undefined;
      const error = await finishUpdate({
        mutationStarted: true,
        result,
        root,
        configSnapshot,
        activationConfig,
        installKindChanged: false,
        requestedChannel: null,
        storedChannel: "stable",
        channel: "stable",
        downgradeRisk: false,
        shouldRestart: true,
        opts: { json: true, run },
        preManagedServiceStop: before,
        controlPlaneUpdateSentinelMeta: null,
        preUpdatePluginInstallRecords: {},
        startedAt: Date.now(),
        updateStepTimeoutMs: 1000,
        schemaVersions: schemas,
        previousVerified: true,
        packageTransaction: {
          backupRoot: path.join(root, "backup"),
          rollback: async () => {
            restores++;
            await fs.writeFile(entryPath, previousBytes);
            return {
              name: "package rollback",
              activePackageRoot: root,
              command: "restore",
              cwd: root,
              exitCode: 0,
              durationMs: 1,
            };
          },
          complete: async () => {
            completedStatus = getUpdateRun(run.runId, { env })?.status;
          },
        },
      }).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(UpdateCommandFailure);
      const record = getUpdateRun(run.runId, { env })!;
      expect(process.env[ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS_ENV]).toBeUndefined();
      expect(before.serviceEnv?.[ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS_ENV]).toBeUndefined();
      if (contentChanged) {
        expect(restores).toBe(0);
        expect(record).toMatchObject({
          reason: "state-migrated-no-rollback",
          status: "failed",
          verification: { serviceRunning: false },
        });
        expect(await readConfig()).toEqual(candidateConfig);
      } else {
        expect(restores).toBe(1);
        expect(mocks.running).toBe(true);
        expect(mocks.stopAllowances).toEqual([undefined, "1"]);
        expect(record).toMatchObject({
          status: "rolled-back",
          after: { version: VERSION },
          verification: { serviceRunning: true, runningVersion: VERSION },
        });
        // Cleanup is pre-terminal; rollback is recorded only after completion settles.
        expect(completedStatus).toBe("running");
        expect(record.downtimeMs).toBeGreaterThanOrEqual(0);
        expect(record.confirmedAtMs).toBeGreaterThanOrEqual(before.stoppedAtMs!);
        expect(renderUpdateRunReport(record).headline).toBe(
          `↩️ OpenClaw update rolled back to ${VERSION}: restart-unhealthy.`,
        );
      }
    },
  );
}
