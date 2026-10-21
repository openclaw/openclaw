import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
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
it.each([
  ["announce", "after-acceptance"],
  ["webhook", "after-acceptance"],
  ["announce", "before-delivery"],
  ["webhook", "before-delivery"],
  ["announce", "legacy-unknown"],
  ["webhook", "legacy-unknown"],
] as const)(
  "recovers %s interrupted %s without duplicating its completion",
  async (mode, interrupted) => {
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
    const restart = async (previous: typeof first, next: typeof first) => {
      previous.cron.stop();
      advanceCronActiveJobGeneration();
      await next.cron.start();
      await next.clock.advanceBy(120_000);
      await onTimer(next.state);
    };
    const expectedDeliveries = interrupted === "before-delivery" ? [] : [result];
    const expectRecoveredOnce = () => {
      expect(received).toEqual([result]);
      expect(executionCount).toBe(interrupted === "before-delivery" ? 2 : 1);
    };
    let tick: Promise<void> | undefined;
    try {
      await first.cron.start();
      const job = await first.cron.add(
        cronTestInput({
          ...(interrupted === "before-delivery" ? { deleteAfterRun: false } : {}),
          schedule: { kind: "at", at: new Date(clock.clock.now() + 1_000).toISOString() },
          delivery:
            mode === "announce"
              ? { mode, channel: "telegram", to: "123" }
              : { mode, to: "http://127.0.0.1/completion" },
        }),
      );
      clock.setTime(job.state.nextRunAtMs!);
      tick = onTimer(first.state);
      await reachedInterruption.promise;
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

      await restart(first, replacement);
      expectRecoveredOnce();
      const recovered = await replacement.cron.readJob(job.id);
      expect(recovered).toMatchObject({
        enabled: false,
        state: {
          lastRunStatus: interrupted === "before-delivery" ? "ok" : "error",
          ...(interrupted !== "before-delivery"
            ? { lastError: interruptedError, lastDeliveryStatus: "unknown" }
            : { lastDeliveryStatus: "delivered" }),
        },
      });
      expect(recovered?.state.nextRunAtMs).toBeUndefined();
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

      await restart(replacement, secondReplacement);
      expectRecoveredOnce();
      expect(await secondReplacement.cron.readJob(job.id)).toEqual(recovered);
      expect(readHistory()).toEqual(history);
    } finally {
      for (const owner of [first, replacement, secondReplacement]) {
        owner.cron.stop();
      }
      acknowledgment.resolve();
      await tick;
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
    mutation.mockRestore();
  }
});
