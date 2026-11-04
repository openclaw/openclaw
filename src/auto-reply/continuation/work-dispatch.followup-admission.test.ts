// karmaterminal/openclaw#1271, j12′: a continue_work wake runs its own turn now or is refused,
// never queued as a follow-up (RFC §5.4.2). With follow-ups pending and no active run, reply
// admission used to queue the wake: its dispatcher saw no start and requeued the claim, and the
// queued copy ran it too. Real: the reply owner (admission, the follow-up queue and its drain), the
// dispatcher, the custody store and boot, the agent database and the system-event queue.
// Synthetic: the provider, which records each turn it runs.
import "../../test-utils/prepare-compiled-subprocesses.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { captureRuntimeConfigAsyncReader } from "../../config/io.runtime.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { enqueueSystemEvent, peekSystemEvents } from "../../infra/system-events.js";
import { resetGatewayWorkAdmission } from "../../process/gateway-work-admission.js";
import { isSessionRunActiveForKey } from "../../sessions/session-controller.queries.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { GetReplyOptions } from "../get-reply-options.types.js";
import { withFullRuntimeReplyConfig } from "../reply/get-reply-fast-path.js";
import { prewarmConfigDrivenReplyRuntime } from "../reply/get-reply-from-config.runtime.js";
import { getReplyFromConfig } from "../reply/get-reply.js";
import { finalizeInboundContext } from "../reply/inbound-context.js";
import { getExistingFollowupQueue, hasPendingFollowupQueueWork } from "../reply/queue/state.js";
import { resolveContinuationRuntimeConfig } from "./config.js";
import { runContinuationCustodyBoot } from "./custody-boot.js";
import { resetContinuationCustodyProjection } from "./custody/custody-projection.js";
import { hydrateContinuationCustody, listContinuationRecords } from "./custody/custody-store.js";
import {
  resetWorkDispatchCustodyHooks,
  settleWorkDispatchCustody,
  workDispatchCustodyHooks,
} from "./work-dispatch-flow-mock.test-support.js";
import {
  dispatchPendingContinuationWork,
  resetContinuationWorkDispatchForTests,
  scheduleContinuationWork,
} from "./work-dispatch.js";

const world = vi.hoisted(() => ({
  /** Names a turn by its prompt: `user-N`, `event-N` or `wake`. */
  label: (prompt: string) =>
    prompt.includes("[continuation:wake]")
      ? "wake"
      : (/(user|event)-\d/.exec(prompt)?.[0] ?? "other"),
  /** Every turn the provider ran, in order. */
  effects: [] as string[],
  /** Run ids of the wake turns the provider ran. */
  wakeRunIds: [] as string[],
  /** Turns aborted while they were held. */
  interrupted: [] as string[],
  /** The next turn waits here, after its effect, until released or aborted. */
  hold: undefined as { entered: () => void; released: Promise<void> } | undefined,
}));
// The provider is the edge: it reports the run's start, commits the turn's effect, and completes.
vi.mock("../../agents/embedded-agent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/embedded-agent.js")>()),
  runEmbeddedAgent: async (params: {
    prompt: string;
    runId: string;
    abortSignal?: AbortSignal;
    onAgentEvent?: (event: { stream: string; data: Record<string, unknown> }) => unknown;
  }) => {
    await params.onAgentEvent?.({ stream: "lifecycle", data: { phase: "start" } });
    world.effects.push(world.label(params.prompt));
    if (world.label(params.prompt) === "wake") {
      world.wakeRunIds.push(params.runId);
    }
    const hold = world.hold;
    world.hold = undefined;
    if (hold) {
      hold.entered();
      const aborted = new Promise<void>((resolve) => {
        params.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
      });
      await Promise.race([hold.released, aborted]);
      if (params.abortSignal?.aborted) {
        world.interrupted.push(world.label(params.prompt));
      }
    }
    return { payloads: [{ text: "done" }], meta: { durationMs: 1 } };
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

await prewarmConfigDrivenReplyRuntime();

const FOLLOWUP_DEBOUNCE_MS = 500;
const CLOCK_STEP_MS = 100;
const REFUSED = "Retryable continuation skip: admission-refused";
const REQUEUED = "Requeued same-session continuation wake";
// Worker replies arrive as real macrotasks that the injected clock never advances.
const realSetImmediate = globalThis.setImmediate;
const realNow = performance.now.bind(performance);
let sessionCount = 0;
let key = "";

beforeEach(() => {
  key = `agent:main:dashboard:wake-admission-${++sessionCount}`;
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "performance"] });
});
afterEach(() => {
  resetWorkDispatchCustodyHooks();
  resetContinuationWorkDispatchForTests();
  resetContinuationCustodyProjection();
  resetGatewayWorkAdmission();
  closeOpenClawAgentDatabasesForTest();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  world.effects.length = 0;
  world.wakeRunIds.length = 0;
  world.interrupted.length = 0;
  world.hold = undefined;
});

