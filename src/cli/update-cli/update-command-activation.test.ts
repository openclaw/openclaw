import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { closeIdleSqliteCoordinators } from "../../infra/sqlite-coordinator.js";
import { withStateDatabaseCoordinatorRuntimeDirectory } from "../../infra/state-database-coordinator.js";
import * as temporaryRoot from "../../infra/tmp-openclaw-dir.js";
import {
  assertUpdateWriteAuthority,
  createFreeBsdUpdateWriteAdmission,
} from "../../infra/update-freebsd-write-admission.js";
import { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import {
  createUpdateRun,
  getUpdateRun,
  recordUpdateRunPhase,
} from "../../infra/update-run-ledger.js";
import { runUtf8CommandWithTimeout } from "../../process/exec.js";
import { defaultRuntime } from "../../runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withMockedPlatform } from "../../test-utils/vitest-spies.js";
import type { UpdateCommandOptions } from "./shared.js";
import { UpdateActivationTimeoutError } from "./update-command-activation.js";
import * as convergence from "./update-command-convergence.js";
import { updateExecutorNativeEntrypoints } from "./update-command-executor-native-runtime.test-support.js";
import {
  withUpdateCommandExecutor,
  withUpdateCommandExecutorChild,
} from "./update-command-executor.js";
import { admitUpdateCommandLedger } from "./update-command-ledger.js";
import { finishSuccessfulPackageSwitch } from "./update-command-post-update.test-support.js";
import { assertUpdateCommandPackageFinalization } from "./update-command-recovery.js";
import * as rollback from "./update-command-rollback.js";
import * as service from "./update-command-service.js";
import { withUpdateCommandTerminalResult } from "./update-command-terminal.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => {
  const temporary = dirs.make("update-activation-tmp-");
  vi.spyOn(temporaryRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(temporary);
});
afterEach(() => {
  vi.useRealTimers();
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

it.each([
  { retained: false, freebsd: false },
  { retained: true, freebsd: false },
  { retained: false, freebsd: true },
  { retained: true, freebsd: true },
])(
  "records an activation timeout while settlement remains pending (retained A: $retained, FreeBSD admission: $freebsd)",
  async ({ retained, freebsd }) => {
    const root = fs.realpathSync(dirs.make("update-activation-"));
    const serviceRoot = retained
      ? fs.realpathSync(dirs.make("update-retained-activation-"))
      : undefined;
    const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
    const freebsdWriteAdmission = freebsd
      ? withMockedPlatform("freebsd", () => createFreeBsdUpdateWriteAdmission())
      : undefined;
    await freebsdWriteAdmission?.revalidate(() => {});
    const run = {
      runId: createUpdateRun({ trigger: "cli" }, { env }).runId,
      env,
      freebsdWriteAdmission,
    };
    admitUpdateCommandLedger(run);
    const output = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
    vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    const entered = createDeferred();
    const release = createDeferred();
    let childWork: Promise<unknown> | undefined;
    let outcome: unknown;
    let assertCurrent: (() => void) | undefined;
    const budget = 10 * 60_000;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const running = withUpdateCommandTerminalResult(
      async (registerRun) => {
        registerRun(run);
        await withUpdateCommandExecutor(
          run.runId,
          async (executor) => {
            const fence = await executor.enter(root, { serviceRoot, activationTimeoutMs: budget });
            assertCurrent = fence.assertCurrent;
            recordUpdateRunPhase(run.runId, "activating", undefined, { env });
            childWork = withUpdateCommandExecutorChild(fence, root, async () => {
              entered.resolve();
              await release.promise;
            });
            void childWork.catch(() => {});
            await entered.promise;
            // Returning does not settle the admitted child's outstanding work.
          },
          { onAuthorityFailure: freebsdWriteAdmission?.revoke },
        );
      },
      { json: true },
    ).catch((error: unknown) => {
      outcome = error;
    });
    try {
      await entered.promise;
      await vi.advanceTimersByTimeAsync(budget - 1);
      expect(getUpdateRun(run.runId, { env })?.status).toBe("running");
      expect(assertCurrent).toBeDefined();
      await vi.advanceTimersByTimeAsync(budget + 1);
      await running;
      expect(outcome).toMatchObject({ result: { reason: "update-activation-timeout" } });
      expect(assertCurrent).toThrow("activation");
      if (freebsdWriteAdmission) {
        expect(freebsdWriteAdmission.canWrite).toBe(true);
        expect(freebsdWriteAdmission.failure).toBeUndefined();
      }
      expect(getUpdateRun(run.runId, { env })).toMatchObject({
        phase: "finished",
        status: "failed",
        reason: "update-activation-timeout",
      });
      expect(output).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: "update-activation-timeout",
          status: "error",
        }),
      );
      expect(createManagedHandoffLeaseStore().read(root).kind).toBe("current");
      if (serviceRoot) {
        expect(createManagedHandoffLeaseStore().read(serviceRoot).kind).toBe("current");
        await expect(
          withUpdateCommandExecutor("competing-retained-owner", (other) =>
            other.enter(serviceRoot),
          ),
        ).rejects.toThrow("Another update executor");
      }
      await expect(
        withUpdateCommandExecutor(run.runId, (other) => other.enter(root)),
      ).rejects.toThrow("Another update executor");
    } finally {
      release.resolve();
      await childWork?.catch(() => {});
      await running;
    }
  },
);

