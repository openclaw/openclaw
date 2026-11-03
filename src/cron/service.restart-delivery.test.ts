import { afterEach, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { sendGatewayCronWebhook } from "../gateway/server-cron-notifications.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { advanceCronActiveJobGeneration } from "./active-jobs.js";
import { sendCronAnnouncePayloadStrict } from "./delivery.js";
import { readCronRunHistoryPageForTests } from "./run-history.test-support.js";
import { cronTestDeps, cronTestInput } from "./service.fixture-builders.test-support.js";
import { CronService } from "./service.js";
import {
  createCronServiceWithStateForTest,
  setupCronServiceSuite,
} from "./service.test-harness.js";
import * as runtimeMutations from "./service/runtime-mutation.js";
import type { CronServiceDeps } from "./service/state.js";
import { onTimer } from "./service/timer.test-support.js";
import { cronStoreKey } from "./store/key.js";
import { inspectActiveCronRunReceipt } from "./store/run-receipt-store.test-support.js";

const transports = vi.hoisted(() => ({
  deliverOutboundPayloads:
    vi.fn<typeof import("../infra/outbound/deliver.js").deliverOutboundPayloads>(),
}));

vi.mock("./isolated-agent/delivery-target.js", () => ({
  resolveDeliveryTarget: async () => ({
    ok: true,
    channel: "telegram",
    to: "123",
    mode: "implicit",
  }),
}));
vi.mock("../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: transports.deliverOutboundPayloads,
  deliverOutboundPayloadsInternal: transports.deliverOutboundPayloads,
}));

const { makeStorePath } = setupCronServiceSuite({ prefix: "cron-restart-delivery-" });

afterEach(() => vi.unstubAllGlobals());

