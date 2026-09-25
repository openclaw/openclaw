import { expect, vi } from "vitest";
import { createFixtureLifetime } from "../../../test/helpers/fixture-lifetime.js";
import {
  captureGatewayRootWorkAdmissionContinuationScope,
  GatewayDrainingError,
  type GatewayRootWorkAdmissionContinuationScope,
} from "../../process/gateway-work-admission.js";
import * as stateRead from "../../state/openclaw-state-db-readonly.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { writeCronStoreSnapshot, type setupCronServiceSuite } from "../service.test-harness.js";
import { cronStoreKey } from "../store/key.js";
import {
  claimCronRunReceiptInDatabase,
  prepareCronRunReceiptClaim,
  releaseLocalCronRunReceiptOwnership,
} from "../store/run-receipt-store.js";
import type { CronRunRecoveryProposal } from "../store/run-recovery-read.types.js";
import type { CronRunRecoveryResult } from "../store/run-recovery.types.js";
import type { CronJob } from "../types.js";
import { stop } from "./ops-lifecycle.js";
import { recoverCronRunProposals } from "./run-recovery.js";
import { createCronServiceState, type CronServiceState, type Logger } from "./state.js";
import { tryCreateCronTaskRunHandle } from "./task-runs.js";

type Failure = { error: unknown };

/** The local lease protects stores; the default lifetime also retains the process owner. */
export function createCronRecoveryFixture(
  suite: Pick<ReturnType<typeof setupCronServiceSuite>, "acquireFixture">,
  registerFinished: (report: () => void) => unknown,
) {
  let active: { finish: () => Promise<Failure | undefined>; markReported: () => void } | undefined;
  return {
    async finishAfterEach() {
      const current = active;
      active = undefined;
      const failure = await current?.finish();
      if (current && failure) {
        // Unknown quiescence must block parent resets; afterAll has its own lease guard.
        current.markReported();
        throw failure.error;
      }
    },
    async run(body: (fixture: ReturnType<typeof makeOwner>) => Promise<void>) {
      const lease = suite.acquireFixture();
      const lifetime = createFixtureLifetime();
      const controller = new AbortController();
      const releases: Array<() => void | Promise<unknown>> = [];
      let failure: Failure | undefined;
      let reported = false;
      let finishing: Promise<Failure | undefined> | undefined;
      const report = () => {
        if (failure && !reported) {
          reported = true;
          throw failure.error;
        }
      };
      const release = (action: () => void | Promise<unknown>) => {
        try {
          lifetime.track(Promise.resolve(action()), true);
        } catch (error) {
          lifetime.verifyCleanup(async () => {
            throw error;
          });
        }
      };
      const finish = () =>
        (finishing ??= (async () => {
          lease.closeAdmission();
          controller.abort(new Error("Cron recovery fixture retired"));
          for (const action of releases) release(action);
          try {
            await lease.verifyQuiescence(() => lifetime.cleanup());
          } catch (error) {
            failure = { error };
          }
          return failure;
        })());
      active = {
        finish,
        markReported: () => {
          reported = true;
        },
      };
      registerFinished(report);
      const owner = makeOwner(lease, lifetime, controller.signal, (action) => {
        if (controller.signal.aborted) release(action);
        else releases.push(action);
      });
      let primary: Failure | undefined;
      try {
        await lifetime.run(async () => {
          controller.signal.throwIfAborted();
          await body(owner);
        });
      } catch (error) {
        primary = { error };
      }
      const cleanup = await finish();
      if (cleanup) reported = true;
      if (primary && cleanup) {
        throw new AggregateError(
          [primary.error, cleanup.error],
          "Recovery fixture and cleanup failed",
          {
            cause: primary.error,
          },
        );
      }
      if (primary) throw primary.error;
      if (cleanup) throw cleanup.error;
    },
  };
}

function makeOwner(
  lease: ReturnType<ReturnType<typeof setupCronServiceSuite>["acquireFixture"]>,
  lifetime: ReturnType<typeof createFixtureLifetime>,
  signal: AbortSignal,
  release: (action: () => void | Promise<unknown>) => void,
) {
  const cancelled = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  void cancelled.catch(() => {});
  const states = new Set<CronServiceState>();
  const timers = new Map<CronServiceState, Promise<unknown>>();
  const cleanup = (action: () => Promise<void>) => {
    void lifetime.acquire(async () => ({ cleanup: action }));
  };
  return {
    signal,
    makeStorePath: lease.makeStorePath,
    track: lifetime.track,
    release,
    cleanup,
    assertCurrent: () => signal.throwIfAborted(),
    async waitFor<T>(ready: Promise<T>, producer: Promise<unknown>): Promise<T> {
      signal.throwIfAborted();
      const value = await Promise.race([
        ready,
        producer.then(() => {
          throw new Error("Cron producer completed before fixture readiness");
        }),
        cancelled,
      ]);
      signal.throwIfAborted();
      return value;
    },
    timerCompletion(state: CronServiceState) {
      const completion = timers.get(state);
      if (!completion) throw new Error("Expected an observed cron timer producer");
      return completion;
    },
    state(state: CronServiceState) {
      signal.throwIfAborted();
      const delegate = state.deps.runSchedulerOwned;
      state.deps.runSchedulerOwned = (run) => {
        const completion = delegate ? delegate(run) : run();
        timers.set(state, lifetime.track(completion));
        return completion;
      };
      if (!states.has(state)) {
        states.add(state);
        release(() => stop(state));
        cleanup(async () => {
          stop(state);
          await Promise.allSettled([lifetime.track(state.op)]);
        });
      }
      return state;
    },
  };
}

