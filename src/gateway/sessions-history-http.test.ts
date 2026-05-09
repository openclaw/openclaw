import { describe, expect, test } from "vitest";
import type { AssistantMessage } from "../agents/pi-ai-contract.js";
import { replaceSqliteSessionTranscriptEvents } from "../config/sessions/transcript-store.sqlite.js";
import {
  appendAssistantMessageToSessionTranscript,
  appendExactAssistantMessageToSessionTranscript,
} from "../config/sessions/transcript.js";
import { runOpenClawAgentWriteTransaction } from "../state/openclaw-agent-db.js";
import {
  connectReq,
  createGatewaySuiteHarness,
  installGatewayTestHooks,
  rpcReq,
  startServerWithClient,
  seedGatewaySessionEntries,
} from "./test-helpers.server.js";

installGatewayTestHooks();

const AUTH_HEADER = { Authorization: "Bearer test-gateway-token-1234567890" };
const READ_SCOPE_HEADER = { "x-openclaw-scopes": "operator.read" };
const AGENT_ID = "main";

async function configureSessionRowTarget(): Promise<void> {
  await seedGatewaySessionEntries({ entries: {} });
}

async function seedSession(params?: { text?: string }) {
  await configureSessionRowTarget();
  await seedGatewaySessionEntries({
    entries: {
      main: {
        sessionId: "sess-main",
        updatedAt: Date.now(),
      },
    },
  });
  if (params?.text) {
    const appended = await appendAssistantMessageToSessionTranscript({
      sessionKey: "agent:main:main",
      text: params.text,
    });
    expect(appended.ok).toBe(true);
  }
}

function makeTranscriptAssistantMessage(params: {
  text: string;
  content?: AssistantMessage["content"];
}): AssistantMessage {
  return {
    role: "assistant" as const,
    content: params.content ?? [{ type: "text", text: params.text }],
    api: "openai-responses",
    provider: "openclaw",
    model: "delivery-mirror",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };
}

async function appendTranscriptMessage(params: {
  sessionKey: string;
  message: AssistantMessage;
  emitInlineMessage?: boolean;
}): Promise<string> {
  const appended = await appendExactAssistantMessageToSessionTranscript({
    sessionKey: params.sessionKey,
    updateMode: params.emitInlineMessage === false ? "signal-only" : "inline",
    message: params.message,
  });
  expect(appended.ok).toBe(true);
  if (!appended.ok) {
    throw new Error(`append failed: ${appended.reason}`);
  }
  return appended.messageId;
}

async function fetchSessionHistory(
  port: number,
  sessionKey: string,
  params?: {
    query?: string;
    headers?: HeadersInit;
  },
) {
  const headers = new Headers();
  for (const [key, value] of new Headers(READ_SCOPE_HEADER).entries()) {
    headers.set(key, value);
  }
  for (const [key, value] of new Headers(params?.headers).entries()) {
    headers.set(key, value);
  }
  return fetch(
    `http://127.0.0.1:${port}/sessions/${encodeURIComponent(sessionKey)}/history${params?.query ?? ""}`,
    {
      headers,
    },
  );
}

async function withGatewayHarness<T>(
  run: (harness: Awaited<ReturnType<typeof createGatewaySuiteHarness>>) => Promise<T>,
) {
  const harness = await createGatewaySuiteHarness({
    serverOptions: {
      auth: { mode: "none" },
    },
  });
  try {
    return await run(harness);
  } finally {
    await harness.close();
  }
}

async function expectSessionHistoryText(params: { sessionKey: string; expectedText: string }) {
  await withGatewayHarness(async (harness) => {
    const res = await fetchSessionHistory(harness.port, params.sessionKey);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessionKey?: string;
      messages?: Array<{ content?: Array<{ text?: string }> }>;
    };
    expect(body.sessionKey).toBe(params.sessionKey);
    expect(body.messages?.[0]?.content?.[0]?.text).toBe(params.expectedText);
  });
}

