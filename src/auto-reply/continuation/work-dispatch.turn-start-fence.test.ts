// karmaterminal/openclaw#1271, gate-2 ruling A: a kept continue_work wake is at-most-once, crash
// recovery included. Its turn-start fence is durable before the turn can run; recovery retries only
// a claimed wake with no fence, and a started wake whose delivery was never confirmed ends
// interrupted with one visible notice, never run again. Real: the agent database and its authority
// epochs, the election, the dispatcher and its hedge, the custody store and boot, the
// session-delivery queue and the in-memory event queue. Observed only: the turns the reply owner is
// asked to run (each commits the turn's effect when it runs), the custody writes, and the wake and
// delivery timer the notice requests.
import "../../test-utils/prepare-compiled-subprocesses.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureRuntimeConfigAsyncReader } from "../../config/io.runtime.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import * as accessor from "../../config/sessions/session-accessor.js";
import { loadPendingSessionDeliveries } from "../../infra/session-delivery-queue-storage.js";
import { drainSystemEventEntries, peekSystemEvents } from "../../infra/system-events.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { resetGatewayWorkAdmission } from "../../process/gateway-work-admission.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { GetReplyOptions } from "../get-reply-options.types.js";
import { resolveContinuationRuntimeConfig } from "./config.js";
import { runContinuationCustodyBoot } from "./custody-boot.js";
import { resetContinuationCustodyProjection } from "./custody/custody-projection.js";
import {
  hydrateContinuationCustody,
  listContinuationRecords,
  updateContinuationRecords,
} from "./custody/custody-store.js";
import { executePendingContinuationWork } from "./work-dispatch-execution.js";
import {
  describeWorkTransition,
  resetWorkDispatchCustodyHooks,
  settleWorkDispatchCustody,
  workDispatchCustodyHooks,
} from "./work-dispatch-flow-mock.test-support.js";
import {
  dispatchPendingContinuationWork,
  rearmContinuationWorkDispatch,
  resetContinuationWorkDispatchForTests,
  scheduleContinuationWork,
} from "./work-dispatch.js";
import { consumePendingWork } from "./work-store.js";
import { resetTerminalNoticeRetriesForTests } from "./work-terminal-notice.js";

const world = vi.hoisted(() => ({
  /** Every turn the reply owner was asked to run, with the run id it was handed. */
  turns: [] as Array<{ body: string; runId?: string }>,
  /** Custody writes and turns, in the order they happened. */
  order: [] as string[],
  /** The Gateway dies inside the next turn, after its effect and before anything else. */
  dieAfterEffect: false,
  /** The next turn is silent, and the Gateway starts draining while it runs. */
  drainDuringTurn: false,
  wakes: [] as Array<{ sessionKey: string; deliveryIds: readonly string[] }>,
}));
// The reply owner is the boundary where a wake's turn runs: the run reports its start, commits the
// turn's effect, and completes, unless the Gateway dies under it.
vi.mock("../reply/get-reply.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../reply/get-reply.js")>()),
  getReplyFromConfig: async (ctx: { Body?: string }, opts?: GetReplyOptions) => {
    const runId = opts?.runId ?? "run-not-named-by-the-dispatcher";
    opts?.onPreparedAgentRunStart?.({ runId, transcriptStart: null });
    world.turns.push({ body: ctx.Body ?? "", ...(opts?.runId ? { runId: opts.runId } : {}) });
    world.order.push("turn");
    if (world.dieAfterEffect) {
      return await new Promise<never>(() => {});
    }
    opts?.onAgentRunTerminalOutcome?.("completed");
    if (world.drainDuringTurn) {
      world.drainDuringTurn = false;
      (await import("../../process/gateway-work-admission.js")).markGatewayRestartDraining();
      return undefined;
    }
    return { text: "continued" };
  },
}));
// mock-isolation: The helper returns the real custody store with every export kept, adding test hooks and in-flight counting.
vi.mock("./custody/custody-store.js", async (importOriginal) =>
  (await import("./work-dispatch-flow-mock.test-support.js")).wrapCustodyStoreForWorkDispatch(
    await importOriginal(),
  ),
);
// mock-isolation: The helper returns the real authority module with every export kept, adding in-flight counting.
vi.mock("./work-recipient-authority.js", async (importOriginal) =>
  (
    await import("./work-dispatch-flow-mock.test-support.js")
  ).wrapWorkRecipientAuthorityForWorkDispatch(await importOriginal()),
);
// The notice's wake is recorded; the notice row and its fast-path event stay real.
vi.mock("./continuation-wake.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./continuation-wake.js")>()),
  requestContinuationWake: (request: { sessionKey: string; deliveryIds: readonly string[] }) => {
    world.wakes.push(request);
  },
}));
// mock-isolation: Delivery scheduling is recorded without running the session delivery runtime.
vi.mock("../../infra/session-delivery-queue-runtime.js", () => ({
  scheduleSessionDelivery: async () => true,
}));

