import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { getReplySystemEventContext } from "../auto-reply/reply/system-event-session-key.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { loadExactSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
import { resetCronActiveJobs } from "../cron/active-jobs.js";
import { racePromiseWithAbortSignal } from "./abort-signal.js";
import {
  createLastTargetConfig,
  formatQueuedEvents,
  type HeartbeatRoutingFixture,
  withRouting,
} from "./heartbeat-runner.event-routing.test-support.js";
import { runHeartbeatOnce, startHeartbeatRunner } from "./heartbeat-runner.js";
import {
  getFirstReplyContext,
  mockCallAt,
  readSessionStoreForTest,
  seedSessionStore,
  setupTelegramHeartbeatPluginRuntimeForTests,
  withTempHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";
import { requestHeartbeatAndWait, setHeartbeatWakeHandler } from "./heartbeat-wake.js";
import { enqueueSystemEvent, peekSystemEvents, resetSystemEventsForTest } from "./system-events.js";

const topicRoute = (threadId: number, accountId?: string) => ({
  channel: "telegram",
  to: `telegram:-1003774691294:topic:${threadId}`,
  threadId,
  ...(accountId ? { accountId } : {}),
});
const sharedSessionKey = "agent:main:telegram:group:-1003774691294";
const topicSessionKey = `${sharedSessionKey}:topic:47`;
type EventRoute = Parameters<typeof enqueueSystemEvent>[1]["deliveryContext"];
const queueEvent = (
  sessionKey: string,
  text: string,
  contextKey?: string,
  deliveryContext?: EventRoute,
) => enqueueSystemEvent(text, { sessionKey, contextKey, deliveryContext });
const execWake = (sessionKey: string, agentId = "main") =>
  requestHeartbeatAndWait({
    source: "exec-event",
    intent: "event",
    reason: "exec-event",
    agentId,
    sessionKey,
    coalesceMs: 0,
  });
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

const seedDriftedSession = (storePath: string, sessionKey: string) =>
  writeTelegramSessionStore(storePath, sessionKey, {
    lastTo: topicRoute(2175).to,
    lastAccountId: "personal",
    lastThreadId: 2175,
  });

const seedIsolated = (storePath: string, key: string, baseKey: string, sessionId: string) =>
  seedSessionStore(storePath, key, { sessionId, heartbeatIsolatedBaseSessionKey: baseKey });
const withSharedRouting = (
  scenario: (fixture: HeartbeatRoutingFixture & { sessionKey: string }) => Promise<void>,
  sessionKey = sharedSessionKey,
) =>
  withRouting(async (fixture) => {
    await seedDriftedSession(fixture.storePath, sessionKey);
    await scenario({ ...fixture, sessionKey });
  }, false);
const queueExec = (sessionKey: string, name: string, route: EventRoute, output = "ready") =>
  queueEvent(
    sessionKey,
    `Exec completed (${name}, code 0)${output ? ` :: ${output}` : ""}`,
    "exec:fixture-source",
    route,
  );
type RunnerOptions = Parameters<typeof startHeartbeatRunner>[0];
async function withFollowup(
  cfg: RunnerOptions["cfg"],
  run: NonNullable<RunnerOptions["runOnce"]>,
  scenario: (followup: Promise<Awaited<ReturnType<typeof runHeartbeatOnce>>>) => Promise<void>,
  select: (opts: Parameters<typeof run>[0], count: number) => boolean = (_, count) => count === 2,
) {
  const followup = createDeferred<Awaited<ReturnType<typeof runHeartbeatOnce>>>();
  let count = 0;
  const runner = startHeartbeatRunner({
    cfg,
    runOnce: (opts) => {
      const result = run(opts);
      if (select(opts, ++count)) {
        followup.resolve(result);
      }
      return result;
    },
  });
  try {
    await scenario(followup.promise);
  } finally {
    runner.stop();
  }
}

const expectTelegramSend = (
  sendTelegram: ReturnType<typeof vi.fn>,
  to: string,
  text: string,
  messageThreadId?: number,
  accountId?: string,
) => {
  expect(sendTelegram).toHaveBeenCalledTimes(1);
  const [sentTo, sentText, options] = mockCallAt(sendTelegram, 0, "Telegram send");
  const telegramOptions = options as { messageThreadId?: number; accountId?: string } | undefined;
  expect([sentTo, sentText, telegramOptions?.messageThreadId]).toEqual([to, text, messageThreadId]);
  if (accountId !== undefined) {
    expect(telegramOptions?.accountId).toBe(accountId);
  }
};

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
  { name: "base route", eventThreadId: undefined, baseThreadId: 42, legacy: false },
  { name: "same-queue event", eventThreadId: 42, baseThreadId: 42, legacy: false },
  { name: "legacy moved base route", eventThreadId: 42, baseThreadId: 88, legacy: true },
])("delivers isolated exec completion using its $name", ({ eventThreadId, baseThreadId, legacy }) =>
  withRouting(async ({ storePath, replySpy, baseKey, isolatedKey, sendTelegram, run }) => {
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
    await seedIsolated(storePath, queueKey, baseKey, "previous-isolated-run");
    queueExec(
      queueKey,
      "background-report",
      eventThreadId === undefined
        ? undefined
        : { channel: "telegram", to: target(eventThreadId), threadId: eventThreadId },
      "report is ready",
    );
    replySpy.mockResolvedValue({ text: "The report is ready." });

    expect((await run({ sessionKey: queueKey, reason: "exec-event" })).status).toBe("ran");
    expectTelegramSend(sendTelegram, target(42), "The report is ready.", 42);
    expect(getFirstReplyContext(replySpy)).toMatchObject({
      SessionKey: isolatedKey,
      InternalTurnSource: "exec",
      InputProvenance: { kind: "internal_system", sourceTool: "exec" },
      MessageThreadId: 42,
      OriginatingChannel: "telegram",
      OriginatingTo: target(42),
      ChatType: "group",
    });
    const conversation = replySpy.mock.calls[0]?.[1]?.replyConversation;
    expect(conversation).toMatchObject({
      fields: { Provider: "telegram", Surface: "telegram", ChatType: "group" },
    });
    expect([conversation?.fields.GroupSubject, conversation?.activation]).toEqual(
      baseThreadId === 42 ? ["Operations", "always"] : [undefined, undefined],
    );
    expect([peekSystemEvents(isolatedKey), peekSystemEvents(queueKey)]).toEqual([[], []]);
    const rows = readSessionStoreForTest(storePath);
    if (legacy) {
      expect(rows[queueKey]).toBeUndefined();
    }
    expect(rows[baseKey]?.sessionId).toBe("base-conversation");
    const isolated = rows[isolatedKey];
    expect([isolated?.heartbeatIsolatedBaseSessionKey, isolated?.groupActivation]).toEqual([
      baseKey,
      undefined,
    ]);
    expect(isolated?.sessionId).not.toBe("previous-isolated-run");
  }),
);

