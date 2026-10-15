import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { makeCronJob } from "../delivery.test-helpers.js";
import { resolveFailureAlert } from "./failure-alerts.js";
import { createCronServiceState, type DeferredCronNotifications } from "./state.js";
import { runPostPersistCronNotifications } from "./store.js";
import { applyJobResult } from "./timer-outcomes.js";

function stripTestTargetPrefix(raw: string, prefixes: readonly string[]): string | undefined {
  const target = raw
    .trim()
    .replace(new RegExp(`^(?:${prefixes.join("|")}):`, "i"), "")
    .trim();
  return target || undefined;
}

describe("cron failure alert account routing", () => {
  beforeEach(() => {
    const pluginSpecs = [
      {
        id: "telegram",
        aliases: [],
        targetPrefixes: ["telegram", "tg"],
        normalizeTarget: (raw: string) => {
          const target = stripTestTargetPrefix(raw, ["telegram", "tg"]);
          return target ? `telegram:${target}` : undefined;
        },
      },
      {
        id: "googlechat",
        aliases: ["gchat", "google-chat"],
        targetPrefixes: ["googlechat", "google-chat", "gchat"],
        normalizeTarget: (raw: string) =>
          stripTestTargetPrefix(raw, ["googlechat", "google-chat", "gchat"]),
      },
    ];
    setActivePluginRegistry(
      createTestRegistry(
        pluginSpecs.map(({ id, aliases, targetPrefixes, normalizeTarget }) => {
          const plugin = createChannelTestPluginBase({ id });
          return {
            pluginId: id,
            plugin: {
              ...plugin,
              meta: { ...plugin.meta, aliases },
              messaging: { targetPrefixes, normalizeTarget },
            },
            source: `test:${id}`,
          };
        }),
      ),
    );
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });

  it.each([
    {
      name: "keeps numeric zero as a distinct primary thread",
      globalAlert: { enabled: true, after: 1 },
      jobAlert: undefined,
      deliveryThreadId: 0,
      failureDestination: {
        channel: "telegram",
        to: "tg:19098680",
        accountId: "telegram-bot",
      },
      expected: {
        channel: "telegram",
        to: "tg:19098680",
        accountId: "telegram-bot",
        threadId: undefined,
        alternateRoute: true,
      },
    },
    {
      name: "lets an explicit alert route override an unthreaded failure destination",
      globalAlert: { enabled: true, after: 1 },
      jobAlert: { to: "tg:19098680" },
      failureDestination: {
        channel: "telegram",
        to: "telegram:19098680",
        accountId: "telegram-bot",
      },
      expected: {
        channel: "telegram",
        to: "tg:19098680",
        accountId: "telegram-bot",
        threadId: 42,
        alternateRoute: false,
      },
    },
    {
      name: "preserves an unthreaded failure destination when the alert only selects its mode",
      globalAlert: { enabled: true, after: 1 },
      jobAlert: { mode: "announce" as const },
      failureDestination: {
        channel: "telegram",
        to: "telegram:19098680",
        accountId: "telegram-bot",
      },
      expected: {
        channel: "telegram",
        to: "telegram:19098680",
        accountId: "telegram-bot",
        threadId: undefined,
        alternateRoute: true,
      },
    },
    {
      name: "does not equate case-sensitive recipient identities across provider aliases",
      globalAlert: { enabled: true, after: 1 },
      deliveryChannel: "googlechat",
      deliveryTo: "googlechat:RoomA",
      jobAlert: { to: "gchat:rooma" },
      expected: {
        channel: "googlechat",
        to: "gchat:rooma",
        accountId: undefined,
        threadId: undefined,
      },
    },
    {
      name: "does not inherit the primary account for another channel",
      globalAlert: { enabled: true, after: 1, channel: "slack" },
      jobAlert: undefined,
      expected: { channel: "slack", to: undefined, accountId: undefined },
    },
  ])("$name", (testCase) => {
    const { globalAlert, jobAlert, expected } = testCase;
    const state = createCronServiceState({
      scheduler: createTestGatewayScheduler(),
      storePath: "/tmp/openclaw-cron-failure-alert-account-routing.json",
      cronEnabled: true,
      defaultAgentId: "main",
      cronConfig: { failureAlert: globalAlert },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      enqueueSystemEvent: vi.fn(),
      enqueueSessionEvent: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    const job = makeCronJob({
      id: "account-routed-job",
      name: "Account-routed job",
      createdAtMs: 1,
      updatedAtMs: 1,
      payload: { kind: "agentTurn", message: "report" },
      delivery: {
        mode: "announce",
        channel: "deliveryChannel" in testCase ? testCase.deliveryChannel : "telegram",
        to: "deliveryTo" in testCase ? testCase.deliveryTo : "telegram:19098680",
        accountId: "telegram-bot",
        threadId: "deliveryThreadId" in testCase ? testCase.deliveryThreadId : 42,
        ...("failureDestination" in testCase
          ? { failureDestination: testCase.failureDestination }
          : {}),
      },
      ...(jobAlert ? { failureAlert: jobAlert } : {}),
    });

    expect(resolveFailureAlert(state, job)).toMatchObject(expected);
  });

  it("routes required delivery failure outside the failed topic", async () => {
    const sendCronFailureAlert = vi.fn(async () => undefined);
    const state = createCronServiceState({
      scheduler: createTestGatewayScheduler(),
      storePath: "/tmp/openclaw-cron-unthreaded-failure-destination.json",
      cronEnabled: true,
      cronConfig: { failureAlert: { enabled: true, after: 1 } },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      enqueueSystemEvent: vi.fn(),
      enqueueSessionEvent: vi.fn(),
      sendCronFailureAlert,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    const job = makeCronJob({
      id: "topic-routed-job",
      name: "Topic-routed job",
      createdAtMs: 1,
      updatedAtMs: 1,
      payload: { kind: "agentTurn", message: "report" },
      delivery: {
        mode: "announce",
        channel: "telegram",
        to: "telegram:19098680",
        accountId: "telegram-bot",
        threadId: 42,
        bestEffort: false,
        failureDestination: {
          channel: "telegram",
          to: "telegram:19098680",
          accountId: "telegram-bot",
        },
      },
    });
    const deferredNotifications: DeferredCronNotifications = [];

    applyJobResult(
      state,
      job,
      {
        status: "ok",
        deliveryAttempted: true,
        delivered: false,
        deliveryError: "topic closed",
        startedAt: 1_000,
        endedAt: 2_000,
      },
      { deferredNotifications },
    );

    expect(deferredNotifications).toHaveLength(1);
    expect(sendCronFailureAlert).not.toHaveBeenCalled();
    await runPostPersistCronNotifications(state, structuredClone(deferredNotifications));
    expect(sendCronFailureAlert).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        channel: "telegram",
        to: "telegram:19098680",
        accountId: "telegram-bot",
        threadId: undefined,
        inheritSessionThread: false,
        payload: expect.objectContaining({
          text: 'Automation "Topic-routed job" delivery failed\nCheck automation history for details.',
        }),
      }),
    );
  });

  it("carries run start time without using it for alert cooldown", async () => {
    const runAtMs = Date.parse("2026-07-30T00:00:00.000Z");
    const endedAt = runAtMs + 5 * 60_000;
    const sendCronFailureAlert = vi.fn(async () => undefined);
    const state = createCronServiceState({
      scheduler: createTestGatewayScheduler(),
      storePath: "/tmp/openclaw-cron-failure-alert-run-time.json",
      cronEnabled: true,
      cronConfig: { failureAlert: { enabled: true, after: 1, cooldownMs: 60_000 } },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      nowMs: () => endedAt,
      enqueueSystemEvent: vi.fn(),
      enqueueSessionEvent: vi.fn(),
      sendCronFailureAlert,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    const job = makeCronJob({
      id: "failed-run",
      name: "Failed run",
      createdAtMs: runAtMs,
      updatedAtMs: runAtMs,
      payload: { kind: "agentTurn", message: "report" },
      delivery: { mode: "announce", channel: "telegram", to: "telegram:19098680" },
    });
    const deferredNotifications: DeferredCronNotifications = [];

    applyJobResult(
      state,
      job,
      {
        status: "error",
        error: "provider unavailable",
        startedAt: runAtMs,
        endedAt,
      },
      { deferredNotifications },
    );

    expect(job.state.lastFailureAlertAtMs).toBe(endedAt);
    expect(sendCronFailureAlert).not.toHaveBeenCalled();
    await runPostPersistCronNotifications(state, structuredClone(deferredNotifications));
    expect(sendCronFailureAlert).toHaveBeenCalledWith(expect.objectContaining({ runAtMs }));
  });

  it("keeps the primary account and topic on provider-aliased failure alerts", async () => {
    const sendCronFailureAlert = vi.fn(async () => undefined);
    const state = createCronServiceState({
      scheduler: createTestGatewayScheduler(),
      storePath: "/tmp/openclaw-cron-failure-alert-thread-routing.json",
      cronEnabled: true,
      cronConfig: { failureAlert: { enabled: true, after: 1 } },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      enqueueSystemEvent: vi.fn(),
      enqueueSessionEvent: vi.fn(),
      sendCronFailureAlert,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    const job = makeCronJob({
      id: "topic-routed-job",
      name: "Topic-routed job",
      createdAtMs: 1,
      updatedAtMs: 1,
      payload: { kind: "agentTurn", message: "report" },
      delivery: {
        mode: "announce",
        channel: "telegram",
        to: "telegram:19098680",
        accountId: "telegram-bot",
        threadId: 42,
      },
      failureAlert: { to: "tg:19098680" },
    });
    const deferredNotifications: DeferredCronNotifications = [];

    applyJobResult(
      state,
      job,
      {
        status: "error",
        error: "provider unavailable",
        startedAt: 1,
        endedAt: 2,
      },
      { deferredNotifications },
    );

    expect(sendCronFailureAlert).not.toHaveBeenCalled();
    await runPostPersistCronNotifications(state, structuredClone(deferredNotifications));
    expect(sendCronFailureAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        to: "tg:19098680",
        accountId: "telegram-bot",
        threadId: 42,
      }),
    );
  });
});