/** A session in `mode` whose first user turn has run, with continuation enabled. */
async function withSession(mode: "followup" | "steer" | "interrupt", run: () => Promise<void>) {
  await withOpenClawTestState(
    { label: "wake-admission", env: { OPENCLAW_TEST_FAST: "0" } },
    async (state) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", state.env.OPENCLAW_STATE_DIR);
      const cfg = withFullRuntimeReplyConfig({
        agents: {
          defaults: {
            workspace: state.workspaceDir,
            skipBootstrap: true,
            model: { primary: "mock-openai/gpt-4o" },
            models: { "mock-openai/gpt-4o": { agentRuntime: { id: "openclaw" as const } } },
            continuation: { enabled: true },
          },
        },
        plugins: { enabled: false },
        messages: { queue: { mode } },
      });
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg);
      await captureRuntimeConfigAsyncReader()();
      await hydrateContinuationCustody();
      await userTurn(0);
      await run();
    },
  );
}

const userTurn = (n: number) =>
  getReplyFromConfig(
    finalizeInboundContext({
      Provider: "webchat",
      Surface: "webchat",
      ChatType: "direct",
      SessionKey: key,
      Body: `user-${n} please continue`,
    }),
  );

/** The dispatcher's own wake context, with another trigger or none. */
const systemTurn = (n: number, trigger: GetReplyOptions["continuationTrigger"]) =>
  getReplyFromConfig(
    finalizeInboundContext({
      Provider: "system",
      Surface: "system",
      From: "system",
      To: "agent",
      SessionKey: key,
      Body: `event-${n} check the build`,
    }),
    trigger ? { continuationTrigger: trigger } : undefined,
  );

/** The production election: one continue_work due in 60 s, made due now. */
async function electDueWake(): Promise<string> {
  const result = await scheduleContinuationWork({
    sessionKey: key,
    chainState: { currentChainCount: 0, chainStartedAt: Date.now(), accumulatedChainTokens: 0 },
    request: { reason: "send the weekly report", delaySeconds: 60 },
    config: resolveContinuationRuntimeConfig(),
  });
  expect(result.scheduled).toBe(true);
  const [record] = await listContinuationRecords({ ownerSessionKey: key, kinds: ["work"] });
  vi.setSystemTime(record!.dueAt! + 1);
  return record!.recordId;
}

/** The next turn holds the session after its effect; resolves once it is running. */
function holdNextTurn() {
  const running = createDeferred();
  const released = createDeferred();
  world.hold = { entered: running.resolve, released: released.promise };
  return { running: running.promise, release: released.resolve };
}

/** user-2 and user-3 queue behind a running user-1, which then ends: no active run remains. */
async function queueFollowupsBehindEndedTurn() {
  const held = holdNextTurn();
  const first = userTurn(1);
  await held.running;
  expect(await userTurn(2)).toBeUndefined();
  expect(await userTurn(3)).toBeUndefined();
  held.release();
  await first;
  expect(pendingFollowups()).toEqual(["user-2", "user-3"]);
}

