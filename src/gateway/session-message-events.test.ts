import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import {
  loadSqliteSessionTranscriptEvents,
  replaceSqliteSessionTranscriptEvents,
} from "../config/sessions/transcript-store.sqlite.js";
import { appendAssistantMessageToSessionTranscript } from "../config/sessions/transcript.js";
import { emitSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import * as transcriptEvents from "../sessions/transcript-events.js";
import { emitSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  connectOk,
  createGatewaySuiteHarness,
  installGatewayTestHooks,
  onceMessage,
  rpcReq,
  seedGatewaySessionEntries,
} from "./test-helpers.server.js";

installGatewayTestHooks({ scope: "suite" });

const cleanupDirs: string[] = [];
const SETUP_RPC_TIMEOUT_MS = 30_000;
let previousStateDir: string | undefined;
let previousStateDirCaptured = false;
let harness: Awaited<ReturnType<typeof createGatewaySuiteHarness>>;
let subscribedOperatorWs:
  | Awaited<ReturnType<Awaited<ReturnType<typeof createGatewaySuiteHarness>>["openWs"]>>
  | undefined;

beforeAll(async () => {
  harness = await createGatewaySuiteHarness();
  subscribedOperatorWs = await harness.openWs();
  await connectOk(subscribedOperatorWs, {
    scopes: ["operator.read"],
    timeoutMs: SETUP_RPC_TIMEOUT_MS,
  });
  await rpcReq(subscribedOperatorWs, "sessions.subscribe", undefined, SETUP_RPC_TIMEOUT_MS);
}, 60_000);

afterAll(async () => {
  subscribedOperatorWs?.close();
  if (harness) {
    await harness.close();
  }
});

afterEach(async () => {
  if (previousStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = previousStateDir;
  }
  previousStateDir = undefined;
  previousStateDirCaptured = false;
  await Promise.all(
    cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function setupTranscriptFixtureState(): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-message-"));
  cleanupDirs.push(dir);
  if (!previousStateDirCaptured) {
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    previousStateDirCaptured = true;
  }
  process.env.OPENCLAW_STATE_DIR = dir;
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
}

function replaceTranscriptEvents(params: { sessionId: string; events: unknown[] }) {
  replaceSqliteSessionTranscriptEvents({
    agentId: "main",
    sessionId: params.sessionId,
    events: params.events,
  });
}

async function withOperatorSessionSubscriber<T>(
  run: (ws: NonNullable<typeof subscribedOperatorWs>) => Promise<T>,
) {
  if (!subscribedOperatorWs) {
    throw new Error("subscribed operator websocket is not ready");
  }
  return await run(subscribedOperatorWs);
}

function waitForSessionMessageEvent(
  ws: Awaited<ReturnType<Awaited<ReturnType<typeof createGatewaySuiteHarness>>["openWs"]>>,
  sessionKey: string,
) {
  return onceMessage(
    ws,
    (message) =>
      message.type === "event" &&
      message.event === "session.message" &&
      (message.payload as { sessionKey?: string } | undefined)?.sessionKey === sessionKey,
  );
}

function waitForSessionsChangedMessagePhase(
  ws: Awaited<ReturnType<Awaited<ReturnType<typeof createGatewaySuiteHarness>>["openWs"]>>,
  sessionKey: string,
) {
  return onceMessage(
    ws,
    (message) =>
      message.type === "event" &&
      message.event === "sessions.changed" &&
      (message.payload as { phase?: string; sessionKey?: string } | undefined)?.phase ===
        "message" &&
      (message.payload as { sessionKey?: string } | undefined)?.sessionKey === sessionKey,
  );
}

async function emitTranscriptUpdateAndCollectEvents(params: {
  ws: Awaited<ReturnType<Awaited<ReturnType<typeof createGatewaySuiteHarness>>["openWs"]>>;
  sessionKey: string;
  sessionId: string;
  message: Record<string, unknown>;
  messageId: string;
}) {
  const messageEventPromise = waitForSessionMessageEvent(params.ws, params.sessionKey);
  const changedEventPromise = waitForSessionsChangedMessagePhase(params.ws, params.sessionKey);

  emitSessionTranscriptUpdate({
    agentId: "main",
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    message: params.message,
    messageId: params.messageId,
  });

  const [messageEvent, changedEvent] = await Promise.all([
    messageEventPromise,
    changedEventPromise,
  ]);
  return { messageEvent, changedEvent };
}

async function expectNoMessageWithin(params: {
  action?: () => Promise<void> | void;
  watch: (timeoutMs: number) => Promise<unknown>;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = params.timeoutMs ?? 300;
  const received = params.watch(timeoutMs).then(
    () => true,
    () => false,
  );
  await params.action?.();
  await expect(received).resolves.toBe(false);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error(`expected ${label} to be an object`);
  }
  return value as Record<string, unknown>;
}

function expectRecordFields(value: unknown, expected: Record<string, unknown>): void {
  const record = requireRecord(value, "record");
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key]).toEqual(expectedValue);
  }
}

