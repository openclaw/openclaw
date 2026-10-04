import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { sendGatewayCronWebhook } from "../gateway/server-cron-notifications.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { advanceCronActiveJobGeneration } from "./active-jobs.js";
import { sendCronAnnouncePayloadStrict } from "./delivery.js";
import { CronService } from "./service.js";
import { setupCronServiceSuite } from "./service.test-harness.js";
import * as runtimeMutations from "./service/runtime-mutation.js";
import type { CronServiceDeps } from "./service/state.js";
import * as receipts from "./store/run-receipt-store.js";
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

const { logger, makeStorePath } = setupCronServiceSuite({ prefix: "cron-restart-delivery-" });

afterEach(() => vi.unstubAllGlobals());

it.each([
  { mode: "announce", interrupted: "after-acceptance" },
  { mode: "webhook", interrupted: "after-acceptance" },
  { mode: "announce", interrupted: "before-delivery" },
  { mode: "webhook", interrupted: "before-delivery" },
] as const)(
  "recovers $mode interrupted $interrupted without duplicating its completion",
  async ({ mode, interrupted }) => {
    const { storePath } = await makeStorePath();
    const clock = createGatewaySchedulerClock(Date.now());
    const reachedInterruption = createDeferred();
    const acknowledgment = createDeferred();
    const received: string[] = [];
    const receive = async (text: string) => {
      received.push(text);
      if (interrupted === "after-acceptance" && received.length === 1) {
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
          payload: { text: "scheduled result" },
          abortSignal: abortSignal!,
          completion: {
            job,
            runStartedAt: job.state.runningAtMs!,
            deliveryAttemptFence,
          },
        });
      }
      return { status: "ok", summary: "scheduled result", delivered: mode === "announce" };
    };
    const deps: CronServiceDeps = {
      storePath,
      scheduler: createTestGatewayScheduler(clock.clock),
      nowMs: clock.clock.now,
      cronEnabled: true,
      log: logger,
      enqueueSystemEvent: vi.fn(),
      enqueueSessionEvent: vi.fn(),
      runIsolatedAgentJob,
      sendCronWebhook: async (params) =>
        await sendGatewayCronWebhook({
          ...params,
          ssrfPolicy: { allowedHostnames: ["127.0.0.1"] },
        }),
    };
    const first = new CronService(deps);
    const replacementClock = createGatewaySchedulerClock(Date.now() + 60_000);
    const replacement = new CronService({
      ...deps,
      scheduler: createTestGatewayScheduler(replacementClock.clock),
      nowMs: replacementClock.clock.now,
    });
    const secondReplacementClock = createGatewaySchedulerClock(Date.now() + 240_000);
    const secondReplacement = new CronService({
      ...deps,
      scheduler: createTestGatewayScheduler(secondReplacementClock.clock),
      nowMs: secondReplacementClock.clock.now,
    });
    let tick: ReturnType<typeof clock.advanceTo> = undefined;
    let restoreOwnerProbe: (() => void) | undefined;
    try {
      await first.start();
      const job = await first.add({
        name: "one completion across restart",
        enabled: true,
        ...(interrupted === "before-delivery" ? { deleteAfterRun: false } : {}),
        schedule: { kind: "at", at: new Date(clock.clock.now() + 1_000).toISOString() },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "produce the scheduled result" },
        delivery:
          mode === "announce"
            ? { mode, channel: "telegram", to: "123" }
            : { mode, to: "http://127.0.0.1/completion" },
      });
      tick = clock.advanceTo(job.state.nextRunAtMs!);
      await reachedInterruption.promise;
      expect(received).toEqual(interrupted === "after-acceptance" ? ["scheduled result"] : []);
      const receipt = inspectActiveCronRunReceipt({ storePath, jobId: job.id });
      expect(receipt).toBeDefined();
      expect((await first.readJob(job.id))?.state.runningReceiptId).toBe(receipt?.receiptId);

      // Simulate process death at the liveness probe. Admission, receipt identity,
      // recovery CAS, catch-up, and finalization use their real persisted state.
      const probe = receipts.isCronRunReceiptOwnerStale;
      const ownerProbe = vi
        .spyOn(receipts, "isCronRunReceiptOwnerStale")
        .mockImplementation(
          (candidate, nowMs) =>
            candidate.receiptId === receipt?.receiptId || probe(candidate, nowMs),
        );
      restoreOwnerProbe = () => ownerProbe.mockRestore();
      first.stop();
      advanceCronActiveJobGeneration();
      await replacement.start();
      await replacementClock.advanceBy(120_000);

      expect(received).toEqual(["scheduled result"]);
      const recovered = await replacement.readJob(job.id);
      expect(recovered).toMatchObject({
        enabled: false,
        state:
          interrupted === "after-acceptance"
            ? { lastRunStatus: "error", lastDeliveryStatus: "unknown" }
            : { lastRunStatus: "ok", lastDeliveryStatus: "delivered" },
      });
      expect(recovered?.state.nextRunAtMs).toBeUndefined();
      expect(recovered?.state.startupCatchupAtMs).toBeUndefined();
      expect(inspectActiveCronRunReceipt({ storePath, jobId: job.id })).toBeUndefined();
      if (interrupted === "after-acceptance") {
        expect(recovered?.deleteAfterRun).toBe(true);
      }

      replacement.stop();
      advanceCronActiveJobGeneration();
      await secondReplacement.start();
      await secondReplacementClock.advanceBy(120_000);
      expect(received).toEqual(["scheduled result"]);
      expect(await secondReplacement.readJob(job.id)).toEqual(recovered);
    } finally {
      first.stop();
      replacement.stop();
      secondReplacement.stop();
      acknowledgment.resolve();
      try {
        await tick;
      } finally {
        restoreOwnerProbe?.();
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
  const cron = new CronService({
    storePath,
    scheduler: createTestGatewayScheduler(),
    cronEnabled: true,
    log: logger,
    enqueueSystemEvent: vi.fn(),
    enqueueSessionEvent: vi.fn(),
    runIsolatedAgentJob: async () => ({ status: "ok", summary: "scheduled result" }),
    sendCronWebhook,
  });
  try {
    await cron.start();
    const job = await cron.add({
      name: "webhook admission refusal",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "produce the scheduled result" },
      delivery: { mode: "webhook", to: "https://example.invalid/completion" },
    });
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