/** The wake reached the session's input queue, waiting, steering or claimed. */
const wakeEnteredSession = () =>
  (getExistingFollowupQueue(key)?.entries ?? []).some(
    (input) => input.source && world.label(input.source.prompt) === "wake",
  );

const pendingFollowups = () =>
  (getExistingFollowupQueue(key)?.items ?? []).map((item) => world.label(item.prompt));

/**
 * Yield real macrotasks until `done` holds, letting `stepMs` of injected time pass between checks.
 * With no step, only due timers fire.
 */
async function until(done: () => boolean | Promise<boolean>, stepMs = 0) {
  const deadline = realNow() + 30_000;
  while (!(await done())) {
    if (realNow() > deadline) {
      throw new Error(`stalled with effects ${JSON.stringify(world.effects)}`);
    }
    await new Promise<void>((resolve) => {
      realSetImmediate(resolve);
    });
    await settleWorkDispatchCustody();
    await vi.advanceTimersByTimeAsync(stepMs);
  }
  await settleWorkDispatchCustody();
}

const ran =
  (...labels: string[]) =>
  () =>
    labels.every((label) => world.effects.includes(label));
/** Every queued turn has run and none is running. */
const drained = () =>
  ran("user-3")() && !hasPendingFollowupQueueWork([key]) && !isSessionRunActiveForKey(key);
const readWork = async (recordId: string) =>
  (await listContinuationRecords({ recordIds: [recordId] }))[0]!;
/** The wake's turn ran and its delivery was recorded. */
const delivered = (recordId: string) => async () =>
  world.effects.includes("wake") && (await readWork(recordId)).status === "succeeded";
const workState = async (recordId: string) =>
  JSON.parse((await readWork(recordId)).stateJson) as Record<string, unknown>;

async function expectRanOnceAfterFollowups(recordId: string) {
  expect(world.effects).toEqual(["user-0", "user-1", "user-2", "user-3", "wake"]);
  expect(await readWork(recordId)).toMatchObject({ status: "succeeded" });
  expect(await workState(recordId)).toMatchObject({
    turnStart: { runId: world.wakeRunIds[0] },
    succeeded: { durability: "durable" },
  });
}

describe("a due continue_work wake with follow-ups pending and no active run", () => {
  it("is refused, never queued: the follow-ups run in order, then the wake once", async () => {
    await withSession("followup", async () => {
      const recordId = await electDueWake();
      await queueFollowupsBehindEndedTurn();
      enqueueSystemEvent("note-1 the build is green", { sessionKey: key, trusted: true });

      await dispatchPendingContinuationWork({ sessionKey: key });
      await settleWorkDispatchCustody();
      // No turn, no queued copy, nothing consumed; the claim is requeued without its fence.
      expect(pendingFollowups()).toEqual(["user-2", "user-3"]);
      expect(world.effects).toEqual(["user-0", "user-1"]);
      expect(peekSystemEvents(key)).toEqual(["note-1 the build is green"]);
      expect(await readWork(recordId)).toMatchObject({ status: "queued", failureReason: REFUSED });
      expect(await workState(recordId)).not.toHaveProperty("turnStart");

      await until(delivered(recordId), CLOCK_STEP_MS);
      await expectRanOnceAfterFollowups(recordId);
    });
  });

  it("runs once through a restart while it is requeued", async () => {
    await withSession("followup", async () => {
      const recordId = await electDueWake();
      await queueFollowupsBehindEndedTurn();
      await dispatchPendingContinuationWork({ sessionKey: key });
      // The queued turns drain within their debounce, before the claim's retry is due.
      await vi.advanceTimersByTimeAsync(FOLLOWUP_DEBOUNCE_MS);
      await until(drained);
      expect(await readWork(recordId)).toMatchObject({ status: "queued" });

      // The Gateway restarts before the retry: process-local dispatch state is gone.
      resetContinuationWorkDispatchForTests();
      resetGatewayWorkAdmission();
      await runContinuationCustodyBoot({
        armedAt: Date.now(),
        whenSubagentRegistryActivated: async () => {},
      });
      await until(delivered(recordId), CLOCK_STEP_MS);
      await expectRanOnceAfterFollowups(recordId);
    });
  });
});

