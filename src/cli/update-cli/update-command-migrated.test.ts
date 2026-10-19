import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { createFixtureLifetime } from "../../../test/helpers/fixture-lifetime.js";
import { openFixtureReceiptChannel } from "../../../test/helpers/fixture-receipts.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { asResolvedSourceConfig, asRuntimeConfig } from "../../config/materialize.js";
import { readDaemonRuntimePin } from "../../daemon/runtime-pin-state.js";
import * as nodeSqlite from "../../infra/node-sqlite.js";
import {
  createPackageIntegrityReader,
  type PackageLauncherFingerprint,
} from "../../infra/package-update-integrity.js";
import { hasNodeErrorCode } from "../../infra/path-guards.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../infra/runtime-worker-url.js";
import { resolveSqliteDatabaseFilePath } from "../../infra/sqlite-database-admission.js";
import { migrateDaemonRuntimePins } from "../../infra/state-migrations.daemon-runtime-pins.js";
import * as temporaryState from "../../infra/tmp-openclaw-dir.js";
import {
  adoptUpdateRun,
  createUpdateRun,
  recordUpdateRunStep,
} from "../../infra/update-run-ledger.js";
import {
  CommandProcessCleanupError,
  hasCommandProcessCleanupError,
} from "../../process/exec-result.js";
import * as childCommandBuffers from "../../process/exec-runner.js";
import * as childCommands from "../../process/exec.js";
import { defaultRuntime } from "../../runtime.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../../state/openclaw-agent-db-contract.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db-contract.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { createUpdateProgress } from "./progress.js";
import { prepareCandidateAuthorityRuntime } from "./update-command-candidate-authority.test-support.js";
import { createUpdateCommandExecutionGuards } from "./update-command-execution-guards.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import {
  MIGRATED_FIXTURE_NO_SERVICE,
  migratedFinalizeFixtureEntrypoint,
} from "./update-command-migrated-fixture-entrypoint.test-support.js";
import {
  expectMigratedPackageFinalization,
  type MigratedPackageFinalizationCase,
} from "./update-command-migrated-package.test-support.js";
import { continueMigratedUpdateInFreshProcess } from "./update-command-migrated.js";
import { readMigratedUpdateRunRow } from "./update-command-migrated.test-support.js";
import {
  UpdateCommandFailure,
  UpdateCommandPendingRecoveryFailure,
} from "./update-command-result.js";
import { createUpdateRunProgress } from "./update-command-run.js";
import { withUpdateCommandTerminalResult } from "./update-command-terminal.js";

// Model the already-running updater's older schema contract. The candidate
// worker is a real unmocked process with the checkout's current contract.
vi.mock("../../state/openclaw-schema-versions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/openclaw-schema-versions.js")>();
  return { ...actual, OPENCLAW_STATE_SCHEMA_VERSION: actual.OPENCLAW_STATE_SCHEMA_VERSION - 1 };
});

const runtimeFixture = createFixtureLifetime();
let candidateRoot: string;
let candidateContract: Awaited<ReturnType<typeof childCommands.runUtf8CommandWithTimeout>>;
beforeAll(async () => {
  const runtime = await runtimeFixture.run(() =>
    prepareCandidateAuthorityRuntime(runtimeFixture.createTempDir("migrated-candidate-runtime-")),
  );
  candidateRoot = fileURLToPath(new URL("../../", runtime.worker));
  const stateDir = runtimeFixture.createTempDir("migrated-candidate-contract-");
  // The immutable candidate's compatibility probe is shared; each delegated
  // finalizer still runs in its own process with its own live executor grant.
  candidateContract = await runtimeFixture.run(() =>
    childCommands.runUtf8CommandWithTimeout(
      [
        process.execPath,
        ...resolveRuntimeWorkerArgv(resolveRuntimeWorkerUrl(migratedFinalizeFixtureEntrypoint)),
        JSON.stringify({ readOnlyEntrypoint: runtimeProcessEntrypoints.sqliteReadOnly }),
        "--check",
      ],
      {
        cwd: candidateRoot,
        env: {
          ...process.env,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
        },
        timeoutMs: 30_000,
        killProcessTree: true,
        requireProcessTreeExtinction: true,
      },
    ),
  );
  expect(candidateContract).toMatchObject({ code: 0, termination: "exit", cleanup: "normal" });
});
afterAll(() => runtimeFixture.cleanup());

const dirs = useAutoCleanupTempDirTracker(afterEach);
let presentation: ReturnType<typeof createUpdateProgress> | undefined;
afterEach(async () => {
  presentation?.suspend();
  presentation?.dispose();
  presentation = undefined;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  await closeStateDatabaseForTest();
});

