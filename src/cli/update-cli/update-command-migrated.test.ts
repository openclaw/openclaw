import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { writePackageDistInventory } from "../../../scripts/lib/package-dist-inventory.ts";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as triageUpdate from "../../commands/triage-update.js";
import { asResolvedSourceConfig, asRuntimeConfig } from "../../config/materialize.js";
import { appendTranscriptEventsInTransaction } from "../../config/sessions/session-accessor.sqlite-transcript-store.js";
import {
  openPackageActivationJournal,
  resolvePackageActivationAnchor,
} from "../../infra/package-update-activation-journal.js";
import {
  swapStagedPackageInstall,
  type PackageUpdateTransaction,
} from "../../infra/package-update-swap.js";
import { createPackageSwapFixture } from "../../infra/package-update-swap.test-support.js";
import { hasNodeErrorCode } from "../../infra/path-guards.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import * as temporaryState from "../../infra/tmp-openclaw-dir.js";
import { readUpdateStateSchemaVersions } from "../../infra/update-candidate-state.js";
import * as ledger from "../../infra/update-run-ledger.js";
import {
  adoptUpdateRun,
  createUpdateRun,
  recordUpdateRunStep,
} from "../../infra/update-run-ledger.js";
import * as triage from "../../infra/update-triage.js";
import * as commandExecution from "../../process/exec.js";
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
import * as stateDatabase from "../../state/openclaw-state-db.js";
import { createUpdateProgress } from "./progress.js";
import type { UpdateCommandOptions } from "./shared.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import type { FinishUpdateParams } from "./update-command-finish-types.js";
import {
  continueMigratedUpdateInFreshProcess,
  inspectActivatedUpdateState,
} from "./update-command-migrated.js";
import { createUpdateRunProgress } from "./update-command-run.js";
import { withUpdateFailureTriage } from "./update-command-triage.js";

// Model the already-running updater's older schema contract. The candidate
// worker is a real unmocked process with the checkout's current contract.
vi.mock("../../state/openclaw-state-db-contract.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/openclaw-state-db-contract.js")>();
  return { ...actual, OPENCLAW_STATE_SCHEMA_VERSION: actual.OPENCLAW_STATE_SCHEMA_VERSION - 1 };
});

let retainTemporaryFixtures = false;
let activeWork: Promise<void> | undefined;
let commandCancellation: AbortController | undefined;
let pendingCommands = 0;
const dirs = createTempDirTracker();
let presentation: ReturnType<typeof createUpdateProgress> | undefined;
afterEach(async () => {
  commandCancellation?.abort();
  // Vitest timeout rejects its wrapper before the callback settles. Join the
  // real callback, including executor unwind, before restoring mocks or deleting files.
  await activeWork?.catch(() => undefined);
  if (pendingCommands !== 0) {
    retainTemporaryFixtures = true;
    throw new Error("Migrated test commands have not settled");
  }
  activeWork = undefined;
  commandCancellation = undefined;
  presentation?.suspend();
  presentation?.dispose();
  presentation = undefined;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  // An uncertain command owner may still have descendants using these fixtures.
  if (!retainTemporaryFixtures) {
    dirs.cleanup();
  }
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
      root: process.cwd(),
      steps: [],
      durationMs: 0,
    };
    await expect(
      inspectActivatedUpdateState({
        result,
        root: process.cwd(),
        schemaVersions,
        candidateSchemaVersions: {
          state: OPENCLAW_STATE_SCHEMA_VERSION + Number(changed === "shared"),
          agent: OPENCLAW_AGENT_SCHEMA_VERSION,
        },
        config: {},
        env,
      }),
    ).resolves.toBe(blocked);
  },
);