const KEY = "agent:main:start-fence";
const INTERRUPTED = "turn-started-delivery-unconfirmed";
const NOTICE_TAG = "[continuation:work-turn-interrupted]";
const RUNNING_RECOVERY_STALE_MS = 60_000;
const cfg = { agents: { defaults: { continuation: { enabled: true } }, entries: { main: {} } } };
const ownerA = { type: "human" as const, source: "unknown" as const, id: "owner-a" };
const ownerB = { type: "human" as const, id: "owner-b" };
type Scope = { agentId: string; env: NodeJS.ProcessEnv; sessionKey: string };

/** Notice events the in-memory queue held when a modeled restart dropped it. */
let droppedNoticeEvents = 0;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  setActivePluginRegistry(createEmptyPluginRegistry());
  workDispatchCustodyHooks.onApplied = (update, record) => {
    const transition = describeWorkTransition(update);
    if (transition) {
      world.order.push(transition);
    } else if (
      update.patch.stateJson?.includes('"turnStart"') &&
      !world.order.includes("fence") &&
      record.status === "running"
    ) {
      world.order.push("fence");
    }
  };
});
afterEach(() => {
  resetWorkDispatchCustodyHooks();
  resetContinuationWorkDispatchForTests();
  resetTerminalNoticeRetriesForTests();
  resetContinuationCustodyProjection();
  resetPluginRuntimeStateForTest();
  resetGatewayWorkAdmission();
  closeOpenClawAgentDatabasesForTest();
  drainSystemEventEntries(KEY);
  vi.useRealTimers();
  vi.unstubAllEnvs();
  world.turns.length = 0;
  world.order.length = 0;
  world.wakes.length = 0;
  world.dieAfterEffect = false;
  world.drainDuringTurn = false;
  droppedNoticeEvents = 0;
});

/** A shared session owned by owner A whose authority row exists before the election. */
async function withSession(run: (scope: Scope) => Promise<void>) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    vi.stubEnv("OPENCLAW_STATE_DIR", state.env.OPENCLAW_STATE_DIR);
    setRuntimeConfigSnapshot(cfg);
    await state.writeConfig(cfg);
    await captureRuntimeConfigAsyncReader()();
    await hydrateContinuationCustody();
    const scope = { agentId: "main", env: state.env, sessionKey: KEY };
    await accessor.upsertSessionEntryCore(scope, {
      sessionId: "head-1",
      updatedAt: 1,
      createdActor: ownerA,
      visibility: "shared",
    });
    await accessor.captureSessionRecipientAuthority(scope);
    // Worker threads stamp authority rows on the real clock; elections follow every setup write.
    vi.setSystemTime(vi.getRealSystemTime() + 1);
    await run(scope);
  });
}

/** The production election: one continue_work due in 60 s. Returns its record and due time. */
async function elect(): Promise<{ recordId: string; dueAt: number }> {
  const result = await scheduleContinuationWork({
    sessionKey: KEY,
    chainState: { currentChainCount: 0, chainStartedAt: Date.now(), accumulatedChainTokens: 0 },
    request: { reason: "send the weekly report", delaySeconds: 60 },
    config: resolveContinuationRuntimeConfig(),
  });
  expect(result.scheduled).toBe(true);
  const [record] = await listContinuationRecords({ ownerSessionKey: KEY, kinds: ["work"] });
  if (!record?.dueAt) {
    throw new Error("expected one queued continue_work record");
  }
  return { recordId: record.recordId, dueAt: record.dueAt };
}

