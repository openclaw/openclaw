import { afterEach, describe, expect, it, vi } from "vitest";
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
import { setTestEnvValue } from "../test-utils/env.js";
import { getLastHeartbeatEvent, resetHeartbeatEventsForTest } from "./heartbeat-events.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import type { HeartbeatDeps } from "./heartbeat-runner.js";
import {
  readSessionStoreForTest,
  seedMainSessionStore,
  seedSessionStore,
  withTempHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";
import {
  enqueueSystemEvent,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "./system-events.js";

describe("exec-completion reply on a WebChat-internal session (#147387)", () => {
  it("tells the model to relay the completion instead of suppressing it", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
      setTestEnvValue("OPENCLAW_STATE_DIR", tmpDir);
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: { every: "5m", target: "last" },
          },
        },
        session: { store: storePath },
      };
      const sessionKey = await seedMainSessionStore(storePath, cfg, {
        lastChannel: "webchat",
        lastProvider: "",
        lastTo: "",
        createdVia: "operator",
      });
      enqueueSystemEvent(
        "Exec completed (background-report, code 0) :: COMPANION_COMPLETION_TEST",
        { sessionKey },
      );

      const getReplyFromConfig = vi
        .fn<NonNullable<HeartbeatDeps["getReplyFromConfig"]>>()
        .mockResolvedValue({ text: "COMPANION_COMPLETION_TEST" });
      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        source: "exec-event",
        intent: "event",
        reason: "exec-event",
        deps: { getReplyFromConfig },
      });

      expect(result.status).toBe("ran");
      expect(getReplyFromConfig).toHaveBeenCalledOnce();
      const [ctx] = getReplyFromConfig.mock.calls[0]!;
      expect(ctx.Body).toContain("Please relay the command output to the user");
      expect(ctx.Body).not.toContain("user delivery is disabled");
      expect(getReplyFromConfig.mock.calls[0]?.[1]).toMatchObject({
        requireExplicitMessageTarget: false,
      });
      expect(ctx).toMatchObject({
        Provider: "webchat",
        Surface: "webchat",
        OriginatingChannel: "webchat",
        OriginatingTo: sessionKey,
        To: sessionKey,
      });
    });
  });

  it("still suppresses a genuinely routeless cron reminder on the same WebChat session", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
      setTestEnvValue("OPENCLAW_STATE_DIR", tmpDir);
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: { every: "5m", target: "last" },
          },
        },
        session: { store: storePath },
      };
      const sessionKey = await seedMainSessionStore(storePath, cfg, {
        lastChannel: "webchat",
        lastProvider: "",
        lastTo: "",
        createdVia: "operator",
      });
      enqueueSystemEvent("Reminder: Check the overnight report", {
        sessionKey,
        contextKey: "cron:overnight-report",
      });

      const getReplyFromConfig = vi.fn().mockResolvedValue({ text: "Reminder handled" });
      await runHeartbeatOnce({
        cfg,
        agentId: "main",
        source: "cron",
        intent: "event",
        reason: "cron",
        deps: { getReplyFromConfig },
      });

      expect(getReplyFromConfig).toHaveBeenCalledOnce();
      const [ctx] = getReplyFromConfig.mock.calls[0] as [Record<string, unknown>];
      expect(ctx.Body).not.toContain("Please relay this reminder to the user");
      expect(getReplyFromConfig.mock.calls[0]?.[1]).toMatchObject({
        requireExplicitMessageTarget: true,
      });
    });
  });

  it("does not relay into a hidden internal-effects session sharing the same delivery.kind", async () => {
    // internal-session-effects.ts and voice bare rows also persist
    // `delivery: { kind: "internal" }`, but they are never a real
    // WebChat/Companion client. `createdVia: "internal"` is how those hidden
    // sessions identify themselves; the bypass must not treat them the same
    // as an ordinary WebChat session with no external route configured.
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
      setTestEnvValue("OPENCLAW_STATE_DIR", tmpDir);
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: { every: "5m", target: "last" },
          },
        },
        session: { store: storePath },
      };
      const sessionKey = await seedMainSessionStore(storePath, cfg, {
        lastChannel: "webchat",
        lastProvider: "",
        lastTo: "",
        createdVia: "internal",
      });
      enqueueSystemEvent(
        "Exec completed (background-report, code 0) :: HIDDEN_SESSION_COMPLETION_TEST",
        { sessionKey },
      );

      const getReplyFromConfig = vi
        .fn()
        .mockResolvedValue({ text: "HIDDEN_SESSION_COMPLETION_TEST" });
      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        source: "exec-event",
        intent: "event",
        reason: "exec-event",
        deps: { getReplyFromConfig },
      });

      expect(result.status).toBe("ran");
      expect(getReplyFromConfig).toHaveBeenCalledOnce();
      const [ctx] = getReplyFromConfig.mock.calls[0] as [Record<string, unknown>];
      expect(ctx.Body).not.toContain("Please relay the command output to the user");
      expect(ctx.Body).toContain("user delivery is disabled");
    });
  });
});

