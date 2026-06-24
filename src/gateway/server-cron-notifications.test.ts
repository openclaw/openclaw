// Cron notification tests protect completion-delivery warning behavior,
// including URL redaction for invalid webhook destinations.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliDeps } from "../cli/deps.types.js";
import type { CronJob } from "../cron/types.js";

const mocks = vi.hoisted(() => ({
  sendCronAnnouncePayloadStrict: vi.fn(),
  sendFailureNotificationAnnounce: vi.fn(),
}));

vi.mock("../cron/delivery.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cron/delivery.js")>();
  return {
    ...actual,
    sendCronAnnouncePayloadStrict: mocks.sendCronAnnouncePayloadStrict,
    sendFailureNotificationAnnounce: mocks.sendFailureNotificationAnnounce,
  };
});

import {
  dispatchGatewayCronFinishedNotifications,
  sendGatewayCronFailureAlert,
} from "./server-cron-notifications.js";

function createSessionStoreWithDestinationSessionId(): { dir: string; storePath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-cron-notify-session-id-"));
  const storePath = path.join(dir, "sessions.json");
  fs.writeFileSync(
    storePath,
    JSON.stringify({
      "agent:main:discord:channel:ops": {
        sessionId: "destination-session-id",
        updatedAt: 1,
      },
    }),
  );
  return { dir, storePath };
}

describe("dispatchGatewayCronFinishedNotifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves session-id targets before sending immediate failure alerts", async () => {
    const { dir, storePath } = createSessionStoreWithDestinationSessionId();
    try {
      const logger = {
        warn: vi.fn(),
      };
      const job = {
        id: "cron-failure-alert-session-id",
        name: "failure alert session id",
        enabled: true,
        createdAtMs: 1,
        updatedAtMs: 1,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "session:destination-session-id",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "hello" },
        state: {},
      } satisfies CronJob;

      await sendGatewayCronFailureAlert({
        deps: {} as CliDeps,
        logger,
        resolveCronAgent: () => ({ agentId: "main", cfg: { session: { store: storePath } } }),
        job,
        text: "boom",
        channel: "discord",
        to: "channel:ops",
      });

      expect(mocks.sendCronAnnouncePayloadStrict).toHaveBeenCalledTimes(1);
      expect(mocks.sendCronAnnouncePayloadStrict.mock.calls[0]?.[0].target).toEqual({
        channel: "discord",
        to: "channel:ops",
        accountId: undefined,
        sessionKey: "agent:main:discord:channel:ops",
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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

  it("resolves session-id targets before sending configured failure destinations", () => {
    const { dir, storePath } = createSessionStoreWithDestinationSessionId();
    try {
      const logger = {
        warn: vi.fn(),
      };
      const job = {
        id: "cron-failure-dest-session-id",
        name: "failure dest session id",
        enabled: true,
        createdAtMs: 1,
        updatedAtMs: 1,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "session:destination-session-id",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "hello" },
        delivery: {
          mode: "announce",
          channel: "discord",
          to: "channel:ops",
          failureDestination: {
            mode: "announce",
            channel: "discord",
            to: "channel:ops-failures",
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
        resolveCronAgent: () => ({ agentId: "main", cfg: { session: { store: storePath } } }),
      });

      expect(mocks.sendFailureNotificationAnnounce).toHaveBeenCalledTimes(1);
      expect(mocks.sendFailureNotificationAnnounce.mock.calls[0]?.[4]).toEqual({
        channel: "discord",
        to: "channel:ops-failures",
        accountId: undefined,
        sessionKey: "agent:main:discord:channel:ops",
        inheritSessionThread: false,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves session-id targets before sending primary failure notifications", () => {
    const { dir, storePath } = createSessionStoreWithDestinationSessionId();
    try {
      const logger = {
        warn: vi.fn(),
      };
      const job = {
        id: "cron-primary-failure-session-id",
        name: "primary failure session id",
        enabled: true,
        createdAtMs: 1,
        updatedAtMs: 1,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "session:destination-session-id",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "hello" },
        delivery: {
          mode: "announce",
          channel: "discord",
          to: "channel:ops",
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
        resolveCronAgent: () => ({ agentId: "main", cfg: { session: { store: storePath } } }),
      });

      expect(mocks.sendFailureNotificationAnnounce).toHaveBeenCalledTimes(1);
      expect(mocks.sendFailureNotificationAnnounce.mock.calls[0]?.[4]).toEqual({
        channel: "discord",
        to: "channel:ops",
        accountId: undefined,
        sessionKey: "agent:main:discord:channel:ops",
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
