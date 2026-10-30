import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect } from "vitest";
import { appendExactAssistantMessageToSessionTranscript } from "../config/sessions/transcript.js";
import { readSseEvent } from "./session-history-fixtures.test-support.js";

const READ_SCOPE_HEADER = { "x-openclaw-scopes": "operator.read" };

export async function appendHistoryMessage(
  params: Parameters<typeof appendExactAssistantMessageToSessionTranscript>[0],
) {
  const appended = await appendExactAssistantMessageToSessionTranscript(params);
  if (!appended.ok) {
    throw new Error(appended.reason);
  }
  return appended;
}

export async function fetchSessionHistory(
  port: number,
  sessionKey: string,
  params?: {
    query?: string;
    headers?: Record<string, string>;
  },
) {
  return fetch(
    `http://127.0.0.1:${port}/sessions/${encodeURIComponent(sessionKey)}/history${params?.query ?? ""}`,
    { headers: { ...READ_SCOPE_HEADER, ...params?.headers } },
  );
}

type SessionHistoryMessage = {
  role?: string;
  timestamp?: number;
  content?: Array<{ text?: string }>;
  __openclaw?: { id?: string; seq?: number; turnBoundary?: boolean };
};

export type SessionHistoryBody = {
  sessionKey?: string;
  items?: SessionHistoryMessage[];
  messages?: SessionHistoryMessage[];
  nextCursor?: string;
  hasMore?: boolean;
};

export const historyTexts = (body: SessionHistoryBody) =>
  body.messages?.map((message) => message.content?.[0]?.text);

export class SessionHistorySseStream {
  readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly streamState = { buffer: "" };

  constructor(response: Response) {
    expect(response.status).toBe(200);
    this.reader = expectDefined(response.body?.getReader(), "session-history SSE reader");
  }

  next(expectedEvent?: "history"): Promise<SessionHistoryBody>;
  next(expectedEvent: string): Promise<unknown>;
  async next(expectedEvent = "history"): Promise<unknown> {
    const event = await readSseEvent(this.reader, this.streamState);
    expect(event.event).toBe(expectedEvent);
    return event.data;
  }

  async expectTexts(texts: string[]) {
    expect(historyTexts(await this.next())).toEqual(texts);
  }

  async expectMessage(text: string, seq: number, id?: string) {
    const data = (await this.next("message")) as {
      message?: SessionHistoryMessage;
      messageSeq?: number;
    };
    expect(data.message?.content?.[0]?.text).toBe(text);
    expect(data.messageSeq).toBe(seq);
    if (id !== undefined) {
      expect(data.message?.["__openclaw"]).toMatchObject({ id, seq });
    }
  }

  async [Symbol.asyncDispose]() {
    await this.reader.cancel();
  }
}

export const historyStream = (response: Response) => new SessionHistorySseStream(response);

export async function openHistoryStream(port: number, sessionKey: string, query?: string) {
  const headers = { Accept: "text/event-stream" };
  return historyStream(await fetchSessionHistory(port, sessionKey, { query, headers }));
}

export async function readSessionHistoryBody(
  port: number,
  sessionKey: string,
  params?: Parameters<typeof fetchSessionHistory>[2],
): Promise<SessionHistoryBody> {
  const res = await fetchSessionHistory(port, sessionKey, params);
  expect(res.status).toBe(200);
  return (await res.json()) as SessionHistoryBody;
}

export function expectErrorResponse(body: unknown, expected: { type: string; message: string }) {
  expect(body).toEqual({ ok: false, error: expected });
}