/** Seed actual receipt/task identities; callers keep their job and expected-result literals. */
export async function seedInterruptedCronJobs(state: CronServiceState, jobs: CronJob[]) {
  const storePath = state.deps.storePath;
  await writeCronStoreSnapshot({ storePath, jobs });
  for (const job of jobs) {
    const startedAtMs = job.state.runningAtMs;
    if (startedAtMs === undefined) throw new Error("Expected an interrupted run timestamp");
    const receipt = claimCronRecoveryReceipt(storePath, job, startedAtMs);
    try {
      job.state.runningReceiptId = receipt.receiptId;
      const handle = tryCreateCronTaskRunHandle({
        state,
        job,
        startedAt: startedAtMs,
        runReceipt: receipt,
      });
      if (!handle.taskId) throw new Error("Expected a persisted cron task identity");
    } finally {
      releaseLocalCronRunReceiptOwnership(receipt);
    }
  }
  await writeCronStoreSnapshot({ storePath, jobs });
}

export async function observeCronRecoveryForTest(
  state: CronServiceState,
  jobId: string,
  queuedAtMs: number | undefined,
  runningAtMs: number | undefined,
): Promise<CronRunRecoveryProposal> {
  const result = await stateRead.executeExistingOpenClawStateRead(
    {},
    {
      type: "cron.observeRunRecovery",
      storeKey: cronStoreKey(state.deps.storePath),
      proposals: [{ jobId, queuedAtMs, runningAtMs }],
    },
  );
  if (
    !result?.ok ||
    result.type !== "cron.observeRunRecovery" ||
    result.observation.kind !== "observed"
  ) {
    throw new Error("Expected a recovery observation");
  }
  return result.observation.proposals[0]!;
}

export async function recoverCronRunForTest(
  state: CronServiceState,
  proposal: CronRunRecoveryProposal,
  mode: "startup" | "reclaim" = "reclaim",
): Promise<CronRunRecoveryResult> {
  let recovered: CronRunRecoveryResult | undefined;
  await recoverCronRunProposals(state, [proposal], {
    mode,
    onRecovery(_proposal, result) {
      recovered = result;
    },
  });
  if (!recovered) {
    throw new Error("Expected a recovery result");
  }
  return recovered;
}

type RecoveryStateOverrides = Partial<
  Pick<
    Parameters<typeof createCronServiceState>[0],
    "cronConfig" | "enqueueSystemEvent" | "requestHeartbeat" | "sendCronFailureAlert"
  >
>;

export function makeCronRecoveryState(
  log: Logger,
  storePath: string,
  nowMs: number,
  overrides: RecoveryStateOverrides = {},
) {
  return createCronServiceState({
    storePath,
    cronEnabled: true,
    log,
    nowMs: () => nowMs,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    ...overrides,
  });
}

export function claimCronRecoveryReceipt(storePath: string, job: CronJob, startedAtMs: number) {
  const prepared = prepareCronRunReceiptClaim({
    storePath,
    job,
    agentId: job.agentId ?? "alpha",
    startedAtMs,
  });
  return runOpenClawStateWriteTransaction(({ db }) =>
    claimCronRunReceiptInDatabase({
      database: db,
      prepared,
      resolveAgentId: (current) => current.agentId ?? "alpha",
    }),
  );
}

export function observeCronTimerAdmissions(state: CronServiceState) {
  const scopes: GatewayRootWorkAdmissionContinuationScope[] = [];
  state.deps.runSchedulerOwned = async (run) => {
    // Borrow the tick's exact root without extending its lifetime. Process-wide
    // counts can change when unrelated work settles, or conceal an offsetting leak.
    const scope = captureGatewayRootWorkAdmissionContinuationScope();
    expect(scope).not.toBeNull();
    scopes.push(scope!);
    return await run();
  };
  return {
    async expectActive() {
      expect(scopes).toHaveLength(1);
      await expect(scopes[0]!.run(async () => true)).resolves.toBe(true);
    },
    async expectReleased(count: number) {
      expect(scopes).toHaveLength(count);
      for (const scope of scopes) {
        await expect(scope.run(async () => undefined)).rejects.toThrow(GatewayDrainingError);
      }
    },
  };
}