const result = "scheduled result";
const interruptedError = "cron: job interrupted by gateway restart";
it.for([
  ["announce", "after-acceptance", "at", 0],
  ["webhook", "after-acceptance", "at", 0],
  ["announce", "before-delivery", "at", 0],
  ["webhook", "before-delivery", "at", 0],
  ["announce", "legacy-unknown", "at", 0],
  ["webhook", "legacy-unknown", "at", 0],
  ["announce", "before-delivery", "every", 0],
  ["announce", "before-delivery", "every", 5],
] as const)(
  "recovers %s interrupted %s (%s, %i prior failures) without duplicating its completion",
  async ([mode, interrupted, scheduleKind, priorErrors], { signal }) => {
    const { storePath } = await makeStorePath();
    const clock = createGatewaySchedulerClock(Date.now());
    const reachedInterruption = createDeferred();
    const acknowledgment = createDeferred();
    const received: string[] = [];
    const receive = async (text: string) => {
      received.push(text);
      if (interrupted !== "before-delivery" && received.length === 1) {
        reachedInterruption.resolve();
        await acknowledgment.promise;
      }
    };
    transports.deliverOutboundPayloads.mockImplementation(async ({ payloads }) => {
      await receive(payloads.map((payload) => payload.text).join("\n"));
      return [{ channel: "telegram", messageId: `completion-${received.length}` }];
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (_url, init) => {
        const body = init?.body;
        if (typeof body !== "string") {
          throw new Error("Expected JSON webhook body");
        }
        const event: { summary: string } = JSON.parse(body);
        await receive(event.summary);
        return new Response(null, { status: 204 });
      }),
    );
    let executionCount = 0;
    const runIsolatedAgentJob: CronServiceDeps["runIsolatedAgentJob"] = async ({
      job,
      abortSignal,
      deliveryAttemptFence,
    }) => {
      executionCount += 1;
      if (interrupted === "before-delivery" && executionCount === 1) {
        reachedInterruption.resolve();
        await acknowledgment.promise;
        // The retired invocation exits only for fixture cleanup; it never sends.
        return { status: "skipped" };
      }
      if (mode === "announce") {
        await sendCronAnnouncePayloadStrict({
          deps: {},
          cfg: {},
          agentId: "main",
          jobId: job.id,
          target: { channel: "telegram", to: "123" },
          payload: { text: result },
          abortSignal: abortSignal!,
          completion: {
            job,
            runStartedAt: job.state.runningAtMs!,
            deliveryAttemptFence,
          },
        });
      }
      return { status: "ok", summary: result, delivered: mode === "announce" };
    };
    const deps = cronTestDeps({
      storePath,
      runIsolatedAgentJob,
      sendCronWebhook: async (params) =>
        await sendGatewayCronWebhook({
          ...params,
          ssrfPolicy: { allowedHostnames: ["127.0.0.1"] },
        }),
    });
    const createOwner = (ownerClock: typeof clock) => ({
      ...createCronServiceWithStateForTest({
        ...deps,
        scheduler: createTestGatewayScheduler(ownerClock.clock),
        nowMs: ownerClock.clock.now,
      }),
      clock: ownerClock,
    });
    const first = createOwner(clock);
    const replacement = createOwner(createGatewaySchedulerClock(Date.now() + 60_000));
    const secondReplacement = createOwner(createGatewaySchedulerClock(Date.now() + 240_000));
    const restart = async (previous: typeof first, next: typeof first, jobId: string) => {
      previous.cron.stop();
      advanceCronActiveJobGeneration();
      if (previous !== first) {
        next.clock.setTime(previous.clock.clock.now() + 60_000);
      }
      await next.cron.start();
      if (previous === first && interrupted === "before-delivery") {
        const recovered = await next.cron.readJob(jobId);
        const retryAtMs = recovered?.state.nextRunAtMs;
        expect(recovered?.state.consecutiveErrors).toBe(priorErrors);
        expect(retryAtMs).toBeGreaterThan(next.clock.clock.now());
        await next.clock.advanceTo(retryAtMs!);
      } else {
        await next.clock.advanceBy(120_000);
      }
      await onTimer(next.state);
    };
    const expectedDeliveries = interrupted === "before-delivery" ? [] : [result];
    const expectRecoveredOnce = () => {
      expect(received).toEqual([result]);
      expect(executionCount).toBe(interrupted === "before-delivery" ? 2 : 1);
    };
    let tick: Promise<void> | undefined;
    let settled: PromiseSettledResult<void>[];
    try {
      await first.cron.start();
      const job = await first.cron.add(
        cronTestInput({
          ...(interrupted === "before-delivery" ? { deleteAfterRun: false } : {}),
          schedule:
            scheduleKind === "at"
              ? { kind: "at", at: new Date(clock.clock.now() + 1_000).toISOString() }
              : {
                  kind: "every",
                  everyMs: 24 * 60 * 60_000,
                  anchorMs: clock.clock.now() + 1_000,
                },
          state: { consecutiveErrors: priorErrors },
          delivery:
            mode === "announce"
              ? { mode, channel: "telegram", to: "123" }
              : { mode, to: "http://127.0.0.1/completion" },
        }),
      );
      clock.setTime(job.state.nextRunAtMs!);
      tick = onTimer(first.state);
      await withinTest(
        awaitGateBeforeSettlement(
          reachedInterruption.promise,
          tick,
          "Cron run settled before reaching the interruption",
        ),
        signal,
      );
      expect(received).toEqual(expectedDeliveries);
      const receipt = inspectActiveCronRunReceipt({ storePath, jobId: job.id });
      expect(receipt).toBeDefined();
      expect((await first.cron.readJob(job.id))?.state.runningReceiptId).toBe(receipt?.receiptId);
      if (interrupted === "legacy-unknown") {
        // Schema-19 migration preserves uncertainty for already-running receipts.
        openOpenClawStateDatabase()
          .db.prepare(
            "UPDATE cron_run_receipts SET delivery_attempt_state = 'unknown' WHERE receipt_id = ?",
          )
          .run(receipt!.receiptId);
      }

      await restart(first, replacement, job.id);
      expectRecoveredOnce();
      const recovered = await replacement.cron.readJob(job.id);
      expect(recovered).toMatchObject({
        enabled: scheduleKind !== "at",
        state: {
          lastRunStatus: interrupted === "before-delivery" ? "ok" : "error",
          ...(interrupted !== "before-delivery"
            ? { lastError: interruptedError, lastDeliveryStatus: "unknown" }
            : { lastDeliveryStatus: "delivered" }),
        },
      });
      if (scheduleKind === "at") {
        expect(recovered?.state.nextRunAtMs).toBeUndefined();
      } else {
        expect(recovered?.state.nextRunAtMs).toBeGreaterThan(replacement.clock.clock.now());
      }
      expect(recovered?.state.startupCatchupAtMs).toBeUndefined();
      expect(inspectActiveCronRunReceipt({ storePath, jobId: job.id })).toBeUndefined();
      if (interrupted !== "before-delivery") {
        expect(recovered?.deleteAfterRun).toBe(true);
      }
      const readHistory = () =>
        readCronRunHistoryPageForTests({ storeKey: cronStoreKey(storePath), jobId: job.id })
          .entries;
      const history = readHistory();
      expect(history).toHaveLength(interrupted === "before-delivery" ? 2 : 1);
      expect(history).toContainEqual(
        expect.objectContaining({
          status: "error",
          error: interruptedError,
          runAtMs: receipt?.startedAtMs,
          deliveryStatus: "unknown",
        }),
      );
      expect(
        openOpenClawStateDatabase()
          .db.prepare("SELECT status FROM cron_run_receipts WHERE receipt_id = ?")
          .get(receipt!.receiptId),
      ).toMatchObject({ status: "interrupted" });

      await restart(replacement, secondReplacement, job.id);
      expectRecoveredOnce();
      expect(await secondReplacement.cron.readJob(job.id)).toEqual(recovered);
      expect(readHistory()).toEqual(history);
    } finally {
      const owners = [first, replacement, secondReplacement];
      for (const owner of owners) {
        owner.cron.stop();
      }
      acknowledgment.resolve();
      settled = await Promise.allSettled([
        tick,
        ...owners.map((owner) => owner.cron.waitForIdle()),
      ]);
    }
    for (const outcome of settled) {
      if (outcome.status === "rejected") {
        throw outcome.reason;
      }
    }
  },
);

