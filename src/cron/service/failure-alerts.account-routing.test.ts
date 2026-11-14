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
    name: "Topic-routed job",
    delivery: primaryDelivery,
    ...overrides,
  });
  const deferredNotifications: DeferredCronNotifications = [];
  return {
    job,
    send,
    deferredNotifications,
    apply: (result: Omit<Parameters<typeof applyJobResult>[2], "errorReason">) =>
      applyJobResult(state, job, { ...result, errorReason: undefined }, { deferredNotifications }),
    drain: async () => {
      expect(send).not.toHaveBeenCalled();
      await runPostPersistCronNotifications(state, structuredClone(deferredNotifications));
    },
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

type RoutingCase = [Partial<NonNullable<CronJob["delivery"]>>, CronJob["failureAlert"], object];
it.each<RoutingCase>([
  [
    { threadId: 0, failureDestination: { ...failureDestination, to: "tg:19098680" } },
    undefined,
    { ...alternateRoute, to: "tg:19098680" },
  ],
  [
    { failureDestination },
    { to: "tg:19098680" },
    { ...failureDestination, to: "tg:19098680", threadId: 42, alternateRoute: false },
  ],
  [{ failureDestination }, { mode: "announce" }, alternateRoute],
  [
    { channel: "googlechat", to: "googlechat:RoomA" },
    { to: "gchat:rooma" },
    { channel: "googlechat", to: "gchat:rooma", accountId: undefined, threadId: undefined },
  ],
])("resolves the account and thread for %j / %j", (delivery, failureAlert, expected) => {
  expect(
    resolveFailureAlert(
      { deps: { cronConfig: { failureAlert: { enabled: true, after: 1 } } } },
      { delivery: { ...primaryDelivery, ...delivery }, failureAlert },
    ),
  ).toMatchObject(expected);
});

const telegramAccount = { accountId: "telegram-bot" };
const webhookMode = { mode: "webhook" as const };
const ownerAccountDelivery = {
  mode: "announce" as const,
  target: "owner" as const,
  channel: "telegram" as const,
  ...telegramAccount,
  directPolicy: "block" as const,
};
const ownerFailureAccount = { ...ownerAccountDelivery, failureDestination: telegramAccount };
const globalTelegramAccount = { failureAlert: { enabled: true, ...telegramAccount } };
const globalAnnounceOnly = { failureAlert: { enabled: true, mode: "announce" as const } };
function failedRun(atMs: number) {
  return {
    status: "error" as const,
    error: "provider unavailable",
    startedAt: atMs - 1_000,
    endedAt: atMs,
  };
}

type InheritanceCase = [string, NonNullable<CronJob["delivery"]>, RoutingDeps["cronConfig"]];
it.each<InheritanceCase>([
  ["owner target without a channel", { mode: "announce", target: "owner" }, undefined],
  ["owner target with a direct-message policy", ownerAccountDelivery, undefined],
  [
    "owner targeting when global alert config only selects announce mode",
    ownerAccountDelivery,
    globalAnnounceOnly,
  ],
])("inherits %s from the primary route", (_name, delivery, cronConfig) => {
  const route = resolveFailureAlert({ deps: { cronConfig } }, { delivery });
  expect(route?.target).toBe("owner");
  expect(route?.directPolicy).toBe(delivery.directPolicy);
});

type SelectorCase = [
  string,
  NonNullable<CronJob["delivery"]>,
  CronJob["failureAlert"],
  RoutingDeps["cronConfig"],
  object,
];
it.each<SelectorCase>([
  ["job account", ownerAccountDelivery, telegramAccount, undefined, telegramAccount],
  ["delivery account", ownerFailureAccount, undefined, undefined, telegramAccount],
  ["global account", ownerAccountDelivery, undefined, globalTelegramAccount, telegramAccount],
  [
    "alert channel",
    { mode: "announce", target: "owner" },
    { channel: "last" },
    undefined,
    { channel: "last" },
  ],
  ["webhook without a URL", ownerAccountDelivery, webhookMode, undefined, webhookMode],
])(
  "keeps an explicit %s ahead of owner inheritance",
  (_name, delivery, failureAlert, cronConfig, expected) => {
    const route = resolveFailureAlert({ deps: { cronConfig } }, { delivery, failureAlert });
    expect(route).toMatchObject(expected);
    expect(route?.target).toBeUndefined();
    expect(route?.directPolicy).toBeUndefined();
  },
);

it("transports an inherited owner target and direct-message policy", async () => {
  const { send, apply, drain } = routingFixture({
    delivery: { mode: "announce", target: "owner", directPolicy: "block" },
  });
  apply(failedRun(2_000));

  await drain();
  expect(send).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      channel: "last",
      target: "owner",
      directPolicy: "block",
    }),
  );
});

