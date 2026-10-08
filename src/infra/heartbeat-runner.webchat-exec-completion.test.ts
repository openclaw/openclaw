import { afterEach, expect, it, vi } from "vitest";
import { appendExecTimeoutRetryGuidance } from "../agents/bash-tools.exec-output.js";
import { createHeartbeatToolResponsePayload } from "../auto-reply/heartbeat-tool-response.js";
import { setReplyPayloadMetadata } from "../auto-reply/reply-payload.js";
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
import { getLastHeartbeatEvent, resetHeartbeatEventsForTest } from "./heartbeat-events.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import type { HeartbeatDeps } from "./heartbeat-runner.js";
import {
  readSessionStoreForTest,
  seedSessionStore,
  withTempHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";
import {
  enqueueSystemEvent,
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
  wake?: "manual" | "cron";
  timeout?: boolean;
};
const visibleCompletions: Array<[string, boolean, VisibleCompletionCase]> = [
  ["routeless target:last", true, { target: "last" }],
  ["explicit target:none", false, { target: "none" }],
  ["unresolved explicit target", false, { target: "pagerduty" }],
  ["manual wake", true, { wake: "manual" }],
  ["cron wake", true, { wake: "cron" }],
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
    const { target, wake, timeout } = options;
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
        expect((await runProjectionWake(scenario, reply, wake)).status).toBe("ran");
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
          const event = getLastHeartbeatEvent();
          if (publishes) {
            expect(prompt).toContain("requested result not yet delivered");
            expect(prompt).toContain("duplicate or superseded results");
            expect(prompt).not.toContain("user delivery is disabled");
            expect(JSON.stringify(messages[0]?.content)).toContain(marker);
            expect(event?.status).toBe("sent");
            expect(event?.reason).toBeUndefined();
          } else {
            expect(prompt).toContain("user delivery is disabled");
            expect(event?.status).toBe("skipped");
            expect(event?.reason).toBe("target-none");
          }
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

it.each([undefined, "[{model}]"])(
  "reconciles an ordinary persisted final with response prefix %s",
  async (responsePrefix) => {
    await withProjectionScenario(
      async (scenario) => {
        scenario.cfg.messages = { ...scenario.cfg.messages, responsePrefix };
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
        if (responsePrefix) {
          expect(sentText).toMatch(/^\[/);
        }
        await runProjectionWake(scenario, reply);
        expect(reply).toHaveBeenCalledOnce();
        expect(await readProjectionMessages(scenario)).toEqual([original]);
      },
      { entry: { activeWriterRunId: "ordinary-writer" } },
    );
  },
);

it.each(["model rejection", "visible tool failure"])(
  "retains a completion after %s",
  async (failure) => {
    await withProjectionScenario(async (scenario) => {
      enqueueSystemEvent("Exec completed (retry-proof, code 0) :: RECOVERED_COMPLETION", {
        sessionKey: scenario.sessionKey,
      });
      const pending = peekSystemEventEntries(scenario.sessionKey);
      const reply = vi.fn<NonNullable<HeartbeatDeps["getReplyFromConfig"]>>();
      if (failure === "model rejection") {
        reply.mockRejectedValue(new Error("injected model failure"));
      } else {
        reply
          .mockResolvedValueOnce(
            setReplyPayloadMetadata(
              { text: "The notification attempt failed.", isError: true },
              { heartbeatTerminalToolFailure: { toolName: "message" } },
            ),
          )
          .mockResolvedValue(completionPayload("RECOVERED_COMPLETION"));
      }
      expect((await runProjectionWake(scenario, reply)).status).toBe("failed");
      expect(peekSystemEventEntries(scenario.sessionKey).map((event) => event.id)).toEqual(
        pending.map((event) => event.id),
      );
      if (failure === "model rejection") {
        expect(await readProjectionMessages(scenario)).toEqual([]);
      } else {
        await runProjectionWake(scenario, reply);
        expect(peekSystemEventEntries(scenario.sessionKey)).toEqual([]);
        expect(
          (await readProjectionMessages(scenario)).filter((message) =>
            JSON.stringify(message?.content).includes("RECOVERED_COMPLETION"),
          ),
        ).toHaveLength(1);
        await runProjectionWake(scenario, reply);
        expect(reply).toHaveBeenCalledTimes(2);
      }
    });
  },
);

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
