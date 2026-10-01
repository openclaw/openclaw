import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { createFixtureLifetime } from "../../../test/helpers/fixture-lifetime.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createConfigIO } from "../../config/io.js";
import { asResolvedSourceConfig, asRuntimeConfig } from "../../config/materialize.js";
import { appendTranscriptEventsInTransaction } from "../../config/sessions/session-accessor.sqlite-transcript-store.js";
import { readDaemonRuntimePin } from "../../daemon/runtime-pin-state.js";
import * as nodeSqlite from "../../infra/node-sqlite.js";
import {
  createPackageIntegrityReader,
  type PackageLauncherFingerprint,
} from "../../infra/package-update-integrity.js";
import { createRetainedPackageSwap } from "../../infra/package-update-swap.test-support.js";
import { hasNodeErrorCode } from "../../infra/path-guards.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../infra/runtime-worker-url.js";
import * as temporaryState from "../../infra/tmp-openclaw-dir.js";
import { readUpdateStateSchemaVersions } from "../../infra/update-candidate-state.js";
import {
  adoptUpdateRun,
  createUpdateRun,
  finishUpdateRun,
  recordUpdateRunStep,
} from "../../infra/update-run-ledger.js";
import {
  CommandProcessCleanupError,
  hasCommandProcessCleanupError,
} from "../../process/exec-result.js";
import * as childCommands from "../../process/exec.js";
import { defaultRuntime } from "../../runtime.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../../state/openclaw-agent-db-contract.js";
import {
  closeOpenClawAgentDatabasesForTest,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { createUpdateProgress } from "./progress.js";
import { prepareCandidateAuthorityRuntime } from "./update-command-candidate-authority.test-support.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import {
  MIGRATED_FIXTURE_NO_SERVICE,
  migratedFinalizeFixtureEntrypoint,
} from "./update-command-migrated-fixture-entrypoint.test-support.js";
import type { MigratedUpdateFinalizationInput } from "./update-command-migrated-types.js";
import {
  continueMigratedUpdateInFreshProcess,
  inspectActivatedUpdateState,
} from "./update-command-migrated.js";
import { readMigratedUpdateRunRow } from "./update-command-migrated.test-support.js";
import { taskRecovery } from "./update-command-post-update.test-support.js";
import {
  UpdateCommandFailure,
  UpdateCommandPendingRecoveryFailure,
} from "./update-command-result.js";
import { createUpdateRunProgress } from "./update-command-run.js";
import { withUpdateCommandTerminalResult } from "./update-command-terminal.js";

// Model the already-running updater's older schema contract. The candidate
// worker is a real unmocked process with the checkout's current contract.
vi.mock("../../state/openclaw-state-db-contract.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/openclaw-state-db-contract.js")>();
  return { ...actual, OPENCLAW_STATE_SCHEMA_VERSION: actual.OPENCLAW_STATE_SCHEMA_VERSION - 1 };
});

const runtimeFixture = createFixtureLifetime();
let candidateRoot: string;
beforeAll(async () => {
  const runtime = await runtimeFixture.run(() =>
    prepareCandidateAuthorityRuntime(runtimeFixture.createTempDir("migrated-candidate-runtime-")),
  );
  candidateRoot = fileURLToPath(new URL("../../", runtime.worker));
});
afterAll(() => runtimeFixture.cleanup());

