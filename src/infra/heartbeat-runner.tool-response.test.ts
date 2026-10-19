import { STREAM_ERROR_FALLBACK_TEXT } from "@openclaw/ai/internal/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GENERIC_EXTERNAL_RUN_FAILURE_TEXT,
  HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT,
} from "../agents/failover/user-copy.js";
import { createHeartbeatToolResponsePayload } from "../auto-reply/heartbeat-tool-response.js";
import {
  markReplyPayloadForSourceSuppressionDelivery,
  setReplyPayloadMetadata,
} from "../auto-reply/reply-payload.js";
import { normalizeReplyPayloadDirectives } from "../auto-reply/reply/reply-delivery.js";
import { resolveReplyOperationRunState } from "../auto-reply/reply/reply-operation-run-state.js";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import type { OpenClawConfig } from "../config/config.js";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import { readCronScratchSnapshot } from "../cron/scratch-read.js";
import { deleteCronJobScratch, readCronJobScratchState } from "../cron/scratch-store.js";
import { resolveCronJobsStorePath, saveCronJobsStore } from "../cron/store.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import { getLastHeartbeatEvent, resetHeartbeatEventsForTest } from "./heartbeat-events.js";
import { claimHeartbeatOutcomeForRun } from "./heartbeat-outcome-store.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "./heartbeat-runner.test-harness.js";
import {
  type HeartbeatReplySpy,
  readSessionStoreForTest,
  seedHeartbeatScratchForTest,
  seedMainSessionStore,
  setHeartbeatAgentTurnStatus,
  withTempTelegramHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";
import { isRetryableHeartbeatSkipReason } from "./heartbeat-wake.js";
import {
  enqueueSystemEvent,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "./system-events.js";

installHeartbeatRunnerTestRuntime();
const TELEGRAM_GROUP = "-1001234567890";
const previousHeartbeat = {
  lastHeartbeatText: "Previous successful heartbeat.",
  lastHeartbeatSentAt: 123,
};
const quietReply = () =>
  createHeartbeatToolResponsePayload({
    outcome: "no_change",
    notify: false,
    summary: "Nothing needs attention.",
  });

type FixtureOptions = {
  messages?: OpenClawConfig["messages"];
  isolatedSession?: boolean;
  target?: "telegram" | "last";
  showOk?: boolean;
  session?: Partial<Parameters<typeof seedMainSessionStore>[2]>;
};

async function createFixture(
  sandbox: { tmpDir: string; storePath: string; replySpy: HeartbeatReplySpy },
  options: FixtureOptions,
) {
  const { tmpDir, storePath, replySpy } = sandbox;
  const cfg: OpenClawConfig = {
    agents: {
      defaults: {
        workspace: tmpDir,
        heartbeat: {
          every: "5m",
          target: options.target ?? "telegram",
          isolatedSession: options.isolatedSession,
        },
      },
    },
    messages: options.messages,
    channels: { telegram: { allowFrom: ["*"], heartbeat: { showOk: options.showOk ?? false } } },
    session: { store: storePath },
  };
  const sessionKey = await seedMainSessionStore(storePath, cfg, {
    lastChannel: "telegram",
    lastProvider: "telegram",
    lastTo: TELEGRAM_GROUP,
    ...options.session,
  });
  const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1" });
  const nowMs = vi.fn(() => 0);
  replySpy.mockResolvedValue(quietReply());
  return {
    ...sandbox,
    cfg,
    sessionKey,
    sendTelegram,
    nowMs,
    run: (overrides: Omit<Parameters<typeof runHeartbeatOnce>[0], "cfg" | "deps"> = {}) =>
      runHeartbeatOnce({
        cfg,
        ...overrides,
        deps: {
          telegram: sendTelegram,
          getReplyFromConfig: replySpy,
          getQueueSize: () => 0,
          nowMs,
        },
      }),
    expectSend: (text: string, silent?: boolean) => {
      expect(sendTelegram).toHaveBeenCalledExactlyOnceWith(TELEGRAM_GROUP, text, {
        verbose: false,
        cfg,
        accountId: undefined,
        ...(silent !== undefined ? { silent } : {}),
      });
    },
  };
}

function withHeartbeat(
  test: (fixture: Awaited<ReturnType<typeof createFixture>>) => Promise<void>,
  options: FixtureOptions = {},
) {
  return withTempTelegramHeartbeatSandbox(async (sandbox) =>
    test(await createFixture(sandbox, options)),
  );
}

function expectToolPrompt(replySpy: HeartbeatReplySpy) {
  const call = replySpy.mock.calls[0];
  expect(call?.[0].Body).toContain("heartbeat_respond");
  expect(call?.[0].Body).not.toContain("HEARTBEAT_OK");
  expect(call?.[1]).toMatchObject({
    enableHeartbeatTool: true,
    forceHeartbeatTool: true,
    sourceReplyDeliveryMode: "message_tool_only",
  });
}

function expectQuiet(sendTelegram: ReturnType<typeof vi.fn>) {
  expect(sendTelegram).not.toHaveBeenCalled();
  expect(getLastHeartbeatEvent()).toMatchObject({
    status: "ok-token",
    channel: "telegram",
    silent: true,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  resetHeartbeatEventsForTest();
  resetSystemEventsForTest();
});

describe("runHeartbeatOnce heartbeat response tool", () => {
  it("commits private monitor scratch without delivering it", async () => {
    await withHeartbeat(async ({ replySpy, run, sendTelegram }) => {
      const jobId = await seedHeartbeatScratchForTest({ content: "old scratch" });
      const reply = createHeartbeatToolResponsePayload({
        outcome: "progress",
        notify: false,
        summary: "Updated monitor context.",
        scratch: "new private scratch",
      });
      expect(JSON.stringify(reply)).not.toContain("new private scratch");
      replySpy.mockResolvedValue(normalizeReplyPayloadDirectives({ payload: reply }).payload);
      expect((await run({ source: "manual" })).status).toBe("ran");
      expect(sendTelegram).not.toHaveBeenCalled();
      expect(readCronJobScratchState(resolveCronJobsStorePath(), jobId).scratch?.content).toBe(
        "new private scratch",
      );
    });
  });

  it("rejects a scratch proposal when its responding run fails", async () => {
    await withHeartbeat(async ({ replySpy, sendTelegram, run }) => {
      const jobId = await seedHeartbeatScratchForTest({ content: "last successful scratch" });
      const before = readCronJobScratchState(resolveCronJobsStorePath(), jobId);
      replySpy.mockImplementationOnce(async (_ctx, options) => {
        setHeartbeatAgentTurnStatus(options, "failed");
        return createHeartbeatToolResponsePayload({
          outcome: "progress",
          notify: false,
          summary: "Progress before failure.",
          scratch: "uncommitted proposal",
        });
      });
      sendTelegram.mockReset();
      expect(await run({ source: "manual" })).toEqual({
        status: "failed",
        reason: "agent-runner-failure",
      });
      expect(readCronJobScratchState(resolveCronJobsStorePath(), jobId)).toEqual(before);
    });
  });

  it.each([
    { turnStatus: "superseded" as const, reason: "preempted" },
    { turnStatus: "cancelled" as const, reason: "agent-runner-cancelled" },
  ])("retains heartbeat work and scratch after $turnStatus", async ({ turnStatus, reason }) => {
    await withHeartbeat(
      async ({ storePath, sessionKey, replySpy, sendTelegram, run }) => {
        const jobId = await seedHeartbeatScratchForTest({ content: "old scratch" });
        enqueueSystemEvent("exec finished: backup completed", { sessionKey });
        const inspectedEvents = peekSystemEventEntries(sessionKey);
        replySpy.mockImplementationOnce(async (_ctx, options) => {
          setHeartbeatAgentTurnStatus(options, turnStatus);
          return createHeartbeatToolResponsePayload({
            outcome: "progress",
            notify: true,
            summary: "Backup completed.",
            scratch: "new private scratch",
          });
        });
        expect(await run({ source: "exec-event", intent: "event", reason: "exec-event" })).toEqual({
          status: "skipped",
          reason,
        });
        expect(sendTelegram).not.toHaveBeenCalled();
        expect(peekSystemEventEntries(sessionKey)).toEqual(inspectedEvents);
        expect(readCronJobScratchState(resolveCronJobsStorePath(), jobId).scratch?.content).toBe(
          "old scratch",
        );
        expect(readSessionStoreForTest(storePath)[sessionKey]).toMatchObject(previousHeartbeat);
        expect(getLastHeartbeatEvent()).toMatchObject({ status: "skipped", reason });
        expect(isRetryableHeartbeatSkipReason(reason)).toBe(turnStatus === "superseded");
      },
      { session: previousHeartbeat },
    );
  });

  it("does not recreate scratch when its monitor is deleted while the heartbeat runs", async () => {
    await withHeartbeat(async ({ replySpy, run }) => {
      const cronStorePath = resolveCronJobsStorePath();
      const monitor = await readCronScratchSnapshot(cronStorePath, {
        kind: "heartbeat",
        agentId: "main",
      });
      expect(monitor).toBeDefined();
      if (!monitor) {
        throw new Error("Expected seeded heartbeat monitor");
      }
      deleteCronJobScratch(cronStorePath, monitor.jobId);
      replySpy.mockImplementation(async () => {
        await saveCronJobsStore(cronStorePath, { version: 1, jobs: [] });
        return createHeartbeatToolResponsePayload({
          outcome: "progress",
          notify: false,
          summary: "Updated monitor context.",
          scratch: "late scratch write",
        });
      });
      expect((await run({ source: "manual" })).status).toBe("ran");
      expect(readCronJobScratchState(cronStorePath, monitor.jobId)).toEqual({ currentRevision: 0 });
    });
  });

  it("persists a meaningful quiet outcome for the base session", async () => {
    await withHeartbeat(async ({ sessionKey, storePath, replySpy, run }) => {
      replySpy.mockResolvedValue(
        createHeartbeatToolResponsePayload({
          outcome: "progress",
          notify: false,
          summary: "Deployment completed; smoke test pending.",
          nextCheck: "next scheduled heartbeat",
        }),
      );
      await run({ source: "manual", reason: "operator check" });
      expect(
        await claimHeartbeatOutcomeForRun({
          agentId: "main",
          sessionKey,
          storePath,
          runId: "user-run",
        }),
      ).toMatchObject({
        outcome: "progress",
        summary: "Deployment completed; smoke test pending.",
        wakeSource: "manual",
        wakeReason: "operator check",
      });
    });
  });

  it("converts trailing notify=false fallback text into silent Telegram delivery", async () => {
    await withHeartbeat(
      async ({ replySpy, run, expectSend }) => {
        const text = `${"x".repeat(199)}🚀tail`;
        replySpy.mockResolvedValue({ text: `${text}\n\nnotify=false\r\n` });
        expect((await run()).status).toBe("ran");
        expectSend(text, true);
        expect(getLastHeartbeatEvent()).toMatchObject({
          status: "sent",
          preview: "x".repeat(199),
          channel: "telegram",
          silent: true,
        });
        const call = replySpy.mock.calls[0];
        expect(call?.[0].Body).toContain(SILENT_REPLY_TOKEN);
        expect(call?.[0].Body).not.toContain("heartbeat_respond");
      },
      { messages: { visibleReplies: "automatic" } },
    );
  });

  it.each([
    { name: "marker-only notify=false", text: "notify=false\r\n", showOk: true },
    {
      name: "stream-error placeholders",
      text: `${STREAM_ERROR_FALLBACK_TEXT}\n${STREAM_ERROR_FALLBACK_TEXT}`,
      showOk: false,
    },
  ])("suppresses $name fallback replies", async ({ text, showOk }) => {
    await withHeartbeat(
      async ({ replySpy, run, sendTelegram }) => {
        replySpy.mockResolvedValue(markReplyPayloadForSourceSuppressionDelivery({ text }));
        expect((await run()).status).toBe("ran");
        expectQuiet(sendTelegram);
      },
      { showOk },
    );
  });

  it("keeps group message-tool finals private", async () => {
    await withHeartbeat(
      async ({ replySpy, run, sendTelegram }) => {
        replySpy.mockResolvedValue({
          text: "Private heartbeat reasoning with HEARTBEAT_OK inside the sentence.",
        });
        expect((await run()).status).toBe("ran");
        expectToolPrompt(replySpy);
        expect(replySpy.mock.calls[0]?.[0].Body).toContain("notify=false");
        expectQuiet(sendTelegram);
      },
      {
        messages: { groupChat: { visibleReplies: "message_tool" } },
        target: "last",
        session: { chatType: "group" },
      },
    );
  });

  it("recalculates isolated runtime instructions and suppresses a quiet text fallback", async () => {
    await withHeartbeat(
      async ({ replySpy, run, sendTelegram }) => {
        replySpy.mockResolvedValue({ text: SILENT_REPLY_TOKEN });
        expect((await run()).status).toBe("ran");
        expectToolPrompt(replySpy);
        const context = replySpy.mock.calls[0]?.[0];
        expect(context?.SessionKey).toMatch(/:heartbeat$/);
        expect(context?.Body).toContain(
          `${SILENT_REPLY_TOKEN} when nothing needs the user's attention`,
        );
        expect(context?.Body).toContain("only the alert text");
        expect(sendTelegram).not.toHaveBeenCalled();
      },
      {
        isolatedSession: true,
        session: {
          modelProvider: "anthropic",
          model: "claude-sonnet-4-6",
          agentRuntimeOverride: "openclaw",
        },
      },
    );
  });

  it("delivers marked operator notices during message-tool mode", async () => {
    await withHeartbeat(async ({ cfg, replySpy, run, expectSend }) => {
      cfg.messages = { visibleReplies: "message_tool" };
      const notice =
        "The backend needs operator attention; the literal notify=false flag is documented.";
      replySpy.mockResolvedValue(markReplyPayloadForSourceSuppressionDelivery({ text: notice }));
      expect((await run()).status).toBe("ran");
      expect(replySpy.mock.calls[0]?.[1]?.sourceReplyDeliveryMode).toBe("message_tool_only");
      expectSend(notice);
    });
  });

  it.each([
    { source: undefined, work: "monitor", heartbeatCopy: true },
    { source: "interval", work: "monitor", heartbeatCopy: true },
    { source: "manual", work: "monitor", heartbeatCopy: true },
    { source: undefined, work: "cron", heartbeatCopy: false },
    { source: "interval", work: "cron", heartbeatCopy: false },
    { source: "manual", work: "cron", heartbeatCopy: false },
    { source: "interval", work: "exec-and-cron", heartbeatCopy: false },
    { source: "manual", work: "background-task", heartbeatCopy: false },
    { source: "exec-event", work: "scheduled-task", heartbeatCopy: true },
  ] as const)(
    "delivers failure copy for selected $work work after a $source wake",
    async ({ source, work, heartbeatCopy }) => {
      await withHeartbeat(async ({ sessionKey, replySpy, run, expectSend }) => {
        if (work === "cron" || work === "exec-and-cron") {
          enqueueSystemEvent("Cron: scheduled reminder", { sessionKey, contextKey: "cron:job" });
        }
        if (work === "exec-and-cron" || work === "scheduled-task") {
          enqueueSystemEvent("exec finished: queued task", { sessionKey });
        }
        if (work === "background-task") {
          enqueueSystemEvent("Background task completed", { sessionKey, contextKey: "task:job" });
        }
        replySpy.mockImplementationOnce(async (_ctx, options) => {
          setHeartbeatAgentTurnStatus(options, "failed");
          return { text: GENERIC_EXTERNAL_RUN_FAILURE_TEXT, isError: true };
        });
        expect(
          await run({
            source,
            ...(work === "scheduled-task"
              ? { tasks: [{ jobId: "scheduled", name: "Periodic check", prompt: "Check status" }] }
              : {}),
          }),
        ).toEqual({ status: "failed", reason: "agent-runner-failure" });
        expectSend(
          heartbeatCopy ? HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT : GENERIC_EXTERNAL_RUN_FAILURE_TEXT,
        );
        expect(replySpy.mock.calls[0]?.[1]).toMatchObject({
          isHeartbeat: true,
          useHeartbeatFailureCopy: heartbeatCopy,
        });
      });
    },
  );

  it("retains failed work and dedupe state until a later successful notification", async () => {
    await withHeartbeat(
      async ({ sessionKey, storePath, replySpy, sendTelegram, run, expectSend }) => {
        enqueueSystemEvent("exec finished: retryable deployment check", { sessionKey });
        const inspectedEvents = peekSystemEventEntries(sessionKey);
        replySpy.mockImplementationOnce(async (_ctx, options) => {
          setHeartbeatAgentTurnStatus(options, "failed");
          return [quietReply(), { text: GENERIC_EXTERNAL_RUN_FAILURE_TEXT, isError: true }];
        });
        expect(await run({ reason: "exec-event" })).toEqual({
          status: "failed",
          reason: "agent-runner-failure",
        });
        expectSend(GENERIC_EXTERNAL_RUN_FAILURE_TEXT);
        expect(replySpy.mock.calls[0]?.[1]?.useHeartbeatFailureCopy).toBe(false);
        expect(peekSystemEventEntries(sessionKey)).toEqual(inspectedEvents);
        expect(readSessionStoreForTest(storePath)[sessionKey]).toMatchObject(previousHeartbeat);
        replySpy.mockImplementationOnce(async (_ctx, options) => {
          setHeartbeatAgentTurnStatus(options, "ok");
          return createHeartbeatToolResponsePayload({
            outcome: "progress",
            notify: true,
            summary: "Queued work completed.",
            notificationText: "Queued work completed successfully.",
          });
        });
        sendTelegram.mockClear();
        expect((await run({ reason: "exec-event" })).status).toBe("ran");
        expectSend("Queued work completed successfully.");
        expect(peekSystemEventEntries(sessionKey)).toEqual([]);
      },
      { session: previousHeartbeat },
    );
  });

  it.each([false, true])(
    "reports one continuous failure until a healthy completion (isolated=%s)",
    async (isolatedSession) => {
      await withHeartbeat(
        async ({ sessionKey, storePath, replySpy, sendTelegram, run, nowMs }) => {
          enqueueSystemEvent("exec finished: retryable background check", { sessionKey });
          const inspectedEvents = peekSystemEventEntries(sessionKey);
          replySpy.mockImplementation(async (_ctx, options) => {
            setHeartbeatAgentTurnStatus(options, "failed");
            return { text: GENERIC_EXTERNAL_RUN_FAILURE_TEXT, isError: true };
          });
          const runCheck = () => run({ reason: "exec-event" });
          expect((await runCheck()).status).toBe("failed");
          nowMs.mockReturnValue(48 * 60 * 60 * 1_000);
          expect((await runCheck()).status).toBe("failed");
          expect(sendTelegram).toHaveBeenCalledTimes(1);
          expect(getLastHeartbeatEvent()).toMatchObject({ status: "failed", silent: true });
          expect(peekSystemEventEntries(sessionKey)).toEqual(inspectedEvents);
          expect(readSessionStoreForTest(storePath)[sessionKey]).toMatchObject(previousHeartbeat);

          replySpy.mockImplementationOnce(async (_ctx, options) => {
            setHeartbeatAgentTurnStatus(options, "cancelled");
            return quietReply();
          });
          expect((await runCheck()).status).toBe("skipped");
          expect((await runCheck()).status).toBe("failed");
          expect(sendTelegram).toHaveBeenCalledTimes(1);

          replySpy.mockImplementationOnce(async (_ctx, options) => {
            setHeartbeatAgentTurnStatus(options, "ok");
            resolveReplyOperationRunState(options)!.backgroundWorkStarted = true;
            return quietReply();
          });
          expect((await runCheck()).status).toBe("ran");
          enqueueSystemEvent("exec finished: next background check", { sessionKey });
          expect((await runCheck()).status).toBe("failed");
          expect(sendTelegram).toHaveBeenCalledTimes(1);

          replySpy.mockImplementationOnce(async (_ctx, options) => {
            setHeartbeatAgentTurnStatus(options, "ok");
            return quietReply();
          });
          expect((await runCheck()).status).toBe("ran");
          expect(peekSystemEventEntries(sessionKey)).toEqual([]);
          enqueueSystemEvent("exec finished: check after recovery", { sessionKey });
          expect((await runCheck()).status).toBe("failed");
          expect(sendTelegram).toHaveBeenCalledTimes(2);
        },
        { isolatedSession, session: previousHeartbeat },
      );
    },
  );

  it("keeps changed failures in one episode while answering foreground manual checks", async () => {
    await withHeartbeat(async ({ sessionKey, storePath, replySpy, sendTelegram, run }) => {
      let text = "The backend could not complete this background check.";
      let toolFailure = false;
      replySpy.mockImplementation(async (_ctx, options) => {
        setHeartbeatAgentTurnStatus(options, "failed");
        const payload = { text, isError: true };
        return toolFailure
          ? setReplyPayloadMetadata(payload, { heartbeatTerminalToolFailure: { toolName: "exec" } })
          : payload;
      });
      expect(await run()).toMatchObject({ status: "failed", reason: "agent-runner-failure" });
      const episodeKey = readSessionStoreForTest(storePath)[sessionKey]?.lastHeartbeatFailureKey;
      expect(episodeKey).toEqual(expect.any(String));
      text = "The backend now requires authentication.";
      expect(await run()).toMatchObject({ status: "failed", reason: "agent-runner-failure" });
      toolFailure = true;
      expect(await run()).toMatchObject({ status: "failed", reason: "agent-tool-failure" });
      expect((await run({ source: "manual", intent: "immediate" })).status).toBe("failed");
      expect(sendTelegram).toHaveBeenCalledTimes(1);

      expect((await run({ source: "manual", intent: "manual" })).status).toBe("failed");
      expect(sendTelegram).toHaveBeenCalledTimes(2);
      expect(readSessionStoreForTest(storePath)[sessionKey]?.lastHeartbeatFailureKey).toBe(
        episodeKey,
      );
      expect((await run()).status).toBe("failed");
      expect(sendTelegram).toHaveBeenCalledTimes(2);
      expect((await run({ source: "manual", intent: "manual" })).status).toBe("failed");
      expect(sendTelegram).toHaveBeenCalledTimes(3);
    });
  });

  it.each(["changed route", "changed thread", "changed account", "replaced lifecycle"] as const)(
    "reports a new failure after %s",
    async (change) => {
      await withHeartbeat(async ({ cfg, sessionKey, storePath, replySpy, sendTelegram, run }) => {
        const text = "The backend could not complete this background check.";
        replySpy.mockImplementation(async (_ctx, options) => {
          setHeartbeatAgentTurnStatus(options, "failed");
          return { text, isError: true };
        });
        expect((await run()).status).toBe("failed");
        expect((await run()).status).toBe("failed");
        expect(sendTelegram).toHaveBeenCalledTimes(1);
        if (change === "changed route") {
          cfg.agents!.defaults!.heartbeat!.to = "-1009876543210";
        } else if (change === "changed account") {
          cfg.agents!.defaults!.heartbeat!.accountId = "secondary";
        } else if (change === "changed thread") {
          cfg.agents!.defaults!.heartbeat!.target = "last";
          await patchSessionEntryCore(
            { storePath, sessionKey },
            () => ({
              chatType: "group",
              delivery: normalizeSessionDeliveryState({
                context: { channel: "telegram", to: TELEGRAM_GROUP, threadId: 42 },
              }),
            }),
            { preserveActivity: true },
          );
        } else {
          await patchSessionEntryCore(
            { storePath, sessionKey },
            () => ({ lifecycleRevision: "replacement-lifecycle" }),
            { preserveActivity: true },
          );
        }
        expect((await run()).status).toBe("failed");
        expect((await run()).status).toBe("failed");
        expect(sendTelegram).toHaveBeenCalledTimes(2);
        expect(sendTelegram.mock.calls[1]?.[0]).toBe(
          change === "changed route" ? "-1009876543210" : TELEGRAM_GROUP,
        );
        if (change === "changed account") {
          expect(sendTelegram.mock.calls[1]?.[2]).toMatchObject({ accountId: "secondary" });
        } else if (change === "changed thread") {
          expect(sendTelegram.mock.calls[1]?.[2]).toMatchObject({ messageThreadId: 42 });
        }
      });
    },
  );

  it("does not carry a late delivered failure into a replaced lifecycle", async () => {
    await withHeartbeat(async ({ sessionKey, storePath, replySpy, sendTelegram, run }) => {
      replySpy.mockImplementation(async (_ctx, options) => {
        setHeartbeatAgentTurnStatus(options, "failed");
        return { text: GENERIC_EXTERNAL_RUN_FAILURE_TEXT, isError: true };
      });
      sendTelegram.mockImplementationOnce(async () => {
        await patchSessionEntryCore(
          { storePath, sessionKey },
          () => ({ lifecycleRevision: "replacement-during-send" }),
          { preserveActivity: true },
        );
        return { messageId: "m1" };
      });
      expect((await run()).status).toBe("failed");
      expect((await run()).status).toBe("failed");
      expect(sendTelegram).toHaveBeenCalledTimes(2);
    });
  });

  it("keeps an unmarked failed run private while retaining inspected work", async () => {
    await withHeartbeat(
      async ({ sessionKey, replySpy, sendTelegram, run }) => {
        enqueueSystemEvent("exec finished: private retryable failure", { sessionKey });
        const inspectedEvents = peekSystemEventEntries(sessionKey);
        replySpy.mockImplementation(async (_ctx, options) => {
          setHeartbeatAgentTurnStatus(options, "failed");
          const reply = createHeartbeatToolResponsePayload({
            outcome: "progress",
            notify: true,
            summary: "Public tool summary.",
            notificationText: "Public tool notification.",
          });
          reply.mediaUrl = "https://example.test/public.png";
          return [
            reply,
            { text: "Private heartbeat reasoning.", mediaUrl: "https://example.test/private.png" },
          ];
        });
        expect(await run()).toEqual({ status: "failed", reason: "agent-runner-failure" });
        expect(sendTelegram).not.toHaveBeenCalled();
        expect(peekSystemEventEntries(sessionKey)).toEqual(inspectedEvents);
        expect(getLastHeartbeatEvent()).toMatchObject({
          status: "failed",
          reason: "agent-runner-failure",
          silent: true,
        });
      },
      { messages: { visibleReplies: "message_tool" } },
    );
  });
});
