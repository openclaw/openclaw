import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { appendAssistantMessageToSessionTranscript } from "../config/sessions/transcript.js";
import { emitSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { testState } from "./test-helpers.mocks.js";
import {
  connectOk,
  createGatewaySuiteHarness,
  installGatewayTestHooks,
  onceMessage,
  rpcReq,
  writeSessionStore,
} from "./test-helpers.server.js";

installGatewayTestHooks();

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function createSessionStoreFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-message-"));
  cleanupDirs.push(dir);
  const storePath = path.join(dir, "sessions.json");
  testState.sessionStorePath = storePath;
  return storePath;
}

async function expectNoMessageWithin(params: {
  action?: () => Promise<void> | void;
  watch: () => Promise<unknown>;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = params.timeoutMs ?? 300;
  vi.useFakeTimers();
  try {
    const outcome = params
      .watch()
      .then(() => "received")
      .catch(() => "timeout");
    await params.action?.();
    await vi.advanceTimersByTimeAsync(timeoutMs);
    await expect(outcome).resolves.toBe("timeout");
  } finally {
    vi.useRealTimers();
  }
}

describe("session.message websocket events", () => {
  test("only sends transcript events to subscribed operator clients", async () => {
    const storePath = await createSessionStoreFile();
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
        },
      },
      storePath,
    });

    const harness = await createGatewaySuiteHarness();
    try {
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
          storePath,
        });
        expect(appended.ok).toBe(true);
        await expect(subscribedEvent).resolves.toBeTruthy();
        await expectNoMessageWithin({
          watch: () =>
            onceMessage(
              unsubscribedWs,
              (message) => message.type === "event" && message.event === "session.message",
              300,
            ),
        });
        await expectNoMessageWithin({
          watch: () =>
            onceMessage(
              nodeWs,
              (message) => message.type === "event" && message.event === "session.message",
              300,
            ),
        });
      } finally {
        subscribedWs.close();
        unsubscribedWs.close();
        nodeWs.close();
      }
    } finally {
      await harness.close();
    }
  });

  test("broadcasts appended transcript messages with the session key", async () => {
    const storePath = await createSessionStoreFile();
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
        },
      },
      storePath,
    });

    const harness = await createGatewaySuiteHarness();
    try {
      const ws = await harness.openWs();
      try {
        await connectOk(ws, { scopes: ["operator.read"] });
        await rpcReq(ws, "sessions.subscribe");

        const appendPromise = appendAssistantMessageToSessionTranscript({
          sessionKey: "agent:main:main",
          text: "live websocket message",
          storePath,
        });
        const eventPromise = onceMessage(
          ws,
          (message) =>
            message.type === "event" &&
            message.event === "session.message" &&
            (message.payload as { sessionKey?: string } | undefined)?.sessionKey ===
              "agent:main:main",
        );

        const [appended, event] = await Promise.all([appendPromise, eventPromise]);
        expect(appended.ok).toBe(true);
        if (!appended.ok) {
          throw new Error(`append failed: ${appended.reason}`);
        }
        expect(
          (event.payload as { message?: { content?: Array<{ text?: string }> } }).message
            ?.content?.[0]?.text,
        ).toBe("live websocket message");
        expect((event.payload as { messageSeq?: number }).messageSeq).toBe(1);
        expect(
          (
            event.payload as {
              message?: { __openclaw?: { id?: string; seq?: number } };
            }
          ).message?.__openclaw,
        ).toMatchObject({
          id: appended.ok ? appended.messageId : undefined,
          seq: 1,
        });
      } finally {
        ws.close();
      }
    } finally {
      await harness.close();
    }
  });

  test("includes live usage metadata on session.message and sessions.changed transcript events", async () => {
    const storePath = await createSessionStoreFile();
    await writeSessionStore({
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
      storePath,
    });
    const transcriptPath = path.join(path.dirname(storePath), "sess-main.jsonl");
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
    await fs.writeFile(
      transcriptPath,
      [
        JSON.stringify({ type: "session", version: 1, id: "sess-main" }),
        JSON.stringify({ id: "msg-usage", message: transcriptMessage }),
      ].join("\n"),
      "utf-8",
    );

    const harness = await createGatewaySuiteHarness();
    try {
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
              "agent:main:main",
        );
        const changedEventPromise = onceMessage(
          ws,
          (message) =>
            message.type === "event" &&
            message.event === "sessions.changed" &&
            (message.payload as { phase?: string; sessionKey?: string } | undefined)?.phase ===
              "message" &&
            (message.payload as { sessionKey?: string } | undefined)?.sessionKey ===
              "agent:main:main",
        );

        emitSessionTranscriptUpdate({
          sessionFile: transcriptPath,
          sessionKey: "agent:main:main",
          message: transcriptMessage,
          messageId: "msg-usage",
        });

        const [messageEvent, changedEvent] = await Promise.all([
          messageEventPromise,
          changedEventPromise,
        ]);
        expect(messageEvent.payload).toMatchObject({
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
        expect(changedEvent.payload).toMatchObject({
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
      } finally {
        ws.close();
      }
    } finally {
      await harness.close();
    }
  });

  test("sessions.messages.subscribe only delivers transcript events for the requested session", async () => {
    const storePath = await createSessionStoreFile();
    await writeSessionStore({
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
      storePath,
    });

    const harness = await createGatewaySuiteHarness();
    try {
      const ws = await harness.openWs();
      try {
        await connectOk(ws, { scopes: ["operator.read"] });
        const subscribeRes = await rpcReq(ws, "sessions.messages.subscribe", {
          key: "agent:main:main",
        });
        expect(subscribeRes.ok).toBe(true);
        expect(subscribeRes.payload?.subscribed).toBe(true);
        expect(subscribeRes.payload?.key).toBe("agent:main:main");

        const mainEvent = onceMessage(
          ws,
          (message) =>
            message.type === "event" &&
            message.event === "session.message" &&
            (message.payload as { sessionKey?: string } | undefined)?.sessionKey ===
              "agent:main:main",
        );
        const [mainAppend] = await Promise.all([
          appendAssistantMessageToSessionTranscript({
            sessionKey: "agent:main:main",
            text: "main only",
            storePath,
          }),
          mainEvent,
        ]);
        expect(mainAppend.ok).toBe(true);

        await expectNoMessageWithin({
          watch: () =>
            onceMessage(
              ws,
              (message) =>
                message.type === "event" &&
                message.event === "session.message" &&
                (message.payload as { sessionKey?: string } | undefined)?.sessionKey ===
                  "agent:main:worker",
              300,
            ),
          action: async () => {
            const workerAppend = await appendAssistantMessageToSessionTranscript({
              sessionKey: "agent:main:worker",
              text: "worker hidden",
              storePath,
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
          watch: () =>
            onceMessage(
              ws,
              (message) =>
                message.type === "event" &&
                message.event === "session.message" &&
                (message.payload as { sessionKey?: string } | undefined)?.sessionKey ===
                  "agent:main:main",
              300,
            ),
          action: async () => {
            const hiddenAppend = await appendAssistantMessageToSessionTranscript({
              sessionKey: "agent:main:main",
              text: "hidden after unsubscribe",
              storePath,
            });
            expect(hiddenAppend.ok).toBe(true);
          },
        });
      } finally {
        ws.close();
      }
    } finally {
      await harness.close();
    }
  });
});
