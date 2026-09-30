import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { resolveVitestNodeArgs } from "../../../scripts/lib/vitest-process-env.mts";
import { createFixtureLifetime } from "../../../test/helpers/fixture-lifetime.js";
import {
  assertManagedHandoffTestConsumer,
  createManagedHandoffTestBinding,
} from "../../../test/helpers/managed-handoff-isolation.js";
import { cronOwnerHardeningEntrypoints } from "../../cron/owner-hardening-runtime.test-support.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { triageTestRuntimeEntrypoints } from "../../infra/triage-runtime.test-support.js";
import { getUpdateRun, type createUpdateRun } from "../../infra/update-run-ledger.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { updateExecutorNativeEntrypoints } from "./update-command-executor-native-runtime.test-support.js";

const sourceImportArgs = resolveRuntimeWorkerUrl(
  updateExecutorNativeEntrypoints.executor,
).pathname.endsWith(".ts")
  ? ["--import", path.resolve("scripts/tsx.mjs")]
  : [];

const lifetime = createFixtureLifetime();
const dirs = { make: lifetime.createTempDir };
afterEach(() => lifetime.cleanup());
it.skipIf(process.platform === "win32").for([
  { signal: "SIGINT", mode: "fresh" },
  { signal: "SIGTERM", mode: "fresh" },
  { signal: "SIGINT", mode: "queued-progress" },
  { signal: "SIGINT", mode: "refused-progress" },
  { signal: "SIGINT", mode: "uncertain-progress" },
  { signal: "SIGINT", mode: "inherited" },
  { signal: "SIGINT", mode: "handoff" },
  { signal: "SIGINT", mode: "pending" },
  { signal: "SIGINT", mode: "activating" },
  { signal: "SIGINT", mode: "migrated" },
  { signal: "SIGINT", mode: "lost" },
  { signal: "SIGINT", mode: "missing" },
  { signal: "SIGINT", mode: "completed" },
  { signal: "SIGINT", mode: "no-owner" },
] as const)(
  "settles only the local pre-activation diagnostic under its real executor: $signal/$mode",
  { timeout: 60000 },
  ({ signal, mode }, { signal: testSignal }) =>
    lifetime.run(async () => {
      try {
        const root = dirs.make("update-owned-signal-");
        const control = path.join(root, "control");
        fs.mkdirSync(control, { mode: 0o700 });
        const binding = createManagedHandoffTestBinding(control);
        const script = path.join(root, "signal.mjs");
        fs.writeFileSync(
          script,
          `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { createRequire, syncBuiltinESMExports } from 'node:module';
    import path from 'node:path';
    import { fileURLToPath } from 'node:url';
    import { Worker } from 'node:worker_threads';
    import { deserialize } from 'node:v8';
    const root = ${JSON.stringify(root)};
    const sqlite = createRequire(import.meta.url)('node:sqlite');
    const NativeDatabase = sqlite.DatabaseSync;
    const GuardedDatabase = new Proxy(NativeDatabase, { construct(target, args, newTarget) {
      const raw = String(args[0]);
      // The runtime safety check uses a connection with no filesystem state.
      if (raw === ':memory:') return Reflect.construct(target, args, newTarget === GuardedDatabase ? target : newTarget);
      const file = raw.startsWith('file:') ? fileURLToPath(raw) : raw;
      const physical = fs.existsSync(file) ? fs.realpathSync(file) : path.join(fs.realpathSync(path.dirname(file)), path.basename(file));
      assert.ok(physical.startsWith(root + path.sep), 'database escaped private signal fixture before open');
      if (path.basename(file) === 'managed-update-handoffs.sqlite') assert.equal(physical, ${JSON.stringify(binding.databasePath)});
      return Reflect.construct(target, args, newTarget === GuardedDatabase ? target : newTarget);
    }});
    sqlite.DatabaseSync = GuardedDatabase;
    syncBuiltinESMExports();
    const { resolveManagedUpdateLeaseDatabasePath, createManagedHandoffLeaseStore } = await import(${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.handoffLease).href)});
    const databasePath = resolveManagedUpdateLeaseDatabasePath();
    assert.equal(databasePath, ${JSON.stringify(binding.databasePath)}, 'private handoff binding missing before admission');
    const { createUpdateRun, finishUpdateRun, getUpdateRun, recordUpdateRunPhase } = await import(${JSON.stringify(resolveRuntimeWorkerUrl(triageTestRuntimeEntrypoints.updateRunLedger).href)});
    const { createRetainedUpdateRecovery } = await import(${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.retainedRecovery).href)});
    const { closeOpenClawStateDatabaseForTest } = await import(${JSON.stringify(resolveRuntimeWorkerUrl(cronOwnerHardeningEntrypoints.stateDatabase).href)});
    const { admitUpdateCommandRun, createUpdateRunProgress, withUpdatePreviewSignals } = await import(${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.commandRun).href)});
    const { withUpdateCommandExecutor, captureUpdateCommandExecutorAuthority } = await import(${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.executor).href)});
    const { recordUpdateRunStepAsync } = await import(${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.candidateStepWriter).href)});
    const { createUpdateCommandExecutionGuards } = await import(${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.executionGuards).href)});
    const { registerSignalExitBarrier } = await import(${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.signalExitBarrier).href)});
    const mode = ${JSON.stringify(mode)};
    const opts = {};
    if (mode === 'inherited') process.env.OPENCLAW_UPDATE_RUN_ID = createUpdateRun({trigger:'cli'}).runId;
    const run = await admitUpdateCommandRun({opts, root});
    const currentOptions = {...opts, run};
    let executorDatabasePath;
    const enter = async (executor) => {
      run.executorFence = await executor.enter(root);
      executorDatabasePath = captureUpdateCommandExecutorAuthority(run.executorFence).databasePath;
      assert.equal(executorDatabasePath, databasePath);
      const current = createManagedHandoffLeaseStore().read(root);
      assert.equal(current.kind, 'current');
    };
    const operate = async () => {
      const sibling = createUpdateRun({trigger:'cli'});
      const hold = async () => {
        recordUpdateRunPhase(run.runId, 'validating');
        if (mode === 'handoff') process.env.OPENCLAW_UPDATE_RUN_HANDOFF = '1';
        if (mode === 'activating') recordUpdateRunPhase(run.runId, 'activating');
        if (mode === 'completed') finishUpdateRun(run.runId, {status:'skipped',reason:'already-current'});
        if (mode === 'pending' || mode === 'missing') {
          const from = {root,nodePath:process.execPath,version:'1.0.0',buildId:null};
          createRetainedUpdateRecovery({runId:run.runId,from,to:{...from,version:'2.0.0'}},{env:run.env});
        }
        const expected = getUpdateRun(run.runId);
        if (mode === 'migrated') {
          createUpdateRunProgress(run, {}).deferLedgerWrites();
          closeOpenClawStateDatabaseForTest();
          const { DatabaseSync } = await import('node:sqlite');
          const db = new DatabaseSync(root + '/state/openclaw.sqlite');
          db.exec('PRAGMA user_version = ' + (db.prepare('PRAGMA user_version').get().user_version + 1));
          db.close();
        }
        if (mode === 'missing') {
          closeOpenClawStateDatabaseForTest();
          fs.mkdirSync(root + '/state/.openclaw-restore-00000000-0000-4000-8000-000000000001-0');
          fs.renameSync(root + '/state/openclaw.sqlite',root + '/state/.openclaw-restore-00000000-0000-4000-8000-000000000001-0/displaced');
        }
        process.channel.ref();
        if (['queued-progress', 'refused-progress', 'uncertain-progress'].includes(mode)) {
          const guards = createUpdateCommandExecutionGuards(currentOptions, root);
          await recordUpdateRunStepAsync(run.runId, {step:'warm-worker',status:'completed'}, guards.captureWriteOptions());
          const locked = new NativeDatabase(root + '/state/openclaw.sqlite');
          locked.exec('BEGIN IMMEDIATE');
          const receiptAbort = new AbortController();
          let receiptWorker;
          process.once('message', () => {
            if (mode === 'uncertain-progress') {
              // Exercise the broker's real failure/retirement path after native dispatch.
              // Missing outcome evidence stays unknown even after this worker exits.
              receiptWorker.emit('error', new Error('fixture SQLite worker transport failure'));
            } else if (mode === 'refused-progress') {
              receiptAbort.abort(new Error('fixture-step-refused'));
            }
            locked.exec('ROLLBACK');
            locked.close();
          });
          const post = Worker.prototype.postMessage;
          Worker.prototype.postMessage = function(request, ...args) {
            const result = Reflect.apply(post, this, [request, ...args]);
            if (request.type === 'execute' && deserialize(request.input).type === 'updateRuns.recordStep') {
              Worker.prototype.postMessage = post;
              receiptWorker = this;
              process.send({runId:run.runId,expected,sibling,databasePath,executorDatabasePath});
            }
            return result;
          };
          process.once('SIGINT', () => {
            void Promise.resolve().then(() => recordUpdateRunStepAsync(
              run.runId, {step:'late-progress',status:'in_progress'}, guards.captureWriteOptions(),
            )).then(
              () => process.send({lateBlocked:false}),
              () => process.send({lateBlocked:true}),
            );
          });
          let observed;
          const checked = new Promise(resolve => {observed=resolve;});
          const releaseObservation = registerSignalExitBarrier(async () => {await checked;});
          try {
            try {
              await recordUpdateRunStepAsync(run.runId, {step:'queued-progress',status:'in_progress'}, {
                ...guards.captureWriteOptions(), signal: receiptAbort.signal,
              });
            } catch (error) {
              await new Promise((resolve,reject) => process.send({receiptFailure:error.code ?? error.message}, sendError => sendError ? reject(sendError) : resolve()));
              throw error;
            }
            let forwardBlocked = false;
            try {
              guards.assertCurrent();
              fs.writeFileSync(root + '/unexpected-canary-child', 'launched');
            } catch {
              forwardBlocked = true;
            }
            await new Promise((resolve,reject) => process.send({forwardBlocked}, error => error ? reject(error) : resolve()));
          } finally {
            observed();
            releaseObservation();
          }
          return;
        }
        process.send({runId:run.runId,expected,sibling,databasePath,executorDatabasePath});
        await new Promise(() => {});
      };
      if (mode === 'lost') {
        await withUpdateCommandExecutor(run.runId, async (executor) => {await enter(executor);});
        await withUpdatePreviewSignals(currentOptions, hold);
      } else if (mode === 'no-owner') {
        await withUpdatePreviewSignals(currentOptions, hold);
      } else {
        await withUpdateCommandExecutor(run.runId, async (executor) => {
          await enter(executor);
          await withUpdatePreviewSignals(currentOptions, hold);
        });
      }
    };
    await operate();
  `,
        );
        const child = spawn(
          process.execPath,
          [
            ...(process.versions.bun ? [] : resolveVitestNodeArgs()),
            ...sourceImportArgs,
            binding.nodeOption,
            script,
          ],
          {
            cwd: process.cwd(),
            env: {
              ...process.env,
              HOME: root,
              USERPROFILE: root,
              XDG_CACHE_HOME: path.join(root, "cache"),
              TMPDIR: root,
              TMP: root,
              TEMP: root,
              OPENCLAW_STATE_DIR: root,
              OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
              OPENCLAW_SUPERVISOR_MODE: "external",
              OPENCLAW_UPDATE_RUN_ID: undefined,
              OPENCLAW_UPDATE_RUN_HANDOFF: undefined,
              OPENCLAW_UPDATE_POST_CORE: undefined,
            },
            stdio: ["ignore", "ignore", "pipe", "ipc"],
          },
        );
        let stderr = "";
        child.stderr?.on("data", (chunk) => {
          stderr += chunk;
        });
        let spawnError: Error | undefined;
        child.once("error", (error) => {
          spawnError = error;
        });
        const closed = new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
          child.once("close", (code, exitSignal) => resolve([code, exitSignal]));
        });
        const stop = () => {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
          }
        };
        testSignal.addEventListener("abort", stop, { once: true });
        if (testSignal.aborted) {
          stop();
        }
        try {
          const message = await Promise.race([
            once(child, "message").then(
              ([payload]) =>
                payload as {
                  databasePath: string;
                  executorDatabasePath?: string;
                  runId: string;
                  expected: ReturnType<typeof getUpdateRun>;
                  sibling: ReturnType<typeof createUpdateRun>;
                },
            ),
            closed.then(() => {
              throw new Error(`Update process exited before ready: ${stderr}`, {
                cause: spawnError,
              });
            }),
          ]);
          expect(binding.assertPath(message.databasePath)).toBe(binding.databasePath);
          assertManagedHandoffTestConsumer(
            binding,
            child.pid,
            path.dirname(
              path.dirname(
                fileURLToPath(
                  resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.handoffLease),
                ),
              ),
            ),
          );
          if (mode !== "no-owner") {
            expect(message.executorDatabasePath).toBe(binding.databasePath);
          }
          const receiptMode =
            mode === "queued-progress" ||
            mode === "refused-progress" ||
            mode === "uncertain-progress";
          const interrupted = receiptMode ? once(child, "message") : undefined;
          expect(child.kill(signal)).toBe(true);
          if (interrupted) {
            const [observed] = await Promise.race([
              interrupted,
              closed.then(() => {
                throw new Error(`Update exited before its pending writer drained: ${stderr}`);
              }),
            ]);
            expect(observed).toEqual({ lateBlocked: true });
            const forward = once(child, "message");
            child.send("release");
            const [continuation] = await Promise.race([
              forward,
              closed.then(() => {
                throw new Error(`Update exited before checking forward authority: ${stderr}`);
              }),
            ]);
            expect(continuation).toEqual(
              mode === "uncertain-progress"
                ? { receiptFailure: "ERR_COMMAND_PROCESS_CLEANUP_UNCERTAIN" }
                : mode === "refused-progress"
                  ? { receiptFailure: "fixture-step-refused" }
                  : { forwardBlocked: true },
            );
            expect(fs.existsSync(path.join(root, "unexpected-canary-child"))).toBe(false);
          }
          const [code, exitSignal] = await closed;
          expect(code ?? (exitSignal === "SIGINT" ? 130 : 143)).toBe(
            signal === "SIGINT" ? 130 : 143,
          );
          if (mode === "migrated") {
            expect(stderr).not.toContain("Update interruption could not be recorded");
            const db = new DatabaseSync(path.join(root, "state", "openclaw.sqlite"), {
              readOnly: true,
            });
            try {
              expect(
                db
                  .prepare("SELECT status, phase, updated_at_ms FROM update_runs WHERE run_id = ?")
                  .get(message.runId),
              ).toEqual({
                status: message.expected?.status,
                phase: message.expected?.phase,
                updated_at_ms: message.expected?.updatedAtMs,
              });
            } finally {
              db.close();
            }
            return;
          }
          const options =
            mode === "missing"
              ? {
                  path: path.join(
                    root,
                    "state",
                    ".openclaw-restore-00000000-0000-4000-8000-000000000001-0",
                    "displaced",
                  ),
                }
              : { env: { OPENCLAW_STATE_DIR: root } };
          const readRun = (runId: string) => getUpdateRun(runId, options);
          const actual = readRun(message.runId);
          if (mode === "uncertain-progress") {
            expect(actual).toMatchObject({
              status: "running",
              phase: "validating",
              reason: null,
              finishedAtMs: null,
            });
            expect(stderr).toContain(
              "Update interruption could not be recorded; history remains pending.",
            );
            expect(stderr).toContain("Update signal cleanup did not complete.");
          } else if (
            mode === "fresh" ||
            mode === "queued-progress" ||
            mode === "refused-progress"
          ) {
            expect(actual).toMatchObject({
              status: "failed",
              phase: "finished",
              reason: "interrupted",
            });
            expect(actual?.steps.some((step) => step.status === "in_progress")).toBe(false);
            if (mode === "queued-progress") {
              expect(actual?.steps).toContainEqual(
                expect.objectContaining({ step: "queued-progress" }),
              );
            } else if (mode === "refused-progress") {
              expect(actual?.steps.some((step) => step.step === "queued-progress")).toBe(false);
              expect(stderr).not.toContain("Update signal cleanup did not complete.");
            }
          } else {
            expect(actual).toEqual(message.expected);
          }
          if (receiptMode) {
            expect(actual?.steps.some((step) => step.step === "late-progress")).toBe(false);
          }
          expect(readRun(message.sibling.runId)).toEqual(message.sibling);
          if (mode === "missing") {
            for (const suffix of ["", "-wal", "-shm"]) {
              expect(fs.existsSync(path.join(root, "state", `openclaw.sqlite${suffix}`))).toBe(
                false,
              );
            }
          }
        } finally {
          await lifetime.verifyCleanup(async () => {
            try {
              stop();
              await closed;
            } finally {
              testSignal.removeEventListener("abort", stop);
            }
          });
        }
      } finally {
        closeOpenClawStateDatabaseForTest();
      }
    }),
);
