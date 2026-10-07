import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { resetProcessRegistryForTests } from "../agents/bash-process-registry.test-support.js";
import { createExecTool } from "../agents/bash-tools.exec-run.js";
import { buildPayloads } from "../agents/embedded-agent-runner/run/payloads.test-helpers.js";
import { resolveEmbeddedRunTerminal } from "../agents/embedded-agent-runner/run/terminal-resolution.js";
import { makeTerminalInput } from "../agents/embedded-agent-runner/run/terminal-resolution.test-support.js";
import { GENERIC_EXTERNAL_RUN_FAILURE_TEXT } from "../agents/failover/user-copy.js";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../agents/test-helpers/embedded-agent-runner-e2e-fixtures.js";
import type { InternalGetReplyOptions } from "../auto-reply/reply/get-reply.types.js";
import { resolveMainSessionKey } from "../config/sessions/main-session.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { loadExactSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
import { resetCronActiveJobs } from "../cron/active-jobs.js";
import { racePromiseWithAbortSignal } from "./abort-signal.js";
import type { HeartbeatRunOptions } from "./heartbeat-runner-execution.js";
import {
  createLastTargetConfig,
  formatQueuedEvents,
  withRouting,
} from "./heartbeat-runner.event-routing.test-support.js";
import { runHeartbeatOnce, startHeartbeatRunner } from "./heartbeat-runner.js";
import {
  getFirstReplyContext,
  mockCallAt,
  readSessionStoreForTest,
  seedSessionStore,
  setHeartbeatAgentTurnStatus,
  setupTelegramHeartbeatPluginRuntimeForTests,
  withTempHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";
import type { HeartbeatRunResult } from "./heartbeat-wake-contracts.js";
import { requestHeartbeatAndWait, setHeartbeatWakeHandler } from "./heartbeat-wake.js";
import { resolveSystemEventQueueKey } from "./system-event-ownership.js";
import { enqueueSystemEvent, peekSystemEvents, resetSystemEventsForTest } from "./system-events.js";

const writeTelegramSessionStore = (
  storePath: string,
  sessionKey: string,
  overrides: Record<string, unknown>,
) =>
  seedSessionStore(storePath, sessionKey, {
    sessionId: "sid",
    updatedAt: Date.now(),
    lastChannel: "telegram",
    lastProvider: "telegram",
    lastTo: "-100155462274",
    ...overrides,
  });

const expectTelegramSend = (
  sendTelegram: ReturnType<typeof vi.fn>,
  params: {
    to: string;
    text: string;
    messageThreadId?: number;
  },
) => {
  expect(sendTelegram).toHaveBeenCalledTimes(1);
  const [to, text, options] = mockCallAt(sendTelegram, 0, "Telegram send");
  expect(to).toBe(params.to);
  expect(text).toBe(params.text);
  expect((options as { messageThreadId?: number } | undefined)?.messageThreadId).toBe(
    params.messageThreadId,
  );
};

describe("Heartbeat event routing", () => {
  beforeEach(() => {
    setupTelegramHeartbeatPluginRuntimeForTests();
    resetSystemEventsForTest();
    resetCronActiveJobs();
  });

  afterEach(async () => {
    setHeartbeatWakeHandler(async () => ({ status: "ran", durationMs: 0 }));
    await requestHeartbeatAndWait({
      source: "manual",
      intent: "immediate",
      reason: "wake",
      coalesceMs: 0,
    });
    setHeartbeatWakeHandler(null);
    resetSystemEventsForTest();
    vi.restoreAllMocks();
  });

  it.each([
    {
      name: "base route",
      eventThreadId: undefined,
      baseThreadId: 42,
      legacy: false,
    },
    {
      name: "same-queue event",
      eventThreadId: 42,
      baseThreadId: 42,
      legacy: false,
    },
    {
      name: "legacy moved base route",
      eventThreadId: 42,
      baseThreadId: 88,
      legacy: true,
    },
  ])(
    "delivers isolated exec completion using its $name",
    async ({ eventThreadId, baseThreadId, legacy }) => {
      await withRouting(
        async ({ storePath, replySpy, baseKey, isolatedKey, sendTelegram, run }) => {
          const queueKey = legacy ? `${isolatedKey}:heartbeat` : isolatedKey;
          const target = (topic: number) => `telegram:-100155462274:topic:${topic}`;
          await writeTelegramSessionStore(storePath, baseKey, {
            sessionId: "base-conversation",
            lastTo: target(baseThreadId),
            lastThreadId: baseThreadId,
            chatType: "group",
            groupId: `-100155462274:topic:${baseThreadId}`,
            subject: "Operations",
            groupActivation: "always",
          });
          await seedSessionStore(storePath, queueKey, {
            sessionId: "previous-isolated-run",
            heartbeatIsolatedBaseSessionKey: baseKey,
          });
          const completion = "Exec completed (background-report, code 0) :: report is ready";
          enqueueSystemEvent(completion, {
            sessionKey: queueKey,
            ...(eventThreadId === undefined
              ? {}
              : {
                  deliveryContext: {
                    channel: "telegram",
                    to: target(eventThreadId),
                    threadId: eventThreadId,
                  },
                }),
          });
          replySpy.mockResolvedValue({ text: "The report is ready." });

          const result = await run({ sessionKey: queueKey, reason: "exec-event" });

          expect(result.status).toBe("ran");
          expectTelegramSend(sendTelegram, {
            to: target(42),
            text: "The report is ready.",
            messageThreadId: 42,
          });
          expect(getFirstReplyContext(replySpy)).toMatchObject({
            SessionKey: isolatedKey,
            InternalTurnSource: "exec",
            InputProvenance: { kind: "internal_system", sourceTool: "exec" },
            MessageThreadId: 42,
            OriginatingChannel: "telegram",
            OriginatingTo: target(42),
            ChatType: "group",
          });
          const options = mockCallAt(
            replySpy,
            0,
            "isolated completion",
          )[1] as InternalGetReplyOptions;
          expect(options.replyConversation?.fields).toMatchObject({
            Provider: "telegram",
            Surface: "telegram",
            ChatType: "group",
          });
          expect(options.replyConversation?.fields.GroupSubject).toBe(
            baseThreadId === 42 ? "Operations" : undefined,
          );
          expect(options.replyConversation?.activation).toBe(
            baseThreadId === 42 ? "always" : undefined,
          );
          expect(peekSystemEvents(isolatedKey)).toEqual([]);
          expect(peekSystemEvents(queueKey)).toEqual([]);
          const rows = readSessionStoreForTest(storePath);
          if (legacy) {
            expect(rows[queueKey]).toBeUndefined();
          }
          expect(rows[baseKey]?.sessionId).toBe("base-conversation");
          expect(rows[isolatedKey]?.heartbeatIsolatedBaseSessionKey).toBe(baseKey);
          expect(rows[isolatedKey]?.sessionId).not.toBe("previous-isolated-run");
          expect(rows[isolatedKey]?.groupActivation).toBeUndefined();
        },
      );
    },
  );

  it("retains a legacy queue's explicit base until its mixed cron follow-up completes", async ({
    signal,
  }) => {
    await withTempHeartbeatSandbox(async ({ tmpDir, replySpy }) => {
      const baseKey = "agent:ops:alerts:heartbeat";
      const isolatedKey = `${baseKey}:heartbeat`;
      const queueKey = `${isolatedKey}:heartbeat`;
      const storeTemplate = `${tmpDir}/agents/{agentId}/sessions/sessions.json`;
      const storePath = resolveSessionStorePathCore(storeTemplate, { agentId: "ops" });
      const cfg = createLastTargetConfig({
        tmpDir,
        storePath: storeTemplate,
        isolatedSession: true,
      });
      cfg.agents!.entries = { ops: {} };
      cfg.agents!.defaults!.heartbeat = {
        every: "0m",
        isolatedSession: true,
        session: "alerts:heartbeat",
        target: "last",
      };
      await writeTelegramSessionStore(storePath, baseKey, { sessionId: "base-conversation" });
      await seedSessionStore(storePath, queueKey, {
        sessionId: "old-isolated",
        heartbeatIsolatedBaseSessionKey: baseKey,
      });
      const readEntry = (sessionKey: string) =>
        loadExactSessionEntryReadOnly({ storePath, agentId: "ops", sessionKey })?.entry;
      expect(readEntry(baseKey)?.sessionId).toBe("base-conversation");
      enqueueSystemEvent("Exec completed (legacy, code 0) :: ready", { sessionKey: queueKey });
      enqueueSystemEvent("Reminder: Legacy queue work", {
        sessionKey: queueKey,
        contextKey: "cron:legacy",
      });
      enqueueSystemEvent("Unrelated base event", { sessionKey: baseKey });
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "delivered" });
      replySpy.mockImplementation(async (ctx) => ({
        text: ctx.InternalTurnSource === "exec" ? "Command completed" : "Reminder handled",
      }));
      const followup = createDeferred<Awaited<ReturnType<typeof runHeartbeatOnce>>>();
      const runner = startHeartbeatRunner({
        cfg,
        runOnce: (opts) => {
          const run = runHeartbeatOnce({
            ...opts,
            cfg,
            deps: { getReplyFromConfig: replySpy, telegram: sendTelegram },
          });
          if (opts.source === "cron") {
            followup.resolve(run);
          }
          return run;
        },
      });
      onTestFinished(() => runner.stop());
      try {
        await requestHeartbeatAndWait({
          source: "exec-event",
          intent: "event",
          reason: "exec-event",
          agentId: "ops",
          sessionKey: queueKey,
          coalesceMs: 0,
        });
        // The exec wake settles before its separately scheduled cron follow-up.
        await expect(racePromiseWithAbortSignal(followup.promise, signal)).resolves.toMatchObject({
          status: "ran",
        });
        expect(replySpy).toHaveBeenCalledTimes(2);
        expect(
          replySpy.mock.calls.map(([ctx]) => [ctx.AgentId, ctx.SessionKey, ctx.InternalTurnSource]),
        ).toEqual([
          ["ops", isolatedKey, "exec"],
          ["ops", isolatedKey, "cron"],
        ]);
        expect(peekSystemEvents(queueKey)).toEqual([]);
        expect(peekSystemEvents(baseKey)).toEqual(["Unrelated base event"]);
        expect(readEntry(baseKey)?.sessionId).toBe("base-conversation");
        expect(readEntry(queueKey)).toBeUndefined();
        expect(readEntry(isolatedKey)?.heartbeatIsolatedBaseSessionKey).toBe(baseKey);
      } finally {
        runner.stop();
      }
    });
  });

  it.each([
    { name: "legacy isolated", queue: "legacy", dedicated: "none", busy: false },
    { name: "shared", queue: "shared", dedicated: "none", busy: false },
    { name: "excluded base", queue: "base", dedicated: "none", busy: false },
    { name: "legacy exec and cron", queue: "legacy", dedicated: "exec", busy: false },
    { name: "busy legacy", queue: "legacy", dedicated: "none", busy: true },
  ])("preserves generic wake queue ownership for $name", async ({ queue, dedicated, busy }) => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createLastTargetConfig({
        tmpDir,
        storePath,
        isolatedSession: queue !== "shared",
      });
      const baseKey = resolveMainSessionKey(cfg);
      const isolatedKey = `${baseKey}:heartbeat`;
      const queueKey = queue === "legacy" ? `${isolatedKey}:heartbeat` : baseKey;
      await writeTelegramSessionStore(storePath, baseKey, { sessionId: "base-conversation" });
      if (queueKey !== baseKey) {
        await seedSessionStore(storePath, queueKey, {
          sessionId: "previous-isolated-run",
          heartbeatIsolatedBaseSessionKey: baseKey,
        });
      }
      const generic = "Gateway restart ok: queued notification";
      const completion = "Exec completed (queue-report, code 0) :: report is ready";
      const reminder = "Reminder: review the scheduled report";
      if (dedicated === "exec") {
        enqueueSystemEvent(completion, { sessionKey: queueKey });
        enqueueSystemEvent(reminder, { sessionKey: queueKey, contextKey: "cron:queue-report" });
      }
      enqueueSystemEvent(generic, {
        sessionKey: queueKey,
        ...(queue === "base"
          ? { deliveryContext: { channel: "telegram", to: "-100999999999", threadId: 42 } }
          : {}),
      });
      const sendTelegram = vi
        .fn()
        .mockResolvedValue({ messageId: "wake", chatId: "-100155462274" });
      const queuedBefore = peekSystemEvents(queueKey);
      let queuedAtReply: string[] | undefined;
      let formatted: string | undefined;
      let legacyRowRemovedAtReply = false;
      replySpy.mockImplementation(async (ctx, options) => {
        queuedAtReply = peekSystemEvents(queueKey);
        legacyRowRemovedAtReply = readSessionStoreForTest(storePath)[queueKey] === undefined;
        formatted = await formatQueuedEvents(cfg, ctx, options);
        return { text: queue === "base" ? "Restart complete" : "HEARTBEAT_OK" };
      });

      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        sessionKey: queueKey,
        source: "hook",
        intent: "immediate",
        reason: "hook:wake",
        deps: {
          getReplyFromConfig: replySpy,
          telegram: sendTelegram,
          getQueueSize: () => (busy ? 1 : 0),
        },
      });
      if (busy) {
        expect(result).toMatchObject({ status: "skipped", reason: "requests-in-flight" });
        expect(replySpy).not.toHaveBeenCalled();
        expect(peekSystemEvents(queueKey)).toEqual(queuedBefore);
        expect(readSessionStoreForTest(storePath)[queueKey]).toBeDefined();
        return;
      }
      expect(result.status).toBe("ran");
      expect(replySpy).toHaveBeenCalledTimes(1);
      expect(queuedAtReply).toEqual(queuedBefore);
      const context = getFirstReplyContext(replySpy);
      expect(context.SessionKey).toBe(queue === "shared" ? baseKey : isolatedKey);
      expect(context.InternalTurnSource).toBe(dedicated === "none" ? "heartbeat" : dedicated);
      expect(context.InputProvenance).toEqual({
        kind: "internal_system",
        sourceTool: dedicated === "none" ? "hook" : dedicated,
      });
      if (queue === "legacy") {
        expect(legacyRowRemovedAtReply).toBe(dedicated !== "exec");
      }
      if (queue === "base") {
        expectTelegramSend(sendTelegram, { to: "-100155462274", text: "Restart complete" });
        expect(formatted ?? "").not.toContain(generic);
        expect(peekSystemEvents(queueKey)).toEqual(queuedBefore);
      } else {
        expect(formatted).toContain(generic);
        expect(formatted).not.toContain(completion);
        expect(formatted).not.toContain(reminder);
        expect(peekSystemEvents(queueKey)).toEqual(dedicated === "exec" ? [reminder] : []);
      }
      if (dedicated !== "none") {
        expect(context.Body).toContain(completion);
        expect(context.Body).not.toContain(generic);
      }
      expect(readSessionStoreForTest(storePath)[baseKey]?.sessionId).toBe("base-conversation");
    });
  });

  it("delivers an isolated group completion after its base conversation moves to a blocked direct chat", async () => {
    await withRouting(
      async ({ cfg, storePath, replySpy, baseKey, isolatedKey, sendTelegram, run }) => {
        cfg.agents!.defaults!.heartbeat!.directPolicy = "block";
        await writeTelegramSessionStore(storePath, baseKey, {
          sessionId: "moved-direct-conversation",
          lastTo: "user:operator",
          chatType: "direct",
        });
        await seedSessionStore(storePath, isolatedKey, {
          sessionId: "original-group-run",
          heartbeatIsolatedBaseSessionKey: baseKey,
        });
        const completion = "Exec completed (group-report, code 0) :: group report is ready";
        enqueueSystemEvent(completion, {
          sessionKey: isolatedKey,
          deliveryContext: { channel: "telegram", to: "group:ops" },
        });
        replySpy.mockResolvedValue({ text: "Group report ready." });
        const result = await run({ sessionKey: isolatedKey, reason: "exec-event" });
        expect(result.status).toBe("ran");
        expectTelegramSend(sendTelegram, { to: "group:ops", text: "Group report ready." });
        expect(getFirstReplyContext(replySpy)).toMatchObject({
          SessionKey: isolatedKey,
          OriginatingTo: "group:ops",
          ChatType: "group",
        });
        expect(peekSystemEvents(isolatedKey)).toEqual([]);
        expect(readSessionStoreForTest(storePath)[baseKey]?.sessionId).toBe(
          "moved-direct-conversation",
        );
      },
    );
  });

  it.each([
    { name: "metadata-only", output: "", reply: "HEARTBEAT_OK" },
    {
      name: "output-bearing",
      output: "review-worker spawn finished",
      reply: "The review-worker spawn finished successfully.",
    },
  ])("routes $name shared-session exec completion after topic drift", async ({ output, reply }) => {
    await withRouting(async ({ storePath, replySpy, sendTelegram, run }) => {
      const sessionKey = "agent:main:telegram:group:-1003774691294:topic:47";
      await writeTelegramSessionStore(storePath, sessionKey, {
        lastTo: "telegram:-1003774691294:topic:2175",
        lastThreadId: 2175,
      });

      replySpy.mockResolvedValue({ text: reply });
      enqueueSystemEvent(`Exec completed (review-run, code 0)${output ? ` :: ${output}` : ""}`, {
        sessionKey,
        deliveryContext: {
          channel: "telegram",
          to: "telegram:-1003774691294:topic:47",
          threadId: 47,
        },
      });

      const result = await run({ sessionKey, reason: "exec-event" });

      expect(result.status).toBe("ran");
      if (output) {
        expectTelegramSend(sendTelegram, {
          to: "telegram:-1003774691294:topic:47",
          text: reply,
          messageThreadId: 47,
        });
      } else {
        expect(getFirstReplyContext(replySpy).Body).toContain(
          "Exec completed (review-run, code 0) without captured stdout/stderr.",
        );
        expect(sendTelegram).not.toHaveBeenCalled();
      }
    }, false);
  });

  it.each([
    { name: "isolated", isolatedSession: true, trigger: "user", reply: "printed", sends: true },
    { name: "shared", isolatedSession: false, trigger: "user", reply: "printed", sends: true },
    {
      name: "quiet outcome",
      isolatedSession: true,
      trigger: "user",
      reply: "NO_REPLY",
      sends: false,
    },
    {
      name: "report redirected to a file",
      isolatedSession: true,
      trigger: "user",
      reply: "printed",
      sends: true,
      redirected: true,
    },
    {
      name: "heartbeat-started command",
      isolatedSession: false,
      trigger: "heartbeat",
      reply: "printed",
      sends: false,
    },
    {
      name: "global session",
      isolatedSession: true,
      trigger: "user",
      reply: "printed",
      sends: true,
    },
    {
      name: "heartbeat alerts off",
      isolatedSession: true,
      trigger: "user",
      reply: "printed",
      sends: true,
    },
    {
      name: "conversation moved to another topic",
      isolatedSession: true,
      trigger: "user",
      reply: "printed",
      sends: false,
      stored: { lastTo: "telegram:-100155462274:topic:43", lastThreadId: 43 },
    },
    {
      name: "command started on another account",
      isolatedSession: true,
      trigger: "user",
      reply: "printed",
      sends: false,
      stored: { lastAccountId: "default" },
      accountId: "work",
    },
    // A continuation authorizes the model's reply; host-generated notices keep the heartbeat
    // target, isolation and alert toggle that governed them on main (#153573).
    { name: "failed turn", isolatedSession: true, trigger: "user", reply: "failed", sends: false },
    {
      name: "failed turn, heartbeat alerts off",
      isolatedSession: true,
      trigger: "user",
      reply: "failed",
      sends: false,
      target: "last",
    },
    {
      name: "failed turn, isolated owner target without an owner",
      isolatedSession: true,
      trigger: "user",
      reply: "failed",
      sends: false,
      target: "owner",
    },
    {
      name: "failed turn, visible heartbeat",
      isolatedSession: true,
      trigger: "user",
      reply: "failed",
      sends: true,
      target: "last",
    },
    {
      name: "failed tool, no final text",
      isolatedSession: true,
      trigger: "user",
      reply: "tool warning",
      sends: false,
    },
    {
      name: "failed tool, no final text, visible heartbeat",
      isolatedSession: true,
      trigger: "user",
      reply: "tool warning",
      sends: true,
      target: "last",
    },
    {
      name: "answer with a trailing status notice",
      isolatedSession: true,
      trigger: "user",
      reply: "printed with status",
      sends: true,
    },
    {
      name: "answer cut off by the output limit",
      isolatedSession: true,
      trigger: "user",
      reply: "truncated",
      sends: true,
    },
  ])(
    "answers a forum topic's own background command under quiet heartbeats ($name)",
    async ({
      name,
      isolatedSession,
      trigger,
      reply,
      sends,
      stored,
      accountId,
      target,
      redirected,
    }) => {
      await withRouting(
        async ({ cfg, storePath, replySpy, sendTelegram }) => {
          const sessionKey =
            name === "global session"
              ? "global"
              : "agent:main:telegram:group:-100155462274:topic:42";
          if (name === "global session") {
            cfg.session = { ...cfg.session, scope: "global" };
          }
          const topic = "telegram:-100155462274:topic:42";
          await writeTelegramSessionStore(storePath, sessionKey, {
            sessionId: "topic-conversation",
            lastTo: topic,
            lastThreadId: 42,
            chatType: "group",
            ...stored,
          });
          cfg.channels!.telegram = {
            allowFrom: ["*"],
            heartbeatVisibility: name.endsWith("heartbeat alerts off")
              ? { showOk: false, showAlerts: false, useIndicator: false }
              : { showOk: true },
          };
          const toolError = { toolName: "exec", error: "Command exited with code 1" };
          if (reply === "failed") {
            replySpy.mockImplementation(async (_ctx, options) => {
              setHeartbeatAgentTurnStatus(options, "failed");
              return { text: GENERIC_EXTERNAL_RUN_FAILURE_TEXT, isError: true };
            });
          } else if (reply === "tool warning") {
            // The real payload builder, as the embedded runner calls it for this turn.
            replySpy.mockImplementation(async (_ctx, options) =>
              buildPayloads({
                isHeartbeatTrigger: options?.isHeartbeat === true && !options.continuesConversation,
                lastToolError: toolError,
              }),
            );
          } else if (reply === "printed with status") {
            // Reply completion appends verbose plugin diagnostics after the answer.
            replySpy.mockResolvedValue([
              { text: "The job printed RESULT-7F3A." },
              { text: "🧩 Active Memory: status=policy-disabled", isStatusNotice: true },
            ]);
          } else if (reply === "truncated") {
            // Real terminal resolution of a length stop: the partial answer, then the host's label.
            const assistant = buildEmbeddedRunnerAssistant({
              stopReason: "length",
              content: [{ type: "text", text: "The job printed RESULT-7F3A." }],
            });
            const resolved = await resolveEmbeddedRunTerminal(
              makeTerminalInput({
                attempt: makeEmbeddedRunnerAttempt({
                  assistantTexts: ["The job printed RESULT-7F3A."],
                  lastAssistant: assistant,
                  currentAttemptAssistant: assistant,
                  currentAttemptReplayMetadata: {
                    hadPotentialSideEffects: false,
                    replaySafe: true,
                  },
                }),
                attemptAssistant: assistant,
                payloadsWithToolMedia: [{ text: "The job printed RESULT-7F3A." }],
              }),
            );
            expect(resolved.action).toBe("complete");
            replySpy.mockResolvedValue(
              resolved.action === "complete" ? resolved.result.payloads : undefined,
            );
          } else {
            replySpy.mockResolvedValue({
              text: reply === "printed" ? "The job printed RESULT-7F3A." : reply,
            });
          }
          const completionRun = createDeferred<Awaited<ReturnType<typeof runHeartbeatOnce>>>();
          const runner = startHeartbeatRunner({
            cfg,
            runOnce: (opts) => {
              const run = runHeartbeatOnce({
                ...opts,
                cfg,
                deps: { getReplyFromConfig: replySpy, telegram: sendTelegram },
              });
              completionRun.resolve(run);
              return run;
            },
          });
          onTestFinished(() => {
            runner.stop();
            resetProcessRegistryForTests();
          });
          const exec = createExecTool({
            host: "gateway",
            security: "full",
            ask: "off",
            allowBackground: true,
            timeoutSec: 10,
            agentId: "main",
            trigger,
            sessionKey,
            messageProvider: "telegram",
            currentChannelId: topic,
            currentThreadTs: "42",
            accountId,
          });
          // Empty successes still wake Telegram turns: the model may continue its own work
          // (here, read the file it redirected to), and its NO_REPLY must stay silent.
          const captured = reply !== "NO_REPLY" && !redirected;
          const command = captured
            ? "echo RESULT-7F3A"
            : redirected
              ? "echo RESULT-7F3A > /dev/null"
              : "true";
          await exec.execute("call-background", { command, background: true });
          await expect(completionRun.promise).resolves.toMatchObject({
            status: reply === "failed" ? "failed" : "ran",
          });

          const ctx = getFirstReplyContext(replySpy);
          const options = mockCallAt(replySpy, 0, "completion turn")[1] as InternalGetReplyOptions;
          if (trigger !== "user" || stored) {
            // Heartbeat-owned work, or a route that is no longer this session's conversation,
            // keeps the heartbeat's own silent delivery.
            expect(ctx.Body).not.toContain("RESULT-7F3A");
            expect(sendTelegram).not.toHaveBeenCalled();
            return;
          }
          expect(ctx).toMatchObject({ SessionKey: sessionKey, InternalTurnSource: "exec" });
          expect(ctx.Body?.includes("RESULT-7F3A")).toBe(captured);
          if (!captured) {
            expect(ctx.Body).toMatch(/Exec completed \(\S+, code 0\) without captured stdout/);
            expect(ctx.Body).toContain("continue any outstanding authorized work");
          }
          expect(options.bootstrapContextMode).toBeUndefined();
          const sent =
            reply === "failed"
              ? GENERIC_EXTERNAL_RUN_FAILURE_TEXT
              : reply === "tool warning"
                ? buildPayloads({ lastToolError: toolError })[0]?.text
                : "The job printed RESULT-7F3A.";
          expect(sendTelegram.mock.calls.map((call) => call.slice(0, 2))).toEqual(
            sends ? [[topic, sent]] : [],
          );
          if (reply !== "failed") {
            expect(peekSystemEvents(resolveSystemEventQueueKey(sessionKey, "main"))).toEqual([]);
          }
        },
        isolatedSession,
        {
          target: target ?? "none",
          lightContext: true,
          activeHours: { start: "00:00", end: "00:01", timezone: "UTC" },
        },
      );
    },
  );

  it("answers a background command started by the topic's own completion turn", async () => {
    await withRouting(
      async ({ cfg, storePath, replySpy, sendTelegram }) => {
        const sessionKey = "agent:main:telegram:group:-100155462274:topic:42";
        const topic = "telegram:-100155462274:topic:42";
        await writeTelegramSessionStore(storePath, sessionKey, {
          sessionId: "topic-conversation",
          lastTo: topic,
          lastThreadId: 42,
          chatType: "group",
        });
        cfg.channels!.telegram = { allowFrom: ["*"] };
        const runs: HeartbeatRunOptions[] = [];
        const firstRun = createDeferred<HeartbeatRunResult>();
        const runner = startHeartbeatRunner({
          cfg,
          runOnce: (opts) => {
            runs.push(opts);
            const run = runHeartbeatOnce({
              ...opts,
              cfg,
              deps: { getReplyFromConfig: replySpy, telegram: sendTelegram },
            });
            firstRun.resolve(run);
            return run;
          },
        });
        onTestFinished(() => {
          runner.stop();
          resetProcessRegistryForTests();
        });
        const execFor = (defaults: { trigger: string; continuesConversation?: boolean }) =>
          createExecTool({
            host: "gateway",
            security: "full",
            ask: "off",
            allowBackground: true,
            timeoutSec: 10,
            agentId: "main",
            sessionKey,
            messageProvider: "telegram",
            currentChannelId: topic,
            currentThreadTs: "42",
            ...defaults,
          });
        replySpy.mockImplementationOnce(async (_ctx, options) => {
          // The completion turn runs as a heartbeat and starts the next command.
          await execFor({
            trigger: "heartbeat",
            continuesConversation: options?.continuesConversation,
          }).execute("call-second", { command: "echo RESULT-2B4C", background: true });
          return { text: "First printed RESULT-7F3A; started the next one." };
        });
        replySpy.mockResolvedValue({ text: "Second printed RESULT-2B4C." });

        await execFor({ trigger: "user" }).execute("call-first", {
          command: "echo RESULT-7F3A",
          background: true,
        });
        await expect(firstRun.promise).resolves.toMatchObject({ status: "ran" });
        await vi.waitFor(() => expect(peekSystemEvents(sessionKey)).toHaveLength(1));
        // The scheduler spaces event turns by 30s; run the retried wake directly.
        await expect(
          runHeartbeatOnce({
            ...runs[0],
            cfg,
            deps: { getReplyFromConfig: replySpy, telegram: sendTelegram },
          }),
        ).resolves.toMatchObject({ status: "ran" });

        expect(replySpy.mock.calls[1]?.[0].Body).toContain("RESULT-2B4C");
        expect(sendTelegram.mock.calls.map((call) => call.slice(0, 2))).toEqual([
          [topic, "First printed RESULT-7F3A; started the next one."],
          [topic, "Second printed RESULT-2B4C."],
        ]);
      },
      true,
      { target: "none", lightContext: true },
    );
  });
});