async function readSseEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  state: { buffer: string },
): Promise<{ event: string; data: unknown }> {
  const decoder = new TextDecoder();
  while (true) {
    const boundary = state.buffer.indexOf("\n\n");
    if (boundary >= 0) {
      const rawEvent = state.buffer.slice(0, boundary);
      state.buffer = state.buffer.slice(boundary + 2);
      const lines = rawEvent.split("\n");
      const event =
        lines
          .find((line) => line.startsWith("event:"))
          ?.slice("event:".length)
          .trim() ?? "message";
      const data = lines
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trim())
        .join("\n");
      if (!data) {
        continue;
      }
      return { event, data: JSON.parse(data) };
    }
    const chunk = await reader.read();
    if (chunk.done) {
      throw new Error("SSE stream ended before next event");
    }
    state.buffer += decoder.decode(chunk.value, { stream: true });
  }
}

type SessionHistorySseStream = {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  streamState: { buffer: string };
};

async function openSessionHistorySse(
  port: number,
  sessionKey: string,
  params?: { query?: string },
): Promise<SessionHistorySseStream> {
  const res = await fetchSessionHistory(port, sessionKey, {
    query: params?.query,
    headers: { Accept: "text/event-stream" },
  });
  expect(res.status).toBe(200);
  const reader = res.body?.getReader();
  if (reader === undefined) {
    throw new Error("expected session-history SSE reader");
  }
  return { reader, streamState: { buffer: "" } };
}

async function expectHistoryEventTexts(stream: SessionHistorySseStream, expectedTexts: string[]) {
  const event = await readSseEvent(stream.reader, stream.streamState);
  expect(event.event).toBe("history");
  expect(
    (event.data as { messages?: Array<{ content?: Array<{ text?: string }> }> }).messages?.map(
      (message) => message.content?.[0]?.text,
    ),
  ).toEqual(expectedTexts);
  return event;
}

async function expectMessageEventMatch(
  stream: SessionHistorySseStream,
  params: { text: string; seq: number; id?: string },
) {
  const event = await readSseEvent(stream.reader, stream.streamState);
  expect(event.event).toBe("message");
  expect(
    (event.data as { message?: { content?: Array<{ text?: string }> } }).message?.content?.[0]
      ?.text,
  ).toBe(params.text);
  expect((event.data as { messageSeq?: number }).messageSeq).toBe(params.seq);
  if (params.id !== undefined) {
    expect(
      (event.data as { message?: { __openclaw?: { id?: string; seq?: number } } }).message
        ?.__openclaw,
    ).toMatchObject({
      id: params.id,
      seq: params.seq,
    });
  }
  return event;
}

async function openBoundedHistoryStreamWithSecondMessage(
  harnessPort: number,
): Promise<SessionHistorySseStream> {
  const second = await appendAssistantMessageToSessionTranscript({
    sessionKey: "agent:main:main",
    text: "second message",
  });
  expect(second.ok).toBe(true);

  const stream = await openSessionHistorySse(harnessPort, "agent:main:main", {
    query: "?limit=1",
  });
  await expectHistoryEventTexts(stream, ["second message"]);
  return stream;
}