const readWork = async (recordId: string) =>
  (await listContinuationRecords({ recordIds: [recordId] }))[0];
const stateOf = async (recordId: string) =>
  JSON.parse((await readWork(recordId))!.stateJson) as Record<string, unknown>;
const wakeTurns = () => world.turns.filter((turn) => turn.body.startsWith("[continuation:wake]"));

/** The due wake's dispatch in a Gateway that dies under it: never awaited, its process is gone. */
async function dispatchInDyingGateway(dueAt: number): Promise<number> {
  vi.setSystemTime(dueAt + 1);
  const claimedAt = Date.now();
  void dispatchPendingContinuationWork({ sessionKey: KEY });
  await settleWorkDispatchCustody();
  return claimedAt;
}

/** The Gateway restarts at `at`: process-local state is gone, durable state remains. */
function restart(at: number) {
  droppedNoticeEvents += drainSystemEventEntries(KEY).filter((event) =>
    event.text.startsWith(NOTICE_TAG),
  ).length;
  resetContinuationWorkDispatchForTests();
  resetTerminalNoticeRetriesForTests();
  resetGatewayWorkAdmission();
  world.dieAfterEffect = false;
  delete workDispatchCustodyHooks.diesBefore;
  vi.setSystemTime(at);
}

const boot = () =>
  runContinuationCustodyBoot({
    armedAt: Date.now(),
    whenSubagentRegistryActivated: async () => {},
  });

/** A restart at `at` whose custody boot replays durable state. */
async function restartAndBoot(at: number) {
  restart(at);
  await boot();
  await settleWorkDispatchCustody();
}

async function advanceTimers(ms: number) {
  await settleWorkDispatchCustody();
  await vi.advanceTimersByTimeAsync(ms);
  await settleWorkDispatchCustody();
}

/** Every visible copy of the interrupted notice: durable rows, fast-path events, wakes. */
async function interruptedNotices() {
  const rows = (
    await loadPendingSessionDeliveries(captureOpenClawStateWorkerContext({ env: process.env }))
  ).filter((entry) => entry.kind === "systemEvent" && entry.text.startsWith(NOTICE_TAG));
  const events =
    droppedNoticeEvents +
    peekSystemEvents(KEY).filter((text) => text.startsWith(NOTICE_TAG)).length;
  return { rows, events, wakes: world.wakes.length };
}

async function expectInterruptedOnce(recordId: string) {
  expect(wakeTurns()).toHaveLength(1);
  expect(await readWork(recordId)).toMatchObject({ status: "failed", failureReason: INTERRUPTED });
  const notices = await interruptedNotices();
  expect(notices).toMatchObject({ rows: [expect.anything()], events: 1, wakes: 1 });
  // The notice names the record and the run whose effects may have happened.
  expect(notices.rows[0]?.kind === "systemEvent" && notices.rows[0].text).toContain(recordId);
  expect(notices.rows[0]?.kind === "systemEvent" && notices.rows[0].text).toContain(
    wakeTurns()[0]!.runId,
  );
}