// Task-local reproduction: real dispatch, persistence reads and event settlement;
// only model output is injected. No ordinary assistant final is pre-persisted.

it("PR148360 accepted publication precedes exec occurrence consumption", async () => {
  await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
    setTestEnvValue("OPENCLAW_STATE_DIR", tmpDir);
    const marker = "PR148360_TOOL_ONLY_COMMIT_PROOF";
    const cfg: OpenClawConfig = {
      agents: { defaults: { workspace: tmpDir, heartbeat: { every: "5m", target: "last" } } },
      messages: { visibleReplies: "message_tool" },
      session: { store: storePath },
    };
    const sessionKey = await seedMainSessionStore(storePath, cfg, {
      lastChannel: "webchat",
      lastProvider: "",
      lastTo: "",
      sessionId: "pr148360-repro-session",
      lifecycleRevision: "pr148360-repro-generation",
      createdVia: "operator",
    });
    enqueueSystemEvent(`Exec completed (proof-command, code 0) :: ${marker}`, { sessionKey });
    const before = peekSystemEventEntries(sessionKey);
    expect(before).toHaveLength(1);
    const getReplyFromConfig = vi.fn().mockResolvedValue(
      createHeartbeatToolResponsePayload({
        outcome: "done",
        notify: true,
        summary: "Private diagnostic summary",
        notificationText: marker,
      }),
    );
    const result = await runHeartbeatOnce({
      cfg,
      agentId: "main",
      source: "exec-event",
      intent: "event",
      reason: "exec-event",
      deps: { getReplyFromConfig },
    });
    const entry = readSessionStoreForTest(storePath)[sessionKey];
    expect(entry?.sessionId).toBe("pr148360-repro-session");
    if (!entry) {
      throw new Error("completion session is missing");
    }
    const events = await loadTranscriptEvents({
      agentId: "main",
      sessionKey,
      sessionId: entry.sessionId!,
      storePath,
    });
    const published = events.filter((event) => {
      const message = readTranscriptEventMessage(event);
      return message?.role === "assistant" && JSON.stringify(message.content).includes(marker);
    });
    const after = peekSystemEventEntries(sessionKey);
    const observed = {
      status: result.status,
      heartbeatStatus: getLastHeartbeatEvent()?.status,
      queuedBefore: before.map((event) => event.id),
      queuedAfter: after.map((event) => event.id),
      assistantPublicationCount: published.length,
    };
    console.log("PR148360_BOUNDARY_OBSERVATION=" + JSON.stringify(observed));
    expect(getReplyFromConfig).toHaveBeenCalledOnce();
    expect(result.status).toBe("ran");
    expect(
      published,
      "must commit notification before consuming the completion occurrence",
    ).toHaveLength(1);
    expect(after).toEqual([]);
    const secondWake = await runHeartbeatOnce({
      cfg,
      agentId: "main",
      source: "exec-event",
      intent: "event",
      reason: "exec-event",
      deps: { getReplyFromConfig },
    });
    expect(secondWake.status).toBe("skipped");
    expect(getReplyFromConfig).toHaveBeenCalledOnce();
    const afterSecondWake = await loadTranscriptEvents({
      agentId: "main",
      sessionKey,
      sessionId: entry.sessionId!,
      storePath,
    });
    expect(afterSecondWake).toEqual(events);
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

it("keeps an encoded external destination subject to explicit targeting", async () => {
  await withProjectionScenario(
    async (scenario) => {
      enqueueSystemEvent("Exec completed (encoded-route-proof, code 0) :: PRIVATE_OUTPUT", {
        sessionKey: scenario.sessionKey,
      });
      const reply = vi.fn<NonNullable<HeartbeatDeps["getReplyFromConfig"]>>().mockResolvedValue(
        createHeartbeatToolResponsePayload({
          outcome: "done",
          notify: false,
          summary: "private",
        }),
      );
      const result = await runProjectionWake(scenario, reply);
      expect(result.status).toBe("ran");
      expect(reply).toHaveBeenCalledOnce();
      expect(reply.mock.calls[0]?.[1]).toMatchObject({ requireExplicitMessageTarget: true });
      expect(reply.mock.calls[0]?.[0].OriginatingChannel).toBeUndefined();
    },
    { sessionKey: "agent:main:telegram:direct:123456" },
  );
});

it("keeps an isolated WebChat completion subject to explicit targeting", async () => {
  await withProjectionScenario(async (scenario) => {
    scenario.cfg.agents!.defaults!.heartbeat!.isolatedSession = true;
    const isolatedKey = `${scenario.sessionKey}:heartbeat`;
    await seedSessionStore(scenario.storePath, isolatedKey, {
      sessionId: "isolated-source-policy",
      heartbeatIsolatedBaseSessionKey: scenario.sessionKey,
    });
    enqueueSystemEvent("Exec completed (isolated-proof, code 0) :: PRIVATE_OUTPUT", {
      sessionKey: isolatedKey,
    });
    const reply = vi
      .fn<NonNullable<HeartbeatDeps["getReplyFromConfig"]>>()
      .mockResolvedValue(
        createHeartbeatToolResponsePayload({ outcome: "done", notify: false, summary: "private" }),
      );
    const result = await runProjectionWake({ ...scenario, sessionKey: isolatedKey }, reply);
    expect(result.status).toBe("ran");
    expect(reply).toHaveBeenCalledOnce();
    expect(reply.mock.calls[0]?.[1]).toMatchObject({ requireExplicitMessageTarget: true });
    expect(reply.mock.calls[0]?.[0].OriginatingChannel).toBeUndefined();
  });
});

it("preserves explicit target:none before target:last delivers in the same WebChat session", async () => {
  await withProjectionScenario(async (scenario) => {
    const heartbeat = scenario.cfg.agents?.defaults?.heartbeat;
    if (!heartbeat) {
      throw new Error("projection scenario heartbeat is missing");
    }
    for (const target of ["none", "last"] as const) {
      heartbeat.target = target;
      const marker = `EXPLICIT_TARGET_${target}`;
      enqueueSystemEvent(`Exec completed (target-proof, code 0) :: ${marker}`, {
        sessionKey: scenario.sessionKey,
      });
      const reply = vi.fn<NonNullable<HeartbeatDeps["getReplyFromConfig"]>>().mockResolvedValue(
        createHeartbeatToolResponsePayload({
          outcome: "done",
          notify: true,
          summary: "private",
          notificationText: marker,
        }),
      );
      await runProjectionWake(scenario, reply);
      expect(reply).toHaveBeenCalledOnce();
      const context = reply.mock.calls[0]?.[0];
      const messages = await readProjectionMessages(scenario);
      expect(reply.mock.calls[0]?.[1]).toMatchObject({
        requireExplicitMessageTarget: target === "none",
      });
      if (target === "none") {
        expect(messages).toEqual([]);
        expect(context?.Body).toContain("user delivery is disabled");
      } else {
        expect(messages).toHaveLength(1);
        expect(JSON.stringify(messages[0]?.content)).toContain(marker);
        expect(context?.Body).toContain("Please relay the command output to the user");
      }
    }
  });
});

// Suppression is the delivery resolver's verdict, not the configured string.
// `target: "none"` and an explicit target that never resolves to a route both
// report `reason: "target-none"` (src/infra/outbound/targets.ts), so neither may
// publish into the WebChat session. These arms assert the two consumers the
// prompt/row test above does not reach: the settlement event operators read and
// the transcript update the gateway fans out as `session.message`.
it.each([
  { target: "last", publishes: true, label: "routeless target:last" },
  { target: "none", publishes: false, label: "explicit target:none" },
  { target: "pagerduty", publishes: false, label: "explicit target with no resolvable route" },
])("$label leaves the completion published: $publishes", async ({ target, publishes }) => {
  await withProjectionScenario(async (scenario) => {
    const heartbeat = scenario.cfg.agents?.defaults?.heartbeat;
    if (!heartbeat) {
      throw new Error("projection scenario heartbeat is missing");
    }
    heartbeat.target = target;
    const marker = `RESOLVER_TARGET_${target.toUpperCase()}`;
    enqueueSystemEvent(`Exec completed (resolver-proof, code 0) :: ${marker}`, {
      sessionKey: scenario.sessionKey,
    });
    const broadcastMessages: unknown[] = [];
    const unsubscribe = onSessionTranscriptUpdate((update) => {
      if (update.sessionKey === scenario.sessionKey && update.message !== undefined) {
        broadcastMessages.push(update.message);
      }
    });
    try {
      const reply = vi.fn<NonNullable<HeartbeatDeps["getReplyFromConfig"]>>().mockResolvedValue(
        createHeartbeatToolResponsePayload({
          outcome: "done",
          notify: true,
          summary: "private",
          notificationText: marker,
        }),
      );
      const result = await runProjectionWake(scenario, reply);

      // The model runs and the completion is consumed in every arm; only the
      // user-visible publication differs.
      expect(result.status).toBe("ran");
      expect(reply).toHaveBeenCalledOnce();
      expect(reply.mock.calls[0]?.[1]).toMatchObject({
        requireExplicitMessageTarget: !publishes,
      });
      expect(peekSystemEventEntries(scenario.sessionKey)).toEqual([]);

      const messages = await readProjectionMessages(scenario);
      const event = getLastHeartbeatEvent();
      expect(messages).toHaveLength(publishes ? 1 : 0);
      expect(broadcastMessages).toHaveLength(publishes ? 1 : 0);
      if (publishes) {
        expect(JSON.stringify(messages[0]?.content)).toContain(marker);
        expect(event?.status).toBe("sent");
        expect(event?.reason).toBeUndefined();
      } else {
        expect(event?.status).toBe("skipped");
        expect(event?.reason).toBe("target-none");
      }
    } finally {
      unsubscribe();
    }
  });
});

it.each([
  {
    name: "queued exec completion inspected by a manual wake",
    wake: "manual" as const,
  },
  {
    name: "queued exec completion inspected by a cron wake",
    wake: "cron" as const,
  },
  {
    name: "unopened spawned dashboard",
    sessionKey: "agent:main:dashboard:spawned-completion",
    entry: { createdVia: "spawn" as const },
  },
  {
    name: "previously opened internal conversation",
    entry: { createdVia: "run" as const, lastReadAt: 1 },
  },
])("publishes completion once in $name", async (options) => {
  await withProjectionScenario(async (scenario) => {
    enqueueSystemEvent("Exec completed (visible-proof, code 0) :: VISIBLE_COMPLETION", {
      sessionKey: scenario.sessionKey,
    });
    const reply = vi.fn<NonNullable<HeartbeatDeps["getReplyFromConfig"]>>().mockResolvedValue(
      createHeartbeatToolResponsePayload({
        outcome: "done",
        notify: true,
        summary: "private",
        notificationText: "VISIBLE_COMPLETION",
      }),
    );
    await runProjectionWake(scenario, reply, "wake" in options ? options.wake : undefined);
    expect(await readProjectionMessages(scenario)).toHaveLength(1);
    expect(peekSystemEventEntries(scenario.sessionKey)).toEqual([]);
    expect(getLastHeartbeatEvent()?.status).toBe("sent");
    await runProjectionWake(scenario, reply);
    expect(reply).toHaveBeenCalledOnce();
    expect(await readProjectionMessages(scenario)).toHaveLength(1);
  }, options);
});

it.each([
  { name: "unstamped internal row", entry: { createdVia: undefined } },
  {
    name: "unopened hidden spawned child",
    skipped: true,
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
    const reply = vi.fn<NonNullable<HeartbeatDeps["getReplyFromConfig"]>>().mockResolvedValue(
      createHeartbeatToolResponsePayload({
        outcome: "done",
        notify: true,
        summary: "private",
        notificationText: "PRIVATE_OUTPUT",
      }),
    );
    await runProjectionWake(scenario, reply);
    if ("skipped" in options) {
      expect(reply).not.toHaveBeenCalled();
    } else {
      expect(reply).toHaveBeenCalledOnce();
      expect(reply.mock.calls[0]?.[1]).toMatchObject({ requireExplicitMessageTarget: true });
    }
    expect(await readProjectionMessages(scenario)).toEqual([]);
    expect(getLastHeartbeatEvent()?.status).not.toBe("sent");
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
          return createHeartbeatToolResponsePayload({
            outcome: "done",
            notify: true,
            summary: "private",
            notificationText: "OLD_GENERATION",
          });
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
    const payload = createHeartbeatToolResponsePayload({
      outcome: "done",
      notify: true,
      summary: "private",
      notificationText: "SAME_NOTIFICATION",
    });
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

it("retains the completion occurrence after a failed model turn", async () => {
  await withProjectionScenario(async (scenario) => {
    enqueueSystemEvent("Exec completed (failed-turn-proof, code 0) :: RETAIN_EVENT", {
      sessionKey: scenario.sessionKey,
    });
    const pending = peekSystemEventEntries(scenario.sessionKey);
    const reply = vi
      .fn<NonNullable<HeartbeatDeps["getReplyFromConfig"]>>()
      .mockRejectedValue(new Error("injected model failure"));
    const result = await runProjectionWake(scenario, reply);
    expect(result.status).toBe("failed");
    expect(peekSystemEventEntries(scenario.sessionKey).map((event) => event.id)).toEqual(
      pending.map((event) => event.id),
    );
    expect(await readProjectionMessages(scenario)).toEqual([]);
  });
});

it.each([undefined, "[bot]", "[{model}]"])(
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

it("does not let a visible failed turn block the successful completion retry", async () => {
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
      .mockResolvedValue(
        createHeartbeatToolResponsePayload({
          outcome: "done",
          notify: true,
          summary: "private",
          notificationText: "RECOVERED_COMPLETION",
        }),
      );
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
      .mockResolvedValueOnce(
        createHeartbeatToolResponsePayload({
          outcome: "done",
          notify: true,
          summary: "private",
          notificationText: "FIRST_ACCEPTED",
        }),
      )
      .mockResolvedValue(
        createHeartbeatToolResponsePayload({
          outcome: "done",
          notify: true,
          summary: "private",
          notificationText: "LATER_ACCEPTED",
        }),
      );
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
