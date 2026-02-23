import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as replyModule from "../auto-reply/reply.js";
import type { OpenClawConfig } from "../config/config.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import {
  seedMainSessionStore,
  setupTelegramHeartbeatPluginRuntimeForTests,
  withTempHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";
import { enqueueSystemEvent, resetSystemEventsForTest } from "./system-events.js";

// Avoid pulling optional runtime deps during isolated runs.
vi.mock("jiti", () => ({ createJiti: () => () => ({}) }));

beforeEach(() => {
  setupTelegramHeartbeatPluginRuntimeForTests();
  resetSystemEventsForTest();
});

afterEach(() => {
  resetSystemEventsForTest();
  vi.restoreAllMocks();
});

describe("Ghost reminder bug (issue #13317)", () => {
  const createHeartbeatDeps = (replyText: string) => {
    const sendTelegram = vi.fn().mockResolvedValue({
      messageId: "m1",
      chatId: "155462274",
    });
    const getReplySpy = vi
      .spyOn(replyModule, "getReplyFromConfig")
      .mockResolvedValue({ text: replyText });
    return { sendTelegram, getReplySpy };
  };

  const createConfig = async (params: {
    tmpDir: string;
    storePath: string;
  }): Promise<{ cfg: OpenClawConfig; sessionKey: string }> => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: params.tmpDir,
          heartbeat: {
            every: "5m",
            target: "telegram",
          },
        },
      },
      channels: { telegram: { allowFrom: ["*"] } },
      session: { store: params.storePath },
    };
    const sessionKey = await seedMainSessionStore(params.storePath, cfg, {
      lastChannel: "telegram",
      lastProvider: "telegram",
      lastTo: "155462274",
    });

    return { cfg, sessionKey };
  };

  const expectCronEventPrompt = (
    calledCtx: {
      Provider?: string;
      Body?: string;
    } | null,
    reminderText: string,
  ) => {
    expect(calledCtx).not.toBeNull();
    expect(calledCtx?.Provider).toBe("cron-event");
    expect(calledCtx?.Body).toContain("scheduled reminder has been triggered");
    expect(calledCtx?.Body).toContain(reminderText);
    expect(calledCtx?.Body).not.toContain("HEARTBEAT_OK");
    expect(calledCtx?.Body).not.toContain("heartbeat poll");
  };

  const runCronReminderCase = async (
    tmpPrefix: string,
    enqueue: (sessionKey: string) => void,
  ): Promise<{
    result: Awaited<ReturnType<typeof runHeartbeatOnce>>;
    sendTelegram: ReturnType<typeof vi.fn>;
    calledCtx: { Provider?: string; Body?: string } | null;
  }> => {
    return runHeartbeatCase({
      tmpPrefix,
      replyText: "Relay this reminder now",
      reason: "cron:reminder-job",
      enqueue,
    });
  };

  const runHeartbeatCase = async (params: {
    tmpPrefix: string;
    replyText: string;
    reason: string;
    enqueue: (sessionKey: string) => void;
  }): Promise<{
    result: Awaited<ReturnType<typeof runHeartbeatOnce>>;
    sendTelegram: ReturnType<typeof vi.fn>;
    calledCtx: { Provider?: string; Body?: string } | null;
    replyCallCount: number;
  }> => {
    return withTempHeartbeatSandbox(
      async ({ tmpDir, storePath }) => {
        const { sendTelegram, getReplySpy } = createHeartbeatDeps(params.replyText);
        const { cfg, sessionKey } = await createConfig({ tmpDir, storePath });
        params.enqueue(sessionKey);
        const result = await runHeartbeatOnce({
          cfg,
          agentId: "main",
          reason: params.reason,
          deps: {
            sendTelegram,
          },
        });
        const calledCtx = (getReplySpy.mock.calls[0]?.[0] ?? null) as {
          Provider?: string;
          Body?: string;
        } | null;
        return {
          result,
          sendTelegram,
          calledCtx,
          replyCallCount: getReplySpy.mock.calls.length,
        };
      },
      { prefix: params.tmpPrefix },
    );
  };

  it("does not use CRON_EVENT_PROMPT when only a HEARTBEAT_OK event is present", async () => {
    const { result, sendTelegram, calledCtx, replyCallCount } = await runHeartbeatCase({
      tmpPrefix: "openclaw-ghost-",
      replyText: "Heartbeat check-in",
      reason: "cron:test-job",
      enqueue: (sessionKey) => {
        enqueueSystemEvent("HEARTBEAT_OK", { sessionKey });
      },
    });
    expect(result.status).toBe("ran");
    expect(replyCallCount).toBe(1);
    expect(calledCtx?.Provider).toBe("heartbeat");
    expect(calledCtx?.Body).not.toContain("scheduled reminder has been triggered");
    expect(calledCtx?.Body).not.toContain("relay this reminder");
    expect(sendTelegram).toHaveBeenCalled();
  });

  it("uses CRON_EVENT_PROMPT when an actionable cron event exists", async () => {
    const { result, sendTelegram, calledCtx } = await runCronReminderCase(
      "openclaw-cron-",
      (sessionKey) => {
        enqueueSystemEvent("Reminder: Check Base Scout results", { sessionKey });
      },
    );
    expect(result.status).toBe("ran");
    expectCronEventPrompt(calledCtx, "Reminder: Check Base Scout results");
    expect(sendTelegram).toHaveBeenCalled();
  });

  it("uses CRON_EVENT_PROMPT when cron events are mixed with heartbeat noise", async () => {
    const { result, sendTelegram, calledCtx } = await runCronReminderCase(
      "openclaw-cron-mixed-",
      (sessionKey) => {
        enqueueSystemEvent("HEARTBEAT_OK", { sessionKey });
        enqueueSystemEvent("Reminder: Check Base Scout results", { sessionKey });
      },
    );
    expect(result.status).toBe("ran");
    expectCronEventPrompt(calledCtx, "Reminder: Check Base Scout results");
    expect(sendTelegram).toHaveBeenCalled();
  });

  it("uses CRON_EVENT_PROMPT for tagged cron events on interval wake", async () => {
    const { result, sendTelegram, calledCtx, replyCallCount } = await runHeartbeatCase({
      tmpPrefix: "openclaw-cron-interval-",
      replyText: "Relay this cron update now",
      reason: "interval",
      enqueue: (sessionKey) => {
        enqueueSystemEvent("Cron: QMD maintenance completed", {
          sessionKey,
          contextKey: "cron:qmd-maintenance",
        });
      },
    });
    expect(result.status).toBe("ran");
    expect(replyCallCount).toBe(1);
    expect(calledCtx?.Provider).toBe("cron-event");
    expect(calledCtx?.Body).toContain("scheduled reminder has been triggered");
    expect(calledCtx?.Body).toContain("Cron: QMD maintenance completed");
    expect(calledCtx?.Body).not.toContain("Read HEARTBEAT.md");
    expect(sendTelegram).toHaveBeenCalled();
  });
});