describe("the turn-start fence", () => {
  it("is durable before the turn runs, under the run id the turn runs with", async () => {
    await withSession(async () => {
      const { recordId, dueAt } = await elect();
      vi.setSystemTime(dueAt + 1);
      await dispatchPendingContinuationWork({ sessionKey: KEY });

      expect(world.order).toEqual([
        "fence",
        "turn",
        "delivered-mark-committed",
        "flow-finished:Same-session continuation turn granted",
      ]);
      expect(await readWork(recordId)).toMatchObject({ status: "succeeded" });
      const [turn] = wakeTurns();
      expect(wakeTurns()).toHaveLength(1);
      expect(await stateOf(recordId)).toMatchObject({
        turnStart: { startedAt: dueAt + 1, runId: turn?.runId },
        succeeded: { point: "optimal", durability: "durable" },
      });
      expect(await interruptedNotices()).toEqual({ rows: [], events: 0, wakes: 0 });
    });
  });

  it("lets recovery retry a claim whose Gateway died before its fence, once", async () => {
    await withSession(async () => {
      const { recordId, dueAt } = await elect();
      workDispatchCustodyHooks.diesBefore = (updates) =>
        updates.some((update) => update.patch.stateJson?.includes('"turnStart"'));
      const claimedAt = await dispatchInDyingGateway(dueAt);
      // The dying Gateway claimed the wake and never committed the fence, so its turn never ran.
      expect(wakeTurns()).toEqual([]);
      expect(await readWork(recordId)).toMatchObject({ status: "running" });

      await restartAndBoot(claimedAt + RUNNING_RECOVERY_STALE_MS + 1);
      expect(wakeTurns()).toHaveLength(1);
      expect(await readWork(recordId)).toMatchObject({ status: "succeeded" });
      expect(await interruptedNotices()).toEqual({ rows: [], events: 0, wakes: 0 });
    });
  });

  it("never starts the turn when the fence write is refused; the claim stays retryable", async () => {
    await withSession(async () => {
      const { recordId, dueAt } = await elect();
      workDispatchCustodyHooks.beforeUpdate = (updates) => {
        if (updates.some((update) => update.patch.stateJson?.includes('"turnStart"'))) {
          workDispatchCustodyHooks.refuseUpdatesWith = "fence refused once";
        }
      };
      vi.setSystemTime(dueAt + 1);
      await dispatchPendingContinuationWork({ sessionKey: KEY });
      expect(wakeTurns()).toEqual([]);
      expect(await readWork(recordId)).toMatchObject({ status: "running" });

      workDispatchCustodyHooks.beforeUpdate = undefined;
      delete workDispatchCustodyHooks.refuseUpdatesWith;
      // The hedge the dispatch armed for its running claim recovers it once it is stale.
      await advanceTimers(RUNNING_RECOVERY_STALE_MS);
      expect(wakeTurns()).toHaveLength(1);
      expect(await readWork(recordId)).toMatchObject({ status: "succeeded" });
    });
  });
});

describe("a wake whose turn started but whose delivery was never confirmed", () => {
  // The Gateway dies inside the turn, after its effect and before the delivered mark. Recovery
  // reaches it through the boot's replay once it is stale, or through the hedge the boot arms.
  it.each(["replay after a restart", "the hedge"] as const)(
    "is interrupted once with one notice through %s, never run again",
    async (path) => {
      await withSession(async () => {
        const { recordId, dueAt } = await elect();
        world.dieAfterEffect = true;
        const claimedAt = await dispatchInDyingGateway(dueAt);
        expect(wakeTurns()).toHaveLength(1);
        expect(await readWork(recordId)).toMatchObject({ status: "running" });

        if (path === "replay after a restart") {
          await restartAndBoot(claimedAt + RUNNING_RECOVERY_STALE_MS + 1);
        } else {
          await restartAndBoot(claimedAt + 1_000);
          expect(await readWork(recordId)).toMatchObject({ status: "running" });
          await advanceTimers(RUNNING_RECOVERY_STALE_MS);
        }
        await expectInterruptedOnce(recordId);
      });
    },
  );

  it("adds no notice on a second recovery pass or a second restart", async () => {
    await withSession(async () => {
      const { recordId, dueAt } = await elect();
      world.dieAfterEffect = true;
      const claimedAt = await dispatchInDyingGateway(dueAt);
      await restartAndBoot(claimedAt + RUNNING_RECOVERY_STALE_MS + 1);
      await expectInterruptedOnce(recordId);

      await dispatchPendingContinuationWork({
        sessionKey: KEY,
        recoverRunning: true,
        includeRunningUpdatedAtOrBefore: Date.now(),
        includeIdleRetry: true,
      });
      await restartAndBoot(Date.now() + RUNNING_RECOVERY_STALE_MS);
      await advanceTimers(RUNNING_RECOVERY_STALE_MS);
      await expectInterruptedOnce(recordId);
    });
  });

  it("is interrupted once when the hedge and the boot recovery contend for it", async () => {
    await withSession(async () => {
      const { recordId, dueAt } = await elect();
      world.dieAfterEffect = true;
      const claimedAt = await dispatchInDyingGateway(dueAt);
      // Hold the first interrupt until the second contender, which read the same revision, arrives.
      let releaseFirst: (() => void) | undefined;
      let contenders = 0;
      workDispatchCustodyHooks.beforeUpdate = async (updates) => {
        if (!updates.some((update) => update.patch.failureReason === INTERRUPTED)) {
          return;
        }
        contenders += 1;
        if (!releaseFirst) {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        } else {
          releaseFirst();
        }
      };

      restart(claimedAt + RUNNING_RECOVERY_STALE_MS + 1);
      const booted = boot();
      // A reset's re-arm fires the hedge at once, while the boot recovers.
      rearmContinuationWorkDispatch(KEY);
      await vi.advanceTimersByTimeAsync(0);
      await booted;
      await settleWorkDispatchCustody();

      expect(contenders).toBe(2);
      await expectInterruptedOnce(recordId);
    });
  });
});

