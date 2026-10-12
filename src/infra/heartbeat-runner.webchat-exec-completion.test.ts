import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { appendExecTimeoutRetryGuidance } from "../agents/bash-tools.exec-output.js";
import { resolveExecNotificationDefaults } from "../agents/bash-tools.exec-request-preparation.js";
import { createHeartbeatToolResponsePayload } from "../auto-reply/heartbeat-tool-response.js";
import { setReplyPayloadMetadata } from "../auto-reply/reply-payload.js";
import { finalizeInboundContext } from "../auto-reply/reply/inbound-context.js";
import { drainFormattedSystemEvents } from "../auto-reply/reply/session-system-events.js";
import { initSessionState } from "../auto-reply/reply/session.js";
import { getReplySystemEventContext } from "../auto-reply/reply/system-event-session-key.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import { resolveInternalSessionEffectsIdentity } from "../config/sessions/internal-session-key.js";
import {
  loadTranscriptEvents,
  persistSessionTranscriptTurn,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { readTranscriptEventMessage } from "../config/sessions/session-accessor.sqlite-read.js";
import { withOwnedSessionTranscriptWrites } from "../config/sessions/transcript-write-context.js";
import { onSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import {
  cancelExecRequestOwners,
  captureExecRequestOwners,
  withExecRequestOwners,
  withExecRequestTurn,
} from "./exec-request-context.js";
import { getLastHeartbeatEvent, resetHeartbeatEventsForTest } from "./heartbeat-events.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import type { HeartbeatDeps } from "./heartbeat-runner.js";
import {
  readSessionStoreForTest,
  seedSessionStore,
  setupTelegramHeartbeatPluginRuntimeForTests,
  withTempHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";
import * as sessionPublication from "./heartbeat-session-publication.js";
import * as heartbeatTargets from "./outbound/targets.js";
import {
  enqueueSystemEvent,
  enqueueSystemEventEntry,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "./system-events.js";

it("suppresses a routeless cron reminder on a WebChat session", async () => {
  await withProjectionScenario(async (scenario) => {
    scenario.cfg.messages = undefined;
    enqueueSystemEvent("Reminder: Check the overnight report", {
      sessionKey: scenario.sessionKey,
      contextKey: "cron:overnight-report",
    });
    const reply = vi
      .fn<NonNullable<HeartbeatDeps["getReplyFromConfig"]>>()
      .mockResolvedValue({ text: "Reminder handled" });
    await runProjectionWake(scenario, reply, "cron");
    expect(reply).toHaveBeenCalledOnce();
    expect(reply.mock.calls[0]?.[0].Body).not.toContain("Please relay this reminder to the user");
    expect(await readProjectionMessages(scenario)).toEqual([]);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  resetSystemEventsForTest();
  resetHeartbeatEventsForTest();
});

type ProjectionScenario = {
  cfg: OpenClawConfig;
  storePath: string;
  sessionKey: string;
  sessionId: string;
};

// Exercise the real dispatcher and SQLite owners; inject only model output.
async function withProjectionScenario(
  run: (scenario: ProjectionScenario) => Promise<void>,
  options: { sessionKey?: string; entry?: Parameters<typeof seedSessionStore>[2] } = {},
) {
  await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
    const cfg: OpenClawConfig = {
      agents: { defaults: { workspace: tmpDir, heartbeat: { every: "5m", target: "last" } } },
      messages: { visibleReplies: "message_tool" },
      session: { store: storePath },
    };
    const sessionKey = options.sessionKey ?? resolveMainSessionKey(cfg);
    const sessionId = "publication-boundary-session";
    await seedSessionStore(storePath, sessionKey, {
      lastChannel: "webchat",
      lastProvider: "",
      lastTo: "",
      sessionId,
      lifecycleRevision: "publication-boundary-generation",
      createdVia: "operator",
      ...options.entry,
    });
    await run({ cfg, storePath, sessionKey, sessionId });
  });
}

function completionPayload(notificationText: string) {
  return createHeartbeatToolResponsePayload({
    outcome: "done",
    notify: true,
    summary: "private",
    notificationText,
  });
}

// The explicit target keeps hidden and replacement scenarios on their own queue.
function runProjectionWake(
  scenario: ProjectionScenario,
  getReplyFromConfig: HeartbeatDeps["getReplyFromConfig"],
  wake: "exec-event" | "manual" | "cron" = "exec-event",
) {
  return runHeartbeatOnce({
    cfg: scenario.cfg,
    agentId: "main",
    sessionKey: scenario.sessionKey,
    source: wake,
    intent: wake === "manual" ? "immediate" : "event",
    reason: wake === "manual" ? "wake" : wake,
    deps: { getReplyFromConfig },
  });
}

// Read committed assistant output, not payload metadata or a reported send status.
async function readProjectionMessages(scenario: ProjectionScenario) {
  const events = await loadTranscriptEvents({ agentId: "main", ...scenario });
  return events.map(readTranscriptEventMessage).filter((message) => message?.role === "assistant");
}

it.for(["route preparation", "model reply"] as const)(
  "retires a stopped exec owner during %s without consuming its live coalesced peer",
  async (stage, test) => {
    await withProjectionScenario(async (scenario) => {
      const captureOwner = (runId: string) => {
        const identity = {
          runId,
          sessionKey: scenario.sessionKey,
          sessionId: scenario.sessionId,
        };
        return withExecRequestTurn({ identity }, async () => {
          const owner = captureExecRequestOwners(identity)?.[0];
          if (!owner) {
            throw new Error("Expected the completion's original exec owner");
          }
          return owner;
        });
      };
      const stoppedOwner = await captureOwner("stopped-request");
      const liveOwner = await captureOwner("live-request");
      const canceledText = "Exec completed (stopped-command, code 0) :: CANCELED_COMPLETION";
      const liveText = "Exec completed (live-command, code 0) :: LIVE_COMPLETION";
      const enqueue = (text: string, owner: typeof liveOwner) =>
        enqueueSystemEventEntry(
          text,
          withExecRequestOwners({ sessionKey: scenario.sessionKey }, [owner]),
        );
      const canceled = enqueue(canceledText, stoppedOwner);
      const live = enqueue(liveText, liveOwner);
      expect(canceled?.id).toEqual(expect.any(String));
      expect(live?.id).toEqual(expect.any(String));
      const entered = createDeferred();
      const release = createDeferred();
      const reply = vi
        .fn<NonNullable<HeartbeatDeps["getReplyFromConfig"]>>()
        .mockResolvedValue(completionPayload("LIVE_COMPLETION"));
      if (stage === "route preparation") {
        const resolve = heartbeatTargets.resolveHeartbeatDeliveryTargetWithSessionRoute;
        vi.spyOn(
          heartbeatTargets,
          "resolveHeartbeatDeliveryTargetWithSessionRoute",
        ).mockImplementationOnce(async (params) => {
          const target = await resolve(params);
          // Preflight has captured both real occurrences before this awaited route returns.
          entered.resolve();
          await release.promise;
          return target;
        });
      } else {
        reply.mockImplementationOnce(async (ctx) => {
          expect(ctx.Body).toContain(canceledText);
          expect(ctx.Body).toContain(liveText);
          entered.resolve();
          await release.promise;
          // Even a provider that completes after cancellation cannot publish this stale batch.
          return completionPayload("CANCELED_BATCH_REPLY");
        });
      }
      const published: unknown[] = [];
      const unsubscribe = onSessionTranscriptUpdate((update) => {
        if (update.sessionKey === scenario.sessionKey && update.message !== undefined) {
          published.push(update.message);
        }
      });
      const pending = runProjectionWake(scenario, reply);
      try {
        await withinTest(
          awaitGateBeforeSettlement(entered.promise, pending, "wake settled before the race gate"),
          test.signal,
        );
        cancelExecRequestOwners([stoppedOwner]);
        release.resolve();
        expect(await pending).toEqual({ status: "skipped", reason: "preempted" });
        expect(reply).toHaveBeenCalledTimes(stage === "route preparation" ? 0 : 1);
        if (stage === "model reply") {
          expect(reply.mock.calls[0]?.[1]?.abortSignal?.aborted).toBe(true);
        }
        expect(liveOwner.signal.aborted).toBe(false);
        expect(await readProjectionMessages(scenario)).toEqual([]);
        expect(published).toEqual([]);
        expect(peekSystemEventEntries(scenario.sessionKey).map((event) => event.id)).toEqual([
          live?.id,
        ]);
        expect(enqueue(canceledText, stoppedOwner)).toBeNull();

        expect((await runProjectionWake(scenario, reply)).status).toBe("ran");
        const next = reply.mock.calls.at(-1)?.[0];
        expect(next?.Body).toContain(liveText);
        expect(next?.Body).not.toContain(canceledText);
        expect(peekSystemEventEntries(scenario.sessionKey)).toEqual([]);
        const messages = await readProjectionMessages(scenario);
        expect(messages.map((message) => message?.content)).toEqual([
          [{ type: "text", text: "LIVE_COMPLETION" }],
        ]);
        expect(published).toHaveLength(1);
        const calls = reply.mock.calls.length;
        expect(await runProjectionWake(scenario, reply)).toEqual({
          status: "skipped",
          reason: "no-pending-event",
        });
        expect(reply).toHaveBeenCalledTimes(calls);
        expect(await readProjectionMessages(scenario)).toEqual(messages);
      } finally {
        release.resolve();
        try {
          await pending;
        } finally {
          unsubscribe();
        }
      }
    });
  },
);

it.each(["automatic", "message_tool"] as const)(
  "settles an unneeded completion silently in %s mode",
  async (visibleReplies) => {
    await withProjectionScenario(async (scenario) => {
      scenario.cfg.messages = { visibleReplies };
      enqueueSystemEvent("Exec completed (already-handled, code 0) :: Previously reported output", {
        sessionKey: scenario.sessionKey,
      });
      const reply = vi.fn<NonNullable<HeartbeatDeps["getReplyFromConfig"]>>().mockResolvedValue(
        visibleReplies === "automatic"
          ? { text: "NO_REPLY" }
          : createHeartbeatToolResponsePayload({
              outcome: "done",
              notify: false,
              summary: "Result already handled; no new user-facing information.",
            }),
      );

      // The runner must offer silence and retire the event without publishing a recap.
      expect((await runProjectionWake(scenario, reply)).status).toBe("ran");
      const prompt = reply.mock.calls[0]?.[0].Body;
      expect(prompt).toContain("duplicate or superseded results");
      expect(prompt).toContain(
        visibleReplies === "automatic" ? "reply NO_REPLY only" : "notify=false",
      );
      expect(await readProjectionMessages(scenario)).toEqual([]);
      expect(peekSystemEventEntries(scenario.sessionKey)).toEqual([]);
      expect(getLastHeartbeatEvent()?.silent).toBe(true);

      expect((await runProjectionWake(scenario, reply)).status).toBe("skipped");
      expect(reply).toHaveBeenCalledOnce();
      expect(await readProjectionMessages(scenario)).toEqual([]);
    });
  },
);

type VisibleCompletionCase = NonNullable<Parameters<typeof withProjectionScenario>[1]> & {
  target?: string;
  timeout?: boolean;
};
const visibleCompletions: Array<[string, boolean, VisibleCompletionCase]> = [
  ["explicit target:none", false, { target: "none" }],
  ["unresolved explicit target", false, { target: "pagerduty" }],
  [
    "unopened spawned dashboard",
    true,
    {
      sessionKey: "agent:main:dashboard:spawned-completion",
      entry: { createdVia: "spawn" },
    },
  ],
  [
    "previously opened internal conversation",
    true,
    { entry: { createdVia: "run", lastReadAt: 1 } },
  ],
  ["timeout without output", true, { timeout: true }],
];
it.each(visibleCompletions)(
  "publishes completion according to %s",
  async (_name, publishes, options) => {
    const { target, timeout } = options;
    const marker = target
      ? `RESOLVER_TARGET_${target.toUpperCase()}`
      : timeout
        ? "TIMEOUT_REPORTED"
        : "VISIBLE_COMPLETION";
    await withProjectionScenario(async (scenario) => {
      const heartbeat = scenario.cfg.agents?.defaults?.heartbeat;
      if (!heartbeat) {
        throw new Error("projection scenario heartbeat is missing");
      }
      if (target) {
        heartbeat.target = target;
      }
      enqueueSystemEvent(
        timeout
          ? appendExecTimeoutRetryGuidance(
              "Exec failed (timeout-proof, signal SIGTERM)",
              "overall-timeout",
            )
          : `Exec completed (visible-proof, code 0) :: ${marker}`,
        {
          sessionKey: scenario.sessionKey,
          ...(timeout ? { contextKey: "exec:timeout-proof" } : {}),
        },
      );
      const broadcastMessages: unknown[] = [];
      const unsubscribe = onSessionTranscriptUpdate((update) => {
        if (update.sessionKey === scenario.sessionKey && update.message !== undefined) {
          broadcastMessages.push(update.message);
        }
      });
      try {
        const reply = vi
          .fn<NonNullable<HeartbeatDeps["getReplyFromConfig"]>>()
          .mockResolvedValue(completionPayload(marker));
        expect((await runProjectionWake(scenario, reply)).status).toBe("ran");
        expect(reply).toHaveBeenCalledOnce();
        expect(reply.mock.calls[0]?.[0]).toMatchObject({
          From: "heartbeat",
          To: undefined,
          OriginatingChannel: undefined,
          OriginatingTo: undefined,
        });
        expect(peekSystemEventEntries(scenario.sessionKey)).toEqual([]);
        const messages = await readProjectionMessages(scenario);
        expect(messages).toHaveLength(publishes ? 1 : 0);
        expect(broadcastMessages).toHaveLength(publishes ? 1 : 0);
        const prompt = reply.mock.calls[0]?.[0].Body;
        if (target) {
          expect(prompt).toContain("user delivery is disabled");
          expect(getLastHeartbeatEvent()).toMatchObject({
            status: "skipped",
            reason: "target-none",
          });
        } else if (timeout) {
          expect(prompt).toContain(
            "Exec failed (timeout-proof, signal SIGTERM) without captured stdout/stderr.",
          );
          expect(prompt).toContain("Verify the resulting state before retrying");
        } else {
          expect(getLastHeartbeatEvent()?.status).toBe("sent");
          await runProjectionWake(scenario, reply);
          expect(reply).toHaveBeenCalledOnce();
          expect(await readProjectionMessages(scenario)).toHaveLength(1);
        }
      } finally {
        unsubscribe();
      }
    }, options);
  },
);

it.each([
  { name: "unstamped internal row", entry: { createdVia: undefined } },
  {
    name: "hidden internal row even with prior readership",
    entry: { createdVia: "internal" as const, lastReadAt: 1 },
  },
  {
    name: "unopened hidden spawned child",
    sessionKey: "agent:main:subagent:hidden-completion",
    entry: { createdVia: "spawn" as const },
  },
  {
    name: "hidden internal-effects key even with operator provenance",
    sessionKey: resolveInternalSessionEffectsIdentity({ agentId: "main", runId: "hidden-proof" })
      .sessionKey,
    entry: { createdVia: "operator" as const },
  },
])("does not publish model output into $name", async (options) => {
  await withProjectionScenario(async (scenario) => {
    enqueueSystemEvent("Exec completed (hidden-proof, code 0) :: PRIVATE_OUTPUT", {
      sessionKey: scenario.sessionKey,
    });
    const reply = vi
      .fn<NonNullable<HeartbeatDeps["getReplyFromConfig"]>>()
      .mockResolvedValue(completionPayload("PRIVATE_OUTPUT"));
    await runProjectionWake(scenario, reply);
    expect(await readProjectionMessages(scenario)).toEqual([]);
    expect(getLastHeartbeatEvent()?.status).not.toBe("sent");
    if (options.entry.createdVia === "internal") {
      expect(reply).toHaveBeenCalledOnce();
      expect(reply.mock.calls[0]?.[0].Body).not.toContain("requested result not yet delivered");
      expect(reply.mock.calls[0]?.[0].Body).toContain("user delivery is disabled");
    }
  }, options);
});

it.each(["sessionId", "lifecycleRevision"] as const)(
  "rejects output after a %s replacement",
  async (field) => {
    await withProjectionScenario(async (scenario) => {
      enqueueSystemEvent("Exec completed (reset-proof, code 0) :: OLD_GENERATION", {
        sessionKey: scenario.sessionKey,
      });
      const pending = peekSystemEventEntries(scenario.sessionKey);
      const reply = vi
        .fn<NonNullable<HeartbeatDeps["getReplyFromConfig"]>>()
        .mockImplementation(async () => {
          const current = readSessionStoreForTest(scenario.storePath)[scenario.sessionKey];
          await replaceSessionEntry(
            { storePath: scenario.storePath, sessionKey: scenario.sessionKey },
            {
              ...current,
              sessionId: scenario.sessionId,
              updatedAt: Date.now(),
              [field]: "replacement-generation",
            },
          );
          return completionPayload("OLD_GENERATION");
        });
      await runProjectionWake(scenario, reply);
      expect(getLastHeartbeatEvent()?.status).not.toBe("sent");
      expect(peekSystemEventEntries(scenario.sessionKey).map((event) => event.id)).toEqual(
        pending.map((event) => event.id),
      );
      expect(await readProjectionMessages(scenario)).toEqual([]);
      if (field === "sessionId") {
        expect(
          await readProjectionMessages({ ...scenario, sessionId: "replacement-generation" }),
        ).toEqual([]);
      }
    });
  },
);

it("consumes only captured occurrences and publishes distinct same-text completions", async () => {
  await withProjectionScenario(async (scenario) => {
    enqueueSystemEvent("Exec completed (first-proof, code 0) :: SAME_NOTIFICATION", {
      sessionKey: scenario.sessionKey,
    });
    const first = peekSystemEventEntries(scenario.sessionKey);
    const payload = completionPayload("SAME_NOTIFICATION");
    const reply = vi
      .fn<NonNullable<HeartbeatDeps["getReplyFromConfig"]>>()
      .mockImplementationOnce(async () => {
        enqueueSystemEvent("Exec completed (later-proof, code 0) :: SAME_NOTIFICATION", {
          sessionKey: scenario.sessionKey,
        });
        return payload;
      })
      .mockResolvedValue(payload);
    await runProjectionWake(scenario, reply);
    const later = peekSystemEventEntries(scenario.sessionKey);
    expect(later).toHaveLength(1);
    expect(later[0]?.id).not.toBe(first[0]?.id);
    expect(await readProjectionMessages(scenario)).toHaveLength(1);
    await runProjectionWake(scenario, reply);
    expect(reply).toHaveBeenCalledTimes(2);
    expect(peekSystemEventEntries(scenario.sessionKey)).toEqual([]);
    expect(await readProjectionMessages(scenario)).toHaveLength(2);
  });
});

it("reconciles an ordinary persisted final with a response prefix", async () => {
  await withProjectionScenario(
    async (scenario) => {
      scenario.cfg.messages = { ...scenario.cfg.messages, responsePrefix: "[{model}]" };
      const text = "ORDINARY_COMPLETION_SOURCE";
      enqueueSystemEvent(`Exec completed (ordinary-proof, code 0) :: ${text}`, {
        sessionKey: scenario.sessionKey,
      });
      const original = {
        role: "assistant",
        content: [{ type: "text", text }],
        idempotencyKey: "ordinary-prefixed-final",
        __openclaw: { runId: "ordinary-writer" },
      };
      const reply = vi
        .fn<NonNullable<HeartbeatDeps["getReplyFromConfig"]>>()
        .mockImplementation(async () => {
          await persistSessionTranscriptTurn(
            { agentId: "main", ...scenario },
            {
              expectedSessionId: scenario.sessionId,
              expectedLifecycleRevision: "publication-boundary-generation",
              expectedWriterRunId: "ordinary-writer",
              messages: [{ message: original }],
              updateMode: "none",
            },
          );
          return setReplyPayloadMetadata(
            { text },
            {
              assistantTranscriptOwned: true,
              assistantTranscriptIdempotencyKey: original.idempotencyKey,
            },
          );
        });
      await runProjectionWake(scenario, reply);
      expect(peekSystemEventEntries(scenario.sessionKey)).toEqual([]);
      expect(getLastHeartbeatEvent()?.status).toBe("sent");
      expect(await readProjectionMessages(scenario)).toEqual([original]);
      const sentText = readSessionStoreForTest(scenario.storePath)[scenario.sessionKey]
        ?.lastHeartbeatText;
      expect(sentText).toContain(text);
      expect(sentText).toMatch(/^\[/);
      await runProjectionWake(scenario, reply);
      expect(reply).toHaveBeenCalledOnce();
      expect(await readProjectionMessages(scenario)).toEqual([original]);
    },
    { entry: { activeWriterRunId: "ordinary-writer" } },
  );
});

it("retains a completion after visible tool failure", async () => {
  await withProjectionScenario(async (scenario) => {
    enqueueSystemEvent("Exec completed (retry-proof, code 0) :: RECOVERED_COMPLETION", {
      sessionKey: scenario.sessionKey,
    });
    const pending = peekSystemEventEntries(scenario.sessionKey);
    const reply = vi
      .fn<NonNullable<HeartbeatDeps["getReplyFromConfig"]>>()
      .mockResolvedValueOnce(
        setReplyPayloadMetadata(
          { text: "The notification attempt failed.", isError: true },
          { heartbeatTerminalToolFailure: { toolName: "message" } },
        ),
      )
      .mockResolvedValue(completionPayload("RECOVERED_COMPLETION"));
    expect((await runProjectionWake(scenario, reply)).status).toBe("failed");
    expect(peekSystemEventEntries(scenario.sessionKey).map((event) => event.id)).toEqual(
      pending.map((event) => event.id),
    );
    await runProjectionWake(scenario, reply);
    expect(peekSystemEventEntries(scenario.sessionKey)).toEqual([]);
    expect(
      (await readProjectionMessages(scenario)).filter((message) =>
        JSON.stringify(message?.content).includes("RECOVERED_COMPLETION"),
      ),
    ).toHaveLength(1);
    await runProjectionWake(scenario, reply);
    expect(reply).toHaveBeenCalledTimes(2);
  });
});

it("settles an accepted completion before retrying a later queued occurrence", async () => {
  await withProjectionScenario(async (scenario) => {
    enqueueSystemEvent("Exec completed (first-drain-proof, code 0) :: FIRST_ACCEPTED", {
      sessionKey: scenario.sessionKey,
    });
    const first = peekSystemEventEntries(scenario.sessionKey);
    const reply = vi
      .fn<NonNullable<HeartbeatDeps["getReplyFromConfig"]>>()
      .mockResolvedValueOnce(completionPayload("FIRST_ACCEPTED"))
      .mockResolvedValue(completionPayload("LATER_ACCEPTED"));
    const result = await withOwnedSessionTranscriptWrites(
      {
        sessionKey: scenario.sessionKey,
        sessionFile: scenario.sessionKey,
        sessionTarget: { agentId: "main", ...scenario },
        withTranscriptWrite: async (run) => {
          await run();
          enqueueSystemEvent("Exec completed (later-drain-proof, code 0) :: LATER_ACCEPTED", {
            sessionKey: scenario.sessionKey,
          });
          throw new Error("owned drain failed after accepted publication");
        },
      },
      () => runProjectionWake(scenario, reply),
    );
    expect(result.status).toBe("ran");
    const pending = peekSystemEventEntries(scenario.sessionKey);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).not.toBe(first[0]?.id);
    expect(getLastHeartbeatEvent()?.status).toBe("sent");
    await runProjectionWake(scenario, reply);
    expect(reply).toHaveBeenCalledTimes(2);
    expect(peekSystemEventEntries(scenario.sessionKey)).toEqual([]);
    const messages = await readProjectionMessages(scenario);
    expect(messages).toHaveLength(2);
    expect(messages.map((message) => message?.content)).toEqual([
      [{ type: "text", text: "FIRST_ACCEPTED" }],
      [{ type: "text", text: "LATER_ACCEPTED" }],
    ]);
    await runProjectionWake(scenario, reply);
    expect(reply).toHaveBeenCalledTimes(2);
    expect(await readProjectionMessages(scenario)).toEqual(messages);
  });
});

describe("WebChat completions with an explicit heartbeat target", () => {
  beforeEach(() => setupTelegramHeartbeatPluginRuntimeForTests());

  function withTargetScenario(
    run: (scenario: ProjectionScenario, sendTelegram: ReturnType<typeof vi.fn>) => Promise<void>,
  ) {
    return withProjectionScenario(async (scenario) => {
      scenario.cfg.agents!.defaults!.heartbeat = {
        every: "0m",
        target: "telegram",
        to: "-100999000111",
      };
      scenario.cfg.channels = { telegram: { allowFrom: ["*"] } };
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1", chatId: "-100999000111" });
      await run(scenario, sendTelegram);
    });
  }

  it("keeps chained completions in WebChat instead of the heartbeat channel", async () => {
    await withTargetScenario(async (scenario, sendTelegram) => {
      const marker = "WEBCHAT_EXEC_COMPLETION_STAYS_HOME";
      enqueueSystemEvent("Exec completed (first, code 0) :: first result", {
        sessionKey: scenario.sessionKey,
        deliveryContext: { channel: "webchat" },
        fromConversationTurn: true,
      });
      const reply = vi
        .fn<NonNullable<HeartbeatDeps["getReplyFromConfig"]>>()
        .mockImplementation(async (ctx, options) => {
          // Model stubs must still initialize the session to exercise persisted routing.
          await initSessionState({
            cfg: scenario.cfg,
            ctx: finalizeInboundContext(ctx),
            commandAuthorized: false,
          });
          if (reply.mock.calls.length === 1) {
            const next = resolveExecNotificationDefaults({
              trigger: "heartbeat",
              continuesConversation: options?.continuesConversation,
              messageProvider: ctx.OriginatingChannel,
              currentChannelId: ctx.OriginatingTo ?? ctx.To,
            });
            enqueueSystemEvent("Exec completed (chained, code 0) :: next result", {
              sessionKey: scenario.sessionKey,
              deliveryContext: next.notifyDeliveryContext,
              fromConversationTurn: next.notifyFromConversationTurn,
            });
            return completionPayload("First completed; started the next command.");
          }
          return completionPayload(marker);
        });
      const run = () =>
        runHeartbeatOnce({
          cfg: scenario.cfg,
          agentId: "main",
          source: "exec-event",
          intent: "event",
          reason: "exec-event",
          deps: { getReplyFromConfig: reply, telegram: sendTelegram },
        });
      expect((await run()).status).toBe("ran");
      expect(sendTelegram).not.toHaveBeenCalled();
      expect(peekSystemEventEntries(scenario.sessionKey)).toHaveLength(1);
      expect((await run()).status).toBe("ran");
      expect(reply).toHaveBeenCalledTimes(2);
      expect(
        sendTelegram,
        "chained completion leaked to the heartbeat channel",
      ).not.toHaveBeenCalled();
      expect(
        (await readProjectionMessages(scenario)).filter((message) =>
          JSON.stringify(message?.content).includes(marker),
        ),
      ).toHaveLength(1);
      expect(peekSystemEventEntries(scenario.sessionKey)).toEqual([]);
    });
  });

  it("keeps the explicit target for a batch that mixes an exec completion with another event", async () => {
    await withTargetScenario(async (scenario, sendTelegram) => {
      scenario.cfg.messages = undefined;
      const marker = "MIXED_BATCH_USES_HEARTBEAT_TARGET";
      enqueueSystemEvent("Exec completed (bg-cmd, code 0) :: done", {
        sessionKey: scenario.sessionKey,
      });
      enqueueSystemEvent("Reminder: rotate the backup disk", { sessionKey: scenario.sessionKey });
      const reply = vi.fn().mockResolvedValue({ text: marker });
      await runHeartbeatOnce({
        cfg: scenario.cfg,
        agentId: "main",
        source: "exec-event",
        intent: "event",
        reason: "exec-event",
        deps: { getReplyFromConfig: reply, telegram: sendTelegram },
      });
      expect(sendTelegram).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(sendTelegram.mock.calls[0])).toContain(marker);
    });
  });

  it.each(["rejected write", "thrown write", "failed model"] as const)(
    "retains a restart occurrence after %s and settles only the successful retry",
    async (failure) => {
      await withTargetScenario(async (scenario, sendTelegram) => {
        const { cfg, sessionKey } = scenario;
        cfg.messages = undefined;
        const marker = "RESTART_RETRY_COMMITTED";
        const continuation = "Gateway restarted. Continue the interrupted turn.";
        enqueueSystemEvent(continuation, {
          sessionKey,
          contextKey: "task:restart-sentinel:retry-1",
        });
        const captured = peekSystemEventEntries(sessionKey);
        const publish = vi.spyOn(sessionPublication, "publishHeartbeatSessionReply");
        if (failure === "rejected write") {
          publish.mockResolvedValueOnce({ ok: false, reason: "injected write rejection" });
        } else if (failure === "thrown write") {
          publish.mockRejectedValueOnce(new Error("injected write failure"));
        }
        const reply = vi
          .fn<NonNullable<HeartbeatDeps["getReplyFromConfig"]>>()
          .mockImplementation(async (_ctx, options) => {
            const context = getReplySystemEventContext(options);
            // Real prompt admission must not drain the occurrence before publication commits.
            const block = await drainFormattedSystemEvents({
              cfg,
              agentId: "main",
              sessionKey,
              isMainSession: false,
              isNewSession: false,
              events: context?.events ?? [],
              deferredEventIds: context?.deferredEventIds,
            });
            expect(block).toContain(continuation);
            if (failure === "failed model" && reply.mock.calls.length === 1) {
              throw new Error("injected model failure after admission");
            }
            return completionPayload(marker);
          });
        const run = () =>
          runHeartbeatOnce({
            cfg,
            agentId: "main",
            sessionKey,
            source: "restart-sentinel",
            intent: "immediate",
            reason: "wake",
            deps: { getReplyFromConfig: reply, telegram: sendTelegram },
          });
        const published = async () =>
          (await readProjectionMessages(scenario)).filter((message) =>
            JSON.stringify(message?.content).includes(marker),
          );
        await run();
        expect(publish).toHaveBeenCalledTimes(failure === "failed model" ? 0 : 1);
        expect(peekSystemEventEntries(sessionKey).map((event) => event.id)).toEqual(
          captured.map((event) => event.id),
        );
        expect(await published()).toHaveLength(0);
        expect(sendTelegram).not.toHaveBeenCalled();
        await run();
        expect(reply).toHaveBeenCalledTimes(2);
        expect(publish).toHaveBeenCalledTimes(failure === "failed model" ? 1 : 2);
        expect(await published()).toHaveLength(1);
        expect(peekSystemEventEntries(sessionKey)).toEqual([]);
        expect(sendTelegram).not.toHaveBeenCalled();
      });
    },
  );
});