const dirs = useAutoCleanupTempDirTracker(afterEach);
let presentation: ReturnType<typeof createUpdateProgress> | undefined;
afterEach(() => {
  presentation?.suspend();
  presentation?.dispose();
  presentation = undefined;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

it.each([
  { agentId: "main", changed: "none", blocked: undefined },
  { agentId: "verification", changed: "none", blocked: undefined },
  { agentId: "main", changed: "shared", blocked: "state-migrated-no-rollback" },
  { agentId: "main", changed: "agent", blocked: "state-migrated-no-rollback" },
])(
  "classifies activation after first-use database creation (agent=$agentId, changed=$changed)",
  async ({ agentId, changed, blocked }) => {
    const stateDir = await fs.realpath(dirs.make("update-first-serving-turn-"));
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const shared = openOpenClawStateDatabase({ env });
    const schemaVersions = await readUpdateStateSchemaVersions({ stateDir, config: {}, env });
    const agentPath = path.join(stateDir, "agents", agentId, "agent", "openclaw-agent.sqlite");
    expect(
      schemaVersions.find((entry) => entry.path === agentPath)?.userVersion ?? null,
    ).toBeNull();

    runOpenClawAgentWriteTransaction(
      (database) => {
        appendTranscriptEventsInTransaction(
          database,
          { agentId, sessionKey: `agent:${agentId}:update-check`, sessionId: "serving-check" },
          [
            {
              type: "message",
              id: "request",
              parentId: null,
              message: { role: "user", content: "Reply with update-verified-run" },
            },
            {
              type: "message",
              id: "reply",
              parentId: "request",
              message: {
                role: "assistant",
                content: "update-verified-run",
                provider: "openai",
                model: "gpt-4.1-mini",
                stopReason: "stop",
                __openclaw: { runId: "run" },
              },
            },
          ],
        );
      },
      { agentId, env },
    );
    closeOpenClawAgentDatabasesForTest();
    if (changed !== "none") {
      const db = new DatabaseSync(changed === "shared" ? shared.path : agentPath);
      try {
        db.exec(
          `PRAGMA user_version = ${changed === "shared" ? OPENCLAW_STATE_SCHEMA_VERSION + 1 : OPENCLAW_AGENT_SCHEMA_VERSION + 1}`,
        );
      } finally {
        db.close();
      }
    }
    const result = {
      status: "ok" as const,
      mode: "npm" as const,
      root: candidateRoot,
      steps: [],
      durationMs: 0,
    };
    await expect(
      runtimeFixture.track(
        inspectActivatedUpdateState({
          result,
          root: candidateRoot,
          schemaVersions,
          candidateSchemaVersions: {
            state: OPENCLAW_STATE_SCHEMA_VERSION + Number(changed === "shared"),
            agent: OPENCLAW_AGENT_SCHEMA_VERSION,
          },
          config: {},
          env,
        }),
      ),
    ).resolves.toBe(blocked);
  },
);

it.each<{
  pending: boolean;
  status: "ok" | "error" | "skipped";
  candidateStartAttempted?: boolean;
  backup?: boolean;
  windows?: boolean;
  handback?: boolean;
  completion?: "success" | "failure";
  recovered?: boolean;
}>([
  { pending: true, status: "skipped", windows: true },
  { pending: false, status: "error", windows: true },
  { pending: true, status: "error", windows: true },
  { pending: false, status: "error", candidateStartAttempted: false, backup: true, handback: true },
  { pending: false, status: "error", candidateStartAttempted: true, backup: true },
  { pending: false, status: "error", backup: true },
  { pending: false, status: "error", candidateStartAttempted: false },
  { pending: false, status: "error", candidateStartAttempted: false, backup: true, windows: true },
  { pending: false, status: "ok", completion: "success" },
  { pending: false, status: "ok", completion: "failure" },
  {
    pending: false,
    status: "error",
    candidateStartAttempted: true,
    backup: true,
    windows: true,
    recovered: true,
  },
])(
  "retains the backup across migrated finalization (pending=$pending, status=$status, start=$candidateStartAttempted, backup=$backup, windows=$windows, completion=$completion, recovered=$recovered)",
  async ({
    pending,
    status,
    candidateStartAttempted,
    backup,
    windows = false,
    handback = false,
    completion,
    recovered = false,
  }) => {
    const exitCode = status === "error" ? 1 : 0;
    const reason =
      status === "ok"
        ? "updated"
        : status === "skipped"
          ? "gateway-readiness-unverified"
          : "doctor-failed";
    const base = dirs.make("migrated-readiness-pending-");
    const { transaction, packageRoot } = await createRetainedPackageSwap(base);
    const env = { OPENCLAW_STATE_DIR: path.join(base, "state") };
    const run = {
      runId: createUpdateRun({ trigger: "cli" }, { env }).runId,
      env,
      activationTimeoutMs: 90_000,
    };
    const configSnapshot = await createConfigIO({ env, observe: false }).readConfigFileSnapshot();
    const windowsRecovery = taskRecovery();
    const settlePackage = transaction.complete.bind(transaction);
    const complete = vi.spyOn(transaction, "complete");
    const rollback = vi.spyOn(transaction, "rollback");
    vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const onResult = vi.fn();
    if (recovered) {
      windowsRecovery.complete.mockImplementationOnce(async () => {
        expect(stdout).not.toHaveBeenCalled();
        expect(onResult).not.toHaveBeenCalled();
      });
    }
    let stdoutAtCompletion: number | undefined;
    let observedAtCompletion: number | undefined;
    let candidateRow: unknown;
    const oldRuntimeOpens: string[] = [];
    const databasePath = path.join(env.OPENCLAW_STATE_DIR, "state", "openclaw.sqlite");
    const readCandidateRow = () => readMigratedUpdateRunRow(databasePath, run.runId);
    if (completion) {
      // Keep the successful package owner's real completion; inject only the
      // ordinary error that the canonical completion policy must classify.
      complete.mockImplementation(async (...args) => {
        stdoutAtCompletion = stdout.mock.calls.length;
        observedAtCompletion = onResult.mock.calls.length;
        if (completion === "failure") {
          throw new Error("fixture package completion unavailable");
        }
        return await settlePackage(...args);
      });
    }
    // Keep the real parent and package owner; model only the completed candidate's JSON reply.
    vi.spyOn(childCommands, "runUtf8CommandWithTimeout").mockImplementation(
      async (_argv, options) => {
        if (typeof options === "number" || typeof options.input !== "string") {
          throw new Error("Expected serialized finalization input");
        }
        const input: MigratedUpdateFinalizationInput = JSON.parse(options.input);
        expect(input.params).not.toHaveProperty("databaseBackup");
        const result = {
          ...input.params.result,
          status,
          reason,
          runId: run.runId,
          ...(recovered
            ? { recovery: { serviceRestartSafe: true, version: "2.0.0", service: "healthy" } }
            : {}),
          steps: pending
            ? [
                {
                  name: "gateway verification",
                  command: "gateway verification",
                  cwd: packageRoot,
                  durationMs: 90_000,
                  exitCode: 0,
                  termination: "timeout",
                  advisory: {
                    kind: "recoverable-maintenance",
                    message:
                      "Gateway is still starting after 90000ms; left running with readiness unverified.",
                  },
                },
              ]
            : [],
        };
        finishUpdateRun(
          run.runId,
          {
            status: status === "ok" ? "succeeded" : status === "skipped" ? "skipped" : "failed",
            reason,
          },
          { env },
        );
        if (completion) {
          candidateRow = readCandidateRow();
          closeOpenClawStateDatabaseForTest();
          const migrated = new DatabaseSync(databasePath);
          migrated.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1}`);
          migrated.close();
          const open = nodeSqlite.openNodeSqliteDatabase;
          vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockImplementation((...args) => {
            const openedPath = args[0];
            if (
              (openedPath.startsWith("file:") ? fileURLToPath(openedPath) : openedPath) ===
              databasePath
            ) {
              oldRuntimeOpens.push(args[0]);
            }
            return open(...args);
          });
        }
        await fs.writeFile(
          input.resultPath,
          JSON.stringify({ result, exitCode, terminalRunId: run.runId, candidateStartAttempted }),
        );
        return {
          stdout: "candidate finalization result\n",
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
          termination: "exit",
          cleanup: "normal",
        };
      },
    );

    const continueUpdate = () =>
      continueMigratedUpdateInFreshProcess(
        {
          mutationStarted: true,
          result: { status: "ok", mode: "npm", root: packageRoot, steps: [], durationMs: 1 },
          root: packageRoot,
          installKindChanged: false,
          configSnapshot,
          requestedChannel: null,
          storedChannel: "stable",
          channel: "stable",
          downgradeRisk: false,
          shouldRestart: true,
          opts: { json: true, run },
          preManagedServiceStop: {
            stopped: true,
            inspected: true,
            runtimeInspected: true,
            running: true,
            serviceEnv: env,
            ...(windows ? { windowsTaskAutoStartRecovery: windowsRecovery } : {}),
          },
          packageTransaction: transaction,
          ...(backup
            ? {
                databaseBackup: {
                  directory: path.join(transaction.backupRoot, "databases"),
                  databases: [],
                  missingPaths: [],
                  sourcePaths: [],
                  sourceGenerations: {},
                  warnings: [],
                },
              }
            : {}),
          controlPlaneUpdateSentinelMeta: null,
          preUpdatePluginInstallRecords: {},
          startedAt: Date.now(),
          packageUpdateNodeRunner: process.execPath,
          updateStepTimeoutMs: 90_000,
        },
        [],
      );
    let continuedResult: Awaited<ReturnType<typeof continueUpdate>> | undefined;
    const operation = withUpdateCommandTerminalResult(
      async (registerRun) => {
        registerRun(run);
        continuedResult = await continueUpdate();
        if (continuedResult.preparedFailure) {
          throw continuedResult.preparedFailure;
        }
        return continuedResult;
      },
      { json: true, onResult },
    );
    const settled = await operation.catch((error: unknown) => error);
    if (completion) {
      expect.soft(stdoutAtCompletion).toBe(0);
      expect.soft(observedAtCompletion).toBe(0);
      expect.soft(readCandidateRow()).toEqual(candidateRow);
      expect.soft(candidateRow).toMatchObject({ status: "succeeded", reason: "updated" });
      expect.soft(oldRuntimeOpens).toEqual([]);
      expect(rollback).not.toHaveBeenCalled();
      if (completion === "failure") {
        expect.soft(settled).toBeInstanceOf(UpdateCommandPendingRecoveryFailure);
        expect.soft(settled).toMatchObject({
          cause: expect.objectContaining({
            result: expect.objectContaining({ reason: "package-backup-retention-failed" }),
          }),
        });
        expect.soft(stdout).not.toHaveBeenCalled();
        expect(onResult).not.toHaveBeenCalled();
        await expect(fs.access(transaction.backupRoot)).resolves.toBeUndefined();
      } else {
        expect(settled).toMatchObject({ exitCode: 0, result: { status: "ok" } });
        expect(stdout).toHaveBeenCalledExactlyOnceWith("candidate finalization result\n");
        expect(onResult).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: "ok" }));
      }
      return;
    }
    if (exitCode !== 0 && !handback) {
      expect(settled).toBeInstanceOf(UpdateCommandFailure);
      expect(settled).not.toBeInstanceOf(UpdateCommandPendingRecoveryFailure);
    } else {
      expect(settled).toBe(continuedResult);
    }
    const outcome = continuedResult!;
    expect(outcome).toMatchObject({
      exitCode,
      result: { status },
    });
    expect(outcome.result.reason).toBe(reason);
    expect(outcome.candidateStartAttempted).toBe(candidateStartAttempted);
    expect(outcome.databaseRollbackAvailable).toBe(handback ? true : undefined);
    if (handback) {
      expect(stdout).not.toHaveBeenCalled();
      expect(onResult).not.toHaveBeenCalled();
    } else {
      expect(stdout).toHaveBeenCalledExactlyOnceWith("candidate finalization result\n");
      expect(onResult).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status }));
    }
    if (pending || handback) {
      expect(complete).not.toHaveBeenCalled();
    } else {
      expect(complete).toHaveBeenCalledExactlyOnceWith(
        { activationVerified: false },
        expect.any(Function),
      );
    }
    expect(rollback).not.toHaveBeenCalled();
    if (windows) {
      expect(windowsRecovery.complete).toHaveBeenCalledWith(pending || recovered);
      expect(windowsRecovery.complete).not.toHaveBeenCalledWith(!(pending || recovered));
    } else {
      expect(windowsRecovery.complete).not.toHaveBeenCalled();
    }
    await expect(
      fs.readFile(path.join(transaction.backupRoot, "package.json"), "utf8"),
    ).resolves.toContain('"version":"1.0.0"');
    await expect(fs.readFile(path.join(packageRoot, "package.json"), "utf8")).resolves.toContain(
      '"version":"2.0.0"',
    );
    if (handback) {
      await expect(transaction.rollback(() => {})).resolves.toMatchObject({ exitCode: 0 });
      await expect(fs.readFile(path.join(packageRoot, "package.json"), "utf8")).resolves.toContain(
        '"version":"1.0.0"',
      );
    }
  },
);

it("refuses state inspection when activation leaves no known runtime root", async () => {
  const result = { status: "error" as const, mode: "npm" as const, steps: [], durationMs: 0 };
  await expect(
    runtimeFixture.track(
      inspectActivatedUpdateState({
        result,
        root: candidateRoot,
        schemaVersions: [],
        config: {},
        env: { OPENCLAW_STATE_DIR: dirs.make("unknown-update-runtime-") },
      }),
    ),
  ).resolves.toBe("rollback-state-unverified");
  expect(result).toMatchObject({
    reason: "rollback-state-unverified",
    steps: [expect.objectContaining({ name: "state-schema-verification", exitCode: 1 })],
  });
});

it.each([
  { beforeContent: false, publish: false, blocked: "state-migrated-no-rollback" },
  { beforeContent: true, publish: false, blocked: undefined },
  { beforeContent: true, publish: true, blocked: undefined },
])(
  "accepts applied shared content through activation (alreadyApplied=$beforeContent, published=$publish)",
  async ({ beforeContent, publish, blocked }) => {
    const stateDir = await fs.realpath(dirs.make("update-deferred-content-"));
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const shared = openOpenClawStateDatabase({ env });
    const contentVersion = OPENCLAW_STATE_SCHEMA_VERSION + 1;
    const markContentApplied = () =>
      shared.db
        .prepare(
          "INSERT OR REPLACE INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
        )
        .run("state.schema.contentVersion", JSON.stringify(contentVersion), Date.now());
    if (beforeContent) {
      markContentApplied();
    }
    const schemaVersions = await readUpdateStateSchemaVersions({ stateDir, config: {}, env });
    markContentApplied();
    if (publish) {
      shared.db.exec(`PRAGMA user_version = ${contentVersion};`);
    }
    const result = {
      status: "ok" as const,
      mode: "npm" as const,
      root: candidateRoot,
      steps: [],
      durationMs: 0,
    };
    await expect(
      runtimeFixture.track(
        inspectActivatedUpdateState({
          result,
          root: candidateRoot,
          schemaVersions,
          candidateSchemaVersions: { state: contentVersion, agent: OPENCLAW_AGENT_SCHEMA_VERSION },
          config: {},
          env,
        }),
      ),
    ).resolves.toBe(blocked);
    expect(result).toMatchObject({ status: "ok", steps: [] });
    expect(shared.db.prepare("PRAGMA user_version").get()?.user_version).toBe(
      publish ? contentVersion : OPENCLAW_STATE_SCHEMA_VERSION,
    );
  },
);

it.each([
  { json: false, legacy: false, parentOwns: false },
  { json: true, legacy: false, parentOwns: true },
  { json: false, legacy: true, parentOwns: true },
  { json: true, legacy: true, parentOwns: true, foreground: true },
  { json: true, legacy: false, parentOwns: true, retained: true },
  { json: true, legacy: true, parentOwns: true, retained: true },
  { json: true, legacy: false, parentOwns: true, retained: true, original: true },
  { json: true, legacy: false, parentOwns: true, checkWorkMs: 31_000, stepBudgetMs: 120_000 },
  { json: true, legacy: false, parentOwns: true, checkWorkMs: 31_000, stepBudgetMs: 20_000 },
  { json: true, legacy: false, parentOwns: true, settlement: "healthy" },
  { json: true, legacy: false, parentOwns: true, settlement: "package" },
  { json: true, legacy: false, parentOwns: true, settlement: "scratch" },
  { json: true, legacy: false, parentOwns: true, settlement: "release" },
  { json: true, legacy: false, parentOwns: true, settlement: "no-owner" },
  { json: true, legacy: false, parentOwns: true, settlement: "swallowed" },
  { json: true, legacy: false, parentOwns: true, settlement: "uncertain-cleanup" },
])(
  "fences migrated candidate finalization (json=$json, legacy=$legacy, parentOwns=$parentOwns, foreground=$foreground, retained=$retained, original=$original, check=$checkWorkMs, budget=$stepBudgetMs, settlement=$settlement)",
  async ({
    json,
    legacy,
    parentOwns,
    foreground,
    retained,
    original,
    checkWorkMs,
    stepBudgetMs,
    settlement,
  }) => {
    const stateDir = await fs.realpath(dirs.make("migrated-update-"));
    const env = {
      ...process.env,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      OPENCLAW_TEST_RUNTIME_LOG: "1",
    };
    const root = legacy ? path.join(stateDir, "legacy-runtime") : candidateRoot;
    const legacyEffect = path.join(stateDir, "legacy-worker-effect");
    if (legacy) {
      const worker = path.join(root, "dist", "infra", "update-migrated-finalize.worker.js");
      await fs.mkdir(path.dirname(worker), { recursive: true });
      await fs.writeFile(
        worker,
        `
        const fs = require("node:fs");
        const { DatabaseSync } = require("node:sqlite");
        if (process.argv[2] === "--check") {
          process.stdout.write(JSON.stringify({state:${OPENCLAW_STATE_SCHEMA_VERSION + 1}, agent:${OPENCLAW_AGENT_SCHEMA_VERSION}${foreground || retained ? ', executorDelegation: "pid-start-v1"' : ""}}));
        } else {
          const input = JSON.parse(fs.readFileSync(0,"utf8"));
          fs.writeFileSync(${JSON.stringify(legacyEffect)}, "unfenced effect");
          const db = new DatabaseSync(${JSON.stringify(path.join(stateDir, "state", "openclaw.sqlite"))});
          db.prepare("UPDATE update_runs SET status = 'failed', phase = 'finished', finished_at_ms = 1 WHERE run_id = ?").run(input.params.opts.run.runId);
          db.close();
          fs.writeFileSync(input.resultPath, JSON.stringify({result:{...input.params.result,runId:input.params.opts.run.runId},exitCode:1,terminalRunId:input.params.opts.run.runId}));
        }
      `,
      );
    }
    const created = createUpdateRun({ trigger: foreground ? "api" : "cli" }, { env });
    const parentDriver = parentOwns
      ? adoptUpdateRun(created.runId, { env }).origin.driver
      : undefined;
    const run = {
      runId: created.runId,
      env,
      ...(foreground ? { completionOwner: "gateway-restart" as const } : {}),
    };
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    vi.useFakeTimers();
    presentation = createUpdateProgress(!json, run);
    const progress = createUpdateRunProgress(run, presentation.progress);
    presentation.suspend();
    progress.deferLedgerWrites();
    const migrationStep = { name: "core migrations", command: "doctor --fix", index: 0, total: 1 };
    progress.onStepStart?.(migrationStep);
    const database = openOpenClawStateDatabase({ env });
    expect(database.db.prepare("PRAGMA user_version").get()).toEqual({
      user_version: OPENCLAW_STATE_SCHEMA_VERSION,
    });
    // Original runtime intent belongs to the pre-migration observation. The old
    // parent must not reopen its state DB after the candidate advances the schema.
    const originalRuntimePin = original
      ? readDaemonRuntimePin({ kind: "gateway", env }, { programArguments: [] })
      : undefined;
    const migrated = new DatabaseSync(database.path);
    try {
      migrated.exec(`
      BEGIN IMMEDIATE;
      PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1};
      UPDATE schema_meta SET schema_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1} WHERE meta_key = 'primary';
      COMMIT;
    `);
    } finally {
      migrated.close();
    }
    expect(() =>
      recordUpdateRunStep(created.runId, { step: "old writer", status: "completed" }, { env }),
    ).toThrow(/newer schema version/);
    const rollbackOutcome = {
      status: "not-attempted" as const,
      reason: "state-migrated-no-rollback",
    };
    expect(() => progress.onRollbackOutcome?.(rollbackOutcome)).not.toThrow();
    expect(() =>
      progress.onStepComplete?.({ ...migrationStep, durationMs: 100, exitCode: 1 }),
    ).not.toThrow();
    expect(() => vi.advanceTimersByTime(500)).not.toThrow();
    expect(() => presentation?.dispose()).not.toThrow();
    presentation = undefined;
    vi.useRealTimers();
    const rollback = vi.fn();
    let terminalAtCleanup: unknown;
    let terminalFromCandidate: unknown;
    let stdoutAtCleanup: string | undefined;
    let stdoutAtExecutorSettlement: string | undefined;
    const oldRuntimeOpens: string[] = [];
    const onResult = vi.fn();
    let settledResult: Awaited<ReturnType<typeof continueMigratedUpdateInFreshProcess>> | undefined;
    let stdout = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout += String(chunk);
      return true;
    });

    const control = path.join(stateDir, "executor-control");
    await fs.mkdir(control);
    vi.spyOn(temporaryState, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
    const inspectTerminal = () => readMigratedUpdateRunRow(database.path, created.runId);
    if (settlement === "scratch") {
      const remove = fs.rm;
      vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
        await remove(...args);
        if (path.basename(String(args[0])).startsWith("openclaw-update-migrated-")) {
          throw new Error("fixture migrated scratch cleanup refused");
        }
      });
    }
    const family = async () =>
      Promise.all(
        [database.path, database.path + "-wal", database.path + "-shm"].map((file) =>
          fs.readFile(file).catch((error: unknown) => {
            if (hasNodeErrorCode(error, "ENOENT")) {
              return null;
            }
            throw new Error("Could not inspect the isolated database family.", { cause: error });
          }),
        ),
      );
    const before = legacy ? await family() : undefined;
    const nativeCommand = childCommands.runUtf8CommandWithTimeout;
    vi.spyOn(childCommands, "runUtf8CommandWithTimeout").mockImplementation(
      async (argv, options): ReturnType<typeof nativeCommand> => {
        const child = await nativeCommand(
          legacy
            ? argv
            : [
                process.execPath,
                ...resolveRuntimeWorkerArgv(
                  resolveRuntimeWorkerUrl(migratedFinalizeFixtureEntrypoint),
                ),
                JSON.stringify(runtimeProcessEntrypoints.sqliteReadOnly),
                ...argv.slice(2),
              ],
          options,
        );
        const allowance = typeof options === "number" ? options : options.timeoutMs;
        if (settlement && argv.at(-1) !== "--check") {
          terminalFromCandidate = inspectTerminal();
          const open = nodeSqlite.openNodeSqliteDatabase;
          vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockImplementation((...args) => {
            const openedPath = args[0];
            if (
              (openedPath.startsWith("file:") ? fileURLToPath(openedPath) : openedPath) ===
              database.path
            ) {
              oldRuntimeOpens.push(args[0]);
            }
            return open(...args);
          });
        }
        // Keep the native admission/cleanup flow; model cold-start work in this phase only.
        return checkWorkMs !== undefined &&
          argv.at(-1) === "--check" &&
          (allowance ?? Infinity) < checkWorkMs
          ? { ...child, code: 124, stdout: "", killed: true, termination: "timeout" }
          : child;
      },
    );
    const uncertainCleanup = new CommandProcessCleanupError();
    const execute = (
      registerRun?: Parameters<Parameters<typeof withUpdateCommandTerminalResult>[0]>[0],
    ) =>
      withUpdateCommandExecutor(run.runId, async (executor) => {
        const serviceRoot = retained ? path.join(stateDir, "service-A") : undefined;
        if (serviceRoot) {
          await fs.mkdir(serviceRoot);
          if (original) {
            await fs.writeFile(
              path.join(serviceRoot, "package.json"),
              JSON.stringify({
                name: "openclaw",
                version: "2026.9.3",
                type: "module",
              }),
            );
          }
        }
        const originalFingerprint =
          original && serviceRoot
            ? await createPackageIntegrityReader().tree(serviceRoot)
            : undefined;
        const unverifiedLauncher: PackageLauncherFingerprint = {
          type: "file",
          mode: "33188",
          uid: "0",
          gid: "0",
          contents: "unverified",
        };
        const executorFence = await executor.enter(root, { serviceRoot });
        const scopedRun = { ...run, executorFence };
        if (settlement !== "no-owner") {
          registerRun?.(scopedRun);
        }
        const continued = await continueMigratedUpdateInFreshProcess(
          {
            mutationStarted: true,
            ...(originalFingerprint && serviceRoot
              ? {
                  originalManagedServiceRuntime: {
                    root: serviceRoot,
                    nodeRunner: process.execPath,
                    version: "2026.9.3",
                    verified: false,
                    definition: {
                      command: { programArguments: [] },
                      fingerprint: "unverified",
                      runtimePin: originalRuntimePin!,
                    },
                    service: { serviceEnv: env },
                    packageFingerprint: originalFingerprint,
                    packageIdentity: originalFingerprint,
                    // Deliberately uncertified; these fields must not grant recovery.
                    launcher: {
                      path: path.join(serviceRoot, "unverified-launcher"),
                      realPath: path.join(serviceRoot, "unverified-launcher"),
                      fingerprint: unverifiedLauncher,
                      targetFingerprint: unverifiedLauncher,
                    },
                    nodeIdentity: "unverified-original-service-fixture",
                  },
                }
              : {}),
            result: {
              status: "error",
              reason: "doctor-failed",
              rollbackOutcome,
              mode: "npm",
              root,
              steps: [],
              durationMs: 0,
            },
            root,
            installKindChanged: false,
            configSnapshot: {
              path: path.join(stateDir, "openclaw.json"),
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
            shouldRestart: false,
            opts: { json, run: scopedRun },
            packageTransaction: {
              backupRoot: path.join(stateDir, "retained-package"),
              rollback,
              complete: async () => {
                stdoutAtCleanup = stdout;
                const inspected = new DatabaseSync(database.path, { readOnly: true });
                try {
                  terminalAtCleanup = inspected
                    .prepare("SELECT status, reason FROM update_runs WHERE run_id = ?")
                    .get(created.runId);
                } finally {
                  inspected.close();
                }
                if (settlement === "package") {
                  throw new UpdateCommandPendingRecoveryFailure(
                    {
                      status: "error",
                      mode: "npm",
                      root,
                      runId: run.runId,
                      steps: [],
                      durationMs: 0,
                    },
                    "fixture migrated package completion refused",
                  );
                }
              },
            },
            controlPlaneUpdateSentinelMeta: null,
            preUpdatePluginInstallRecords: {},
            startedAt: Date.now(),
            packageUpdateNodeRunner: process.execPath,
            updateStepTimeoutMs: stepBudgetMs ?? 30_000,
            rollbackBlockedReason: "state-migrated-no-rollback",
          },
          progress.pendingSteps,
        );
        settledResult = continued;
        stdoutAtExecutorSettlement = stdout;
        if (settlement === "release") {
          const leases = new DatabaseSync(path.join(control, "managed-update-handoffs.sqlite"));
          try {
            // Refuse the real owner's final DELETE, after the delegated child has settled.
            leases.exec(
              "CREATE TRIGGER deny_migrated_release BEFORE DELETE ON managed_update_handoffs BEGIN SELECT RAISE(FAIL, 'fixture migrated release refused'); END",
            );
          } finally {
            leases.close();
          }
        }
        if (settlement === "uncertain-cleanup") {
          throw uncertainCleanup;
        }
        if (continued.preparedFailure && settlement !== "swallowed") {
          throw continued.preparedFailure;
        }
        return continued;
      });
    const refusesBeforeHandoff =
      legacy ||
      (checkWorkMs !== undefined && stepBudgetMs !== undefined && stepBudgetMs < checkWorkMs);
    const work = refusesBeforeHandoff
      ? execute()
      : withUpdateCommandTerminalResult(execute, { json, onResult });
    void runtimeFixture.track(work);
    if (settlement) {
      const failure = await work.catch((error: unknown) => error);
      expect.soft(stdoutAtCleanup).toBe(settlement === "no-owner" ? undefined : "");
      if (
        settlement === "healthy" ||
        settlement === "release" ||
        settlement === "swallowed" ||
        settlement === "uncertain-cleanup"
      ) {
        expect.soft(stdoutAtExecutorSettlement).toBe("");
      }
      expect.soft(oldRuntimeOpens).toEqual([]);
      expect.soft(inspectTerminal()).toEqual(terminalFromCandidate);
      expect
        .soft(terminalFromCandidate)
        .toMatchObject({ status: "failed", reason: "state-migrated-no-rollback" });
      if (settlement !== "healthy") {
        if (settlement === "uncertain-cleanup") {
          expect.soft(hasCommandProcessCleanupError(failure)).toBe(true);
          expect.soft(collectNestedErrorCandidates(failure)).toContain(uncertainCleanup);
        } else {
          expect.soft(failure).toBeInstanceOf(UpdateCommandPendingRecoveryFailure);
        }
        expect.soft(stdout).toBe("");
        expect.soft(onResult).not.toHaveBeenCalled();
        expect(rollback).not.toHaveBeenCalled();
        return;
      }
      expect(failure).toBeInstanceOf(UpdateCommandFailure);
      expect(failure).not.toBeInstanceOf(UpdateCommandPendingRecoveryFailure);
      expect(onResult).toHaveBeenCalledExactlyOnceWith(settledResult?.result);
    }
    if (checkWorkMs !== undefined && stepBudgetMs !== undefined && stepBudgetMs < checkWorkMs) {
      await expect(work).rejects.toThrow(/delegation capability could not be inspected/);
      expect(terminalAtCleanup).toBeUndefined();
      expect(rollback).not.toHaveBeenCalled();
      return;
    }
    if (legacy) {
      await expect(work).rejects.toThrow(
        foreground ? /cannot defer foreground update completion/ : /live executor delegation/,
      );
      await expect(fs.access(legacyEffect)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await family()).toEqual(before);
      expect(terminalAtCleanup).toBeUndefined();
      return;
    }
    if (!settlement) {
      await expect(work).rejects.toBeInstanceOf(UpdateCommandFailure);
    }
    const result = settledResult!;
    expect(result.candidateStartAttempted).toBe(false);
    expect(result.automaticTriage).toMatchObject({
      kind: "update",
      phase: "state-migrated-no-rollback",
      installationRoot: root,
      gateway: "preserve",
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.result).toMatchObject({
      runId: created.runId,
      status: "error",
      reason: "state-migrated-no-rollback",
    });
    if (original) {
      expect(result.result.steps).toContainEqual(
        expect.objectContaining({
          name: "original-managed-service-compensation",
          cwd: path.join(stateDir, "service-A"),
          exitCode: 1,
        }),
      );
      expect(result.result.recovery?.serviceRestartSafe).toBe(false);
    } else {
      expect(result.result.steps).toContainEqual(
        expect.objectContaining({
          name: "gateway recovery verification",
          failureFacts: [expect.objectContaining({ message: MIGRATED_FIXTURE_NO_SERVICE })],
        }),
      );
    }
    expect(rollback).not.toHaveBeenCalled();
    expect(terminalAtCleanup).toEqual({ status: "failed", reason: "state-migrated-no-rollback" });
    if (json) {
      expect(log).not.toHaveBeenCalled();
      expect(JSON.parse(stdout)).toMatchObject({
        runId: created.runId,
        run: { runId: created.runId, status: "failed", reason: "state-migrated-no-rollback" },
      });
    } else {
      expect(stdout).toMatch(/update failed/iu);
    }
    const inspected = new DatabaseSync(database.path, { readOnly: true });
    try {
      const row = inspected
        .prepare(
          "SELECT status, reason, origin_json, steps_json, verification_json FROM update_runs WHERE run_id = ?",
        )
        .get(created.runId);
      expect(row).toMatchObject({ status: "failed", reason: "state-migrated-no-rollback" });
      expect(JSON.parse(String(row?.verification_json)).rollbackOutcome).toEqual(rollbackOutcome);
      expect(JSON.parse(String(row?.steps_json))).toEqual(
        expect.arrayContaining([progress.pendingSteps.at(-1)]),
      );
      const origin = JSON.parse(String(row?.origin_json));
      const driver = origin.driver;
      expect(driver).toMatchObject({
        host: os.hostname(),
        pid: expect.any(Number),
        startIdentity: expect.any(String),
      });
      expect(driver.pid).not.toBe(process.pid);
      expect(origin.previousDrivers).toEqual(parentOwns ? [parentDriver] : undefined);
    } finally {
      inspected.close();
    }
  },
  30_000,
);