// In process, too: once the run reported its start, the claim is never requeued.
describe("a run that started in a live Gateway", () => {
  it("is never requeued when its delivered mark fails; recovery interrupts it once", async () => {
    await withSession(async () => {
      const { recordId, dueAt } = await elect();
      let markFails = true;
      workDispatchCustodyHooks.beforeUpdate = (updates) => {
        if (
          markFails &&
          updates.some((u) => describeWorkTransition(u) === "delivered-mark-committed")
        ) {
          markFails = false;
          throw new Error("state database busy");
        }
      };
      vi.setSystemTime(dueAt + 1);
      await dispatchPendingContinuationWork({ sessionKey: KEY });
      // The hedge the dispatch armed for its running claim, once the claim is stale.
      await advanceTimers(RUNNING_RECOVERY_STALE_MS);
      await expectInterruptedOnce(recordId);
    });
  });

  it("is granted when silent and completed as the Gateway starts draining", async () => {
    await withSession(async () => {
      const { recordId, dueAt } = await elect();
      world.drainDuringTurn = true;
      vi.setSystemTime(dueAt + 1);
      await dispatchPendingContinuationWork({ sessionKey: KEY });

      await restartAndBoot(Date.now() + RUNNING_RECOVERY_STALE_MS + 1);
      expect(wakeTurns()).toHaveLength(1);
      expect(await readWork(recordId)).toMatchObject({ status: "succeeded" });
    });
  });
});

describe("controls", () => {
  it("fails closed on a malformed fence: the record is rejected, never driven", async () => {
    await withSession(async () => {
      const { recordId, dueAt } = await elect();
      vi.setSystemTime(dueAt + 1);
      const [claimed] = await consumePendingWork(KEY);
      const record = (await readWork(recordId))!;
      const malformed = { ...(await stateOf(recordId)), turnStart: { startedAt: "soon" } };
      await updateContinuationRecords(
        [
          {
            recordId,
            ownerSessionKey: KEY,
            expectedRevision: claimed!.expectedRevision!,
            patch: { stateJson: JSON.stringify(malformed), updatedAt: record.updatedAt },
          },
        ],
        { now: record.updatedAt },
      );

      await restartAndBoot(Date.now() + RUNNING_RECOVERY_STALE_MS + 1);
      expect(wakeTurns()).toEqual([]);
      expect(await readWork(recordId)).toMatchObject({ status: "failed" });
    });
  });

  it("leaves a refused wake unfenced and unnoticed: the refusal precedes the fence", async () => {
    await withSession(async (scope) => {
      const { recordId, dueAt } = await elect();
      vi.setSystemTime(dueAt + 1);
      const [claimed] = await consumePendingWork(KEY);
      accessor.assignSessionOwner(scope, {
        owner: ownerB,
        assignedBy: ownerA,
        assignedAt: 3,
      });
      const policy = {
        reasonCategory: "follow-up-work",
        busyRetryDelayMs: 1_000,
        idleRetryHedgeMs: 60_000,
        mainCommandLane: "main",
      } as const;
      expect(
        await executePendingContinuationWork(claimed!, policy, new AbortController().signal),
      ).toEqual({ kind: "failed" });

      await restartAndBoot(Date.now() + RUNNING_RECOVERY_STALE_MS + 1);
      expect(wakeTurns()).toEqual([]);
      expect(await readWork(recordId)).toMatchObject({
        status: "failed",
        failureReason: "recipient-authority-changed",
      });
      expect(await stateOf(recordId)).not.toHaveProperty("turnStart");
      expect(await interruptedNotices()).toEqual({ rows: [], events: 0, wakes: 0 });
    });
  });
});
