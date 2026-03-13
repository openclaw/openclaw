import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { appendAssistantMessageToSessionTranscript } from "../config/sessions/transcript.js";
import { testState } from "./test-helpers.mocks.js";
import {
  createGatewaySuiteHarness,
  installGatewayTestHooks,
  writeSessionStore,
} from "./test-helpers.server.js";

installGatewayTestHooks();

const AUTH_HEADER = { Authorization: "Bearer test-gateway-token-1234567890" };
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

    const harness = await createGatewaySuiteHarness();
    try {
      const res = await fetch(
        `http://127.0.0.1:${harness.port}/sessions/${encodeURIComponent("agent:main:main")}/history`,
        {
          headers: AUTH_HEADER,
        },
      );

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
    } finally {
      await harness.close();
    }
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

    const harness = await createGatewaySuiteHarness();
    try {
      const firstPage = await fetch(
        `http://127.0.0.1:${harness.port}/sessions/${encodeURIComponent("agent:main:main")}/history?limit=2`,
        {
          headers: AUTH_HEADER,
        },
      );
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

      const secondPage = await fetch(
        `http://127.0.0.1:${harness.port}/sessions/${encodeURIComponent("agent:main:main")}/history?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor ?? "")}`,
        {
          headers: AUTH_HEADER,
        },
      );
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
    } finally {
      await harness.close();
    }
  });

  test("streams bounded history windows over SSE", async () => {
    const { storePath } = await seedSession({ text: "first message" });
    const second = await appendAssistantMessageToSessionTranscript({
      sessionKey: "agent:main:main",
      text: "second message",
      storePath,
    });
    expect(second.ok).toBe(true);

    const harness = await createGatewaySuiteHarness();
    try {
      const res = await fetch(
        `http://127.0.0.1:${harness.port}/sessions/${encodeURIComponent("agent:main:main")}/history?limit=1`,
        {
          headers: {
            ...AUTH_HEADER,
            Accept: "text/event-stream",
          },
        },
      );

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
    } finally {
      await harness.close();
    }
  });

  test("streams session history updates over SSE", async () => {
    const { storePath } = await seedSession({ text: "first message" });

    const harness = await createGatewaySuiteHarness();
    try {
      const res = await fetch(
        `http://127.0.0.1:${harness.port}/sessions/${encodeURIComponent("agent:main:main")}/history`,
        {
          headers: {
            ...AUTH_HEADER,
            Accept: "text/event-stream",
          },
        },
      );

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
      expect(
        (
          messageEvent.data as {
            message?: { __openclaw?: { id?: string; seq?: number } };
          }
        ).message?.__openclaw,
      ).toMatchObject({
        id: appended.messageId,
        seq: 2,
      });

      await reader?.cancel();
    } finally {
      await harness.close();
    }
  });
});
