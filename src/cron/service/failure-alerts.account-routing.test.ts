import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createCronRegressionState } from "../../../test/helpers/cron/service-regression-fixtures.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { makeCronJob } from "../delivery.test-helpers.js";
import type { CronJob } from "../types.js";
import { resolveFailureAlert } from "./failure-alerts.js";
import type { DeferredCronNotifications } from "./state.js";
import { runPostPersistCronNotifications } from "./store.js";
import { applyJobResult } from "./timer-outcomes.js";

type RoutingDeps = Partial<Parameters<typeof createCronRegressionState>[0]>;
function routingFixture(overrides: Partial<CronJob> = {}, deps: RoutingDeps = {}) {
  const send = vi.fn(async () => undefined);
  const state = createCronRegressionState({
    storePath: "/tmp/openclaw-cron-failure-alert-account-routing.json",
    cronConfig: { failureAlert: { enabled: true, after: 1 } },
    sendCronFailureAlert: send,
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    ...deps,
  });
  const job = makeCronJob({
    id: "topic-routed-job",
    name: "Topic-routed job",
    createdAtMs: 1,
    updatedAtMs: 1,
    payload: { kind: "agentTurn", message: "report" },
    delivery: { ...primaryDelivery },
    ...overrides,
  });
  const deferredNotifications: DeferredCronNotifications = [];
  return {
    state,
    job,
    send,
    deferredNotifications,
    apply: (result: Parameters<typeof applyJobResult>[2]) =>
      applyJobResult(state, job, result, { deferredNotifications }),
    drain: () => runPostPersistCronNotifications(state, structuredClone(deferredNotifications)),
  };
}

const failureDestination = {
  channel: "telegram",
  to: "telegram:19098680",
  accountId: "telegram-bot",
};
const primaryDelivery = { ...failureDestination, mode: "announce" as const, threadId: 42 };
const alternateRoute = { ...failureDestination, threadId: undefined, alternateRoute: true };

function testPlugin(id: string, aliases: string[], targetPrefixes: string[], outputPrefix = "") {
  const plugin = createChannelTestPluginBase({ id });
  return {
    pluginId: id,
    source: `test:${id}`,
    plugin: {
      ...plugin,
      meta: { ...plugin.meta, aliases },
      messaging: {
        targetPrefixes,
        normalizeTarget: (raw: string) => {
          const target = raw
            .trim()
            .replace(new RegExp(`^(?:${targetPrefixes.join("|")}):`, "i"), "")
            .trim();
          return target ? `${outputPrefix}${target}` : undefined;
        },
      },
    },
  };
}

beforeEach(() => {
  setActivePluginRegistry(
    createTestRegistry([
      testPlugin("telegram", [], ["telegram", "tg"], "telegram:"),
      testPlugin("googlechat", ["gchat", "google-chat"], ["googlechat", "google-chat", "gchat"]),
    ]),
  );
});

afterEach(resetPluginRuntimeStateForTest);

type RoutingCase = {
  name: string;
  delivery?: Partial<NonNullable<CronJob["delivery"]>>;
  failureAlert?: CronJob["failureAlert"];
  globalAlert?: NonNullable<RoutingDeps["cronConfig"]>["failureAlert"];
  expected: object;
};
it.each<RoutingCase>([
  {
    name: "keeps numeric zero as a distinct primary thread",
    delivery: { threadId: 0, failureDestination: { ...failureDestination, to: "tg:19098680" } },
    expected: { ...alternateRoute, to: "tg:19098680" },
  },
  {
    name: "lets an explicit alert route override an unthreaded failure destination",
    failureAlert: { to: "tg:19098680" },
    delivery: { failureDestination },
    expected: { ...failureDestination, to: "tg:19098680", threadId: 42, alternateRoute: false },
  },
  {
    name: "preserves an unthreaded failure destination when the alert only selects its mode",
    failureAlert: { mode: "announce" },
    delivery: { failureDestination },
    expected: alternateRoute,
  },
  {
    name: "does not equate case-sensitive recipient identities across provider aliases",
    delivery: { channel: "googlechat", to: "googlechat:RoomA" },
    failureAlert: { to: "gchat:rooma" },
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
    expected: { channel: "slack", to: undefined, accountId: undefined },
  },
])("$name", ({ delivery, failureAlert, globalAlert, expected }) => {
  const { state, job } = routingFixture(
    {
      delivery: { ...primaryDelivery, ...delivery },
      ...(failureAlert ? { failureAlert } : {}),
    },
    {
      defaultAgentId: "main",
      cronConfig: { failureAlert: globalAlert ?? { enabled: true, after: 1 } },
      sendCronFailureAlert: undefined,
    },
  );
  expect(resolveFailureAlert(state, job)).toMatchObject(expected);
});

it("routes required delivery failure outside the failed topic", async () => {
  const { send, apply, drain, deferredNotifications } = routingFixture(
    {
      delivery: {
        ...primaryDelivery,
        bestEffort: false,
        failureDestination,
      },
    },
    { storePath: "/tmp/openclaw-cron-unthreaded-failure-destination.json" },
  );
  apply({
    status: "ok",
    deliveryAttempted: true,
    delivered: false,
    deliveryError: "topic closed",
    startedAt: 1_000,
    endedAt: 2_000,
  });

  expect(deferredNotifications).toHaveLength(1);
  expect(send).not.toHaveBeenCalled();
  await drain();
  expect(send).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      ...failureDestination,
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
  const { job, send, apply, drain } = routingFixture(
    {
      id: "failed-run",
      name: "Failed run",
      createdAtMs: runAtMs,
      updatedAtMs: runAtMs,
      delivery: { mode: "announce", channel: "telegram", to: "telegram:19098680" },
    },
    {
      storePath: "/tmp/openclaw-cron-failure-alert-run-time.json",
      cronConfig: { failureAlert: { enabled: true, after: 1, cooldownMs: 60_000 } },
      nowMs: () => endedAt,
    },
  );
  apply({
    status: "error",
    error: "provider unavailable",
    startedAt: runAtMs,
    endedAt,
  });

  expect(job.state.lastFailureAlertAtMs).toBe(endedAt);
  expect(send).not.toHaveBeenCalled();
  await drain();
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ runAtMs }));
});

it("keeps the primary account and topic on provider-aliased failure alerts", async () => {
  const { send, apply, drain } = routingFixture(
    { failureAlert: { to: "tg:19098680" } },
    { storePath: "/tmp/openclaw-cron-failure-alert-thread-routing.json" },
  );
  apply({
    status: "error",
    error: "provider unavailable",
    startedAt: 1,
    endedAt: 2,
  });

  expect(send).not.toHaveBeenCalled();
  await drain();
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({
      ...failureDestination,
      to: "tg:19098680",
      threadId: 42,
    }),
  );
});