function incidentFixture(state: CronJob["state"] = {}) {
  let now = 100_000;
  const fixture = routingFixture(
    { delivery: { mode: "announce", channel: "last" }, state },
    {
      cronConfig: { failureAlert: { enabled: true, after: 1, cooldownMs: 60_000 } },
      nowMs: () => now,
    },
  );
  return {
    ...fixture,
    failAfter: (ms = 0) => {
      now += ms;
      fixture.apply(failedRun(now));
    },
  };
}

type SignatureCase = [string, NonNullable<CronJob["delivery"]>, number, boolean];
it.each<SignatureCase>([
  [
    "starts a new incident after cooldown when the destination becomes owner",
    { mode: "announce", target: "owner" },
    1,
    false,
  ],
  [
    "does not reopen an incident when only directPolicy changes",
    { mode: "announce", channel: "last", directPolicy: "block" },
    0,
    true,
  ],
])("%s", (_name, delivery, notifications, signatureUnchanged) => {
  const fixture = incidentFixture();
  fixture.failAfter();
  const previousSignature = fixture.job.state.failureAlertIncident?.signature;
  fixture.deferredNotifications.length = 0;
  fixture.job.delivery = delivery;
  fixture.failAfter(61_000);
  expect(fixture.deferredNotifications).toHaveLength(notifications);
  const currentSignature = fixture.job.state.failureAlertIncident?.signature;
  expect(currentSignature === previousSignature).toBe(signatureUnchanged);
});

it("keeps a pre-change non-owner incident deduplicated", () => {
  const fixture = incidentFixture({
    consecutiveErrors: 1,
    lastFailureAlertAtMs: 100_000 - 120_000,
    failureAlertIncident: {
      scope: "run",
      // Signature the base code stored for this route; it has no target element.
      signature: "be298b54d2db7aff2a7cff818a701a847628068fe68a383179ffb650dc96e926",
    },
  });
  fixture.failAfter();
  expect(fixture.deferredNotifications).toHaveLength(0);
});

it("does not inherit the primary account for another channel", () => {
  expect(
    resolveFailureAlert(
      { deps: { cronConfig: { failureAlert: { enabled: true, after: 1, channel: "slack" } } } },
      { delivery: primaryDelivery },
    ),
  ).toMatchObject({ channel: "slack", to: undefined, accountId: undefined });
});

it("routes required delivery failure outside the failed topic", async () => {
  const { send, apply, drain } = routingFixture({
    delivery: { ...primaryDelivery, bestEffort: false, failureDestination },
  });
  apply({
    status: "ok",
    deliveryAttempted: true,
    delivered: false,
    deliveryError: "topic closed",
    startedAt: 1_000,
    endedAt: 2_000,
  });

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

it("preserves the aliased primary route and run time while starting cooldown at completion", async () => {
  const runAtMs = Date.parse("2026-07-30T00:00:00.000Z");
  const endedAt = runAtMs + 5 * 60_000;
  const { job, send, apply, drain } = routingFixture(
    { failureAlert: { to: "tg:19098680" } },
    {
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
  await drain();
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({
      runAtMs,
      ...failureDestination,
      to: "tg:19098680",
      threadId: 42,
    }),
  );
});