it.each<MigratedPackageFinalizationCase>([
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
  { pending: false, status: "error", diagnostics: "interrupted" },
  { pending: false, status: "error", diagnostics: "truncated" },
  { pending: false, status: "error", diagnostics: "incomplete" },
  {
    pending: false,
    status: "error",
    candidateStartAttempted: true,
    backup: true,
    windows: true,
    recovered: true,
  },
])(
  "retains the backup across migrated finalization (pending=$pending, status=$status, start=$candidateStartAttempted, backup=$backup, windows=$windows, completion=$completion, recovered=$recovered, diagnostics=$diagnostics)",
  async (scenario) => {
    await expectMigratedPackageFinalization(dirs.make("migrated-readiness-pending-"), scenario);
  },
);

it.for([
  { json: false, legacy: false, parentOwns: false, replay: "settled" },
  { json: true, legacy: false, parentOwns: true, replay: "refused" },
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
  "fences migrated candidate finalization (json=$json, legacy=$legacy, parentOwns=$parentOwns, foreground=$foreground, retained=$retained, original=$original, check=$checkWorkMs, budget=$stepBudgetMs, settlement=$settlement, replay=$replay)",
  { timeout: 30_000 },
  async (
    {
      json,
      legacy,
      parentOwns,
      foreground,
      retained,
      original,
      checkWorkMs,
      stepBudgetMs,
      settlement,
      replay,
    },
    { signal },
  ) => {
    const stateDir = await fs.realpath(dirs.make("migrated-update-"));
    const env = {
      ...process.env,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      OPENCLAW_TEST_RUNTIME_LOG: "1",
    };
    const root = legacy ? path.join(stateDir, "legacy-runtime") : candidateRoot;
    const legacyEffect = path.join(stateDir, "legacy-worker-effect");
    const replayEvents = path.join(stateDir, "receiver-replay.jsonl");
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
    if (original) {
      expect((await migrateDaemonRuntimePins(env)).warnings).toEqual([]);
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
    const guards = createUpdateCommandExecutionGuards({ run }, root);
    const progress = createUpdateRunProgress(run, presentation.progress, guards.recordStep);
    presentation.suspend();
    progress.deferLedgerWrites();
    const migrationStep = { name: "core migrations", command: "doctor --fix", index: 0, total: 1 };
    await progress.onStepStart?.(migrationStep);
    const database = openOpenClawStateDatabase({ env });
    expect(database.db.prepare("PRAGMA user_version").get()).toEqual({
      user_version: OPENCLAW_STATE_SCHEMA_VERSION,
    });
    // Original runtime intent belongs to the pre-migration observation. The old
    // parent must not reopen its state DB after the candidate advances the schema.
    const originalRuntimePin = original
      ? readDaemonRuntimePin({ kind: "gateway", env }, { programArguments: [] })
      : undefined;
    // The migration owner publishes its committed schema to the already-running updater.
    const migrated = nodeSqlite.openNodeSqliteDatabase(database.path);
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
    await expect(
      progress.onStepComplete?.({ ...migrationStep, durationMs: 100, exitCode: 1 }),
    ).resolves.toBeUndefined();
    expect(() => vi.advanceTimersByTime(500)).not.toThrow();
    expect(() => presentation?.dispose()).not.toThrow();
    presentation = undefined;
    vi.useRealTimers();
    const rollback = vi.fn();
    let terminalAtCleanup: unknown;
    let terminalFromCandidate: unknown;
    let stdoutAtCleanup: string | undefined;
    let stdoutAtExecutorSettlement: string | undefined;
    const progressGate =
      settlement === "healthy"
        ? await runtimeFixture.acquire(async () => {
            const receipts = await openFixtureReceiptChannel();
            return { ...receipts, cleanup: () => receipts.close() };
          })
        : undefined;
    const progressSeen = createDeferred();
    let stderr = "";
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr += String(chunk);
      if (stderr.includes("fixture-finalizer-progress")) {
        progressSeen.resolve();
      }
      return true;
    });
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
    const nativeProbe = childCommands.runUtf8CommandWithTimeout;
    vi.spyOn(childCommands, "runUtf8CommandWithTimeout").mockImplementation(
      async (argv, options) => {
        const child = legacy ? await nativeProbe(argv, options) : candidateContract;
        const allowance = typeof options === "number" ? options : options.timeoutMs;
        // Keep the native admission/cleanup flow; model cold-start work in this phase only.
        return checkWorkMs !== undefined && (allowance ?? Infinity) < checkWorkMs
          ? { ...child, code: 124, stdout: "", killed: true, termination: "timeout" }
          : child;
      },
    );
    const nativeCommand = childCommandBuffers.runUtf8CommandBuffersWithTimeout;
    let replayChild: Awaited<ReturnType<typeof nativeCommand>> | undefined;
    vi.spyOn(childCommandBuffers, "runUtf8CommandBuffersWithTimeout").mockImplementation(
      async (argv, options): ReturnType<typeof nativeCommand> => {
        const child = await nativeCommand(
          legacy
            ? argv
            : [
                process.execPath,
                ...resolveRuntimeWorkerArgv(
                  resolveRuntimeWorkerUrl(migratedFinalizeFixtureEntrypoint),
                ),
                JSON.stringify({
                  readOnlyEntrypoint: runtimeProcessEntrypoints.sqliteReadOnly,
                  progressGate: progressGate?.endpoint,
                  ...(replay
                    ? {
                        replay: {
                          path: replayEvents,
                          refuseStep: replay === "refused" ? "receiver-second" : undefined,
                        },
                      }
                    : {}),
                }),
                ...argv.slice(2),
              ],
          options,
        );
        if (replay) {
          replayChild = child;
        }
        if (settlement) {
          terminalFromCandidate = inspectTerminal();
          const open = nodeSqlite.openNodeSqliteDatabase;
          const migratedStateLocation = nodeSqlite.resolveNodeSqliteLocation(database.path);
          vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockImplementation((...args) => {
            // SQLite encodes Windows filenames separately from file URLs. The
            // observer must not turn the executor's lease writes into failed cleanup.
            const openedPath = nodeSqlite.resolveNodeSqliteLocation(
              resolveSqliteDatabaseFilePath(args[0]),
            );
            if (openedPath === migratedStateLocation) {
              oldRuntimeOpens.push(args[0]);
            }
            return open(...args);
          });
        }
        return child;
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
          [
            ...progress.pendingSteps,
            ...(replay
              ? [
                  { step: "receiver-first", status: "completed" as const },
                  { step: "receiver-second", status: "completed" as const },
                ]
              : []),
          ],
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
      if (progressGate) {
        try {
          await withinTest(
            awaitGateBeforeSettlement(
              Promise.all([progressGate.waitFor("finalizer", "waiting"), progressSeen.promise]),
              work,
              "Finalizer settled before forwarding live progress",
            ),
            signal,
          );
          expect(stdout).toBe("");
          expect(terminalFromCandidate).toBeUndefined();
        } finally {
          progressGate.release("finalizer", "finish");
        }
      }
      const failure = await work.catch((error: unknown) => error);
      await progressGate?.cleanup();
      expect.soft(stderr.match(/fixture-finalizer-progress/g)).toHaveLength(1);
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
    if (replay) {
      const outcome = await work.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      const trace = await fs.readFile(replayEvents, "utf8").catch((error: unknown) => {
        if (hasNodeErrorCode(error, "ENOENT")) {
          return "";
        }
        throw error;
      });
      const events = trace.trim()
        ? trace
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
        : [];
      expect(events.slice(0, 8)).toEqual([
        { event: "entered", step: "receiver-first" },
        { event: "transaction", step: "receiver-first" },
        { event: "commit", step: "receiver-first" },
        { event: "settled", step: "receiver-first" },
        { event: "entered", step: "receiver-second" },
        { event: "transaction", step: "receiver-second" },
        { event: "commit", step: "receiver-second" },
        { event: replay === "refused" ? "rejected" : "settled", step: "receiver-second" },
      ]);
      if (replay === "refused") {
        expect(outcome).toHaveProperty("error");
        expect(replayChild).toMatchObject({ code: 1, termination: "exit", cleanup: "normal" });
        expect(replayChild?.stderr.toString("utf8")).toContain("receiver replay commit refused");
        expect(events).not.toContainEqual({ event: "service" });
        expect(terminalAtCleanup).toBeUndefined();
        expect(rollback).not.toHaveBeenCalled();
        const inspected = new DatabaseSync(database.path, { readOnly: true });
        try {
          const row = inspected
            .prepare("SELECT steps_json FROM update_runs WHERE run_id = ?")
            .get(created.runId);
          const steps = JSON.parse(String(row?.steps_json));
          expect(steps).toContainEqual(
            expect.objectContaining({ step: "receiver-first", status: "completed" }),
          );
          expect(steps).not.toContainEqual(expect.objectContaining({ step: "receiver-second" }));
        } finally {
          inspected.close();
        }
        return;
      }
      expect(outcome).toEqual({ error: expect.any(UpdateCommandFailure) });
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
);
