// Command and script completion announcements own one durable recipient intent
// per admitted occurrence and route, across in-run retries, outbound-queue
// replay, and the scheduler's native retry run.
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createMessageReceiptFromOutboundResults } from "../channels/message/receipt.js";
import type {
  ChannelMessageSendAttemptContext,
  ChannelMessageSendTextContext,
} from "../channels/message/types.js";
import type { CliDeps } from "../cli/deps.types.js";
import { resolveSessionStorePathCore } from "../config/sessions/inbound.runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CronCompletionDeliveryFence } from "../cron/delivery-attempt-fence.js";
import { loadCronSessionEntryLatest } from "../cron/isolated-agent/session.js";
import { CronService } from "../cron/service.js";
import { createNoopLogger } from "../cron/service.test-harness.js";
import type { CronEvent, CronServiceDeps } from "../cron/service/state.js";
import type { CronJob } from "../cron/types.js";
import { PlatformMessageNotDispatchedError } from "../infra/outbound/deliver-types.js";
import { deliverOutboundPayloads } from "../infra/outbound/deliver.js";
import { drainPendingDeliveriesCore } from "../infra/outbound/delivery-queue-recovery.js";
import {
  createRecoveryLog,
  installDeliveryQueueTmpDirHooks,
  loadPendingDeliveries,
} from "../infra/outbound/delivery-queue.test-helpers.js";
import { resolveOutboundSessionRoute } from "../infra/outbound/outbound-session.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { finalizeCronCompletionAnnouncement } from "./server-cron-completion.js";

const AT_MS = Date.UTC(2026, 9, 3, 9, 0, 0);
const DAY_MS = 24 * 60 * 60_000;
const REMINDER = "Stand-up starts in 10 minutes";

type CompletionParams = Parameters<typeof finalizeCronCompletionAnnouncement>[0];

function reminderJob(overrides: Partial<Pick<CronJob, "delivery">> = {}): CronJob {
  return {
    id: "reminder-job",
    name: "reminder",
    enabled: true,
    createdAtMs: AT_MS - 60_000,
    updatedAtMs: AT_MS - 60_000,
    schedule: { kind: "at", at: new Date(AT_MS).toISOString() },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "command", argv: ["/bin/cat"] },
    delivery: { mode: "announce", channel: "matrix", to: "!room:example" },
    deleteAfterRun: true,
    state: { nextRunAtMs: AT_MS },
    ...overrides,
  };
}

/** A fence for an occurrence no earlier run admitted (see service.delivery-occurrence.test.ts). */
function unadmittedOccurrence(occurrenceAtMs: number): CronCompletionDeliveryFence {
  return { occurrenceAtMs, beforeAttempt: async () => {}, assertCurrent: () => {} };
}

