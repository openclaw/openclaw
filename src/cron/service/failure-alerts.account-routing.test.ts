import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelId } from "../../channels/plugins/types.public.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createDirectOutboundTestAdapter,
  createOutboundTestPlugin,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import type { CronJob } from "../types.js";
import { resolveFailureAlert } from "./failure-alerts.js";
import { createCronServiceState } from "./state.js";
import { applyJobResult } from "./timer.js";

function createTargetNormalizerPlugin(id: ChannelId, prefixes: readonly string[]) {
  return createOutboundTestPlugin({
    id,
    outbound: createDirectOutboundTestAdapter({ channel: id }),
    messaging: {
      targetPrefixes: prefixes,
      normalizeTarget: (raw) => {
        let normalized = raw.trim();
        while (normalized) {
          const next = normalized
            .replace(new RegExp(`^(?:${prefixes.join("|")}):`, "i"), "")
            .trim();
          if (next === normalized) {
            return normalized;
          }
          normalized = next;
        }
        return undefined;
      },
    },
  });
}

describe("cron failure alert account routing", () => {
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          plugin: createTargetNormalizerPlugin("telegram", ["telegram", "tg"]),
          source: "test",
        },
        {
          pluginId: "slack",
          plugin: createTargetNormalizerPlugin("slack", ["slack", "channel", "conversation"]),
          source: "test",
        },
        {
          pluginId: "discord",
          plugin: createTargetNormalizerPlugin("discord", ["discord", "channel", "room"]),
          source: "test",
        },
      ]),
    );
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry());
  });

  it.each([
    {
      name: "inherits the primary account when an alert uses its delivery route",
      globalAlert: { enabled: true, after: 1 },
      jobAlert: undefined,
      expected: {
        channel: "telegram",
        to: "telegram:19098680",
        accountId: "telegram-bot",
        threadId: 42,
      },
    },
    {
      name: "prefers an explicit alert account over the primary account",
      globalAlert: { enabled: true, after: 1 },
      jobAlert: { accountId: "alert-bot" },
      expected: {
        channel: "telegram",
        to: "telegram:19098680",
        accountId: "alert-bot",
        threadId: undefined,
      },
    },
    {
      name: "does not inherit the primary account for another channel",
      globalAlert: { enabled: true, after: 1, channel: "slack" },
      jobAlert: undefined,
      expected: { channel: "slack", to: undefined, accountId: undefined },
    },
    {
      name: "does not inherit the primary account for a webhook",
      globalAlert: {
        enabled: true,
        after: 1,
        mode: "webhook" as const,
        to: "https://alerts.example.test/cron-failures",
      },
      jobAlert: undefined,
      expected: {
        mode: "webhook",
        to: "https://alerts.example.test/cron-failures",
        accountId: undefined,
      },
    },
  ])("$name", ({ globalAlert, jobAlert, expected }) => {
    const state = createCronServiceState({
      storePath: "/tmp/openclaw-cron-failure-alert-account-routing.json",
      cronEnabled: true,
      defaultAgentId: "main",
      cronConfig: { failureAlert: globalAlert },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    const job: CronJob = {
      id: "account-routed-job",
      name: "Account-routed job",
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 1,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "report" },
      delivery: {
        mode: "announce",
        channel: "telegram",
        to: "telegram:19098680",
        accountId: "telegram-bot",
        threadId: 42,
      },
      ...(jobAlert ? { failureAlert: jobAlert } : {}),
      state: {},
    };

    expect(resolveFailureAlert(state, job)).toMatchObject(expected);
  });

  it("carries run start time without using it for alert cooldown", () => {
    const runAtMs = Date.parse("2026-07-30T00:00:00.000Z");
    const endedAt = runAtMs + 5 * 60_000;
    const sendCronFailureAlert = vi.fn(async () => undefined);
    const state = createCronServiceState({
      storePath: "/tmp/openclaw-cron-failure-alert-run-time.json",
      cronEnabled: true,
      cronConfig: { failureAlert: { enabled: true, after: 1, cooldownMs: 60_000 } },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      nowMs: () => endedAt,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      sendCronFailureAlert,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    const job: CronJob = {
      id: "failed-run",
      name: "Failed run",
      enabled: true,
      createdAtMs: runAtMs,
      updatedAtMs: runAtMs,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "report" },
      delivery: { mode: "announce", channel: "telegram", to: "telegram:19098680" },
      state: {},
    };

    applyJobResult(state, job, {
      status: "error",
      error: "provider unavailable",
      startedAt: runAtMs,
      endedAt,
    });

    expect(sendCronFailureAlert).toHaveBeenCalledWith(expect.objectContaining({ runAtMs }));
    expect(job.state.lastFailureAlertAtMs).toBe(endedAt);
  });

  it("keeps the primary topic on same-account failure alerts", () => {
    const sendCronFailureAlert = vi.fn(async () => undefined);
    const state = createCronServiceState({
      storePath: "/tmp/openclaw-cron-failure-alert-thread-routing.json",
      cronEnabled: true,
      cronConfig: { failureAlert: { enabled: true, after: 1 } },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      sendCronFailureAlert,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    const job: CronJob = {
      id: "topic-routed-job",
      name: "Topic-routed job",
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 1,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "report" },
      delivery: {
        mode: "announce",
        channel: "telegram",
        to: "telegram:19098680",
        accountId: "telegram-bot",
        threadId: 42,
      },
      state: {},
    };

    applyJobResult(state, job, {
      status: "error",
      error: "provider unavailable",
      startedAt: 1,
      endedAt: 2,
    });

    expect(sendCronFailureAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        to: "telegram:19098680",
        accountId: "telegram-bot",
        threadId: 42,
      }),
    );
  });

  it.each([
    {
      channel: "telegram",
      deliveryTo: "telegram:-1001234567890",
      alertTo: "tg:-1001234567890",
    },
    {
      channel: "slack",
      deliveryTo: "C1234567890",
      alertTo: "channel:C1234567890",
    },
    {
      channel: "discord",
      deliveryTo: "1234567890",
      alertTo: "discord:channel:1234567890",
    },
  ] as const)(
    "keeps the primary $channel thread across equivalent target aliases",
    ({ channel, deliveryTo, alertTo }) => {
      const state = createCronServiceState({
        storePath: "/tmp/openclaw-cron-failure-alert-target-alias.json",
        cronEnabled: true,
        log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      });
      const job: CronJob = {
        id: `${channel}-alias-routed-job`,
        name: `${channel} alias-routed job`,
        enabled: true,
        createdAtMs: 1,
        updatedAtMs: 1,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "report" },
        delivery: {
          mode: "announce",
          channel,
          to: deliveryTo,
          accountId: "alerts",
          threadId: "thread-42",
        },
        failureAlert: {
          after: 1,
          channel,
          to: alertTo,
          accountId: "alerts",
        },
        state: {},
      };

      expect(resolveFailureAlert(state, job)).toMatchObject({
        channel,
        to: alertTo,
        accountId: "alerts",
        threadId: "thread-42",
      });
    },
  );

  it.each([
    {
      name: "different peer",
      alertTo: "telegram:-1009876543210",
      alertAccountId: "bot-a",
    },
    {
      name: "different account",
      alertTo: "tg:-1001234567890",
      alertAccountId: "bot-b",
    },
    {
      name: "different explicit topic",
      alertTo: "telegram:-1001234567890:topic:99",
      alertAccountId: "bot-a",
    },
  ])("does not inherit the primary topic for a $name", ({ alertTo, alertAccountId }) => {
    const state = createCronServiceState({
      storePath: "/tmp/openclaw-cron-failure-alert-distinct-route.json",
      cronEnabled: true,
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    const job: CronJob = {
      id: "distinct-topic-routed-job",
      name: "Distinct topic-routed job",
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 1,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "report" },
      delivery: {
        mode: "announce",
        channel: "telegram",
        to: "telegram:-1001234567890",
        accountId: "bot-a",
        threadId: 42,
      },
      failureAlert: {
        after: 1,
        channel: "telegram",
        to: alertTo,
        accountId: alertAccountId,
      },
      state: {},
    };

    expect(resolveFailureAlert(state, job)).toMatchObject({ threadId: undefined });
  });

  it("uses the display name in repeated failure alert text", () => {
    const sendCronFailureAlert = vi.fn(async () => undefined);
    const state = createCronServiceState({
      storePath: "/tmp/openclaw-cron-failure-alert-display-name.json",
      cronEnabled: true,
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      sendCronFailureAlert,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    const job: CronJob = {
      id: "display-name-job",
      name: "internal-stable-name",
      displayName: "Operator-visible name",
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 1,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "report" },
      failureAlert: { after: 1 },
      state: {},
    };

    applyJobResult(state, job, {
      status: "error",
      error: "provider unavailable",
      startedAt: 1,
      endedAt: 2,
    });

    expect(sendCronFailureAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Automation "Operator-visible name" failed 1 times'),
      }),
    );
  });
});