describe("session.message websocket events", () => {
  test("includes spawned session ownership metadata on lifecycle sessions.changed events", async () => {
    await setupTranscriptFixtureState();
    await seedGatewaySessionEntries({
      entries: {
        child: {
          sessionId: "sess-child",
          updatedAt: Date.now(),
          spawnedBy: "agent:main:parent",
          spawnedWorkspaceDir: "/tmp/subagent-workspace",
          forkedFromParent: true,
          spawnDepth: 2,
          subagentRole: "orchestrator",
          subagentControlScope: "children",
          displayName: "Ops Child",
        },
      },
    });

    await withOperatorSessionSubscriber(async (ws) => {
      const changedEvent = onceMessage(
        ws,
        (message) =>
          message.type === "event" &&
          message.event === "sessions.changed" &&
          (message.payload as { sessionKey?: string } | undefined)?.sessionKey ===
            "agent:main:child",
      );

      emitSessionLifecycleEvent({
        sessionKey: "agent:main:child",
        reason: "reactivated",
      });

      const event = await changedEvent;
      expectRecordFields(event.payload, {
        sessionKey: "agent:main:child",
        reason: "reactivated",
        spawnedBy: "agent:main:parent",
        spawnedWorkspaceDir: "/tmp/subagent-workspace",
        forkedFromParent: true,
        spawnDepth: 2,
        subagentRole: "orchestrator",
        subagentControlScope: "children",
        displayName: "Ops Child",
      });
    });
  });

  test("only sends transcript events to subscribed operator clients", async () => {
    await setupTranscriptFixtureState();
    await seedGatewaySessionEntries({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
        },
      },
    });

    const subscribedWs = await harness.openWs();
    const unsubscribedWs = await harness.openWs();
    const nodeWs = await harness.openWs();
    try {
      await connectOk(subscribedWs, { scopes: ["operator.read"] });
      await rpcReq(subscribedWs, "sessions.subscribe");
      await connectOk(unsubscribedWs, { scopes: ["operator.read"] });
      await connectOk(nodeWs, { role: "node", scopes: [] });

      const subscribedEvent = onceMessage(
        subscribedWs,
        (message) =>
          message.type === "event" &&
          message.event === "session.message" &&
          (message.payload as { sessionKey?: string } | undefined)?.sessionKey ===
            "agent:main:main",
      );
      const appended = await appendAssistantMessageToSessionTranscript({
        sessionKey: "agent:main:main",
        text: "subscribed only",
      });
      expect(appended.ok).toBe(true);
      const event = await subscribedEvent;
      expectRecordFields(event, {
        type: "event",
        event: "session.message",
      });
      await expectNoMessageWithin({
        watch: (timeoutMs) =>
          onceMessage(
            unsubscribedWs,
            (message) => message.type === "event" && message.event === "session.message",
            timeoutMs,
          ),
      });
      await expectNoMessageWithin({
        watch: (timeoutMs) =>
          onceMessage(
            nodeWs,
            (message) => message.type === "event" && message.event === "session.message",
            timeoutMs,
          ),
      });
    } finally {
      subscribedWs.close();
      unsubscribedWs.close();
      nodeWs.close();
    }
  });

  test("broadcasts appended transcript messages with the session key", async () => {
    await setupTranscriptFixtureState();
    await seedGatewaySessionEntries({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
        },
      },
    });

    const emitSpy = vi.spyOn(transcriptEvents, "emitSessionTranscriptUpdate");
    try {
      const appended = await appendAssistantMessageToSessionTranscript({
        sessionKey: "agent:main:main",
        text: "live websocket message",
      });
      expect(appended.ok).toBe(true);
      if (!appended.ok) {
        throw new Error(`append failed: ${appended.reason}`);
      }
      expect(emitSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "agent:main:main",
          messageId: appended.messageId,
          message: expect.objectContaining({
            role: "assistant",
            content: [{ type: "text", text: "live websocket message" }],
          }),
        }),
      );
      const transcript = loadSqliteSessionTranscriptEvents({
        agentId: "main",
        sessionId: "sess-main",
      }).map((entry) => entry.event);
      expect(transcript).toContainEqual(
        expect.objectContaining({
          message: expect.objectContaining({
            content: [{ type: "text", text: "live websocket message" }],
          }),
        }),
      );
    } finally {
      emitSpy.mockRestore();
    }
  });

  test("strips blocked original content from live session.message events", async () => {
    await setupTranscriptFixtureState();
    await seedGatewaySessionEntries({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
        },
      },
    });
    replaceTranscriptEvents({
      sessionId: "sess-main",
      events: [{ type: "session", version: 1, id: "sess-main" }],
    });

    await withOperatorSessionSubscriber(async (ws) => {
      const { messageEvent } = await emitTranscriptUpdateAndCollectEvents({
        ws,
        sessionKey: "agent:main:main",
        sessionId: "sess-main",
        messageId: "blocked-1",
        message: {
          role: "user",
          content: [{ type: "text", text: "The agent cannot read this message." }],
          __openclaw: {
            beforeAgentRunBlocked: { blockedBy: "policy-plugin", blockedAt: 1 },
          },
        },
      });

      const payload = messageEvent.payload as {
        message?: { content?: unknown; __openclaw?: { beforeAgentRunBlocked?: unknown } };
      };
      expect(payload.message?.content).toEqual([
        { type: "text", text: "The agent cannot read this message." },
      ]);
      expect(JSON.stringify(payload.message)).not.toContain("secret blocked prompt");
      expect(JSON.stringify(payload.message)).not.toContain("contains protected content");
    });
  });

  test("broadcasts redacted blocked user appends to live session listeners", async () => {
    await setupTranscriptFixtureState();
    await seedGatewaySessionEntries({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
        },
      },
    });

    await withOperatorSessionSubscriber(async (ws) => {
      const messageEventPromise = waitForSessionMessageEvent(ws, "agent:main:main");
      emitSessionTranscriptUpdate({
        agentId: "main",
        sessionId: "sess-main",
        sessionKey: "agent:main:main",
        messageId: "blocked-message",
        message: {
          role: "user",
          content: [{ type: "text", text: "The agent cannot read this message." }],
          __openclaw: {
            beforeAgentRunBlocked: {
              blockedBy: "policy-plugin",
              blockedAt: Date.now(),
            },
          },
        },
      });

      const messageEvent = await messageEventPromise;
      const payload = messageEvent.payload as {
        message?: {
          role?: unknown;
          content?: unknown;
          __openclaw?: { beforeAgentRunBlocked?: unknown };
        };
      };
      expect(payload.message?.role).toBe("user");
      expect(payload.message?.content).toEqual([
        { type: "text", text: "The agent cannot read this message." },
      ]);
      expect(JSON.stringify(payload.message)).not.toContain("secret blocked prompt");
      expect(JSON.stringify(payload.message)).not.toContain("contains protected content");
    });
  });

  test("includes live usage metadata on session.message and sessions.changed transcript events", async () => {
    await setupTranscriptFixtureState();
    await seedGatewaySessionEntries({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
          modelProvider: "openai",
          model: "gpt-5.4",
          contextTokens: 123_456,
          totalTokens: 0,
          totalTokensFresh: false,
        },
      },
    });
    const transcriptMessage = {
      role: "assistant",
      content: [{ type: "text", text: "usage snapshot" }],
      provider: "openai",
      model: "gpt-5.4",
      usage: {
        input: 2_000,
        output: 400,
        cacheRead: 300,
        cacheWrite: 100,
        cost: { total: 0.0042 },
      },
      timestamp: Date.now(),
    };
    replaceTranscriptEvents({
      sessionId: "sess-main",
      events: [
        { type: "session", version: 1, id: "sess-main" },
        { id: "msg-usage", message: transcriptMessage },
      ],
    });

    await withOperatorSessionSubscriber(async (ws) => {
      const { messageEvent, changedEvent } = await emitTranscriptUpdateAndCollectEvents({
        ws,
        sessionKey: "agent:main:main",
        sessionId: "sess-main",
        message: transcriptMessage,
        messageId: "msg-usage",
      });
      expectRecordFields(messageEvent.payload, {
        sessionKey: "agent:main:main",
        messageId: "msg-usage",
        messageSeq: 1,
        totalTokens: 2_400,
        totalTokensFresh: true,
        contextTokens: 123_456,
        estimatedCostUsd: 0.0042,
        modelProvider: "openai",
        model: "gpt-5.4",
      });
      expectRecordFields(changedEvent.payload, {
        sessionKey: "agent:main:main",
        phase: "message",
        messageId: "msg-usage",
        messageSeq: 1,
        totalTokens: 2_400,
        totalTokensFresh: true,
        contextTokens: 123_456,
        estimatedCostUsd: 0.0042,
        modelProvider: "openai",
        model: "gpt-5.4",
      });
    });
  });

  test("includes spawnedBy metadata on session.message and sessions.changed transcript events", async () => {
    await setupTranscriptFixtureState();
    await seedGatewaySessionEntries({
      entries: {
        child: {
          sessionId: "sess-child",
          updatedAt: Date.now(),
          spawnedBy: "agent:main:main",
          spawnedWorkspaceDir: "/tmp/subagent-workspace",
          forkedFromParent: true,
          spawnDepth: 2,
          subagentRole: "orchestrator",
          subagentControlScope: "children",
          parentSessionKey: "agent:main:main",
        },
      },
    });
    const transcriptMessage = {
      role: "assistant",
      content: [{ type: "text", text: "spawn metadata snapshot" }],
      timestamp: Date.now(),
    };
    replaceTranscriptEvents({
      sessionId: "sess-child",
      events: [
        { type: "session", version: 1, id: "sess-child" },
        { id: "msg-spawn", message: transcriptMessage },
      ],
    });

    const ws = await harness.openWs();
    try {
      await connectOk(ws, { scopes: ["operator.read"] });
      await rpcReq(ws, "sessions.subscribe");

      const messageEventPromise = onceMessage(
        ws,
        (message) =>
          message.type === "event" &&
          message.event === "session.message" &&
          (message.payload as { sessionKey?: string } | undefined)?.sessionKey ===
            "agent:main:child",
      );
      const changedEventPromise = onceMessage(
        ws,
        (message) =>
          message.type === "event" &&
          message.event === "sessions.changed" &&
          (message.payload as { phase?: string; sessionKey?: string } | undefined)?.phase ===
            "message" &&
          (message.payload as { sessionKey?: string } | undefined)?.sessionKey ===
            "agent:main:child",
      );

      emitSessionTranscriptUpdate({
        agentId: "main",
        sessionId: "sess-child",
        sessionKey: "agent:main:child",
        message: transcriptMessage,
        messageId: "msg-spawn",
      });

      const [messageEvent, changedEvent] = await Promise.all([
        messageEventPromise,
        changedEventPromise,
      ]);
      expectRecordFields(messageEvent.payload, {
        sessionKey: "agent:main:child",
        spawnedBy: "agent:main:main",
        spawnedWorkspaceDir: "/tmp/subagent-workspace",
        forkedFromParent: true,
        spawnDepth: 2,
        subagentRole: "orchestrator",
        subagentControlScope: "children",
        parentSessionKey: "agent:main:main",
      });
      expectRecordFields(changedEvent.payload, {
        sessionKey: "agent:main:child",
        phase: "message",
        spawnedBy: "agent:main:main",
        spawnedWorkspaceDir: "/tmp/subagent-workspace",
        forkedFromParent: true,
        spawnDepth: 2,
        subagentRole: "orchestrator",
        subagentControlScope: "children",
        parentSessionKey: "agent:main:main",
      });
    } finally {
      ws.close();
    }
  });

  test("includes route thread metadata on session.message and sessions.changed transcript events", async () => {
    await setupTranscriptFixtureState();
    await seedGatewaySessionEntries({
      entries: {
        main: {
          sessionId: "sess-thread",
          updatedAt: Date.now(),
          lastChannel: "telegram",
          lastTo: "-100123",
          lastAccountId: "acct-1",
          lastThreadId: 42,
        },
      },
    });
    const transcriptMessage = {
      role: "assistant",
      content: [{ type: "text", text: "thread route snapshot" }],
      timestamp: Date.now(),
    };
    replaceTranscriptEvents({
      sessionId: "sess-thread",
      events: [
        { type: "session", version: 1, id: "sess-thread" },
        { id: "msg-thread", message: transcriptMessage },
      ],
    });

    await withOperatorSessionSubscriber(async (ws) => {
      const { messageEvent, changedEvent } = await emitTranscriptUpdateAndCollectEvents({
        ws,
        sessionKey: "agent:main:main",
        sessionId: "sess-thread",
        message: transcriptMessage,
        messageId: "msg-thread",
      });
      expectRecordFields(messageEvent.payload, {
        sessionKey: "agent:main:main",
        lastChannel: "telegram",
        lastTo: "-100123",
        lastAccountId: "acct-1",
        lastThreadId: 42,
      });
      expectRecordFields(changedEvent.payload, {
        sessionKey: "agent:main:main",
        phase: "message",
        lastChannel: "telegram",
        lastTo: "-100123",
        lastAccountId: "acct-1",
        lastThreadId: 42,
      });
    });
  });

  test("sessions.messages.subscribe only delivers transcript events for the requested session", async () => {
    await setupTranscriptFixtureState();
    await seedGatewaySessionEntries({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
        },
        worker: {
          sessionId: "sess-worker",
          updatedAt: Date.now(),
        },
      },
    });

    const ws = await harness.openWs();
    try {
      await connectOk(ws, { scopes: ["operator.read"] });
      const subscribeRes = await rpcReq(ws, "sessions.messages.subscribe", {
        key: "agent:main:main",
      });
      expect(subscribeRes.ok).toBe(true);
      expect(subscribeRes.payload?.subscribed).toBe(true);
      expect(subscribeRes.payload?.key).toBe("agent:main:main");

      const mainEvent = waitForSessionMessageEvent(ws, "agent:main:main");
      const [mainAppend] = await Promise.all([
        appendAssistantMessageToSessionTranscript({
          sessionKey: "agent:main:main",
          text: "main only",
        }),
        mainEvent,
      ]);
      expect(mainAppend.ok).toBe(true);

      await expectNoMessageWithin({
        watch: (timeoutMs) =>
          onceMessage(
            ws,
            (message) =>
              message.type === "event" &&
              message.event === "session.message" &&
              (message.payload as { sessionKey?: string } | undefined)?.sessionKey ===
                "agent:main:worker",
            timeoutMs,
          ),
        action: async () => {
          const workerAppend = await appendAssistantMessageToSessionTranscript({
            sessionKey: "agent:main:worker",
            text: "worker hidden",
          });
          expect(workerAppend.ok).toBe(true);
        },
      });

      const unsubscribeRes = await rpcReq(ws, "sessions.messages.unsubscribe", {
        key: "agent:main:main",
      });
      expect(unsubscribeRes.ok).toBe(true);
      expect(unsubscribeRes.payload?.subscribed).toBe(false);

      await expectNoMessageWithin({
        watch: (timeoutMs) =>
          onceMessage(
            ws,
            (message) =>
              message.type === "event" &&
              message.event === "session.message" &&
              (message.payload as { sessionKey?: string } | undefined)?.sessionKey ===
                "agent:main:main",
            timeoutMs,
          ),
        action: async () => {
          const hiddenAppend = await appendAssistantMessageToSessionTranscript({
            sessionKey: "agent:main:main",
            text: "hidden after unsubscribe",
          });
          expect(hiddenAppend.ok).toBe(true);
        },
      });
    } finally {
      ws.close();
    }
  });
});