describe("session history HTTP endpoints", () => {
  test("returns session history over direct REST", async () => {
    await seedSession({ text: "hello from history" });
    await withGatewayHarness(async (harness) => {
      const res = await fetchSessionHistory(harness.port, "agent:main:main");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        sessionKey?: string;
        messages?: Array<{ content?: Array<{ text?: string }> }>;
      };
      expect(body.sessionKey).toBe("agent:main:main");
      expect(body.messages).toHaveLength(1);
      expect(body.messages?.[0]?.content?.[0]?.text).toBe("hello from history");
      expect(
        (
          body.messages?.[0] as {
            __openclaw?: { id?: string; seq?: number };
          }
        )?.__openclaw,
      ).toMatchObject({
        seq: 1,
      });
    });
  });

  test("returns 404 for unknown sessions", async () => {
    await configureSessionRowTarget();
    await withGatewayHarness(async (harness) => {
      const res = await fetchSessionHistory(harness.port, "agent:main:missing");
      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toMatchObject({
        ok: false,
        error: {
          type: "not_found",
          message: "Session not found: agent:main:missing",
        },
      });
    });
  });

  test("uses the canonical row for direct history reads", async () => {
    await configureSessionRowTarget();
    replaceSqliteSessionTranscriptEvents({
      agentId: AGENT_ID,
      sessionId: "sess-stale-main",
      events: [
        { type: "session", version: 1, id: "sess-stale-main" },
        {
          message: { role: "assistant", content: [{ type: "text", text: "stale history" }] },
        },
      ],
    });
    replaceSqliteSessionTranscriptEvents({
      agentId: AGENT_ID,
      sessionId: "sess-fresh-main",
      events: [
        { type: "session", version: 1, id: "sess-fresh-main" },
        {
          message: { role: "assistant", content: [{ type: "text", text: "fresh history" }] },
        },
      ],
    });
    runOpenClawAgentWriteTransaction(
      (database) => {
        const insert = database.db.prepare(`
        INSERT INTO session_entries (session_key, entry_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(session_key) DO UPDATE SET
          entry_json = excluded.entry_json,
          updated_at = excluded.updated_at
      `);
        insert.run(
          "agent:main:main",
          JSON.stringify({
            sessionId: "sess-stale-main",
            updatedAt: 1,
          }),
          1,
        );
        insert.run(
          "agent:main:MAIN",
          JSON.stringify({
            sessionId: "sess-fresh-main",
            updatedAt: 2,
          }),
          2,
        );
      },
      { agentId: AGENT_ID },
    );

    await expectSessionHistoryText({
      sessionKey: "agent:main:main",
      expectedText: "stale history",
    });
  });

  test("supports cursor pagination over direct REST while preserving the messages field", async () => {
    await seedSession({ text: "first message" });
    const second = await appendAssistantMessageToSessionTranscript({
      sessionKey: "agent:main:main",
      text: "second message",
    });
    expect(second.ok).toBe(true);
    const third = await appendAssistantMessageToSessionTranscript({
      sessionKey: "agent:main:main",
      text: "third message",
    });
    expect(third.ok).toBe(true);

    await withGatewayHarness(async (harness) => {
      const firstPage = await fetchSessionHistory(harness.port, "agent:main:main", {
        query: "?limit=2",
      });
      expect(firstPage.status).toBe(200);
      const firstBody = (await firstPage.json()) as {
        sessionKey?: string;
        items?: Array<{ content?: Array<{ text?: string }>; __openclaw?: { seq?: number } }>;
        messages?: Array<{ content?: Array<{ text?: string }>; __openclaw?: { seq?: number } }>;
        nextCursor?: string;
        hasMore?: boolean;
      };
      expect(firstBody.sessionKey).toBe("agent:main:main");
      expect(firstBody.items?.map((message) => message.content?.[0]?.text)).toEqual([
        "second message",
        "third message",
      ]);
      expect(firstBody.messages?.map((message) => message.__openclaw?.seq)).toEqual([2, 3]);
      expect(firstBody.hasMore).toBe(true);
      expect(firstBody.nextCursor).toBe("2");

      const secondPage = await fetchSessionHistory(harness.port, "agent:main:main", {
        query: `?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor ?? "")}`,
      });
      expect(secondPage.status).toBe(200);
      const secondBody = (await secondPage.json()) as {
        items?: Array<{ content?: Array<{ text?: string }>; __openclaw?: { seq?: number } }>;
        messages?: Array<{ __openclaw?: { seq?: number } }>;
        nextCursor?: string;
        hasMore?: boolean;
      };
      expect(secondBody.items?.map((message) => message.content?.[0]?.text)).toEqual([
        "first message",
      ]);
      expect(secondBody.messages?.map((message) => message.__openclaw?.seq)).toEqual([1]);
      expect(secondBody.hasMore).toBe(false);
      expect(secondBody.nextCursor).toBeUndefined();
    });
  });

  test("streams bounded history windows over SSE", async () => {
    await seedSession({ text: "first message" });

    await withGatewayHarness(async (harness) => {
      const stream = await openBoundedHistoryStreamWithSecondMessage(harness.port);

      const thirdMessageId = await appendTranscriptMessage({
        sessionKey: "agent:main:main",
        emitInlineMessage: false,
        message: makeTranscriptAssistantMessage({ text: "third message" }),
      });

      const nextEvent = await readSseEvent(stream.reader, stream.streamState);
      expect(nextEvent.event).toBe("history");
      const nextData = nextEvent.data as {
        messages?: Array<{
          content?: Array<{ text?: string }>;
          __openclaw?: { id?: string; seq?: number };
        }>;
      };
      expect(nextData.messages?.[0]?.content?.[0]?.text).toBe("third message");
      expect(nextData.messages?.[0]?.__openclaw).toMatchObject({
        id: thirdMessageId,
        seq: 3,
      });

      await stream.reader.cancel();
    });
  });

  test("seeds bounded SSE windows from visible history when transcript refreshes are silent", async () => {
    await seedSession({ text: "first message" });

    await withGatewayHarness(async (harness) => {
      const stream = await openBoundedHistoryStreamWithSecondMessage(harness.port);

      await appendTranscriptMessage({
        sessionKey: "agent:main:main",
        emitInlineMessage: false,
        message: makeTranscriptAssistantMessage({ text: "NO_REPLY" }),
      });

      const refreshEvent = await readSseEvent(stream.reader, stream.streamState);
      expect(refreshEvent.event).toBe("history");
      const refreshData = refreshEvent.data as {
        messages?: Array<{ content?: Array<{ text?: string }>; __openclaw?: { seq?: number } }>;
      };
      expect(refreshData.messages?.[0]?.content?.[0]?.text).toBe("second message");
      expect(refreshData.messages?.[0]?.__openclaw?.seq).toBe(2);

      await stream.reader.cancel();
    });
  });

  test("sanitizes phased assistant history entries before returning them", async () => {
    await configureSessionRowTarget();
    await seedGatewaySessionEntries({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
        },
      },
    });

    await withGatewayHarness(async (harness) => {
      const hidden = await appendAssistantMessageToSessionTranscript({
        sessionKey: "agent:main:main",
        text: "NO_REPLY",
      });
      expect(hidden.ok).toBe(true);

      if (!hidden.ok) {
        throw new Error(`append failed: ${hidden.reason}`);
      }
      const visibleMessageId = await appendTranscriptMessage({
        sessionKey: "agent:main:main",
        message: makeTranscriptAssistantMessage({
          text: "Done.",
          content: [
            {
              type: "text",
              text: "internal reasoning",
              textSignature: JSON.stringify({ v: 1, id: "item_commentary", phase: "commentary" }),
            },
            {
              type: "text",
              text: "Done.",
              textSignature: JSON.stringify({ v: 1, id: "item_final", phase: "final_answer" }),
            },
          ],
        }),
        emitInlineMessage: false,
      });

      const historyRes = await fetchSessionHistory(harness.port, "agent:main:main");
      expect(historyRes.status).toBe(200);
      const body = (await historyRes.json()) as {
        sessionKey?: string;
        messages?: Array<{
          content?: Array<{ text?: string }>;
          __openclaw?: { id?: string; seq?: number };
        }>;
      };
      expect(body.sessionKey).toBe("agent:main:main");
      expect(body.messages).toHaveLength(1);
      expect(body.messages?.[0]?.content?.[0]?.text).toBe("Done.");
      expect(body.messages?.[0]?.__openclaw).toMatchObject({
        id: visibleMessageId,
        seq: 2,
      });
    });
  });

  test("streams session history updates over SSE", async () => {
    await seedSession({ text: "first message" });

    await withGatewayHarness(async (harness) => {
      const stream = await openSessionHistorySse(harness.port, "agent:main:main");
      await expectHistoryEventTexts(stream, ["first message"]);

      const appended = await appendAssistantMessageToSessionTranscript({
        sessionKey: "agent:main:main",
        text: "second message",
      });
      expect(appended.ok).toBe(true);

      if (!appended.ok) {
        throw new Error(`append failed: ${appended.reason}`);
      }
      await expectMessageEventMatch(stream, {
        text: "second message",
        seq: 2,
        id: appended.messageId,
      });

      await stream.reader.cancel();
    });
  });

  test("seeds SSE raw sequence state from startup snapshots, not only visible history", async () => {
    await seedSession({ text: "first message" });
    await appendTranscriptMessage({
      sessionKey: "agent:main:main",
      message: makeTranscriptAssistantMessage({ text: "NO_REPLY" }),
      emitInlineMessage: false,
    });

    await withGatewayHarness(async (harness) => {
      const stream = await openSessionHistorySse(harness.port, "agent:main:main");
      await expectHistoryEventTexts(stream, ["first message"]);

      const visible = await appendAssistantMessageToSessionTranscript({
        sessionKey: "agent:main:main",
        text: "third visible message",
      });
      expect(visible.ok).toBe(true);

      await expectMessageEventMatch(stream, {
        text: "third visible message",
        seq: 3,
      });

      await stream.reader.cancel();
    });
  });

  test("suppresses NO_REPLY-only SSE fast-path updates while preserving raw sequence numbering", async () => {
    await seedSession({ text: "first message" });

    await withGatewayHarness(async (harness) => {
      const stream = await openSessionHistorySse(harness.port, "agent:main:main");
      await expectHistoryEventTexts(stream, ["first message"]);

      const silent = await appendAssistantMessageToSessionTranscript({
        sessionKey: "agent:main:main",
        text: "NO_REPLY",
      });
      expect(silent.ok).toBe(true);

      const visible = await appendAssistantMessageToSessionTranscript({
        sessionKey: "agent:main:main",
        text: "third visible message",
      });
      expect(visible.ok).toBe(true);

      if (!visible.ok) {
        throw new Error(`append failed: ${visible.reason}`);
      }
      await expectMessageEventMatch(stream, {
        text: "third visible message",
        seq: 3,
        id: visible.messageId,
      });

      await stream.reader.cancel();
    });
  });

  test("resyncs raw sequence numbering after transcript-only SSE refreshes", async () => {
    await seedSession({ text: "first message" });

    await withGatewayHarness(async (harness) => {
      const stream = await openSessionHistorySse(harness.port, "agent:main:main");
      await expectHistoryEventTexts(stream, ["first message"]);

      const second = await appendAssistantMessageToSessionTranscript({
        sessionKey: "agent:main:main",
        text: "second visible message",
      });
      expect(second.ok).toBe(true);

      if (!second.ok) {
        throw new Error(`append failed: ${second.reason}`);
      }
      await expectMessageEventMatch(stream, {
        text: "second visible message",
        seq: 2,
      });
      await appendTranscriptMessage({
        sessionKey: "agent:main:main",
        message: makeTranscriptAssistantMessage({ text: "NO_REPLY" }),
        emitInlineMessage: false,
      });

      const refreshEvent = await readSseEvent(stream.reader, stream.streamState);
      expect(refreshEvent.event).toBe("history");
      expect(
        (
          refreshEvent.data as { messages?: Array<{ content?: Array<{ text?: string }> }> }
        ).messages?.map((message) => message.content?.[0]?.text),
      ).toEqual(["first message", "second visible message"]);

      const third = await appendAssistantMessageToSessionTranscript({
        sessionKey: "agent:main:main",
        text: "third visible message",
      });
      expect(third.ok).toBe(true);

      if (!third.ok) {
        throw new Error(`append failed: ${third.reason}`);
      }
      await expectMessageEventMatch(stream, {
        text: "third visible message",
        seq: 4,
        id: third.messageId,
      });

      await stream.reader.cancel();
    });
  });

  test("rejects session history when operator.read is not requested", async () => {
    await seedSession({ text: "scope-guarded history" });

    const started = await startServerWithClient("test-gateway-token-1234567890");
    const { server, ws, port, envSnapshot } = started;
    try {
      const connect = await connectReq(ws, {
        token: "test-gateway-token-1234567890",
        scopes: ["operator.approvals"],
      });
      expect(connect.ok).toBe(true);

      const wsHistory = await rpcReq<{ messages?: unknown[] }>(ws, "chat.history", {
        sessionKey: "agent:main:main",
        limit: 1,
      });
      expect(wsHistory.ok).toBe(false);
      expect(wsHistory.error?.message).toBe("missing scope: operator.read");

      const httpHistory = await fetch(
        `http://127.0.0.1:${port}/sessions/${encodeURIComponent("agent:main:main")}/history?limit=1`,
        {
          headers: {
            ...AUTH_HEADER,
            "x-openclaw-scopes": "operator.approvals",
          },
        },
      );
      expect(httpHistory.status).toBe(403);
      await expect(httpHistory.json()).resolves.toMatchObject({
        ok: false,
        error: {
          type: "forbidden",
          message: "missing scope: operator.read",
        },
      });

      const httpHistoryWithoutScopes = await fetch(
        `http://127.0.0.1:${port}/sessions/${encodeURIComponent("agent:main:main")}/history?limit=1`,
        {
          headers: AUTH_HEADER,
        },
      );
      expect(httpHistoryWithoutScopes.status).toBe(403);
      await expect(httpHistoryWithoutScopes.json()).resolves.toMatchObject({
        ok: false,
        error: {
          type: "forbidden",
          message: "missing scope: operator.read",
        },
      });
    } finally {
      ws.close();
      await server.close();
      envSnapshot.restore();
    }
  });
});