it.each([false, true])(
  "checks the activation deadline after synchronous work (expired: %s)",
  async (expired) => {
    const root = fs.realpathSync(dirs.make("update-activation-clock-"));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const work = withUpdateCommandExecutor("clock-probe", async (executor) => {
      await executor.enter(root, { activationTimeoutMs: 60_000 });
      // Move the clock without dispatching timers, as a blocking native probe can.
      vi.setSystemTime(Date.now() + (expired ? 60_001 : 59_999));
      return "completed";
    });
    if (expired) {
      await expect(work).rejects.toMatchObject({ reason: "update-activation-timeout" });
    } else {
      await expect(work).resolves.toBe("completed");
    }
    expect(createManagedHandoffLeaseStore().read(root)).toEqual({ kind: "absent" });
    expect(vi.getTimerCount()).toBe(0);
  },
);

it.each([undefined, 48 * 60 * 60_000])(
  "keeps activation alive for measured state and caller allowance %s",
  async (callerTimeoutMs) => {
    const { resolveUpdateFinalizationTimeoutMs } =
      await import("../../infra/update-finalization-budget.js");
    const root = fs.realpathSync(dirs.make("update-activation-size-"));
    const database = path.join(root, "agent.sqlite");
    const descriptor = fs.openSync(database, "w");
    fs.ftruncateSync(descriptor, 2 * 1024 ** 3);
    fs.closeSync(descriptor);
    const budget = await resolveUpdateFinalizationTimeoutMs(callerTimeoutMs, {
      databases: [{ path: database }],
      env: { ...process.env, OPENCLAW_STATE_DIR: root },
    });
    const legacyBudget = Math.max(30 * 60_000, (callerTimeoutMs ?? 0) * 6);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    await expect(
      withUpdateCommandExecutor("measured-activation", async (executor) => {
        const fence = await executor.enter(root, { activationTimeoutMs: budget });
        vi.setSystemTime(Date.now() + (callerTimeoutMs ?? legacyBudget + 1));
        fence.assertCurrent();
        return "completed";
      }),
    ).resolves.toBe("completed");
    expect(createManagedHandoffLeaseStore().read(root)).toEqual({ kind: "absent" });
  },
);

