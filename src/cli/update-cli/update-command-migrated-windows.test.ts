import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveGatewayTaskScriptPath } from "../../daemon/paths.js";
import type { GatewayService } from "../../daemon/service.js";
import {
  createMockGatewayService,
  mockSystemAccountHome,
} from "../../daemon/service.test-helpers.js";
import * as nodeSqlite from "../../infra/node-sqlite.js";
import * as updateLedger from "../../infra/update-run-ledger.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import { runUtf8CommandBuffersWithTimeout } from "../../process/exec-runner.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db-contract.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { createCommandResult } from "../../test-utils/npm-spec-install-test-helpers.js";
import { createUpdateCliBaseSnapshot } from "./update-cli-config.test-support.js";
import { createUpdateCommandExecutionGuards } from "./update-command-execution-guards.js";
import { finishParams, updateResult } from "./update-command-maintenance-fixtures.test-support.js";
import { withMigratedTerminalResult } from "./update-command-migrated-package.test-support.js";
import type { MigratedUpdateFinalizationInput } from "./update-command-migrated-types.js";
import { continueMigratedUpdateInFreshProcess } from "./update-command-migrated.js";
import { readMigratedUpdateRunRow } from "./update-command-migrated.test-support.js";
import {
  UpdateCommandFailure,
  UpdateCommandPendingRecoveryFailure,
} from "./update-command-result.js";
import { maybeStopManagedServiceBeforeMutableUpdate } from "./update-command-service-maintenance.js";

const mocks = vi.hoisted(() => ({
  service: vi.fn<() => GatewayService>(),
  enabled: true,
}));
vi.mock("../../daemon/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/service.js")>()),
  resolveGatewayService: mocks.service,
}));
vi.mock("../../daemon/schtasks-control.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/schtasks-control.js")>()),
  suspendScheduledTaskAutoStartForUpdate: vi.fn<
    typeof import("../../daemon/schtasks-control.js").suspendScheduledTaskAutoStartForUpdate
  >(async (_env, options) => {
    const enabled = mocks.enabled;
    if (enabled) {
      await options?.beforeMutation?.();
    }
    mocks.enabled = false;
    return enabled;
  }),
  resumeScheduledTaskAutoStartAfterUpdate: vi.fn<
    typeof import("../../daemon/schtasks-control.js").resumeScheduledTaskAutoStartAfterUpdate
  >(async (_env, options) => {
    await options?.beforeMutation?.();
    mocks.enabled = true;
    return true;
  }),
}));
vi.mock("../../process/exec-runner.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../process/exec-runner.js")>()),
  runUtf8CommandBuffersWithTimeout: vi.fn(),
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
const nativePlatform = process.platform;
beforeEach(() => {
  mockSystemAccountHome();
  mocks.enabled = true;
  const platform = vi.spyOn(process, "platform", "get").mockReturnValue(nativePlatform);
  // The service is Windows-shaped; SQLite still opens files on the real host.
  for (const name of ["resolveExistingSqliteFileUri", "resolveImmutableSqliteFileUri"] as const) {
    const resolveUri = nodeSqlite[name];
    vi.spyOn(nodeSqlite, name).mockImplementation((pathname) =>
      resolveUri(pathname, nativePlatform),
    );
  }
  const readRun = updateLedger.getUpdateRun;
  vi.spyOn(updateLedger, "getUpdateRun").mockImplementation((...args) => {
    const previousPlatform = process.platform;
    platform.mockReturnValue(nativePlatform);
    try {
      return readRun(...args);
    } finally {
      platform.mockReturnValue(previousPlatform);
    }
  });
});
afterEach(async () => {
  await closeStateDatabaseForTest();
  vi.restoreAllMocks();
});