it("records a rejected durable attempt as not delivered before webhook dispatch", async () => {
  const { storePath } = await makeStorePath();
  const sendCronWebhook = vi.fn<NonNullable<CronServiceDeps["sendCronWebhook"]>>();
  const runMutation = runtimeMutations.runCronRuntimeMutation;
  const mutation = vi
    .spyOn(runtimeMutations, "runCronRuntimeMutation")
    .mockImplementation(async (params) => {
      if (params.type === "cron.markDeliveryStarted") {
        throw new Error("delivery attempt could not be committed");
      }
      await runMutation(params);
    });
  const cron = new CronService(
    cronTestDeps({
      storePath,
      runIsolatedAgentJob: async () => ({ status: "ok", summary: result }),
      sendCronWebhook,
    }),
  );
  try {
    await cron.start();
    const job = await cron.add(
      cronTestInput({
        delivery: { mode: "webhook", to: "https://example.invalid/completion" },
      }),
    );
    await cron.run(job.id, "force");
    expect(sendCronWebhook).not.toHaveBeenCalled();
    expect((await cron.readJob(job.id))?.state).toMatchObject({
      lastDelivered: false,
      lastDeliveryStatus: "not-delivered",
      lastDeliveryError: "delivery attempt could not be committed",
    });
  } finally {
    cron.stop();
    await cron.waitForIdle();
    mutation.mockRestore();
  }
});