it("keeps the legacy base binding through its cron follow-up", ({ signal }) =>
  withTempHeartbeatSandbox(async ({ tmpDir, replySpy }) => {
    const baseKey = "agent:ops:alerts:heartbeat";
    const isolatedKey = `${baseKey}:heartbeat`;
    const queueKey = `${isolatedKey}:heartbeat`;
    const storeTemplate = `${tmpDir}/agents/{agentId}/sessions/sessions.json`;
    const storePath = resolveSessionStorePathCore(storeTemplate, { agentId: "ops" });
    const cfg = createLastTargetConfig({
      tmpDir,
      storePath: storeTemplate,
      isolatedSession: true,
      heartbeat: { every: "0m", session: "alerts:heartbeat" },
    });
    cfg.agents!.entries = { ops: {} };
    await writeTelegramSessionStore(storePath, baseKey, { sessionId: "base-conversation" });
    await seedIsolated(storePath, queueKey, baseKey, "old-isolated");
    const readEntry = (sessionKey: string) =>
      loadExactSessionEntryReadOnly({ storePath, agentId: "ops", sessionKey })?.entry;
    const route = (threadId: number) => ({
      channel: "telegram",
      to: "-100155462274",
      threadId,
    });
    queueExec(queueKey, "legacy", route(47));
    queueEvent(queueKey, "Reminder: Legacy queue work", "cron:legacy", route(99));
    queueEvent(baseKey, "Unrelated base event");
    const sendTelegram = vi.fn().mockResolvedValue({ messageId: "delivered" });
    let bindingAtExec: string | undefined;
    replySpy.mockImplementation(async (ctx) => {
      if (ctx.InternalTurnSource === "exec") {
        bindingAtExec = readEntry(queueKey)?.heartbeatIsolatedBaseSessionKey;
      }
      return {
        text: ctx.InternalTurnSource === "exec" ? "Command completed" : "Reminder handled",
      };
    });
    await withFollowup(
      cfg,
      (opts) =>
        runHeartbeatOnce({
          ...opts,
          cfg,
          deps: { getReplyFromConfig: replySpy, telegram: sendTelegram },
        }),
      async (followup) => {
        await execWake(queueKey, "ops");
        expect(bindingAtExec).toBe(baseKey);
        // The exec wake settles before its separately scheduled route follow-up.
        await expect(racePromiseWithAbortSignal(followup, signal)).resolves.toMatchObject({
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
      },
      (opts) => opts.source !== "exec-event",
    );
  }));

it.each([
  { name: "legacy isolated", queue: "legacy", dedicated: "none", busy: false },
  { name: "shared", queue: "shared", dedicated: "none", busy: false },
  { name: "excluded base", queue: "base", dedicated: "none", busy: false },
  { name: "excluded base exec same-route", queue: "base", dedicated: "exec", busy: false },
  { name: "legacy exec and cron", queue: "legacy", dedicated: "exec", busy: false },
  { name: "busy legacy", queue: "legacy", dedicated: "none", busy: true },
])("preserves generic wake queue ownership for $name", ({ queue, dedicated, busy }) =>
  withRouting(async ({ cfg, storePath, replySpy, baseKey, isolatedKey, sendTelegram, run }) => {
    const queueKey = queue === "legacy" ? `${isolatedKey}:heartbeat` : baseKey;
    await writeTelegramSessionStore(storePath, baseKey, { sessionId: "base-conversation" });
    if (queueKey !== baseKey) {
      await seedIsolated(storePath, queueKey, baseKey, "previous-isolated-run");
    }
    const generic = "Gateway restart ok: queued notification";
    const completion = "Exec completed (queue-report, code 0) :: report is ready";
    const reminder = "Reminder: review the scheduled report";
    const route =
      queue === "base" ? { channel: "telegram", to: "-100999999999", threadId: 42 } : undefined;
    if (dedicated === "exec") {
      queueEvent(queueKey, completion, "exec:fixture-source", route);
      queueEvent(queueKey, reminder, "cron:queue-report");
    }
    queueEvent(queueKey, generic, undefined, route);
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

    const result = await run({
      sessionKey: queueKey,
      source: "hook",
      intent: "immediate",
      reason: "hook:wake",
      deps: { getQueueSize: () => (busy ? 1 : 0) },
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
    expect(context).toMatchObject({
      SessionKey: queue === "shared" ? baseKey : isolatedKey,
      InternalTurnSource: dedicated === "none" ? "heartbeat" : dedicated,
    });
    expect(context.InputProvenance).toEqual({
      kind: "internal_system",
      sourceTool: dedicated === "none" ? "hook" : dedicated,
    });
    if (queue === "legacy") {
      expect(legacyRowRemovedAtReply).toBe(dedicated !== "exec");
    }
    if (queue === "base") {
      expectTelegramSend(
        sendTelegram,
        dedicated === "exec" ? "-100999999999" : "-100155462274",
        "Restart complete",
        dedicated === "exec" ? 42 : undefined,
      );
      expect(formatted ?? "").not.toContain(generic);
      expect(peekSystemEvents(queueKey)).toEqual(
        dedicated === "exec" ? [reminder, generic] : queuedBefore,
      );
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
  }, queue !== "shared"),
);

it("delivers isolated group completion after the base moves to a blocked DM", () =>
  withRouting(async ({ cfg, storePath, replySpy, baseKey, isolatedKey, sendTelegram, run }) => {
    cfg.agents!.defaults!.heartbeat!.directPolicy = "block";
    await writeTelegramSessionStore(storePath, baseKey, {
      sessionId: "moved-direct-conversation",
      lastTo: "user:operator",
      chatType: "direct",
    });
    await seedIsolated(storePath, isolatedKey, baseKey, "original-group-run");
    queueExec(isolatedKey, "group", { channel: "telegram", to: "group:ops" });
    replySpy.mockResolvedValue({ text: "Group report ready." });
    expect((await run({ sessionKey: isolatedKey, reason: "exec-event" })).status).toBe("ran");
    expectTelegramSend(sendTelegram, "group:ops", "Group report ready.");
    expect(getFirstReplyContext(replySpy)).toMatchObject({
      SessionKey: isolatedKey,
      OriginatingTo: "group:ops",
      ChatType: "group",
    });
    expect(peekSystemEvents(isolatedKey)).toEqual([]);
    expect(readSessionStoreForTest(storePath)[baseKey]?.sessionId).toBe(
      "moved-direct-conversation",
    );
  }));

it("keeps the exec route when a cron wake sees both queued payloads", () =>
  withRouting(async ({ storePath, replySpy, sendTelegram, run }) => {
    const sessionKey = topicSessionKey;
    await writeTelegramSessionStore(storePath, sessionKey, {
      lastTo: topicRoute(99).to,
      lastThreadId: 99,
    });
    queueExec(sessionKey, "mixed-run", topicRoute(47));
    queueEvent(sessionKey, "Reminder: mixed cron follow-up", "cron:mixed-run", topicRoute(99));
    replySpy.mockResolvedValue({ text: "Command completed." });

    const result = await run({
      sessionKey,
      source: "cron",
      intent: "immediate",
      reason: "cron:mixed-run",
    });
    expect(result.status).toBe("ran");
    expect(getFirstReplyContext(replySpy).InternalTurnSource).toBe("exec");
    expectTelegramSend(sendTelegram, topicRoute(47).to, "Command completed.", 47);
    expect(peekSystemEvents(sessionKey)).toEqual(["Reminder: mixed cron follow-up"]);
  }, false));

it.each([
  { name: "metadata-only", output: "", reply: "HEARTBEAT_OK" },
  { name: "output-bearing", output: "ready", reply: "Done." },
])("routes $name exec completion after topic drift", ({ output, reply }) =>
  withSharedRouting(async ({ sessionKey, replySpy, sendTelegram, run }) => {
    let projectedSystemEvents: string[] = [];
    replySpy.mockImplementation(async (_ctx, options) => {
      projectedSystemEvents =
        getReplySystemEventContext(options)?.events?.map((event) => event.text) ?? [];
      return { text: reply };
    });
    queueExec(sessionKey, "review-run", topicRoute(47, "work"), output);
    queueEvent(sessionKey, "Node connected", undefined, {
      channel: "telegram",
      to: "123456789",
      accountId: "personal",
    });

    expect((await run({ sessionKey, reason: "exec-event" })).status).toBe("ran");
    if (output) {
      expectTelegramSend(sendTelegram, topicRoute(47).to, reply, 47, "work");
    } else {
      expect(getFirstReplyContext(replySpy).Body).toContain(
        "Exec completed (review-run, code 0) without captured stdout/stderr.",
      );
      expect(sendTelegram).not.toHaveBeenCalled();
    }
    expect(projectedSystemEvents).not.toContain("Node connected");
    expect(peekSystemEvents(sessionKey)).toEqual(["Node connected"]);
  }, topicSessionKey),
);

it("automatically drains queued exec completions on their own routes", ({ signal }) =>
  withSharedRouting(async ({ cfg, sessionKey, replySpy, sendTelegram, run }) => {
    const enqueueCompletion = (name: string, accountId: string, threadId: number) =>
      queueExec(sessionKey, name, topicRoute(threadId, accountId), `${name} is ready`);
    enqueueCompletion("work-report", "work", 47);
    enqueueCompletion("personal-report", "personal", 99);
    replySpy.mockResolvedValue({ text: "Done." });

    await withFollowup(cfg, run, async (followup) => {
      await execWake(sessionKey);
      await expect(racePromiseWithAbortSignal(followup, signal)).resolves.toMatchObject({
        status: "ran",
      });
      expect(replySpy).toHaveBeenCalledTimes(2);
      expect(replySpy.mock.calls[0]?.[0].Body).toContain("work-report is ready");
      expect(replySpy.mock.calls[0]?.[0].Body).not.toContain("personal-report is ready");
      expect(replySpy.mock.calls[1]?.[0].Body).toContain("personal-report is ready");
      expect(sendTelegram).toHaveBeenCalledTimes(2);
      expect(sendTelegram.mock.calls).toMatchObject([
        [topicRoute(47).to, "Done.", { messageThreadId: 47, accountId: "work" }],
        [topicRoute(99).to, "Done.", { messageThreadId: 99, accountId: "personal" }],
      ]);
      expect(peekSystemEvents(sessionKey)).toEqual([]);
    });
  }));

it("does not let a deferred exec route retarget scheduled work", () =>
  withSharedRouting(async ({ sessionKey, replySpy, sendTelegram, run }) => {
    queueExec(sessionKey, "work-report", topicRoute(47, "work"), "report is ready");
    replySpy.mockResolvedValue({ text: "Scheduled result" });

    const result = await run({
      sessionKey,
      source: "cron",
      intent: "task",
      reason: "cron:job",
      tasks: [{ jobId: "job", name: "Maintenance", prompt: "Run maintenance" }],
    });
    expect(result.status).toBe("ran");
    expectTelegramSend(
      sendTelegram,
      topicRoute(2175).to,
      "Scheduled result",
      undefined,
      "personal",
    );
    expect(peekSystemEvents(sessionKey)).toEqual([
      "Exec completed (work-report, code 0) :: report is ready",
    ]);
  }));
