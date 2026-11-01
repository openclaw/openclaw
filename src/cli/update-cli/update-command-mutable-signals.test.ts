import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
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
import { resolveTestNodeExecPath } from "../../test-utils/node-process.js";
import { updateExecutorNativeEntrypoints as native } from "./update-command-executor-native-runtime.test-support.js";
import {
  createMutableInterruptionService,
  mutableCompensationFixtureSource,
} from "./update-command-mutable-signals-compensation.test-support.js";

const sourceImportArgs = resolveRuntimeWorkerUrl(native.executor).pathname.endsWith(".ts")
  ? ["--import", path.resolve("scripts/tsx.mjs")]
  : [];

const lifetime = createFixtureLifetime();
afterEach(() => lifetime.cleanup());
it.skipIf(process.platform === "win32").for([
  { signal: "SIGINT", mode: "fresh" },
  { signal: "SIGTERM", mode: "fresh" },
  { signal: "SIGTERM", mode: "publishing-compensation" },
  { signal: "SIGHUP", mode: "rollback-compensation" },
  { signal: "SIGINT", mode: "queued-progress" },
  { signal: "SIGINT", mode: "refused-progress" },
  { signal: "SIGINT", mode: "uncertain-progress" },
  { signal: "SIGINT", mode: "accepted-compensation" },
  { signal: "SIGINT", mode: "uncertain-compensation" },
  { signal: "SIGINT", mode: "sealed-compensation" },
  { signal: "SIGINT", mode: "inherited" },
  { signal: "SIGINT", mode: "handoff" },
  { signal: "SIGINT", mode: "pending" },
  { signal: "SIGINT", mode: "activating" },
  { signal: "SIGINT", mode: "lost" },
  { signal: "SIGINT", mode: "missing" },
  { signal: "SIGINT", mode: "completed" },
  { signal: "SIGINT", mode: "no-owner" },
] as const)(
  "settles the admitted update and its owned compensation: $signal/$mode",
  { timeout: 60000 },
  ({ signal, mode }, { signal: testSignal }) =>
    lifetime.run(async () => {
      let service: Awaited<ReturnType<typeof createMutableInterruptionService>> | undefined;
      try {
        const root = lifetime.createTempDir("update-owned-signal-");
        const exists = (name: string) => fs.existsSync(path.join(root, name));
        const read = (...parts: string[]) => fs.readFileSync(path.join(...parts), "utf8");
        const receiptMode = mode.endsWith("-progress");
        const publicationMode =
          mode === "publishing-compensation" || mode === "rollback-compensation";
        const compensationMode = mode.endsWith("-compensation") && !publicationMode;
        const installRoot = publicationMode
          ? path.join(root, "pair", "live", "lib", "node_modules", "openclaw")
          : root;
        if (publicationMode) {
          service = await createMutableInterruptionService(installRoot, testSignal);
        }
        const stateDir = mode.endsWith("-compensation") ? path.join(root, ".openclaw") : root;
        const configPath = path.join(stateDir, "openclaw.json");
        const displaced = path.join(
          root,
          "state/.openclaw-restore-00000000-0000-4000-8000-000000000001-0/displaced",
        );
        const readRun = (runId: string) =>
          getUpdateRun(
            runId,
            mode === "missing" ? { path: displaced } : { env: { OPENCLAW_STATE_DIR: stateDir } },
          );
        const readyz = () => fetch(`http://127.0.0.1:${service?.port}/readyz`);
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
    const stateDir = ${JSON.stringify(stateDir)};
    const configPath = ${JSON.stringify(configPath)};
    const mode = ${JSON.stringify(mode)};
    const gatewayPort = ${JSON.stringify(service?.port)};
    const controlUrl = ${JSON.stringify(service?.controlUrl)};
    const installRoot = ${JSON.stringify(installRoot)};
    const displaced = ${JSON.stringify(displaced)};
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
    ${mutableCompensationFixtureSource()}
    const { resolveManagedUpdateLeaseDatabasePath, createManagedHandoffLeaseStore } = await import(${JSON.stringify(resolveRuntimeWorkerUrl(native.handoffLease).href)});
    const databasePath = resolveManagedUpdateLeaseDatabasePath();
    assert.equal(databasePath, ${JSON.stringify(binding.databasePath)}, 'private handoff binding missing before admission');
    const { createUpdateRun, finishUpdateRun, getUpdateRun, recordUpdateRunPhase } = await import(${JSON.stringify(resolveRuntimeWorkerUrl(triageTestRuntimeEntrypoints.updateRunLedger).href)});
    const { createRetainedUpdateRecovery } = await import(${JSON.stringify(resolveRuntimeWorkerUrl(native.retainedRecovery).href)});
    const { closeOpenClawStateDatabaseForTest } = await import(${JSON.stringify(resolveRuntimeWorkerUrl(cronOwnerHardeningEntrypoints.stateDatabase).href)});
    const { admitUpdateCommandRun, withUpdatePreviewSignals } = await import(${JSON.stringify(resolveRuntimeWorkerUrl(native.commandRun).href)});
    const { withUpdateCommandExecutor, captureUpdateCommandExecutorAuthority } = await import(${JSON.stringify(resolveRuntimeWorkerUrl(native.executor).href)});
    const { recordUpdateRunStepAsync } = await import(${JSON.stringify(resolveRuntimeWorkerUrl(native.candidateStepWriter).href)});
    const { createUpdateCommandExecutionGuards } = await import(${JSON.stringify(resolveRuntimeWorkerUrl(native.executionGuards).href)});
    const { registerSignalExitBarrier } = await import(${JSON.stringify(resolveRuntimeWorkerUrl(native.signalExitBarrier).href)});
    const { withCliProcessScope, withCliCommandCleanup } = await import(${JSON.stringify(resolveRuntimeWorkerUrl(native.cliCleanupScope).href)});
    const { runCliWithExitFinalization } = await import(${JSON.stringify(resolveRuntimeWorkerUrl(native.oneShotExit).href)});
    const opts = {};
    if (mode === 'inherited') process.env.OPENCLAW_UPDATE_RUN_ID = createUpdateRun({trigger:'cli'}).runId;
    const run = await admitUpdateCommandRun({ env: process.env,opts, root:installRoot});
    const currentOptions = {...opts, run};
    let executorDatabasePath;
    const enter = async (executor) => {
      run.executorFence = await executor.enter(installRoot);
      executorDatabasePath = captureUpdateCommandExecutorAuthority(run.executorFence).databasePath;
      assert.equal(executorDatabasePath, databasePath);
      const current = createManagedHandoffLeaseStore().read(installRoot);
      assert.equal(current.kind, 'current');
    };
    const operate = async () => {
      const sibling = createUpdateRun({trigger:'cli'});
      const ready = expected => process.send({runId:run.runId,expected,sibling,databasePath,executorDatabasePath});
      const hold = async () => {
        recordUpdateRunPhase(run.runId, 'validating');
        if (mode === 'handoff') process.env.OPENCLAW_UPDATE_RUN_HANDOFF = '1';
        if (mode === 'activating' || compensationFixture) recordUpdateRunPhase(run.runId, 'activating');
        if (mode === 'completed') finishUpdateRun(run.runId, {status:'skipped',reason:'already-current'});
        if (mode === 'pending' || mode === 'missing') {
          const from = {root,nodePath:process.execPath,version:'1.0.0',buildId:null};
          createRetainedUpdateRecovery({runId:run.runId,from,to:{...from,version:'2.0.0'}},{env:run.env});
        }
        const expected = getUpdateRun(run.runId);
        if (mode === 'missing') {
          closeOpenClawStateDatabaseForTest();
          fs.mkdirSync(path.dirname(displaced));
          fs.renameSync(root + '/state/openclaw.sqlite', displaced);
        }
        process.channel.ref();
        if (compensationFixture) {
          await compensationFixture({run,currentOptions,ready:()=>ready(expected)});
          return;
        }
        if (${receiptMode}) {
          const guards = createUpdateCommandExecutionGuards(currentOptions, root);
          await recordUpdateRunStepAsync(run.runId, {step:'warm-worker',status:'completed'}, guards.captureWriteOptions());
          const locked = new NativeDatabase(root + '/state/openclaw.sqlite');
          locked.exec('BEGIN IMMEDIATE');
          const receiptAbort = new AbortController();
          let receiptWorker;
          process.once('message', () => {
            if (mode === 'uncertain-progress') {
              // Native dispatch without outcome evidence remains unknown after worker exit.
              receiptWorker.emit('error', new Error('fixture SQLite worker transport failure'));
            } else if (mode === 'refused-progress') {
              receiptAbort.abort(new Error('fixture-step-refused'));
            }
            locked.exec('ROLLBACK');
            locked.close();
          });
          const post = Worker.prototype.postMessage;
          Worker.prototype.postMessage = function(request, ...args) {
            // postMessage transfers and detaches the serialized input.
            const commandType = request.type === 'execute' ? deserialize(request.input).type : undefined;
            const result = Reflect.apply(post, this, [request, ...args]);
            if (commandType === 'updateRuns.recordStep') {
              Worker.prototype.postMessage = post;
              receiptWorker = this;
              ready(expected);
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
        ready(expected);
        await new Promise(resolve => {
          if (mode !== "inherited") process.once(${JSON.stringify(signal)}, resolve);
        });
      };
      if (mode === 'lost') {
        await withUpdateCommandExecutor(run.runId, async (executor) => {await enter(executor);});
        await withUpdatePreviewSignals(currentOptions, hold);
      } else if (mode === 'no-owner') {
        await withUpdatePreviewSignals(currentOptions, hold);
      } else {
        const execute=()=>withUpdateCommandExecutor(run.runId, async (executor) => {
          await enter(executor);
          await withUpdatePreviewSignals(currentOptions, hold);
        });
        if(mode==='publishing-compensation'||mode==='rollback-compensation') {
          const {withUpdateCommandTerminalResult}=await import(${JSON.stringify(resolveRuntimeWorkerUrl(native.terminal).href)});
          try {await withUpdateCommandTerminalResult(register=>{register(run);return execute();},{json:true});}
          catch(error) {process.stderr.write(String(error)+'\\n'+JSON.stringify(error.result)+'\\n');}
        } else {await execute();}
      }
    };
    try {
      if (mode === "inherited") await operate();
      else {
        let resources;
        await withCliProcessScope(() => runCliWithExitFinalization({
          run: () => withCliCommandCleanup(false, async cleanup => {
            resources = cleanup.pluginResources;
            await operate();
            process.exitCode = 19;
          }),
          onError: error => {
            if (!run.interrupted) throw error;
            process.exitCode = 19;
          },
          finalize: async () => { await resources?.release(); },
        }));
      }
    } finally {
      fs.writeFileSync(root + "/signal-owner-unwound", "settled");
      closeOpenClawStateDatabaseForTest();
      if (process.connected) process.disconnect();
    }
  `,
        );
        const child = spawn(
          resolveTestNodeExecPath(),
          [
            ...resolveVitestNodeArgs(),
            ...(mode.endsWith("-compensation") ? ["--experimental-test-module-mocks"] : []),
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
              OPENCLAW_STATE_DIR: stateDir,
              OPENCLAW_CONFIG_PATH: configPath,
              ...(mode.endsWith("-compensation")
                ? { OPENCLAW_HOME: undefined, OPENCLAW_PROFILE: undefined }
                : {}),
              OPENCLAW_SUPERVISOR_MODE: "external",
              OPENCLAW_UPDATE_RUN_ID: undefined,
              OPENCLAW_UPDATE_RUN_HANDOFF: undefined,
              OPENCLAW_UPDATE_POST_CORE: undefined,
            },
            stdio: ["ignore", "ignore", "pipe", "ipc"],
          },
        );
        let stderr = "";
        let publicationReleased = false;
        child.stderr?.on("data", (chunk) => {
          stderr += chunk;
          if (
            publicationMode &&
            !publicationReleased &&
            stderr.includes("Recovering the Gateway before exit.")
          ) {
            publicationReleased = true;
            child.send("publish");
          }
        });
        // The fixture is removed before Vitest renders failures; retain diagnostics without
        // inviting its stack parser to source-map the already-retired generated script.
        const childDiagnostics = () =>
          stderr
            .split("\n")
            .filter((line) => !line.includes(script))
            .join("\n");
        let spawnError: Error | undefined;
        child.once("error", (error) => {
          spawnError = error;
        });
        const closed = new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
          child.once("close", (code, exitSignal) => resolve([code, exitSignal]));
        });
        const beforeExit = <T>(pending: Promise<T>, reason: string): Promise<T> =>
          Promise.race([
            pending,
            closed.then(() => {
              throw new Error(`Update exited before ${reason}: ${childDiagnostics()}`, {
                cause: spawnError,
              });
            }),
          ]);
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
          const [message] = (await beforeExit(once(child, "message"), "ready")) as [
            {
              databasePath: string;
              executorDatabasePath?: string;
              runId: string;
              expected: ReturnType<typeof getUpdateRun>;
              sibling: ReturnType<typeof createUpdateRun>;
            },
          ];
          expect(binding.assertPath(message.databasePath)).toBe(binding.databasePath);
          assertManagedHandoffTestConsumer(
            binding,
            child.pid,
            fileURLToPath(new URL("../", resolveRuntimeWorkerUrl(native.handoffLease))),
          );
          if (mode !== "no-owner") {
            expect(message.executorDatabasePath).toBe(binding.databasePath);
          }
          if (publicationMode) {
            expect(service?.transitions).toEqual(["stopped"]);
            await expect(readyz()).rejects.toThrow();
            if (mode === "publishing-compensation") {
              expect(fs.existsSync(installRoot)).toBe(false);
            } else {
              expect(JSON.parse(read(installRoot, "package.json"))).toMatchObject({
                version: "1.0.0",
              });
            }
          }
          const interrupted = receiptMode || compensationMode ? once(child, "message") : undefined;
          expect(child.kill(signal)).toBe(true);
          if (interrupted && compensationMode) {
            const [observed] = await beforeExit(interrupted, "observing compensation");
            expect(observed).toEqual(
              mode === "sealed-compensation"
                ? { compensationRefused: true }
                : { compensationReceipt: true },
            );
            expect(exists("compensation-native-stop")).toBe(false);
            if (mode !== "sealed-compensation") {
              child.send("release");
            }
          } else if (interrupted) {
            const [observed] = await beforeExit(interrupted, "its pending writer drained");
            expect(observed).toEqual({ lateBlocked: true });
            const forward = once(child, "message");
            child.send("release");
            const [continuation] = await beforeExit(forward, "checking forward authority");
            expect(continuation).toEqual(
              mode === "uncertain-progress"
                ? { receiptFailure: "ERR_COMMAND_PROCESS_CLEANUP_UNCERTAIN" }
                : mode === "refused-progress"
                  ? { receiptFailure: "fixture-step-refused" }
                  : { forwardBlocked: true },
            );
            expect(exists("unexpected-canary-child")).toBe(false);
          }
          const [code, exitSignal] = await closed;
          if (mode !== "inherited") {
            expect({ exitSignal, unwound: read(root, "signal-owner-unwound") }).toEqual({
              exitSignal: null,
              unwound: "settled",
            });
          }
          const expectedCode = signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143;
          expect(code ?? (exitSignal === signal ? expectedCode : null)).toBe(expectedCode);
          if (publicationMode) {
            expect(service?.transitions, childDiagnostics()).toEqual([
              "stopped",
              "restarted 1.0.0",
            ]);
            expect(await (await readyz()).json()).toEqual({ ok: true, version: "1.0.0" });
            expect(readRun(message.runId)).toMatchObject({
              status: "rolled-back",
              steps: expect.arrayContaining([
                expect.objectContaining({ step: "activating", termination: "signal", signal }),
              ]),
            });
            const report = read(stateDir, "update-reports", `${message.runId}.md`);
            expect(report).toContain(`interrupted by ${signal} during activating`);
            expect(report).toContain("Bounded diagnostic JSON:");
            expect(stderr).toContain("openclaw update repair");
            return;
          }
          const actual = readRun(message.runId);
          const expectPendingHistory = (phase: "activating" | "validating") => {
            expect(actual).toMatchObject({
              status: "running",
              phase,
              reason: null,
              finishedAtMs: null,
            });
            expect(stderr).toContain(
              "Update interruption could not be recorded; history remains pending.",
            );
            expect(stderr).toContain("Update signal cleanup did not complete.");
          };
          if (compensationMode) {
            const admitted = mode !== "sealed-compensation";
            const completed = mode === "accepted-compensation";
            expect(exists("compensation-signal-snapshot")).toBe(true);
            expect(exists("compensation-rollback-entered")).toBe(admitted);
            expect(exists("compensation-phase-dispatched")).toBe(admitted);
            expect(exists("compensation-native-stop")).toBe(completed);
            expect(exists("compensation-package-rollback")).toBe(completed);
            if (mode === "uncertain-compensation") {
              expect(exists("compensation-uncertainty-observed")).toBe(true);
              expectPendingHistory("activating");
            }
          } else if (mode === "uncertain-progress") {
            expectPendingHistory("validating");
          } else if (mode === "fresh" || receiptMode) {
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
              expect(exists(`state/openclaw.sqlite${suffix}`)).toBe(false);
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
        await service?.close();
        closeOpenClawStateDatabaseForTest();
      }
    }),
);
