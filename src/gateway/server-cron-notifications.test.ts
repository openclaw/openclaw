// Cron notification tests protect completion-delivery warning behavior,
// including URL redaction for invalid webhook destinations.
import { describe, expect, it, vi } from "vitest";
import type { CliDeps } from "../cli/deps.types.js";
import type { CronJob } from "../cron/types.js";

const mocks = vi.hoisted(() => ({
  resolveCronDeliveryPlan: vi.fn(),
  resolveFailureDestination: vi.fn(),
  sendCronAnnouncePayloadStrict: vi.fn(async () => undefined),
  sendFailureNotificationAnnounce: vi.fn(),
}));

vi.mock("../cron/delivery.js", () => ({
  resolveCronDeliveryPlan: mocks.resolveCronDeliveryPlan,
  resolveFailureDestination: mocks.resolveFailureDestination,
  sendCronAnnouncePayloadStrict: mocks.sendCronAnnouncePayloadStrict,
  sendFailureNotificationAnnounce: mocks.sendFailureNotificationAnnounce,
}));

import {
  dispatchGatewayCronFinishedNotifications,
  sendGatewayCronFailureAlert,
} from "./server-cron-notifications.js";

describe("dispatchGatewayCronFinishedNotifications", () => {
  it("passes failure alert thread ids to announce delivery", async () => {
    const deps = {} as CliDeps;
    const cfg = {};
    const logger = { warn: vi.fn() };
    const job = {
      id: "cron-thread",
      name: "thread",
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 1,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "hello" },
      state: {},
    } satisfies CronJob;

    await sendGatewayCronFailureAlert({
      deps,
      logger,
      resolveCronAgent: () => ({ agentId: "main", cfg }),
      job,
      text: "Cron failed",
      channel: "telegram",
      to: "123",
      threadId: 79,
      mode: "announce",
      accountId: "bot-a",
    });

    expect(mocks.sendCronAnnouncePayloadStrict).toHaveBeenCalledWith({
      deps,
      cfg,
      agentId: "main",
      jobId: "cron-thread",
      target: {
        channel: "telegram",
        to: "123",
        threadId: 79,
        accountId: "bot-a",
        sessionKey: undefined,
      },
      message: "Cron failed",
      abortSignal: expect.any(AbortSignal),
    });
  });

  it("redacts invalid completion webhook targets in warnings", () => {
    const logger = {
      warn: vi.fn(),
    };
    const job = {
      id: "cron-redact",
      name: "redact",
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 1,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "hello" },
      delivery: {
        mode: "announce",
        completionDestination: {
          mode: "webhook",
          to: "ftp://user:secret@example.invalid/hook?token=secret",
        },
      },
      state: {},
    } satisfies CronJob;

    dispatchGatewayCronFinishedNotifications({
      evt: { jobId: job.id, action: "finished", status: "ok" },
      job,
      deps: {} as CliDeps,
      logger,
      resolveCronAgent: () => ({ agentId: "main", cfg: {} }),
    });

    expect(logger.warn).toHaveBeenCalledWith(
      {
        jobId: "cron-redact",
        deliveryTo: "ftp://example.invalid/hook",
      },
      "cron: skipped completion webhook delivery, delivery.completionDestination.to must be a valid http(s) URL",
    );
  });
});