describe("finalizeCronCompletionAnnouncement durable occurrence delivery", () => {
  const fixtures = installDeliveryQueueTmpDirHooks();
  const cfg = {} as OpenClawConfig;
  /** Announcements use this config; a per-room scope gives each room its own conversation. */
  let agentCfg = cfg;
  const platform = {
    down: false,
    failures: 0,
    sent: [] as { to: string; text: string }[],
  };

  beforeEach(() => {
    vi.stubEnv("OPENCLAW_STATE_DIR", fixtures.tmpDir());
    platform.down = false;
    platform.failures = 0;
    platform.sent = [];
    agentCfg = cfg;
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "matrix",
            outbound: {
              deliveryMode: "direct",
              sendText: async ({ to, text, onPlatformSendDispatch }) => {
                if (platform.down) {
                  platform.failures += 1;
                  throw new PlatformMessageNotDispatchedError("matrix is disconnected", {
                    cause: new Error("socket closed"),
                  });
                }
                await onPlatformSendDispatch?.();
                platform.sent.push({ to, text });
                return { channel: "matrix", messageId: `matrix-${platform.sent.length}` };
              },
            },
          }),
        },
      ]),
    );
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
    vi.unstubAllEnvs();
  });

  function finalizeAnnouncement(
    params: Pick<CompletionParams, "deliveryAttemptFence" | "job" | "runStartedAtMs"> &
      Partial<Pick<CompletionParams, "abortSignal">>,
  ) {
    return finalizeCronCompletionAnnouncement({
      ...params,
      text: REMINDER,
      deps: {} as CliDeps,
      resolveCronAgent: () => ({ agentId: "main", cfg: agentCfg }),
      logger: { warn: vi.fn() } as unknown as CompletionParams["logger"],
      label: "command",
    });
  }

  async function announce(job: CronJob, runStartedAtMs: number, occurrenceAtMs = AT_MS) {
    return await finalizeAnnouncement({
      deliveryAttemptFence: unadmittedOccurrence(occurrenceAtMs),
      job,
      runStartedAtMs,
    });
  }

  /**
   * A scheduler whose command runs end as listed, announcing through the
   * Gateway's completion owner the way `server-cron.ts` wires it.
   */
  function startReminderScheduler(
    runs: Array<
      "announce" | "announce, then time out" | "announce after recovery delivered it" | "time out"
    >,
  ) {
    const clock = createGatewaySchedulerClock(Date.now());
    let finished = createDeferred<CronEvent>();
    // Abort cleanup can outlive a timed-out run; tests wait for it explicitly.
    const announcements: Promise<unknown>[] = [];
    const runJob: NonNullable<CronServiceDeps["runCommandJob"]> = async ({
      job,
      abortSignal,
      deliveryAttemptFence,
    }) => {
      const run = runs.shift();
      if (run === "time out") {
        return { status: "error", error: "cron: job execution timed out" };
      }
      if (run === "announce after recovery delivered it") {
        // The run's first attempts fail. Queue recovery then delivers their
        // send during the retry delay, and retention prunes its receipt before
        // the run's next attempt.
        platform.down = true;
        await finalizeAnnouncement({
          deliveryAttemptFence,
          job,
          runStartedAtMs: job.state.runningAtMs,
          abortSignal,
        });
        platform.down = false;
        await drainOnReconnect();
        pruneCompletionReceipts();
      }
      const announcement = finalizeAnnouncement({
        deliveryAttemptFence,
        job,
        runStartedAtMs: job.state.runningAtMs,
        abortSignal,
      });
      announcements.push(announcement);
      const completion = await announcement;
      return run === "announce" || run === "announce after recovery delivered it"
        ? { status: "ok", summary: REMINDER, ...completion }
        : { status: "error", error: "cron: job execution timed out", ...completion };
    };
    const cron = new CronService({
      storePath: path.join(fixtures.tmpDir(), "cron", "jobs.json"),
      scheduler: createTestGatewayScheduler(clock.clock),
      nowMs: clock.clock.now,
      cronEnabled: true,
      log: createNoopLogger(),
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(),
      runCommandJob: runJob,
      runScriptJob: runJob,
      onEvent: (event) => {
        if (event.action === "finished") {
          finished.resolve(event);
        }
      },
    });
    return {
      cron,
      clock,
      addReminder: async (
        atMs: number,
        {
          timeoutSeconds,
          sessionKey,
          script,
        }: { timeoutSeconds?: number; sessionKey?: string; script?: boolean } = {},
      ) =>
        await cron.add({
          name: "reminder",
          enabled: true,
          schedule: { kind: "at", at: new Date(atMs).toISOString() },
          sessionTarget: "isolated",
          ...(sessionKey ? { sessionKey } : {}),
          wakeMode: "next-heartbeat",
          payload: {
            ...(script
              ? { kind: "script" as const, script: "return {}" }
              : { kind: "command" as const, argv: ["/bin/cat"] }),
            ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
          },
          delivery: { mode: "announce", channel: "matrix", to: "!room:example" },
        }),
      /** Waits for every announcement, including abort cleanup that outlived its run. */
      announcementsSettled: async () => await Promise.allSettled(announcements),
      /** Runs the job now, as an operator would, and waits for that run. */
      runNow: async (jobId: string) => {
        finished = createDeferred<CronEvent>();
        await expect(cron.run(jobId, "force")).resolves.toEqual({ ok: true, ran: true });
        return await finished.promise;
      },
      /** Fires the timer due at `atMs` and waits for the run it starts. */
      runDueAt: async (atMs: number) => {
        finished = createDeferred<CronEvent>();
        void clock.advanceTo(atMs);
        return await finished.promise;
      },
    };
  }

  /** A channel reconnect drain replays queued sends regardless of backoff. */
  async function drainOnReconnect() {
    await drainPendingDeliveriesCore({
      drainKey: "matrix:reconnect",
      logLabel: "Matrix reconnect drain",
      cfg,
      log: createRecoveryLog(),
      deliver: (params) => deliverOutboundPayloads(params),
      selectEntry: (entry) => ({ match: entry.channel === "matrix", bypassBackoff: true }),
    });
  }

  /**
   * Retention can drop a receipt early once later completions exceed its count
   * bound. The worker prunes on its own clock, so age the stored receipt past
   * the age bound to let that same prune remove it.
   */
  function pruneCompletionReceipts() {
    openOpenClawStateDatabase({ env: { ...process.env } })
      .db.prepare(
        `UPDATE delivery_queue_entries SET enqueued_at = enqueued_at - ? WHERE status = 'completed'`,
      )
      .run(DAY_MS + 60 * 60_000);
  }

  /** The main agent's conversation entry for a Matrix room, if any delivery created it. */
  async function conversationFor(to: string) {
    const route = await resolveOutboundSessionRoute({
      cfg: agentCfg,
      channel: "matrix",
      agentId: "main",
      target: to,
    });
    return route
      ? loadCronSessionEntryLatest(
          resolveSessionStorePathCore(undefined, { agentId: "main" }),
          route.sessionKey,
        )
      : undefined;
  }

  /**
   * Gives matrix a message adapter whose send preparation holds the first
   * attempt until its run aborts, then fails it. Preparation runs after the
   * queue takes custody and before the platform send starts, so the abort drops
   * the send unsent. With `settleLater`, preparation fails only once released.
   */
  function holdFirstSendPreparationUntilAborted({ settleLater = false } = {}) {
    const entered = createDeferred();
    const settled = createDeferred();
    if (!settleLater) {
      settled.resolve();
    }
    let attempts = 0;
    const send = async ({ to, text, onPlatformSendDispatch }: ChannelMessageSendTextContext) => {
      await onPlatformSendDispatch?.();
      platform.sent.push({ to, text });
      const messageId = `matrix-${platform.sent.length}`;
      return {
        messageId,
        receipt: createMessageReceiptFromOutboundResults({
          results: [{ channel: "matrix", messageId }],
          kind: "text",
        }),
      };
    };
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: {
            ...createOutboundTestPlugin({ id: "matrix", outbound: { deliveryMode: "direct" } }),
            message: {
              id: "matrix",
              durableFinal: { capabilities: { text: true } },
              send: {
                lifecycle: {
                  beforeSendAttempt: async ({ signal }: ChannelMessageSendAttemptContext) => {
                    if (attempts++ > 0) {
                      return;
                    }
                    entered.resolve();
                    if (!signal) {
                      throw new Error("send preparation has no run signal");
                    }
                    await new Promise((resolve) => {
                      signal.addEventListener("abort", resolve, { once: true });
                    });
                    await settled.promise;
                    throw new Error("send preparation aborted", { cause: signal.reason });
                  },
                },
                text: send,
              },
            },
          },
        },
      ]),
    );
    return { entered: entered.promise, settle: () => settled.resolve() };
  }

  it("keeps every failed in-run attempt on one queued send that recovery delivers once", async () => {
    platform.down = true;
    const failed = await announce(reminderJob(), AT_MS + 100);

    expect(failed).toMatchObject({ deliveryAttempted: true, delivered: false });
    expect(platform.failures).toBe(4);
    expect(await loadPendingDeliveries(fixtures.tmpDir())).toHaveLength(1);

    platform.down = false;
    await drainOnReconnect();
    await drainOnReconnect();

    expect(platform.sent).toEqual([{ to: "!room:example", text: REMINDER }]);
    expect(await loadPendingDeliveries(fixtures.tmpDir())).toHaveLength(0);
  });

  it("reports a native retry run delivered without resending a replayed occurrence", async () => {
    const job = reminderJob();
    platform.down = true;
    await announce(job, AT_MS + 100);
    platform.down = false;
    await drainOnReconnect();

    const retry = await announce(job, AT_MS + 60_100);

    expect(retry).toMatchObject({ deliveryAttempted: true, delivered: true });
    expect(platform.sent).toHaveLength(1);
  });

  it("lets a native retry run take over the pending send before recovery replays it", async () => {
    const job = reminderJob();
    platform.down = true;
    await announce(job, AT_MS + 100);
    platform.down = false;

    const retry = await announce(job, AT_MS + 60_100);
    await drainOnReconnect();

    expect(retry).toMatchObject({ deliveryAttempted: true, delivered: true });
    expect(platform.sent).toEqual([{ to: "!room:example", text: REMINDER }]);
    expect(await loadPendingDeliveries(fixtures.tmpDir())).toHaveLength(0);
  });

  it("keeps distinct occurrences and routes on separate sends", async () => {
    await announce(reminderJob(), AT_MS + 100);
    await announce(reminderJob(), AT_MS + DAY_MS + 100, AT_MS + DAY_MS);
    await announce(
      reminderJob({ delivery: { mode: "announce", channel: "matrix", to: "!other:example" } }),
      AT_MS + 100,
    );

    expect(platform.sent.map(({ to }) => to)).toEqual([
      "!room:example",
      "!room:example",
      "!other:example",
    ]);
  });

  it("never admits a scheduled occurrence again, even after an operator run and a pruned receipt", async () => {
    const scheduler = startReminderScheduler(["announce, then time out", "announce", "announce"]);
    try {
      await scheduler.cron.start();
      const atMs = scheduler.clock.clock.now() + 1_000;
      const job = await scheduler.addReminder(atMs);
      platform.down = true;
      await scheduler.runDueAt(atMs);
      platform.down = false;
      await drainOnReconnect();
      const retryAtMs = (await scheduler.cron.readJob(job.id))?.state.nextRunAtMs;
      expect(retryAtMs).toBeGreaterThan(atMs);

      // An operator run delivers its own request and leaves the pending retry's admission intact.
      void scheduler.clock.advanceTo(atMs + 5_000);
      await expect(scheduler.cron.run(job.id, "force")).resolves.toEqual({ ok: true, ran: true });
      pruneCompletionReceipts();
      const retry = await scheduler.runDueAt(retryAtMs!);

      expect(platform.sent).toEqual([
        { to: "!room:example", text: REMINDER },
        { to: "!room:example", text: REMINDER },
      ]);
      expect(retry).toMatchObject({ status: "ok", deliveryStatus: "unknown" });
    } finally {
      scheduler.cron.stop();
    }
  });

  it("keeps a run's later attempts from queuing an occurrence its first attempt admitted", async () => {
    const scheduler = startReminderScheduler(["announce after recovery delivered it"]);
    try {
      await scheduler.cron.start();
      const atMs = scheduler.clock.clock.now() + 1_000;
      await scheduler.addReminder(atMs);
      const run = await scheduler.runDueAt(atMs);

      expect(platform.sent).toEqual([{ to: "!room:example", text: REMINDER }]);
      expect(run).toMatchObject({ status: "ok", deliveryStatus: "unknown" });
    } finally {
      scheduler.cron.stop();
    }
  });

  it("keeps an operator run's later attempts from queuing the send its first attempt queued", async () => {
    const scheduler = startReminderScheduler(["announce after recovery delivered it"]);
    try {
      await scheduler.cron.start();
      const job = await scheduler.addReminder(scheduler.clock.clock.now() + 60 * 60_000);
      const run = await scheduler.runNow(job.id);

      expect(platform.sent).toEqual([{ to: "!room:example", text: REMINDER }]);
      expect(run).toMatchObject({ status: "ok", deliveryStatus: "unknown" });
    } finally {
      scheduler.cron.stop();
    }
  });

  it("keeps an earlier route's delivery out of a retargeted job's new conversation", async () => {
    agentCfg = { session: { dmScope: "per-channel-peer" } };
    const scheduler = startReminderScheduler(["announce, then time out", "announce"]);
    try {
      await scheduler.cron.start();
      const atMs = scheduler.clock.clock.now() + 1_000;
      // Created from the agent's main session, which owns the delivered rooms' conversations.
      const job = await scheduler.addReminder(atMs, { sessionKey: "agent:main:main" });
      platform.down = true;
      await scheduler.runDueAt(atMs);
      platform.down = false;
      // The operator moves the reminder to another room before its retry runs.
      await scheduler.cron.update(job.id, {
        delivery: { mode: "announce", channel: "matrix", to: "!other:example" },
      });
      const retryAtMs = (await scheduler.cron.readJob(job.id))?.state.nextRunAtMs;
      const retry = await scheduler.runDueAt(retryAtMs!);

      // The occurrence's queued send keeps its original room.
      expect(platform.sent).toEqual([{ to: "!room:example", text: REMINDER }]);
      expect(retry).toMatchObject({ status: "ok", deliveryStatus: "delivered" });
      expect(await conversationFor("!other:example")).toBeUndefined();
    } finally {
      scheduler.cron.stop();
    }
  });

  it("retries an occurrence whose admitted send was dropped unsent when its run timed out", async () => {
    const preparation = holdFirstSendPreparationUntilAborted();
    const scheduler = startReminderScheduler(["announce", "announce"]);
    try {
      await scheduler.cron.start();
      const atMs = scheduler.clock.clock.now() + 1_000;
      const job = await scheduler.addReminder(atMs, { timeoutSeconds: 30 });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const timedOut = scheduler.runDueAt(atMs);
      await preparation.entered;
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(timedOut).resolves.toMatchObject({ status: "error" });
      vi.useRealTimers();

      // The queue dropped the never-dispatched send; only the admission could suppress it.
      expect(await loadPendingDeliveries(fixtures.tmpDir())).toHaveLength(0);
      const retryAtMs = (await scheduler.cron.readJob(job.id))?.state.nextRunAtMs;
      const retry = await scheduler.runDueAt(retryAtMs!);

      expect(platform.sent).toEqual([{ to: "!room:example", text: REMINDER }]);
      expect(retry).toMatchObject({ status: "ok", deliveryStatus: "delivered" });
    } finally {
      vi.useRealTimers();
      scheduler.cron.stop();
    }
  });

  it("retries a script occurrence whose dropped send settled after its timed-out run finished", async () => {
    const preparation = holdFirstSendPreparationUntilAborted({ settleLater: true });
    const scheduler = startReminderScheduler(["announce", "announce"]);
    try {
      await scheduler.cron.start();
      const atMs = scheduler.clock.clock.now() + 1_000;
      const job = await scheduler.addReminder(atMs, { timeoutSeconds: 30, script: true });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const timedOut = scheduler.runDueAt(atMs);
      await preparation.entered;
      await vi.advanceTimersByTimeAsync(30_000);
      // A script run finishes without waiting for its abort cleanup.
      await expect(timedOut).resolves.toMatchObject({ status: "error" });
      vi.useRealTimers();
      preparation.settle();
      await scheduler.announcementsSettled();

      expect(await loadPendingDeliveries(fixtures.tmpDir())).toHaveLength(0);
      const retryAtMs = (await scheduler.cron.readJob(job.id))?.state.nextRunAtMs;
      const retry = await scheduler.runDueAt(retryAtMs!);

      expect(platform.sent).toEqual([{ to: "!room:example", text: REMINDER }]);
      expect(retry).toMatchObject({ status: "ok", deliveryStatus: "delivered" });
    } finally {
      vi.useRealTimers();
      scheduler.cron.stop();
    }
  });

  it("announces a retry whose earlier run never reached announcement, even a day late", async () => {
    // The Gateway was down when the one-shot came due; its first run then timed out.
    const scheduler = startReminderScheduler(["time out", "announce"]);
    try {
      await scheduler.cron.start();
      const job = await scheduler.addReminder(Date.now() - DAY_MS - 60 * 60_000);
      await scheduler.runDueAt(scheduler.clock.armedAtMs!);

      const retryAtMs = (await scheduler.cron.readJob(job.id))?.state.nextRunAtMs;
      const retry = await scheduler.runDueAt(retryAtMs!);

      expect(platform.sent).toEqual([{ to: "!room:example", text: REMINDER }]);
      expect(retry).toMatchObject({ status: "ok", deliveryStatus: "delivered" });
    } finally {
      scheduler.cron.stop();
    }
  });
});
