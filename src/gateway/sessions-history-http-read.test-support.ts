import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect } from "vitest";
import { appendExactAssistantMessageToSessionTranscript } from "../config/sessions/transcript.js";
import { readSseEvent } from "./session-history-fixtures.test-support.js";

const READ_SCOPE_HEADER = { "x-openclaw-scopes": "operator.read" };

export async function appendHistoryMessage(
  params: Parameters<typeof appendExactAssistantMessageToSessionTranscript>[0],
) {
  const appended = await appendExactAssistantMessageToSessionTranscript(params);
  expect(appended.ok).toBe(true);
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

export type SessionHistoryMessage = {
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

export type SessionHistorySseStream = {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  streamState: { buffer: string };
};

export function historyStream(response: Response): SessionHistorySseStream {
  expect(response.status).toBe(200);
  return {
    reader: expectDefined(response.body?.getReader(), "session-history SSE reader"),
    streamState: { buffer: "" },
  };
}

export function readHistoryEvent(
  stream: SessionHistorySseStream,
  expectedEvent?: "history",
): Promise<SessionHistoryBody>;
export function readHistoryEvent(
  stream: SessionHistorySseStream,
  expectedEvent: string,
): Promise<unknown>;
export async function readHistoryEvent(
  stream: SessionHistorySseStream,
  expectedEvent = "history",
): Promise<unknown> {
  const event = await readSseEvent(stream.reader, stream.streamState);
  expect(event.event).toBe(expectedEvent);
  return event.data;
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
