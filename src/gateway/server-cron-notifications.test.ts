// Cron notification tests protect completion-delivery warning behavior,
// including URL redaction for invalid webhook destinations.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliDeps } from "../cli/deps.types.js";
import type { CronJob } from "../cron/types.js";

const mocks = vi.hoisted(() => ({
  sendFailureNotificationAnnounce: vi.fn(),
}));

vi.mock("../cron/delivery.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cron/delivery.js")>();
  return {
    ...actual,
    sendFailureNotificationAnnounce: mocks.sendFailureNotificationAnnounce,
  };
});

import { dispatchGatewayCronFinishedNotifications } from "./server-cron-notifications.js";

describe("dispatchGatewayCronFinishedNotifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it("keeps configured failure destinations from inheriting the primary delivery thread", () => {
    const logger = {
      warn: vi.fn(),
    };
    const job = {
      id: "cron-threaded-failure-dest",
      name: "threaded failure dest",
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 1,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      sessionKey: "agent:main:telegram:group:-1001234567890:thread:42",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "hello" },
      delivery: {
        mode: "announce",
        channel: "telegram",
        to: "-1001234567890",
        threadId: 42,
        failureDestination: {
          mode: "announce",
          channel: "telegram",
          to: "-1001234567890",
        },
      },
      state: {},
    } satisfies CronJob;

    dispatchGatewayCronFinishedNotifications({
      evt: {
        jobId: job.id,
        action: "finished",
        status: "error",
        error: "boom",
      },
      job,
      deps: {} as CliDeps,
      logger,
      resolveCronAgent: () => ({ agentId: "main", cfg: {} }),
    });

    expect(mocks.sendFailureNotificationAnnounce).toHaveBeenCalledTimes(1);
    expect(mocks.sendFailureNotificationAnnounce.mock.calls[0]?.[4]).toEqual({
      channel: "telegram",
      to: "-1001234567890",
      accountId: undefined,
      sessionKey: "agent:main:telegram:group:-1001234567890:thread:42",
      inheritSessionThread: false,
    });
  });
});
