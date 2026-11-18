import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createCronRegressionState } from "../../../test/helpers/cron/service-regression-fixtures.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { makeCronJob } from "../delivery.test-helpers.js";
import type { CronJob } from "../types.js";
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

it("routes required delivery failure outside the failed topic", async () => {
  const { send, apply, drain } = routingFixture(
    {
      delivery: primaryDelivery,
    },
    { cronConfig: { failureAlert: failureDestination } },
  );
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
    { delivery: { ...primaryDelivery, to: "tg:19098680" } },
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