it("preserves retained ownership when preflight starts a measured activation deadline", async () => {
  const root = fs.realpathSync(dirs.make("update-preflight-activation-"));
  const serviceRoot = fs.realpathSync(dirs.make("update-preflight-retained-"));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  await expect(
    withUpdateCommandExecutor("retained-preflight", async (executor) => {
      const preflight = await executor.enter(root, { preflight: true, serviceRoot });
      vi.setSystemTime(Date.now() + 3_600_000);
      preflight.assertCurrent();
      const activation = await executor.enter(root, { serviceRoot, activationTimeoutMs: 60_000 });
      expect(activation).toBe(preflight);
      expect(createManagedHandoffLeaseStore().read(serviceRoot).kind).toBe("current");
      vi.setSystemTime(Date.now() + 60_001);
      activation.assertCurrent();
    }),
  ).rejects.toMatchObject({ reason: "update-activation-timeout" });
  expect(createManagedHandoffLeaseStore().read(root)).toEqual({ kind: "absent" });
  expect(createManagedHandoffLeaseStore().read(serviceRoot)).toEqual({ kind: "absent" });
  expect(vi.getTimerCount()).toBe(0);
});

it.each([
  "clean",
  "requester finalization",
  "revoked requester finalization",
  "package admission expiry",
  "native before expiry",
  "native after expiry",
  "private database after expiry",
  "retained owner after expiry",
])("separates activation expiry from native diagnostic custody: %s", async (fault) => {
  const root = fs.realpathSync(dirs.make("update-timeout-custody-"));
  const coordinatorDirectory = path.join(root, "coordinators");
  await withStateDatabaseCoordinatorRuntimeDirectory(
    { directory: coordinatorDirectory, keepAlive: true },
    async () => {
      try {
        const temporary = path.join(root, "private-tmp");
        fs.mkdirSync(temporary, { mode: 0o700 });
        vi.spyOn(temporaryRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(temporary);
        const serviceRoot =
          fault === "retained owner after expiry" ? path.join(root, "service") : undefined;
        if (serviceRoot) {
          fs.mkdirSync(serviceRoot);
        }
        const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
        const admission = withMockedPlatform("freebsd", () => createFreeBsdUpdateWriteAdmission()!);
        await admission.revalidate(() => {});
        const created = createUpdateRun({ trigger: "cli" }, { env });
        const run: NonNullable<UpdateCommandOptions["run"]> = {
          runId: created.runId,
          env,
          freebsdWriteAdmission: admission,
        };
        admitUpdateCommandLedger(run);
        const requesterFinalization = fault.includes("requester finalization");
        let requesterCurrent = true;
        if (requesterFinalization) {
          run.requesterAuthority = { requester: {}, isCurrent: () => requesterCurrent };
        }
        const converge = vi.spyOn(convergence, "convergeUpdatePlugins");
        const rollbackUpdate = vi.spyOn(rollback, "rollbackFailedUpdate");
        const restart = vi.spyOn(service, "maybeRestartService");
        let finalizationError: unknown;
        let admissionAwaitObserved = false;
        const output = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
        vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
        const refusal = vi.fn((cause: unknown) => admission.revoke(cause));
        const replaceOwner = () => {
          const { DatabaseSync } = requireNodeSqlite();
          const db = new DatabaseSync(path.join(temporary, "managed-update-handoffs.sqlite"));
          try {
            db.prepare("UPDATE managed_update_handoffs SET owner = ? WHERE install_root = ?").run(
              "replaced",
              serviceRoot ?? root,
            );
          } finally {
            db.close();
          }
        };
        let first: unknown;
        let timeout: unknown;
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
        await withUpdateCommandTerminalResult(
          async (registerRun) => {
            registerRun(run);
            await withUpdateCommandExecutor(
              run.runId,
              async (executor) => {
                const fence = await executor.enter(root, {
                  serviceRoot,
                  activationTimeoutMs: 60_000,
                });
                run.executorFence = fence;
                if (fault === "native before expiry") {
                  replaceOwner();
                  try {
                    fence.assertCurrent();
                  } catch (error) {
                    first = error;
                  }
                  expect(first).toBeInstanceOf(Error);
                }
                if (fault === "package admission expiry") {
                  const lstat = fsp.lstat.bind(fsp);
                  vi.spyOn(fsp, "lstat").mockImplementation(async (...args) => {
                    const result = await lstat(...args);
                    if (
                      !admissionAwaitObserved &&
                      String(args[0]) === path.dirname(resolveOpenClawStateSqlitePath(env))
                    ) {
                      admissionAwaitObserved = true;
                      vi.setSystemTime(Date.now() + 60_001);
                    }
                    return result;
                  });
                  try {
                    await assertUpdateCommandPackageFinalization({
                      opts: { run },
                      result: { status: "ok", mode: "npm", root, steps: [], durationMs: 0 },
                    });
                  } catch (error) {
                    finalizationError = error;
                  }
                } else {
                  if (fault === "revoked requester finalization") {
                    requesterCurrent = false;
                  }
                  vi.setSystemTime(Date.now() + 60_001);
                }
                try {
                  assertUpdateWriteAuthority(admission, fence.assertCurrent);
                } catch (error) {
                  timeout = error;
                }
                if (!first) {
                  expect(timeout).toBeInstanceOf(UpdateActivationTimeoutError);
                } else {
                  expect(timeout).toBe(first);
                }
                if (requesterFinalization) {
                  try {
                    await finishSuccessfulPackageSwitch({ packageRoot: root, run });
                  } catch (error) {
                    finalizationError = error;
                    if (!requesterCurrent) {
                      first = error;
                    }
                  }
                }
                if (fault === "native after expiry" || serviceRoot) {
                  replaceOwner();
                }
                if (fault === "private database after expiry") {
                  const database = path.join(temporary, "managed-update-handoffs.sqlite");
                  fs.renameSync(database, database + ".displaced");
                  fs.writeFileSync(database, "foreign generation", { mode: 0o600 });
                }
                // The executor must inspect custody during settlement, even though the
                // public effect fence now throws an operation timeout.
                throw timeout;
              },
              { onAuthorityFailure: refusal },
            );
          },
          { json: true },
        ).catch(() => {});
        if (requesterFinalization || fault === "package admission expiry") {
          expect(finalizationError).toBe(requesterCurrent ? timeout : first);
          expect(finalizationError).toBeInstanceOf(Error);
          expect(converge).not.toHaveBeenCalled();
          expect(rollbackUpdate).not.toHaveBeenCalled();
          expect(restart).not.toHaveBeenCalled();
          if (fault === "package admission expiry") {
            expect(admissionAwaitObserved).toBe(true);
          }
          if (!requesterCurrent) {
            expect(first).toMatchObject({ code: "requester-revoked" });
          }
        }
        if (
          fault === "clean" ||
          fault === "requester finalization" ||
          fault === "package admission expiry"
        ) {
          expect(admission.canWrite).toBe(true);
          expect(refusal).not.toHaveBeenCalled();
          expect(getUpdateRun(run.runId, { env })).toMatchObject({
            status: "failed",
            reason: "update-activation-timeout",
          });
          expect(output).toHaveBeenCalledTimes(1);
          expect(createManagedHandoffLeaseStore().read(root)).toEqual({ kind: "absent" });
        } else {
          expect(admission.canWrite).toBe(false);
          expect(admission.failure).toBeInstanceOf(Error);
          expect(admission.failure).not.toBeInstanceOf(UpdateActivationTimeoutError);
          if (first) {
            expect(admission.failure).toBe(first);
          }
          expect(getUpdateRun(run.runId, { env })).toEqual(created);
          expect(output).not.toHaveBeenCalled();
        }
      } finally {
        // Terminal history releases idle pooled coordinators, not activation work.
        // Dispose only this fixture's pool before checking for leaked deadline timers.
        closeIdleSqliteCoordinators(coordinatorDirectory);
      }
    },
  );
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["clean", "parent", "receiver", "retained receiver", "private database"])(
  "observes delegated native custody after expiry without poisoning clean timeout: %s",
  async (fault) => {
    const root = fs.realpathSync(dirs.make("update-delegated-timeout-"));
    const temporary = path.join(root, "private-tmp");
    fs.mkdirSync(temporary, { mode: 0o700 });
    vi.spyOn(temporaryRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(temporary);
    const serviceRoot = fault === "retained receiver" ? path.join(root, "service") : undefined;
    if (serviceRoot) {
      fs.mkdirSync(serviceRoot);
    }
    const worker = resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.executor);
    const sourceArgs = worker.pathname.endsWith(".ts")
      ? ["--import", path.resolve("scripts/tsx.mjs")]
      : [];
    let result: Awaited<ReturnType<typeof runUtf8CommandWithTimeout>> | undefined;
    const running = withUpdateCommandExecutor("delegated-timeout", async (executor) => {
      const fence = await executor.enter(root, { serviceRoot });
      await withUpdateCommandExecutorChild(fence, root, async (grant, beforeInput) => {
        result = await runUtf8CommandWithTimeout(
          [
            process.execPath,
            ...sourceArgs,
            "--input-type=module",
            "-e",
            `
          import assert from 'node:assert/strict';
          import fs from 'node:fs';
          import {DatabaseSync} from 'node:sqlite';
          import {json} from 'node:stream/consumers';
          import {withDelegatedUpdateCommandExecutor} from ${JSON.stringify(worker.href)};
          import {createFreeBsdUpdateWriteAdmission,assertUpdateWriteAuthority} from ${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.freebsdWriteAdmission).href)};
          import {UpdateActivationTimeoutError} from ${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.activation).href)};
          const grant = await json(process.stdin);
          const descriptor = Object.getOwnPropertyDescriptor(process,'platform');
          let admission;
          try { Object.defineProperty(process,'platform',{value:'freebsd'}); admission=createFreeBsdUpdateWriteAdmission(); }
          finally { Object.defineProperty(process,'platform',descriptor); }
          const fault=${JSON.stringify(fault)};
          const now=Date.now;
          let expired;
          try {
            await withDelegatedUpdateCommandExecutor(grant,grant.runId,grant.root,async(fence)=>{
              await admission.revalidate(fence.assertCurrent);
              const after=now()+60001;
              Date.now=()=>after;
              try { assertUpdateWriteAuthority(admission,fence.assertCurrent); }
              catch(error) { expired=error; }
              assert(expired instanceof UpdateActivationTimeoutError);
              assert.equal(admission.canWrite,true);
              if(fault==='private database') {
                fs.renameSync(grant.databasePath,grant.databasePath+'.displaced');
                fs.writeFileSync(grant.databasePath,'foreign generation',{mode:0o600});
              } else if(fault!=='clean') {
                const db=new DatabaseSync(grant.databasePath);
                const key=fault==='parent'?grant.originalParent.key:fault==='receiver'?grant.childKey:grant.retainedChildKey;
                try { db.prepare('UPDATE managed_update_handoffs SET owner = ? WHERE install_root = ?').run('replacement',key); }
                finally { db.close(); }
              }
              throw expired;
            },{activationTimeoutMs:60000,onAuthorityFailure:admission.revoke});
            throw new Error('expired operation unexpectedly succeeded');
          } catch(error) {
            assert(error instanceof UpdateActivationTimeoutError);
          } finally { Date.now=now; }
          if(fault==='clean') {
            assert.equal(admission.canWrite,true); assert.equal(admission.failure,undefined);
          } else {
            assert.equal(admission.canWrite,false); assert(admission.failure instanceof Error);
            assert(!(admission.failure instanceof UpdateActivationTimeoutError));
          }
          process.stdout.write(JSON.stringify({canWrite:admission.canWrite,refused:!!admission.failure}));
        `,
          ],
          {
            input: JSON.stringify(grant),
            beforeInput,
            timeoutMs: 15_000,
            killProcessTree: true,
            requireProcessTreeExtinction: true,
          },
        );
        return result;
      });
    });
    if (fault === "clean") {
      await running;
    } else {
      await expect(running).rejects.toThrow();
    }
    expect(result, "real bound child must finish its assertions").toBeDefined();
    expect(result?.code, result?.stderr).toBe(0);
    expect(result).toMatchObject({ termination: "exit", cleanup: "normal" });
    expect(JSON.parse(result!.stdout)).toEqual({
      canWrite: fault === "clean",
      refused: fault !== "clean",
    });
  },
  30_000,
);
