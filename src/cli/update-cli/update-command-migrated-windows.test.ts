import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { asResolvedSourceConfig, asRuntimeConfig } from "../../config/materialize.js";
import type { GatewayService } from "../../daemon/service.js";
import {
  createMockGatewayService,
  mockSystemAccountHome,
} from "../../daemon/service.test-helpers.js";
import * as nodeSqlite from "../../infra/node-sqlite.js";
import * as updateLedger from "../../infra/update-run-ledger.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import { runUtf8CommandWithTimeout } from "../../process/exec.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db-contract.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withEnvAsync } from "../../test-utils/env.js";
import type { MigratedUpdateFinalizationInput } from "./update-command-migrated-types.js";
import { continueMigratedUpdateInFreshProcess } from "./update-command-migrated.js";
import { maybeStopManagedServiceBeforeMutableUpdate } from "./update-command-service-maintenance.js";

const mocks = vi.hoisted(() => ({
  service: vi.fn<() => GatewayService>(),
  enabled: true,
}));
vi.mock("../../daemon/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/service.js")>()),
  resolveGatewayService: mocks.service,
}));
vi.mock("../../daemon/schtasks.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/schtasks.js")>()),
  suspendScheduledTaskAutoStartForUpdate: vi.fn<
    typeof import("../../daemon/schtasks.js").suspendScheduledTaskAutoStartForUpdate
  >(async (_env, options) => {
    const enabled = mocks.enabled;
    if (enabled) {
      await options?.beforeMutation?.();
    }
    mocks.enabled = false;
    return enabled;
  }),
  resumeScheduledTaskAutoStartAfterUpdate: vi.fn<
    typeof import("../../daemon/schtasks.js").resumeScheduledTaskAutoStartAfterUpdate
  >(async (_env, options) => {
    await options?.beforeMutation?.();
    mocks.enabled = true;
    return true;
  }),
}));
vi.mock("../../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../process/exec.js")>()),
  runUtf8CommandWithTimeout: vi.fn(),
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
const nativePlatform = process.platform;
beforeEach(() => {
  mockSystemAccountHome();
  mocks.enabled = true;
  const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  // The service is Windows-shaped; SQLite still opens files on the real host.
  const existingUri = nodeSqlite.resolveExistingSqliteFileUri;
  const immutableUri = nodeSqlite.resolveImmutableSqliteFileUri;
  vi.spyOn(nodeSqlite, "resolveExistingSqliteFileUri").mockImplementation((pathname) =>
    existingUri(pathname, nativePlatform),
  );
  vi.spyOn(nodeSqlite, "resolveImmutableSqliteFileUri").mockImplementation((pathname) =>
    immutableUri(pathname, nativePlatform),
  );
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
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

it.each([
  "plugin warning",
  "launch failure",
  "failed terminal result",
  "replaced task",
  "changed protected task",
] as const)("hands off migrated Windows updates: %s", async (outcome) => {
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
      const activationTimeoutMs = 3_600_000;
      const run = { runId, env: { ...process.env }, activationTimeoutMs };
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
      });
      expect(stopped.serviceMutationSkipMessage).toBeUndefined();
      expect(stopped).toMatchObject({ stopped: true, inspected: true });
      const recovery = stopped.windowsTaskAutoStartRecovery;
      expect(recovery).toBeDefined();
      if (outcome === "changed protected task" && stopped.serviceUpdateVerdict?.kind === "owned") {
        stopped.serviceUpdateVerdict.refreshDefinition = false;
      }
      recovery?.beginMutation();
      expect(running).toBe(false);
      expect(mocks.enabled).toBe(false);
      // Candidate Doctor publishes a schema the retained updater cannot open.
      closeOpenClawStateDatabaseForTest();
      const database = new DatabaseSync(resolveOpenClawStateSqlitePath());
      database.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1}`);
      database.close();
      expect(() => getUpdateRun(runId)).toThrow(/newer schema version/);
      let enabledAtWorkerStart: boolean | undefined;
      vi.mocked(runUtf8CommandWithTimeout).mockImplementationOnce(async (_argv, options) => {
        assert(typeof options === "object");
        expect(options.timeoutMs).toBe(activationTimeoutMs);
        const input = JSON.parse(String(options.input)) as MigratedUpdateFinalizationInput; // SAFETY: The real typed parent serializes this private worker input.
        expect(input.params.opts.run?.activationTimeoutMs).toBe(activationTimeoutMs);
        enabledAtWorkerStart = mocks.enabled;
        if (outcome === "launch failure") {
          throw new Error("candidate finalizer unavailable");
        }
        if (outcome === "replaced task" || outcome === "changed protected task") {
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
              ...(outcome === "plugin warning"
                ? {
                    postUpdate: {
                      plugins: {
                        status: "warning",
                        changed: false,
                        sync: {
                          changed: false,
                          switchedToBundled: [],
                          switchedToNpm: [],
                          warnings: [],
                          errors: [],
                        },
                        npm: { changed: false, outcomes: [] },
                        integrityDrifts: [],
                        warnings: [
                          {
                            reason: "plugin-version-drift",
                            message: "codex: 2026.9.5 (npm) -> expected 2026.9.6",
                            guidance: ["openclaw doctor --fix"],
                          },
                        ],
                      },
                    },
                  }
                : { status: "error", reason: "plugin-convergence-failed" }),
            },
            terminalRunId: runId,
            exitCode: outcome === "plugin warning" ? 0 : 1,
          }),
        );
        if (outcome === "plugin warning") {
          mocks.enabled = true;
          running = true;
        }
        return {
          stdout: "",
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
          termination: "exit",
          cleanup: "normal",
        };
      });
      const operation = continueMigratedUpdateInFreshProcess(
        {
          mutationStarted: true,
          root,
          result: { status: "ok", mode: "npm", root, runId, steps: [], durationMs: 0 },
          installKindChanged: false,
          configSnapshot: {
            path: path.join(home, "openclaw.json"),
            exists: false,
            raw: null,
            parsed: {},
            sourceConfig: asResolvedSourceConfig({}),
            resolved: asResolvedSourceConfig({}),
            valid: true,
            runtimeConfig: asRuntimeConfig({}),
            config: asRuntimeConfig({}),
            issues: [],
            warnings: [],
            legacyIssues: [],
          },
          requestedChannel: null,
          storedChannel: "stable",
          channel: "stable",
          downgradeRisk: false,
          shouldRestart: true,
          opts: { json: true, run },
          preManagedServiceStop: stopped,
          controlPlaneUpdateSentinelMeta: null,
          preUpdatePluginInstallRecords: {},
          startedAt: Date.now(),
          packageUpdateNodeRunner: process.execPath,
          updateStepTimeoutMs: 1_000,
          rollbackBlockedReason: "state-migrated-no-rollback",
        },
        [],
      );
      try {
        if (outcome === "launch failure") {
          await expect(operation).rejects.toThrow("candidate finalizer unavailable");
        } else if (outcome === "replaced task" || outcome === "changed protected task") {
          await expect(operation).rejects.toThrow(/ownership or manager identity changed/);
        } else if (outcome === "plugin warning") {
          await expect(operation).resolves.toMatchObject({
            exitCode: 0,
            result: { status: "ok", postUpdate: { plugins: { status: "warning" } } },
          });
        } else {
          await expect(operation).resolves.toMatchObject({ exitCode: 1 });
        }
        expect(enabledAtWorkerStart).toBe(false);
        const replaced = outcome === "replaced task" || outcome === "changed protected task";
        expect(mocks.enabled).toBe(replaced || outcome === "plugin warning");
        await recovery?.restore();
        expect(mocks.enabled).toBe(replaced || outcome === "plugin warning");
        expect(running).toBe(outcome === "plugin warning");
      } finally {
        await recovery?.complete(false);
      }
      // Windows cannot remove the fixture home while native state handles are open.
      expect(databases.filter((connection) => connection.isOpen)).toEqual([]);
    },
  );
});