describe("a due continue_work wake whose session becomes active before reply admission", () => {
  // A user turn starts between the dispatcher's busy check and the wake's admission. The wake would
  // be steered into that turn or queued behind it (steer), or interrupt it (interrupt); it is
  // refused and waits for that turn instead.
  it.each(["steer", "interrupt"] as const)(
    "in %s mode is refused, then runs once after that turn",
    async (mode) => {
      await withSession(mode, async () => {
        const recordId = await electDueWake();
        const held = holdNextTurn();
        let userTurnOne: ReturnType<typeof userTurn> | undefined;
        workDispatchCustodyHooks.beforeUpdate = async (updates) => {
          if (!userTurnOne && updates.some((u) => u.patch.stateJson?.includes('"turnStart"'))) {
            userTurnOne = userTurn(1);
            await held.running;
          }
        };
        const dispatching = dispatchPendingContinuationWork({ sessionKey: key });
        // Admission decides while user-1 holds the session: the wake is requeued, or it entered
        // the session's input queue (steered, queued, or run once user-1 is interrupted).
        await until(
          async () => wakeEnteredSession() || (await readWork(recordId)).phase === REQUEUED,
        );
        const entered = wakeEnteredSession();
        const decided = await readWork(recordId);
        held.release();
        await Promise.allSettled([userTurnOne, dispatching]);
        expect(world.interrupted).toEqual([]);
        expect(entered).toBe(false);
        expect(decided).toMatchObject({ status: "queued", failureReason: REFUSED });

        await until(delivered(recordId), CLOCK_STEP_MS);
        expect(world.effects).toEqual(["user-0", "user-1", "wake"]);
      });
    },
  );
});

describe("unchanged admission (controls)", () => {
  it("runs a due wake at once when nothing is pending", async () => {
    await withSession("followup", async () => {
      const recordId = await electDueWake();
      await dispatchPendingContinuationWork({ sessionKey: key });
      await until(delivered(recordId), CLOCK_STEP_MS);
      expect(world.effects).toEqual(["user-0", "wake"]);
    });
  });

  // The dispatcher folds a due wake into an active turn; with no live embedded run to carry the
  // note here, it keeps the wake for that turn's end. Reply admission never sees it.
  it("folds or parks a due wake at an active run, then runs it once", async () => {
    await withSession("followup", async () => {
      const recordId = await electDueWake();
      const held = holdNextTurn();
      const first = userTurn(1);
      await held.running;
      await dispatchPendingContinuationWork({ sessionKey: key });
      await settleWorkDispatchCustody();
      expect(pendingFollowups()).toEqual([]);
      expect(await readWork(recordId)).toMatchObject({
        status: "queued",
        failureReason: expect.stringContaining("fold-note delivery failed"),
      });

      held.release();
      await first;
      await until(delivered(recordId), CLOCK_STEP_MS);
      expect(world.effects).toEqual(["user-0", "user-1", "wake"]);
    });
  });

  it.each([undefined, "delegate-return"] as const)(
    "queues another system turn (trigger %s) behind pending follow-ups, as before",
    async (trigger) => {
      await withSession("followup", async () => {
        await queueFollowupsBehindEndedTurn();
        expect(await systemTurn(4, trigger)).toBeUndefined();
        expect(pendingFollowups()).toEqual(["user-2", "user-3", "event-4"]);
        await until(ran("event-4"), CLOCK_STEP_MS);
        expect(world.effects).toEqual(["user-0", "user-1", "user-2", "user-3", "event-4"]);
      });
    },
  );
});
