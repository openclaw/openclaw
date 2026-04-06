import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, test } from "vitest";
import {
  appendAssistantMessageToSessionTranscript,
  appendExactAssistantMessageToSessionTranscript,
} from "../config/sessions/transcript.js";
import { testState } from "./test-helpers.runtime-state.js";
import {
  connectReq,
  createGatewaySuiteHarness,
  installGatewayTestHooks,
  rpcReq,
  writeSessionStore,
} from "./test-helpers.server.js";

installGatewayTestHooks();

const AUTH_HEADER = { Authorization: "Bearer test-gateway-token-1234567890" };
const READ_SCOPE_HEADER = { "x-openclaw-scopes": "operator.read" };
const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function createSessionStoreFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-history-"));
  cleanupDirs.push(dir);
  const storePath = path.join(dir, "sessions.json");
  testState.sessionStorePath = storePath;
  return storePath;
}

async function seedSession(params?: { text?: string }) {
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
  if (params?.text) {
    const appended = await appendAssistantMessageToSessionTranscript({
      sessionKey: "agent:main:main",
      text: params.text,
      storePath,
    });
    expect(appended.ok).toBe(true);
  }
  return { storePath };
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
  storePath?: string;
}): Promise<string> {
  const appended = await appendExactAssistantMessageToSessionTranscript({
    sessionKey: params.sessionKey,
    storePath: params.storePath ?? testState.sessionStorePath,
    updateMode: params.emitInlineMessage === false ? "file-only" : "inline",
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
    await createSessionStoreFile();
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

  test("prefers the freshest duplicate row for direct history reads", async () => {
    const storePath = await createSessionStoreFile();
    const dir = path.dirname(storePath);
    const staleTranscriptPath = path.join(dir, "sess-stale-main.jsonl");
    const freshTranscriptPath = path.join(dir, "sess-fresh-main.jsonl");
    await fs.writeFile(
      staleTranscriptPath,
      [
        JSON.stringify({ type: "session", version: 1, id: "sess-stale-main" }),
        JSON.stringify({
          message: { role: "assistant", content: [{ type: "text", text: "stale history" }] },
        }),
      ].join("\n"),
      "utf-8",
    );
    await fs.writeFile(
      freshTranscriptPath,
      [
        JSON.stringify({ type: "session", version: 1, id: "sess-fresh-main" }),
        JSON.stringify({
          message: { role: "assistant", content: [{ type: "text", text: "fresh history" }] },
        }),
      ].join("\n"),
      "utf-8",
    );
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          "agent:main:main": {
            sessionId: "sess-stale-main",
            sessionFile: staleTranscriptPath,
            updatedAt: 1,
          },
          "agent:main:MAIN": {
            sessionId: "sess-fresh-main",
            sessionFile: freshTranscriptPath,
            updatedAt: 2,
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    await expectSessionHistoryText({
      sessionKey: "agent:main:main",
      expectedText: "fresh history",
    });
  });

  test("supports cursor pagination over direct REST while preserving the messages field", async () => {
    const { storePath } = await seedSession({ text: "first message" });
    const second = await appendAssistantMessageToSessionTranscript({
      sessionKey: "agent:main:main",
      text: "second message",
      storePath,
    });
    expect(second.ok).toBe(true);
    const third = await appendAssistantMessageToSessionTranscript({
      sessionKey: "agent:main:main",
      text: "third message",
      storePath,
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
    const { storePath } = await seedSession({ text: "first message" });
    const second = await appendAssistantMessageToSessionTranscript({
      sessionKey: "agent:main:main",
      text: "second message",
      storePath,
    });
    expect(second.ok).toBe(true);

    await withGatewayHarness(async (harness) => {
      const res = await fetchSessionHistory(harness.port, "agent:main:main", {
        query: "?limit=1",
        headers: { Accept: "text/event-stream" },
      });

      expect(res.status).toBe(200);
      const reader = res.body?.getReader();
      expect(reader).toBeTruthy();
      const streamState = { buffer: "" };
      const historyEvent = await readSseEvent(reader!, streamState);
      expect(historyEvent.event).toBe("history");
      expect(
        (historyEvent.data as { messages?: Array<{ content?: Array<{ text?: string }> }> })
          .messages?.[0]?.content?.[0]?.text,
      ).toBe("second message");

      const appended = await appendAssistantMessageToSessionTranscript({
        sessionKey: "agent:main:main",
        text: "third message",
        storePath,
      });
      expect(appended.ok).toBe(true);

      const nextEvent = await readSseEvent(reader!, streamState);
      expect(nextEvent.event).toBe("history");
      expect(
        (nextEvent.data as { messages?: Array<{ content?: Array<{ text?: string }> }> })
          .messages?.[0]?.content?.[0]?.text,
      ).toBe("third message");

      await reader?.cancel();
    });
  });

  test("sanitizes phased assistant history entries before returning them", async () => {
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

    await withGatewayHarness(async (harness) => {
      const hidden = await appendAssistantMessageToSessionTranscript({
        sessionKey: "agent:main:main",
        text: "NO_REPLY",
        storePath,
      });
      expect(hidden.ok).toBe(true);

      if (!hidden.ok) {
        throw new Error(`append failed: ${hidden.reason}`);
      }
      const visibleMessageId = await appendTranscriptMessage({
        sessionKey: "agent:main:main",
        storePath,
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
    const { storePath } = await seedSession({ text: "first message" });

    await withGatewayHarness(async (harness) => {
      const res = await fetchSessionHistory(harness.port, "agent:main:main", {
        headers: { Accept: "text/event-stream" },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");
      const reader = res.body?.getReader();
      expect(reader).toBeTruthy();
      const streamState = { buffer: "" };
      const historyEvent = await readSseEvent(reader!, streamState);
      expect(historyEvent.event).toBe("history");
      expect(
        (historyEvent.data as { messages?: Array<{ content?: Array<{ text?: string }> }> })
          .messages?.[0]?.content?.[0]?.text,
      ).toBe("first message");

      const appended = await appendAssistantMessageToSessionTranscript({
        sessionKey: "agent:main:main",
        text: "second message",
        storePath,
      });
      expect(appended.ok).toBe(true);

      const messageEvent = await readSseEvent(reader!, streamState);
      expect(messageEvent.event).toBe("message");
      expect(
        (
          messageEvent.data as {
            sessionKey?: string;
            message?: { content?: Array<{ text?: string }> };
          }
        ).sessionKey,
      ).toBe("agent:main:main");
      expect(
        (messageEvent.data as { message?: { content?: Array<{ text?: string }> } }).message
          ?.content?.[0]?.text,
      ).toBe("second message");
      expect((messageEvent.data as { messageSeq?: number }).messageSeq).toBe(2);
      if (!appended.ok) {
        throw new Error(`append failed: ${appended.reason}`);
      }
      expect(
        (
          messageEvent.data as {
            message?: { __openclaw?: { id?: string; seq?: number } };
          }
        ).message?.__openclaw,
      ).toMatchObject({
        id: appended.ok ? appended.messageId : undefined,
        seq: 2,
      });

      await reader?.cancel();
    });
  });

  test("suppresses NO_REPLY-only SSE fast-path updates while preserving raw sequence numbering", async () => {
    const { storePath } = await seedSession({ text: "first message" });

    await withGatewayHarness(async (harness) => {
      const res = await fetchSessionHistory(harness.port, "agent:main:main", {
        headers: { Accept: "text/event-stream" },
      });

      expect(res.status).toBe(200);
      const reader = res.body?.getReader();
      expect(reader).toBeTruthy();
      const streamState = { buffer: "" };
      await readSseEvent(reader!, streamState);

      const silent = await appendAssistantMessageToSessionTranscript({
        sessionKey: "agent:main:main",
        text: "NO_REPLY",
        storePath,
      });
      expect(silent.ok).toBe(true);

      const visible = await appendAssistantMessageToSessionTranscript({
        sessionKey: "agent:main:main",
        text: "third visible message",
        storePath,
      });
      expect(visible.ok).toBe(true);

      const messageEvent = await readSseEvent(reader!, streamState);
      expect(messageEvent.event).toBe("message");
      expect(
        (messageEvent.data as { message?: { content?: Array<{ text?: string }> } }).message
          ?.content?.[0]?.text,
      ).toBe("third visible message");
      expect((messageEvent.data as { messageSeq?: number }).messageSeq).toBe(3);
      expect(
        (
          messageEvent.data as {
            message?: { __openclaw?: { id?: string; seq?: number } };
          }
        ).message?.__openclaw,
      ).toMatchObject({
        id: visible.ok ? visible.messageId : undefined,
        seq: 3,
      });

      await reader?.cancel();
    });
  });

  test("resyncs raw sequence numbering after transcript-only SSE refreshes", async () => {
    const { storePath } = await seedSession({ text: "first message" });

    await withGatewayHarness(async (harness) => {
      const res = await fetchSessionHistory(harness.port, "agent:main:main", {
        headers: { Accept: "text/event-stream" },
      });

      expect(res.status).toBe(200);
      const reader = res.body?.getReader();
      expect(reader).toBeTruthy();
      const streamState = { buffer: "" };
      await readSseEvent(reader!, streamState);

      const second = await appendAssistantMessageToSessionTranscript({
        sessionKey: "agent:main:main",
        text: "second visible message",
        storePath,
      });
      expect(second.ok).toBe(true);

      const secondEvent = await readSseEvent(reader!, streamState);
      expect(secondEvent.event).toBe("message");
      expect((secondEvent.data as { messageSeq?: number }).messageSeq).toBe(2);

      if (!second.ok) {
        throw new Error(`append failed: ${second.reason}`);
      }
      await appendTranscriptMessage({
        sessionKey: "agent:main:main",
        storePath,
        message: makeTranscriptAssistantMessage({ text: "NO_REPLY" }),
        emitInlineMessage: false,
      });

      const refreshEvent = await readSseEvent(reader!, streamState);
      expect(refreshEvent.event).toBe("history");
      expect(
        (
          refreshEvent.data as { messages?: Array<{ content?: Array<{ text?: string }> }> }
        ).messages?.map((message) => message.content?.[0]?.text),
      ).toEqual(["first message", "second visible message"]);

      const third = await appendAssistantMessageToSessionTranscript({
        sessionKey: "agent:main:main",
        text: "third visible message",
        storePath,
      });
      expect(third.ok).toBe(true);

      const thirdEvent = await readSseEvent(reader!, streamState);
      expect(thirdEvent.event).toBe("message");
      expect(
        (thirdEvent.data as { message?: { content?: Array<{ text?: string }> } }).message
          ?.content?.[0]?.text,
      ).toBe("third visible message");
      expect((thirdEvent.data as { messageSeq?: number }).messageSeq).toBe(4);
      expect(
        (
          thirdEvent.data as {
            message?: { __openclaw?: { id?: string; seq?: number } };
          }
        ).message?.__openclaw,
      ).toMatchObject({
        id: third.ok ? third.messageId : undefined,
        seq: 4,
      });

      await reader?.cancel();
    });
  });

  test("rejects session history when operator.read is not requested", async () => {
    await seedSession({ text: "scope-guarded history" });

    const harness = await createGatewaySuiteHarness();
    const ws = await harness.openWs();
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
        `http://127.0.0.1:${harness.port}/sessions/${encodeURIComponent("agent:main:main")}/history?limit=1`,
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
        `http://127.0.0.1:${harness.port}/sessions/${encodeURIComponent("agent:main:main")}/history?limit=1`,
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
      await harness.close();
    }
  });
});