it.each([
  "plugin warning",
  "launch failure",
  "failed terminal result",
  "replaced task",
  "changed protected task",
  "terminal compensation refusal",
] as const)("hands off migrated Windows updates: %s", async (outcome) => {
  const succeeded = outcome === "plugin warning";
  const replaced = outcome === "replaced task" || outcome === "changed protected task";
  const compensationRefusal = outcome === "terminal compensation refusal";
  const home = await fs.realpath(dirs.make("migrated-windows-"));
  await withEnvAsync(
    {
      HOME: home,
      USERPROFILE: home,
      APPDATA: path.join(home, "AppData"),
      OPENCLAW_HOME: undefined,
      OPENCLAW_STATE_DIR: undefined,
      OPENCLAW_CONFIG_PATH: undefined,
      OPENCLAW_PROFILE: undefined,
      OPENCLAW_SUPERVISOR_MODE: undefined,
      OPENCLAW_SERVICE_MARKER: undefined,
      OPENCLAW_SERVICE_KIND: undefined,
    },
    async () => {
      const databases: ReturnType<typeof nodeSqlite.openNodeSqliteDatabase>[] = [];
      const openDatabase = nodeSqlite.openNodeSqliteDatabase;
      vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockImplementation((...args) => {
        const database = openDatabase(...args);
        databases.push(database);
        return database;
      });
      const root = process.cwd();
      const runId = createUpdateRun({ trigger: "cli" }).runId;
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      const activationTimeoutMs = 3_600_000;
      const run = { runId, env: { ...process.env }, activationTimeoutMs };
      const { recordPhase } = createUpdateCommandExecutionGuards({ run }, root);
      let running = true;
      let programArguments = [process.execPath, path.join(root, "openclaw.mjs"), "gateway"];
      mocks.service.mockReturnValue(
        createMockGatewayService({
          label: "Scheduled Task",
          stop: async () => {
            running = false;
          },
          readCommand: async () => ({
            programArguments,
            sourcePath: resolveGatewayTaskScriptPath(process.env),
            environment: { HOME: home },
          }),
          readRuntime: async () => ({ status: running ? "running" : "stopped" }),
          isLoaded: async () => true,
        }),
      );
      const stopped = await maybeStopManagedServiceBeforeMutableUpdate({
        root,
        updateInstallKind: "package",
        shouldRestart: true,
        jsonMode: true,
        updateRun: run,
        recordPhase,
      });
      expect(stopped.serviceMutationSkipMessage).toBeUndefined();
      expect(stopped).toMatchObject({ stopped: true, inspected: true });
      const recovery = stopped.windowsTaskAutoStartRecovery;
      expect(recovery).toBeDefined();
      if (outcome === "changed protected task" && stopped.serviceUpdateVerdict?.kind === "owned") {
        stopped.serviceUpdateVerdict.refreshDefinition = false;
      }
      recovery?.beginMutation();
      expect({ running, enabled: mocks.enabled }).toEqual({ running: false, enabled: false });
      // Candidate Doctor publishes a schema the retained updater cannot open.
      await closeStateDatabaseForTest();
      const database = new DatabaseSync(resolveOpenClawStateSqlitePath());
      database.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1}`);
      database.close();
      expect(() => getUpdateRun(runId)).toThrow(/newer schema version/);
      let enabledAtWorkerStart: boolean | undefined;
      const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      const onResult = vi.fn();
      let terminalFromCandidate: unknown;
      let databaseCountAtTerminal = 0;
      const inspectTerminal = () =>
        readMigratedUpdateRunRow(resolveOpenClawStateSqlitePath(), runId);
      vi.mocked(runUtf8CommandBuffersWithTimeout).mockImplementationOnce(async (_argv, options) => {
        assert(typeof options === "object");
        expect(options.timeoutMs).toBe(activationTimeoutMs);
        const input = JSON.parse(String(options.input)) as MigratedUpdateFinalizationInput; // SAFETY: The real typed parent serializes this private worker input.
        expect(input.params.opts.run?.activationTimeoutMs).toBe(activationTimeoutMs);
        enabledAtWorkerStart = mocks.enabled;
        if (outcome === "launch failure") {
          throw new Error("candidate finalizer unavailable");
        }
        if (replaced) {
          mocks.enabled = true;
          programArguments =
            outcome === "replaced task"
              ? [process.execPath, path.join(home, "other-install", "openclaw.mjs"), "gateway"]
              : [...programArguments, "--port", "20000"];
          throw new Error("candidate finalizer disappeared");
        }
        expect(input.windowsTaskAutoStartSuspended).toBe(true);
        expect(input.params.preManagedServiceStop).not.toHaveProperty(
          "windowsTaskAutoStartRecovery",
        );
        await fs.writeFile(
          input.resultPath,
          JSON.stringify({
            result: {
              ...input.params.result,
              ...(succeeded
                ? { postUpdate: { plugins: { status: "warning" } } }
                : { status: "error", reason: "plugin-convergence-failed" }),
            },
            terminalRunId: runId,
            exitCode: succeeded ? 0 : 1,
          }),
        );
        if (succeeded) {
          mocks.enabled = true;
          running = true;
        }
        if (compensationRefusal) {
          // The candidate restored autostart, but another owner replaced the
          // task before the parent can compensate the failed terminal result.
          mocks.enabled = true;
          programArguments = [
            process.execPath,
            path.join(home, "other-install", "openclaw.mjs"),
            "gateway",
          ];
          const candidateDatabase = new DatabaseSync(resolveOpenClawStateSqlitePath());
          try {
            candidateDatabase
              .prepare(
                "UPDATE update_runs SET status = 'failed', phase = 'finished', finished_at_ms = ?, reason = 'plugin-convergence-failed' WHERE run_id = ?",
              )
              .run(Date.now(), runId);
          } finally {
            candidateDatabase.close();
          }
          terminalFromCandidate = inspectTerminal();
          databaseCountAtTerminal = databases.length;
        }
        return {
          ...createCommandResult({ cleanup: "normal" }),
          stdout: Buffer.from(compensationRefusal ? "candidate terminal result\n" : ""),
          stderr: Buffer.alloc(0),
          windowsEncoding: null,
        };
      });
      const continueUpdate = () =>
        continueMigratedUpdateInFreshProcess(
          finishParams({
            root,
            result: updateResult({ root, runId, durationMs: 0 }),
            configSnapshot: {
              ...createUpdateCliBaseSnapshot({}),
              path: path.join(home, "openclaw.json"),
              exists: false,
              raw: null,
            },
            opts: { json: true, run },
            preManagedServiceStop: stopped,
            packageUpdateNodeRunner: process.execPath,
            updateStepTimeoutMs: 1_000,
            rollbackBlockedReason: "state-migrated-no-rollback",
          }),
          [],
        );
      const refusesBeforeReceipt = outcome === "launch failure" || replaced;
      const operation = refusesBeforeReceipt
        ? continueUpdate()
        : withMigratedTerminalResult(run, continueUpdate, onResult);
      try {
        if (compensationRefusal) {
          const failure = await operation.catch((error: unknown) => error);
          expect(terminalFromCandidate).toMatchObject({
            status: "failed",
            phase: "finished",
            reason: "plugin-convergence-failed",
            finished_at_ms: expect.any(Number),
          });
          expect(failure).toBeInstanceOf(UpdateCommandPendingRecoveryFailure);
          expect(stdout).not.toHaveBeenCalled();
          expect(onResult).not.toHaveBeenCalled();
          expect(inspectTerminal()).toEqual(terminalFromCandidate);
          expect(databases).toHaveLength(databaseCountAtTerminal);
        } else if (refusesBeforeReceipt) {
          await expect(operation).rejects.toThrow(
            replaced ? /ownership or manager identity changed/ : "candidate finalizer unavailable",
          );
        } else if (succeeded) {
          await expect(operation).resolves.toMatchObject({
            exitCode: 0,
            result: { status: "ok", postUpdate: { plugins: { status: "warning" } } },
          });
        } else {
          await expect(operation).rejects.toMatchObject({
            result: expect.objectContaining({ status: "error" }),
            exitCode: 1,
          });
          await expect(operation).rejects.toBeInstanceOf(UpdateCommandFailure);
        }
        expect(enabledAtWorkerStart).toBe(false);
        expect(mocks.enabled).toBe(replaced || compensationRefusal || succeeded);
        await recovery?.restore();
        expect([mocks.enabled, running]).toEqual([
          replaced || compensationRefusal || succeeded,
          succeeded,
        ]);
      } finally {
        await recovery?.complete(false);
      }
      // Windows cannot remove the fixture home while native state handles are open.
      expect(databases.filter((connection) => connection.isOpen)).toEqual([]);
    },
  );
});