it("refuses state inspection when activation leaves no known runtime root", async () => {
  const result = { status: "error" as const, mode: "npm" as const, steps: [], durationMs: 0 };
  await expect(
    inspectActivatedUpdateState({
      result,
      root: process.cwd(),
      schemaVersions: [],
      config: {},
      env: { OPENCLAW_STATE_DIR: dirs.make("unknown-update-runtime-") },
    }),
  ).resolves.toBe("rollback-state-unverified");
  expect(result).toMatchObject({
    reason: "rollback-state-unverified",
    steps: [expect.objectContaining({ name: "state schema verification", exitCode: 1 })],
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
      root: process.cwd(),
      steps: [],
      durationMs: 0,
    };
    await expect(
      inspectActivatedUpdateState({
        result,
        root: process.cwd(),
        schemaVersions,
        candidateSchemaVersions: { state: contentVersion, agent: OPENCLAW_AGENT_SCHEMA_VERSION },
        config: {},
        env,
      }),
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
])(
  "fences migrated candidate finalization (json=$json, legacy=$legacy, parentOwns=$parentOwns)",
  async ({ json, legacy, parentOwns }) => {
    const stateDir = await fs.realpath(dirs.make("migrated-update-"));
    const env = {
      ...process.env,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      OPENCLAW_TEST_RUNTIME_LOG: "1",
    };
    const root = legacy ? path.join(stateDir, "legacy-runtime") : process.cwd();
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
          process.stdout.write(JSON.stringify({state:${OPENCLAW_STATE_SCHEMA_VERSION + 1}, agent:${OPENCLAW_AGENT_SCHEMA_VERSION}}));
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
    const created = createUpdateRun({ trigger: "cli" }, { env });
    const parentDriver = parentOwns
      ? adoptUpdateRun(created.runId, { env }).origin.driver
      : undefined;
    const run = { runId: created.runId, env };
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
    expect(() =>
      progress.onStepComplete?.({ ...migrationStep, durationMs: 100, exitCode: 1 }),
    ).not.toThrow();
    expect(() => vi.advanceTimersByTime(500)).not.toThrow();
    expect(() => presentation?.dispose()).not.toThrow();
    presentation = undefined;
    vi.useRealTimers();
    const rollback = vi.fn();
    let terminalAtCleanup: unknown;
    let stdout = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout += String(chunk);
      return true;
    });

    const control = path.join(stateDir, "executor-control");
    await fs.mkdir(control);
    vi.spyOn(temporaryState, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
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
    const work = withUpdateCommandExecutor(run.runId, async (executor) => {
      const executorFence = await executor.enter(root);
      return await continueMigratedUpdateInFreshProcess(
        {
          mutationStarted: true,
          result: {
            status: "error",
            reason: "doctor-failed",
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
          opts: { json, run: { ...run, executorFence } },
          packageTransaction: {
            backupRoot: path.join(stateDir, "retained-package"),
            rollback,
            complete: async () => {
              const inspected = new DatabaseSync(database.path, { readOnly: true });
              try {
                terminalAtCleanup = inspected
                  .prepare("SELECT status, reason FROM update_runs WHERE run_id = ?")
                  .get(created.runId);
              } finally {
                inspected.close();
              }
            },
          },
          controlPlaneUpdateSentinelMeta: null,
          preUpdatePluginInstallRecords: {},
          startedAt: Date.now(),
          packageUpdateNodeRunner: process.execPath,
          updateStepTimeoutMs: 1_000,
          rollbackBlockedReason: "state-migrated-no-rollback",
        },
        progress.pendingSteps,
      );
    });
    if (legacy) {
      await expect(work).rejects.toThrow(/live executor delegation/);
      await expect(fs.access(legacyEffect)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await family()).toEqual(before);
      expect(terminalAtCleanup).toBeUndefined();
      return;
    }
    const result = await work;
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
        .prepare("SELECT status, reason, origin_json, steps_json FROM update_runs WHERE run_id = ?")
        .get(created.runId);
      expect(row).toMatchObject({ status: "failed", reason: "state-migrated-no-rollback" });
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

it
  .skipIf(process.platform === "win32")
  .for([
    "healthy",
    "ordinary-healthy",
    "journal-error",
    "link-refusal",
    "maintenance-warning",
    "failed-child",
  ] as const)(
  "settles real migrated candidate output before parent package completion (%s)",
  { timeout: 30_000 },
  (kind, { signal }) => {
    if (activeWork) {
      throw new Error("Previous migrated test operation has not settled");
    }
    commandCancellation = new AbortController();
    const cancellation = AbortSignal.any([signal, commandCancellation.signal]);
    activeWork = Promise.resolve().then(async () => {
      cancellation.throwIfAborted();
      const home = await fs.realpath(dirs.make("migrated-package-completion-"));
      const fixture = await createPackageSwapFixture(home);
      const control = path.join(home, "authority");
      await fs.mkdir(control);
      vi.spyOn(temporaryState, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
      const env = {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        OPENCLAW_STATE_DIR: path.join(home, "state"),
        OPENCLAW_CONFIG_PATH: path.join(home, "state", "openclaw.json"),
        OPENCLAW_UPDATE_RUN_HANDOFF: "",
        OPENCLAW_TEST_RUNTIME_LOG: "1",
      };
      await fs.mkdir(env.OPENCLAW_STATE_DIR);
      const config = { plugins: { enabled: false } };
      await fs.writeFile(env.OPENCLAW_CONFIG_PATH, JSON.stringify(config));
      const candidateCliCalls = path.join(home, "candidate-cli-calls.jsonl");
      // Script only the independent CLI probes, never the finalization worker or its receipt.
      await fs.writeFile(
        path.join(fixture.params.stage.packageRoot, "dist", "index.js"),
        `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(candidateCliCalls)}, JSON.stringify({ pid: process.pid, argv: process.argv.slice(2) }) + "\\n");
if (process.argv[2] === "doctor" && process.argv[3] === "--lint") {
  process.stdout.write(JSON.stringify({ ok: true, checksRun: 1, findings: [] }));
} else if (process.argv[2] !== "config" || process.argv[3] !== "validate") {
  throw new Error("Unexpected candidate CLI command");
}
`,
      );
      const worker = path.join(
        fixture.params.stage.packageRoot,
        "dist",
        runtimeProcessEntrypoints.updateMigratedFinalize.distWorkerPath,
      );
      await fs.mkdir(path.dirname(worker), { recursive: true });
      await fs.writeFile(
        worker,
        `import(${JSON.stringify(resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.updateMigratedFinalize).href)});\n`,
      );
      await writePackageDistInventory(fixture.params.stage.packageRoot);
      const runCommand = commandExecution.runUtf8CommandWithTimeout;
      const commands: Array<{
        argv: string[];
        pid?: number;
        code: Awaited<ReturnType<typeof runCommand>>["code"];
        stderr: string;
        cleanup: Awaited<ReturnType<typeof runCommand>>["cleanup"];
      }> = [];
      vi.spyOn(commandExecution, "runUtf8CommandWithTimeout").mockImplementation(
        async (argv, input) => {
          const options: commandExecution.CommandOptions =
            typeof input === "number" ? { timeoutMs: input } : input;
          pendingCommands += 1;
          try {
            const result = await runCommand(argv, {
              ...options,
              signal: options.signal
                ? AbortSignal.any([options.signal, cancellation])
                : cancellation,
            });
            retainTemporaryFixtures ||= result.cleanup !== "normal";
            commands.push({
              argv,
              pid: result.pid,
              code: result.code,
              stderr: result.stderr,
              cleanup: result.cleanup,
            });
            return result;
          } catch (error) {
            retainTemporaryFixtures = true;
            throw error;
          } finally {
            pendingCommands -= 1;
          }
        },
      );
      const checkout = path.join(home, "operator-checkout");
      if (kind === "link-refusal") {
        await fs.rename(fixture.packageRoot, checkout);
        await fs.symlink(checkout, fixture.packageRoot, "dir");
      }
      const run: NonNullable<UpdateCommandOptions["run"]> = {
        runId: createUpdateRun({ trigger: "cli" }, { env }).runId,
        env,
      };
      const database = openOpenClawStateDatabase({ env });
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
        recordUpdateRunStep(run.runId, { step: "old writer", status: "completed" }, { env }),
      ).toThrow(/newer schema version/);
      closeOpenClawStateDatabaseForTest();
      const parentStateAccess = [
        vi.spyOn(ledger, "getUpdateRun"),
        vi.spyOn(ledger, "finishUpdateRun"),
        vi.spyOn(ledger, "recordUpdateRunPhase"),
        vi.spyOn(ledger, "recordUpdateRunStep"),
        vi.spyOn(stateDatabase, "openOpenClawStateDatabase"),
      ];
      const runTriage = vi.fn(async () => ({ status: "cancelled" as const }));
      vi.spyOn(triage, "prepareUpdateFailureTriage").mockResolvedValue(runTriage);
      const triageWrites = vi.spyOn(triageUpdate, "writeTriageUpdateFailure");
      const reports: unknown[] = [];
      const diagnostics: string[] = [];
      let stdout = "";
      vi.spyOn(defaultRuntime, "writeJson").mockImplementation((value) => {
        reports.push(structuredClone(value));
      });
      vi.spyOn(defaultRuntime, "error").mockImplementation((value) => {
        diagnostics.push(String(value));
      });
      vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        stdout += String(chunk);
        return true;
      });
      const terminalRow = () => {
        const inspected = new DatabaseSync(database.path, { readOnly: true });
        try {
          return inspected.prepare("SELECT * FROM update_runs WHERE run_id = ?").get(run.runId);
        } finally {
          inspected.close();
        }
      };
      let terminalAtCompletion: ReturnType<typeof terminalRow>;
      let transaction: PackageUpdateTransaction | undefined;
      let rollbackCalls = () => 0;
      let injected = false;
      const rm = fs.rm.bind(fs);
      vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
        if (
          (kind === "journal-error" || kind === "maintenance-warning") &&
          String(args[0]) === transaction?.backupRoot
        ) {
          injected = true;
          throw Object.assign(new Error("fixture backup removal denied"), { code: "EACCES" });
        }
        return rm(...args);
      });
      const unlink = fs.unlink.bind(fs);
      vi.spyOn(fs, "unlink").mockImplementation(async (...args) => {
        if (kind === "link-refusal" && String(args[0]) === transaction?.backupRoot) {
          injected = true;
          throw Object.assign(new Error("fixture retained link removal denied"), {
            code: "EACCES",
          });
        }
        return unlink(...args);
      });
      const readFile = fs.readFile.bind(fs);
      vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
        const value = await readFile(...args);
        if (typeof args[0] === "string" && path.basename(args[0]) === "result.json") {
          terminalAtCompletion = terminalRow();
          expect(terminalAtCompletion?.status).toBe(
            kind === "failed-child" ? "failed" : "succeeded",
          );
          expect(stdout).toBe("");
        }
        return value;
      });
      const journaled =
        kind === "healthy" || kind === "ordinary-healthy" || kind === "journal-error";
      let continued: Awaited<ReturnType<typeof continueMigratedUpdateInFreshProcess>> | undefined;
      let failure: unknown;
      await withUpdateFailureTriage(
        { json: true, yes: true, run },
        { root: fixture.packageRoot, env },
        async () => {
          await withUpdateCommandExecutor(run.runId, async (executor) => {
            const fence = await executor.enter(fixture.packageRoot);
            run.executorFence = fence;
            const published = await swapStagedPackageInstall({
              ...fixture.params,
              ...(journaled
                ? {
                    activation: {
                      fence,
                      nodeRunner: process.execPath,
                      onPrepared: () => undefined,
                    },
                  }
                : {}),
              onTransaction: (value) => {
                transaction = value;
              },
            });
            expect(published.status, published.step.stderrTail ?? undefined).toBe("committed");
            if (!transaction) {
              throw new Error("Migrated package fixture did not retain its transaction");
            }
            const rollback = vi.spyOn(transaction, "rollback");
            rollbackCalls = () => rollback.mock.calls.length;
            if (journaled) {
              expect(
                openPackageActivationJournal(
                  resolvePackageActivationAnchor(fixture.packageRoot),
                ).read().phase,
              ).toBe("publication-complete");
            }
            const params: FinishUpdateParams = {
              mutationStarted: true,
              result: {
                status: kind === "failed-child" ? "error" : "ok",
                ...(kind === "failed-child" ? { reason: "doctor-failed" } : {}),
                mode: "npm",
                root: fixture.packageRoot,
                runId: run.runId,
                after: { version: "2.0.0" },
                steps: [],
                durationMs: 0,
              },
              root: fixture.packageRoot,
              installKindChanged: false,
              configSnapshot: {
                path: env.OPENCLAW_CONFIG_PATH,
                exists: true,
                raw: JSON.stringify(config),
                parsed: config,
                sourceConfig: asResolvedSourceConfig(config),
                resolved: asResolvedSourceConfig(config),
                valid: true,
                runtimeConfig: asRuntimeConfig(config),
                config: asRuntimeConfig(config),
                issues: [],
                warnings: [],
                legacyIssues: [],
              },
              requestedChannel: null,
              storedChannel: "stable",
              channel: "stable",
              // Preserve the downgrade controls alongside ordinary candidate convergence.
              downgradeRisk: kind !== "ordinary-healthy",
              shouldRestart: false,
              opts: { json: true, yes: true, run },
              packageTransaction: transaction,
              controlPlaneUpdateSentinelMeta: null,
              preUpdatePluginInstallRecords: {},
              startedAt: Date.now(),
              packageUpdateNodeRunner: process.execPath,
              updateStepTimeoutMs: 1_000,
              rollbackBlockedReason: "state-migrated-no-rollback",
            };
            continued = await continueMigratedUpdateInFreshProcess(params, []);
          });
        },
      ).catch((error: unknown) => {
        failure = error;
      });
      const finalizerCommands = commands.filter(
        ({ argv }) =>
          argv[1] ===
            path.join(
              fixture.packageRoot,
              "dist",
              runtimeProcessEntrypoints.updateMigratedFinalize.distWorkerPath,
            ) && !argv.includes("--check"),
      );
      expect(finalizerCommands).toHaveLength(1);
      expect(finalizerCommands[0]).toMatchObject({ pid: expect.any(Number), cleanup: "normal" });
      expect(finalizerCommands[0]?.pid).not.toBe(process.pid);
      if (kind === "link-refusal") {
        expect(finalizerCommands[0]?.code, finalizerCommands[0]?.stderr).toBe(0);
      }
      expect(terminalAtCompletion).toBeDefined();
      expect(terminalRow()).toEqual(terminalAtCompletion);
      for (const access of parentStateAccess) {
        expect(access).not.toHaveBeenCalled();
      }
      expect(rollbackCalls()).toBe(0);
      expect(runTriage).not.toHaveBeenCalled();
      expect(triageWrites).not.toHaveBeenCalled();
      if (kind === "journal-error" || kind === "link-refusal") {
        expect(injected).toBe(true);
        expect(failure).toMatchObject({ code: 1 });
        expect(continued).toBeUndefined();
        expect(stdout).toBe("");
        expect(reports).toEqual([
          expect.objectContaining({
            status: "error",
            recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
          }),
        ]);
        expect(await fs.lstat(transaction!.backupRoot)).toBeDefined();
        if (kind === "journal-error") {
          expect(
            openPackageActivationJournal(resolvePackageActivationAnchor(fixture.packageRoot)).read()
              .phase,
          ).toBe("retiring");
        } else {
          expect(
            JSON.parse(await fs.readFile(path.join(checkout, "package.json"), "utf8")).version,
          ).toBe("1.0.0");
        }
      } else {
        expect(failure).toBeUndefined();
        expect(reports).toEqual([]);
        const reported = JSON.parse(stdout);
        expect(reported.status).toBe(kind === "failed-child" ? "error" : "ok");
        expect(continued?.exitCode).toBe(kind === "failed-child" ? 1 : 0);
        if (kind === "ordinary-healthy") {
          expect(continued?.result.postUpdate?.plugins).toMatchObject({
            status: "ok",
            changed: false,
          });
          const cliCalls = (await fs.readFile(candidateCliCalls, "utf8"))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as { pid: number; argv: string[] });
          expect(cliCalls.map(({ argv }) => argv)).toEqual([
            ["config", "validate", "--json"],
            ["doctor", "--lint", "--json", "--severity-min", "error"],
          ]);
          for (const call of cliCalls) {
            expect(call.pid).not.toBe(process.pid);
            expect(call.pid).not.toBe(finalizerCommands[0]?.pid);
          }
        }
        if (kind === "failed-child") {
          expect(continued?.result.reason).toBe("state-migrated-no-rollback");
          expect(terminalAtCompletion?.reason).toBe("state-migrated-no-rollback");
        } else if (kind === "maintenance-warning") {
          expect(injected).toBe(true);
          expect(continued?.result.steps).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                advisory: expect.objectContaining({ kind: "recoverable-maintenance" }),
              }),
            ]),
          );
          expect(diagnostics.join("\n")).toContain("openclaw-package-backup-");
        } else {
          await expect(
            fs.lstat(resolvePackageActivationAnchor(fixture.packageRoot)),
          ).rejects.toMatchObject({ code: "ENOENT" });
        }
      }
    });
    return activeWork;
  },
);
