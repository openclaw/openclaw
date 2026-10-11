import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, test, vi } from "vitest";
import { HEARTBEAT_PROMPT } from "../auto-reply/heartbeat.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import * as sessionEntryRows from "../config/sessions/session-accessor.sqlite-status.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { appendExactAssistantMessageToSessionTranscript } from "../config/sessions/transcript.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { emitSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { persistUserTurnTranscript } from "../sessions/user-turn-transcript.test-support.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import { runOpenClawAgentWriteTransaction } from "../state/openclaw-agent-db.js";
import { setAvatar, setDisplayName } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { resolveCurrentUserProfileDisplay } from "./current-user-profile-display.js";
import { readSseEvent } from "./session-history-fixtures.test-support.js";
import * as sessionHistoryState from "./session-history-state.js";
import { SessionHistorySseState } from "./session-history-state.js";
import {
  expectErrorResponse,
  fetchSessionHistory,
  readSessionHistoryBody,
  registerMemorySessionHistoryTests,
  type SessionHistoryBody,
  type SessionHistoryMessage,
} from "./sessions-history-http-read.test-support.js";
import {
  closeHistoryHarness,
  makeTranscriptAssistantMessage,
  withGatewayHarness,
} from "./sessions-history-http.test-support.js";
import { testState } from "./test-helpers.runtime-state.js";
import {
  connectReq,
  installGatewayTestHooks,
  rpcReq,
  startServerWithClient,
  writeSessionStore,
} from "./test-helpers.server.js";
import { releaseGatewaySessionStoreFixture } from "./test/server-sessions-resources.test-helpers.js";

const AUTH_HEADER = { Authorization: "Bearer test-gateway-token-1234567890" };
const cleanupDirs: string[] = [];
const requireRecord = createRequireRecord("object", "expected-label");

const AGENT_ID = "main";
const SESSION_KEY = "agent:main:main";

async function createSessionStoreFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-history-"));
  cleanupDirs.push(dir);
  const storePath = path.join(dir, "sessions.json");
  testState.sessionStorePath = storePath;
  await writeSessionStore({
    entries: {},
    storePath,
  });
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
    const appended = await appendExactAssistantMessageToSessionTranscript({
      sessionKey: SESSION_KEY,
      storePath,
      message: makeTranscriptAssistantMessage({ text: params.text }),
    });
    expect(appended.ok).toBe(true);
  }
  return { storePath };
}

async function appendText(storePath: string, text: string, emitInlineMessage = true) {
  const appended = await appendExactAssistantMessageToSessionTranscript({
    sessionKey: SESSION_KEY,
    storePath,
    message: makeTranscriptAssistantMessage({ text }),
    updateMode: emitInlineMessage ? "inline" : "file-only",
  });
  expect(appended.ok).toBe(true);
  if (!appended.ok) {
    throw new Error(`append failed: ${appended.reason}`);
  }
  return appended.messageId;
}

function sessionHistoryRowIdentity(message: unknown): string {
  const record = requireRecord(message, "session history row");
  const metadata = requireRecord(record["__openclaw"], "session history row metadata");
  const firstContent = Array.isArray(record.content)
    ? requireRecord(record.content[0], "session history row content")
    : undefined;
  const label =
    (typeof firstContent?.text === "string" ? firstContent.text : undefined) ??
    (typeof firstContent?.id === "string" ? firstContent.id : undefined) ??
    (typeof record.toolCallId === "string" ? record.toolCallId : "");
  return `${String(metadata.seq)}:${String(record.role)}:${label}`;
}

function attributedHistoryMessageProjection(value: unknown) {
  const message = requireRecord(value, "attributed history message");
  const metadata = requireRecord(message["__openclaw"], "attributed history metadata");
  return {
    role: message.role,
    content: message.content,
    __openclaw: {
      id: metadata.id,
      seq: metadata.seq,
      senderId: metadata.senderId,
      senderName: metadata.senderName,
      senderUsername: metadata.senderUsername,
      senderProfileAvatarUrl: metadata.senderProfileAvatarUrl,
    },
  };
}

function withMockedDateNow<T>(now: number, run: () => T): T {
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  try {
    return run();
  } finally {
    clock.mockRestore();
  }
}

function currentProfileAvatarUrl(profileId: string): string {
  const display = resolveCurrentUserProfileDisplay(profileId);
  expect(display.kind).toBe("resolved");
  if (display.kind !== "resolved") {
    throw new Error("expected a resolved current profile display");
  }
  return display.avatarUrl;
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

async function withHistoryStream(
  port: number,
  run: (stream: SessionHistorySseStream) => Promise<void>,
  query?: string,
) {
  const stream = await openSessionHistorySse(port, SESSION_KEY, { query });
  try {
    await run(stream);
  } finally {
    await stream.reader.cancel();
  }
}

async function expectHistoryEventTexts(stream: SessionHistorySseStream, expectedTexts: string[]) {
  const event = await readSseEvent(stream.reader, stream.streamState);
  expect(event.event).toBe("history");
  expect(
    (event.data as SessionHistoryBody).messages?.map((message) => message.content?.[0]?.text),
  ).toEqual(expectedTexts);
  return event;
}

async function expectMessageEventMatch(
  stream: SessionHistorySseStream,
  params: { text: string; seq: number; id?: string },
) {
  const event = await readSseEvent(stream.reader, stream.streamState);
  expect(event.event).toBe("message");
  const data = event.data as { message?: SessionHistoryMessage; messageSeq?: number };
  expect(data.message?.content?.[0]?.text).toBe(params.text);
  expect(data.messageSeq).toBe(params.seq);
  if (params.id !== undefined) {
    expect(data.message?.["__openclaw"]).toMatchObject({ id: params.id, seq: params.seq });
  }
  return event;
}

describe("session history HTTP endpoints", () => {
  installGatewayTestHooks({ scope: "suite", cleanup: closeHistoryHarness });

  afterEach(async () => {
    for (const dir of cleanupDirs.splice(0)) {
      await releaseGatewaySessionStoreFixture(dir);
      await fs.rm(dir, { recursive: true, force: true });
    }
    testState.sessionConfig = undefined;
    testState.agentsConfig = undefined;
  });

  registerMemorySessionHistoryTests(createSessionStoreFile);

  test("uses SSE only for an explicit acceptable event-stream media range", async () => {
    const expectedText = "accept negotiation sentinel";
    await seedSession({ text: expectedText });
    await withGatewayHarness(async (harness) => {
      const cases = [
        { accept: "text/event-stream", expected: "sse" },
        { accept: "TEXT/EVENT-STREAM", expected: "sse" },
        { accept: "  text/event-stream  ", expected: "sse" },
        { accept: "text/event-stream;", expected: "sse" },
        { accept: "text/event-stream; ; q=0.5;", expected: "sse" },
        { accept: "text/event-stream; charset=utf-8", expected: "sse" },
        {
          accept: 'text/event-stream; note="quoted,comma;semicolon\\\"quote"; q=0.5',
          expected: "json",
        },
        { accept: "text/event-stream;q=0.001", expected: "sse" },
        { accept: "text/event-stream;Q=1.000", expected: "sse" },
        { accept: "text/event-stream;q=0, text/event-stream;q=0.5", expected: "sse" },
        {
          accept: "text/event-stream;q=1, text/event-stream;charset=utf-8;q=0",
          expected: "json",
        },
        {
          accept: "text/event-stream;q=0, text/event-stream;charset=utf-8;q=0.5",
          expected: "sse",
        },
        { accept: "text/event-stream;q=0.5;charset=utf-8", expected: "sse" },
        { accept: "text/event-stream;q=1;charset=utf-16", expected: "json" },
        { accept: "text/event-stream;charset=utf-16", expected: "json" },
        { accept: "text/event-streaming", expected: "json" },
        { accept: "text/event-streamx", expected: "json" },
        { accept: 'application/json; note="text/event-stream"', expected: "json" },
        { accept: "text/*", expected: "json" },
        { accept: "*/*", expected: "json" },
        { accept: "text/event-stream;q=0", expected: "json" },
        { accept: "text/event-stream;q=0, */*;q=1", expected: "json" },
        { accept: "text/event-stream;q=0.1234", expected: "json" },
        { accept: "text/event-stream;q =0.5", expected: "json" },
        { accept: "text/event-stream;q= 0.5", expected: "json" },
        { accept: "text/event-stream;\u00a0q=0.5", expected: "json" },
        {
          accept: 'text/event-stream;q=0.5;legacy;note="quoted,comma;semicolon"',
          expected: "json",
        },
      ] as const;

      for (const testCase of cases) {
        const response = await fetchSessionHistory(harness.port, SESSION_KEY, {
          headers: { Accept: testCase.accept },
        });
        expect(response.status, testCase.accept).toBe(200);
        const contentType = response.headers.get("content-type") ?? "";
        if (testCase.expected === "sse") {
          expect(contentType, testCase.accept).toContain("text/event-stream");
          const reader = response.body?.getReader();
          expect(reader, testCase.accept).toBeDefined();
          const event = await readSseEvent(reader!, { buffer: "" });
          expect(event.event, testCase.accept).toBe("history");
          expect(
            (event.data as SessionHistoryBody).messages?.[0]?.content?.[0]?.text,
            testCase.accept,
          ).toBe(expectedText);
          await reader!.cancel();
          continue;
        }
        expect(contentType, testCase.accept).toContain("application/json");
        const body = (await response.json()) as SessionHistoryBody;
        expect(body.messages?.[0]?.content?.[0]?.text, testCase.accept).toBe(expectedText);
      }
    });
  });

  test("reads only the selected history entry for default and blank cursor queries", async () => {
    const { storePath } = await seedSession({ text: "hello from history" });
    const unrelatedPrompt = "Unrelated saved session prompt";
    await replaceSessionEntry(
      { agentId: AGENT_ID, sessionKey: "agent:main:unrelated", storePath },
      {
        sessionId: "sess-unrelated",
        updatedAt: 1,
        skillsSnapshot: { prompt: unrelatedPrompt, skills: [] },
      },
    );
    await withGatewayHarness(async (harness) => {
      const decode = vi.spyOn(sessionEntryRows, "parseSessionEntryJson");
      try {
        for (const query of ["", "?cursor=", "?cursor=%20"]) {
          decode.mockClear();
          const context = `query ${JSON.stringify(query)}`;
          const res = await fetchSessionHistory(harness.port, SESSION_KEY, { query });
          expect(res.status, context).toBe(200);
          const body = (await res.json()) as SessionHistoryBody;
          expect(body.sessionKey, context).toBe(SESSION_KEY);
          expect(body.messages, context).toHaveLength(1);
          expect(body.messages?.[0]?.content?.[0]?.text, context).toBe("hello from history");
          expect(body.messages?.[0]?.["__openclaw"]?.seq, context).toBe(1);
          expect(
            decode.mock.calls.some(([row]) => row.entry_json.includes(unrelatedPrompt)),
            context,
          ).toBe(false);
        }
      } finally {
        decode.mockRestore();
      }
    });
  });

  test("shares revisioned current-profile projection across REST and initial and inline SSE", async () => {
    const OLD_REV = 1_800_000_000_000;
    const NEW_REV = 1_900_000_000_000;
    const { storePath } = await seedSession();
    const sessionId = "sess-main";
    const sessionKey = SESSION_KEY;
    const sessionEntry = { sessionId, updatedAt: 1 };

    const profile = withMockedDateNow(OLD_REV, () => {
      const created = ensureProfileForEmail("session-history-profile@example.com");
      setDisplayName(created.id, "Old Display Name");
      expect(setAvatar(created.id, new Uint8Array([1, 2, 3]), "image/png").ok).toBe(true);
      return created;
    });
    const oldAvatarUrl = currentProfileAvatarUrl(profile.id);
    const persistAttributedTurn = async (id: string, senderName: string, text: string) => {
      const turn = await persistUserTurnTranscript({
        agentId: AGENT_ID,
        sessionEntry,
        sessionId,
        sessionKey,
        storePath,
        input: {
          idempotencyKey: `session-history-profile:${id}`,
          sender: {
            id: profile.id,
            identity: { type: "profile", id: profile.id },
            name: senderName,
            username: "ada",
          },
          text,
        },
      });
      expect(turn).toBeDefined();
      return turn!;
    };
    const first = await persistAttributedTurn(
      "first",
      "Historical Ada",
      "first attributed history turn",
    );

    await withGatewayHarness(async (harness) => {
      const initialRest = await readSessionHistoryBody(harness.port, sessionKey);
      const stream = await openSessionHistorySse(harness.port, sessionKey);
      try {
        const initialSse = await readSseEvent(stream.reader, stream.streamState);
        expect(initialSse.event).toBe("history");
        const oldExpected = {
          role: "user",
          content: "first attributed history turn",
          __openclaw: {
            id: first.messageId,
            seq: 1,
            senderId: profile.id,
            senderName: "Historical Ada",
            senderUsername: "ada",
            senderProfileAvatarUrl: oldAvatarUrl,
          },
        };
        expect(attributedHistoryMessageProjection(initialRest.messages?.[0])).toEqual(oldExpected);
        expect(
          attributedHistoryMessageProjection((initialSse.data as SessionHistoryBody).messages?.[0]),
        ).toEqual(oldExpected);

        withMockedDateNow(NEW_REV, () => {
          setDisplayName(profile.id, "Current Ada");
          expect(setAvatar(profile.id, new Uint8Array([4, 5, 6]), "image/png").ok).toBe(true);
        });
        const newAvatarUrl = currentProfileAvatarUrl(profile.id);
        expect(newAvatarUrl).not.toBe(oldAvatarUrl);

        const inlineEventPromise = readSseEvent(stream.reader, stream.streamState);
        const second = await persistAttributedTurn(
          "second",
          "Current Ada",
          "second attributed history turn",
        );
        const refreshEvent = await inlineEventPromise;
        expect(refreshEvent.event).toBe("history");
        const newSecondExpected = {
          role: "user",
          content: "second attributed history turn",
          __openclaw: {
            id: second.messageId,
            seq: 2,
            senderId: profile.id,
            senderName: "Current Ada",
            senderUsername: "ada",
            senderProfileAvatarUrl: newAvatarUrl,
          },
        };
        const newFirstExpected = {
          ...oldExpected,
          __openclaw: {
            ...oldExpected["__openclaw"],
            senderProfileAvatarUrl: newAvatarUrl,
          },
        };
        const refreshedSse = refreshEvent.data as SessionHistoryBody;
        expect(refreshedSse.messages).toHaveLength(2);
        expect(attributedHistoryMessageProjection(refreshedSse.messages?.[0])).toEqual(
          newFirstExpected,
        );
        expect(attributedHistoryMessageProjection(refreshedSse.messages?.[1])).toEqual(
          newSecondExpected,
        );

        const refreshedRest = await readSessionHistoryBody(harness.port, sessionKey);
        expect(refreshedRest.messages).toHaveLength(2);
        expect(attributedHistoryMessageProjection(refreshedRest.messages?.[0])).toEqual(
          newFirstExpected,
        );
        expect(attributedHistoryMessageProjection(refreshedRest.messages?.[1])).toEqual(
          newSecondExpected,
        );
      } finally {
        await stream.reader.cancel();
      }
    });
  });

  test("keeps same-sequence SQLite projection rows reachable over REST and SSE", async () => {
    const storePath = await createSessionStoreFile();
    const sessionId = "sess-same-sequence";
    const sessionKey = SESSION_KEY;
    const sharedTimestamp = Date.UTC(2026, 7, 15, 9, 30, 0);
    await writeSessionStore({
      entries: { main: { sessionId, updatedAt: sharedTimestamp } },
      storePath,
    });
    await replaceTranscriptEvents({ agentId: AGENT_ID, sessionId, sessionKey, storePath }, [
      { type: "session", version: 1, id: sessionId },
      {
        id: "history-user",
        message: {
          role: "user",
          content: [{ type: "text", text: "reply here" }],
          timestamp: sharedTimestamp,
        },
      },
      {
        id: "history-tool-call",
        message: {
          ...makeTranscriptAssistantMessage({ text: "" }),
          content: [
            {
              type: "toolCall",
              id: "call-message-first",
              name: "message",
              arguments: { action: "send", message: "First visible reply." },
            },
            {
              type: "toolCall",
              id: "call-message-second",
              name: "message",
              arguments: { action: "send", message: "Second visible reply." },
            },
          ],
          timestamp: sharedTimestamp,
        },
      },
      {
        id: "history-commentary",
        message: {
          ...makeTranscriptAssistantMessage({ text: "" }),
          content: ["First visible reply.", "Second visible reply."].map((text, index) => ({
            type: "text",
            text,
            textSignature: JSON.stringify({ v: 1, id: `commentary-${index}`, phase: "commentary" }),
          })),
          timestamp: sharedTimestamp,
        },
      },
      {
        id: "history-hidden-reply",
        message: {
          ...makeTranscriptAssistantMessage({ text: "NO_REPLY" }),
          timestamp: sharedTimestamp,
        },
      },
      {
        id: "history-hidden-control",
        message: {
          ...makeTranscriptAssistantMessage({ text: "NO_REPLY" }),
          timestamp: sharedTimestamp,
        },
      },
    ]);

    await withGatewayHarness(async (harness) => {
      const firstPage = await readSessionHistoryBody(harness.port, sessionKey, {
        query: "?limit=1",
      });
      expect(firstPage.messages?.map(sessionHistoryRowIdentity)).toEqual([
        "3:assistant:First visible reply.",
        "3:assistant:Second visible reply.",
      ]);
      expect(firstPage.hasMore).toBe(true);
      expect(firstPage.nextCursor).toBe("3");

      const stream = await openSessionHistorySse(harness.port, sessionKey, {
        query: "?limit=1",
      });
      try {
        const event = await readSseEvent(stream.reader, stream.streamState);
        expect(event.event).toBe("history");
        const data = event.data as SessionHistoryBody;
        expect(data.messages?.map(sessionHistoryRowIdentity)).toEqual(
          firstPage.messages?.map(sessionHistoryRowIdentity),
        );
        expect(data).toMatchObject({ hasMore: true, nextCursor: "3" });
      } finally {
        await stream.reader.cancel();
      }

      const pages: SessionHistoryBody[] = [firstPage];
      const seenCursors = new Set<string>();
      let cursor = firstPage.nextCursor;
      while (cursor) {
        expect(seenCursors.has(cursor)).toBe(false);
        seenCursors.add(cursor);
        const page = await readSessionHistoryBody(harness.port, sessionKey, {
          query: `?limit=1&cursor=${encodeURIComponent(cursor)}`,
        });
        pages.push(page);
        cursor = page.hasMore ? page.nextCursor : undefined;
      }

      const chronologicalRows = pages.toReversed().flatMap((page) => page.messages ?? []);
      expect(chronologicalRows.map(sessionHistoryRowIdentity)).toEqual([
        "1:user:reply here",
        "2:assistant:call-message-first",
        "3:assistant:First visible reply.",
        "3:assistant:Second visible reply.",
      ]);
      expect(
        chronologicalRows.map((message) => requireRecord(message, "history timestamp").timestamp),
      ).toEqual(Array.from({ length: 4 }, () => sharedTimestamp));
      expect(
        pages
          .flatMap((page) => page.messages ?? [])
          .some((message) => sessionHistoryRowIdentity(message).includes("NO_REPLY")),
      ).toBe(false);
      expect(seenCursors).toEqual(new Set(["3", "2"]));
      expect(pages.at(-1)).toMatchObject({ hasMore: false });
      expect(pages.at(-1)?.nextCursor).toBeUndefined();
    });
  });

  test("attributes forwarded history only from structured provenance across transports and pages", async () => {
    const { storePath } = await seedSession();
    const sessionId = "sess-main";
    const sessionKey = SESSION_KEY;
    const cases = [
      {
        body: "Verified sender body\n    indented line",
        promptSessionKey: "agent:grimwald:asserted",
        sourceSessionKey: "agent:helper:ops",
        senderLabel: "Forwarded from helper",
        senderSession: { sessionKey: "agent:helper:ops", agentId: "helper" },
      },
      {
        body: "Unverified sender body\n    indented line",
        promptSessionKey: "agent:grimwald:asserted",
        sourceSessionKey: undefined,
        senderLabel: "Forwarded agent message",
        senderSession: undefined,
      },
    ];
    for (const entry of cases) {
      const persisted = await persistUserTurnTranscript({
        agentId: AGENT_ID,
        sessionEntry: { sessionId, updatedAt: 1 },
        sessionId,
        sessionKey,
        storePath,
        input: {
          text: `[Inter-session message] sourceSession=${entry.promptSessionKey} sourceTool=sessions_send isUser=false\n${entry.body}`,
          provenance: {
            kind: "inter_session",
            sourceTool: "sessions_send",
            ...(entry.sourceSessionKey ? { sourceSessionKey: entry.sourceSessionKey } : {}),
          },
        },
      });
      expect(persisted).toBeDefined();
    }

    await withGatewayHarness(async (harness) => {
      const ws = await harness.openWs();
      try {
        expect((await connectReq(ws, { scopes: ["operator.read"] })).ok).toBe(true);
        let cursor: string | undefined;
        for (const [offset, entry] of cases.toReversed().entries()) {
          const http = await readSessionHistoryBody(harness.port, sessionKey, {
            query: `?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
          });
          const websocket = await rpcReq<{ messages: unknown[]; hasMore: boolean }>(
            ws,
            "chat.history",
            { sessionKey, limit: 1, offset },
          );
          expect(websocket.ok).toBe(true);
          for (const page of [http, websocket.payload]) {
            expect(page?.messages).toHaveLength(1);
            expect(page?.messages?.[0]).toMatchObject({
              role: "assistant",
              content: entry.body,
              senderLabel: entry.senderLabel,
              ...(entry.senderSession ? { senderSession: entry.senderSession } : {}),
            });
            if (!entry.senderSession) {
              expect(page?.messages?.[0]).not.toHaveProperty("senderSession");
            }
            expect(page?.hasMore).toBe(offset < cases.length - 1);
          }
          if (offset < cases.length - 1) {
            expect(http.nextCursor).toEqual(expect.any(String));
          }
          cursor = http.nextCursor;
        }
      } finally {
        ws.close();
      }
    });
  });

  test("refreshes unbounded SSE when an active transcript replaces reset archive history", async () => {
    const storePath = await createSessionStoreFile();
    const sessionId = "sess-reset-sse-takeover";
    const dir = path.dirname(storePath);
    await fs.writeFile(
      path.join(dir, `${sessionId}.jsonl.reset.2026-02-16T22-26-34.000Z`),
      [
        JSON.stringify({ type: "session", version: 1, id: sessionId }),
        JSON.stringify({
          message: {
            role: "assistant",
            content: [{ type: "text", text: "archived before reset" }],
          },
        }),
      ].join("\n"),
    );
    await writeSessionStore({
      entries: {
        [SESSION_KEY]: {
          sessionId,
          updatedAt: 1,
        },
      },
      storePath,
    });

    await withGatewayHarness(async (harness) => {
      await withHistoryStream(harness.port, async (stream) => {
        await expectHistoryEventTexts(stream, ["archived before reset"]);

        const activeMessage = makeTranscriptAssistantMessage({ text: "active after reset" });
        const appended = await appendExactAssistantMessageToSessionTranscript({
          sessionKey: SESSION_KEY,
          storePath,
          message: activeMessage,
          updateMode: "none",
        });
        expect(appended.ok).toBe(true);
        if (!appended.ok) {
          throw new Error(`append failed: ${appended.reason}`);
        }
        emitSessionTranscriptUpdate({
          sessionFile: appended.target.sessionKey,
          sessionKey: SESSION_KEY,
          target: {
            agentId: appended.target.agentId ?? "main",
            sessionId: appended.target.sessionId,
            sessionKey: appended.target.sessionKey,
          },
          message: activeMessage,
          messageId: appended.messageId,
          messageSeq: 2,
        });

        await expectHistoryEventTexts(stream, ["active after reset"]);
      });
    });
  });

  test("claims invalid encoded session keys on a listening Gateway", async () => {
    await withGatewayHarness(async (harness) => {
      for (const encodedSessionKey of ["%20", "%zz"]) {
        const response = await fetch(
          `http://127.0.0.1:${harness.port}/sessions/${encodedSessionKey}/history`,
        );
        const body = await response.json();
        expect(response.status).toBe(400);
        expect(body).toEqual({
          error: {
            type: "invalid_request_error",
            message: "invalid session key",
          },
        });
      }
    });
  });

  test("returns 404 after initializing a missing configured session store", async () => {
    await closeHistoryHarness();
    const storePath = await createSessionStoreFile();
    const agentId = "new-history";
    const storeTemplate = path.join(
      path.dirname(storePath),
      "agents/{agentId}/sessions/sessions.json",
    );
    testState.sessionConfig = { store: storeTemplate };
    testState.agentsConfig = {
      ownership: "explicit",
      entries: { [AGENT_ID]: {}, [agentId]: {} },
    };
    await writeSessionStore({ entries: {}, storePath });
    const sessionKey = `agent:${agentId}:missing`;
    const missingDatabasePath = resolveSqliteTargetFromSessionStorePath(
      storeTemplate.replace("{agentId}", agentId),
      { agentId },
    ).path;
    if (!missingDatabasePath) {
      throw new Error("expected configured database path");
    }
    await withGatewayHarness(
      async ({ port }) => {
        await expect(fs.stat(missingDatabasePath)).rejects.toMatchObject({ code: "ENOENT" });
        const res = await fetchSessionHistory(port, sessionKey);
        expect(res.status).toBe(404);
        expectErrorResponse(await res.json(), {
          type: "not_found",
          message: `Session not found: ${sessionKey}`,
        });
        expect((await fs.stat(missingDatabasePath)).isFile()).toBe(true);
      },
      { fresh: true },
    );
  });

  test("rejects duplicate canonical rows with an actionable migration error", async () => {
    await closeHistoryHarness();
    testState.sessionConfig = { mainKey: "work" };
    const storePath = await createSessionStoreFile();
    await withGatewayHarness(
      async (harness) => {
        // Exercise the HTTP reader against a malformed hot write after admission.
        const databasePath = resolveSqliteTargetFromSessionStorePath(storePath, {
          agentId: AGENT_ID,
        }).path;
        if (!databasePath) {
          throw new Error("expected SQLite session store path");
        }
        runOpenClawAgentWriteTransaction(
          (database) => {
            const db = getNodeSqliteKysely<Pick<OpenClawAgentKyselyDatabase, "session_nodes">>(
              database.db,
            );
            for (const [sessionKey, sessionId, updatedAt] of [
              ["agent:main:work", "sess-stale-main", 1],
              [SESSION_KEY, "sess-fresh-main", 2],
            ] as const) {
              executeSqliteQuerySync(
                database.db,
                db.insertInto("session_nodes").values({
                  current_session_id: sessionId,
                  entry_json: JSON.stringify({ sessionId, updatedAt }),
                  session_key: sessionKey,
                  updated_at: updatedAt,
                }),
              );
            }
          },
          { agentId: AGENT_ID, path: databasePath },
        );
        const res = await fetchSessionHistory(harness.port, "agent:main:work");
        expect(res.status).toBe(409);
        expectErrorResponse(await res.json(), {
          type: "migration_required",
          message:
            "duplicate rows resolve to canonical session key agent:main:work; stop the Gateway and run openclaw doctor --fix",
        });
      },
      { fresh: true },
    );
  });

  test("keeps repeated assistant replies from separate hidden user turns in REST and SSE history", async () => {
    const storePath = await createSessionStoreFile();
    const sessionId = "sess-hidden-turn-replies";
    const sessionKey = SESSION_KEY;
    await writeSessionStore({
      entries: { main: { sessionId, updatedAt: Date.now() } },
      storePath,
    });
    const assistantMessage = (text: string, model: string) =>
      makeTranscriptAssistantMessage({ text, provider: "openclaw", model });
    await replaceTranscriptEvents({ agentId: AGENT_ID, sessionId, sessionKey, storePath }, [
      { type: "session", version: 1, id: sessionId },
      { message: assistantMessage("First reply.", "acp-runtime") },
      { message: { role: "user", content: "" } },
      { message: assistantMessage("First reply.", "gateway-injected") },
      { message: assistantMessage("Second reply.", "acp-runtime") },
      { message: { role: "user", content: HEARTBEAT_PROMPT } },
      { message: assistantMessage("Second reply.", "gateway-injected") },
      { message: assistantMessage("Third reply.", "acp-runtime") },
      { message: { role: "user", content: HEARTBEAT_PROMPT } },
      { message: { role: "assistant", content: "HEARTBEAT_OK" } },
      { message: assistantMessage("Third reply.", "gateway-injected") },
    ]);

    const expectedRows = [
      "1:assistant:First reply.",
      "3:assistant:First reply.",
      "4:assistant:Second reply.",
      "6:assistant:Second reply.",
      "7:assistant:Third reply.",
      "10:assistant:Third reply.",
    ];
    await withGatewayHarness(async (harness) => {
      const history = await readSessionHistoryBody(harness.port, sessionKey);
      expect(history.messages?.map(sessionHistoryRowIdentity)).toEqual(expectedRows);
      expect(history.messages?.map((message) => message["__openclaw"]?.turnBoundary)).toEqual([
        undefined,
        undefined,
        undefined,
        true,
        undefined,
        true,
      ]);

      await withHistoryStream(harness.port, async (stream) => {
        const event = await readSseEvent(stream.reader, stream.streamState);
        expect(event.event).toBe("history");
        const streamedHistory = event.data as SessionHistoryBody;
        expect(streamedHistory.messages?.map(sessionHistoryRowIdentity)).toEqual(expectedRows);
      });
    });
  });

  test("caps all-digit direct REST history limits that exceed safe integer range", async () => {
    const { storePath } = await seedSession({ text: "first message" });
    await appendText(storePath, "second message");
    await appendText(storePath, "third message");

    await withGatewayHarness(async (harness) => {
      const body = await readSessionHistoryBody(harness.port, SESSION_KEY, {
        query: `?limit=${"9".repeat(100)}`,
      });

      expect(body.messages?.map((message) => message.content?.[0]?.text)).toEqual([
        "first message",
        "second message",
        "third message",
      ]);
      expect(body.hasMore).toBe(false);
      expect(body.nextCursor).toBeUndefined();
    });
  });

  test.each([
    { key: "limit", values: ["", " ", "abc", "0", "-5", "1.5"] },
    {
      key: "cursor",
      values: [
        "garbage",
        "seq:garbage",
        "seq:2next",
        "seq:0",
        "seq:99999999999999999999",
        "0",
        "-1",
        "1.5",
      ],
    },
  ])("rejects invalid $key queries with 400", async ({ key, values }) => {
    await seedSession({ text: "first message" });
    await withGatewayHarness(async ({ port }) => {
      for (const value of values) {
        const res = await fetchSessionHistory(port, SESSION_KEY, {
          query: `?${key}=${encodeURIComponent(value)}`,
        });
        expect(res.status, value).toBe(400);
        expect((await res.json()).error).toEqual({
          type: "invalid_request_error",
          message: `${key} must be a positive integer`,
        });
      }
    });
  });

  test("sanitizes phased output_text assistant history before returning it", async () => {
    const blockType = "output_text";
    const { storePath } = await seedSession();

    await withGatewayHarness(async (harness) => {
      const visibleMessageId = "visible-phased-assistant";
      await replaceTranscriptEvents(
        { agentId: AGENT_ID, sessionId: "sess-main", sessionKey: SESSION_KEY, storePath },
        [
          { type: "session", version: 1, id: "sess-main" },
          { id: "hidden-control", message: makeTranscriptAssistantMessage({ text: "NO_REPLY" }) },
          {
            id: visibleMessageId,
            message: {
              ...makeTranscriptAssistantMessage({ text: "Done." }),
              content: [
                { id: "item_commentary", phase: "commentary", text: "internal reasoning" },
                { id: "item_final", phase: "final_answer", text: "Done." },
              ].map(({ text, ...signature }) => ({
                type: blockType,
                text,
                textSignature: JSON.stringify({ v: 1, ...signature }),
              })),
            },
          },
        ],
      );

      const historyRes = await fetchSessionHistory(harness.port, SESSION_KEY);
      expect(historyRes.status).toBe(200);
      const body = (await historyRes.json()) as SessionHistoryBody;
      expect(body.sessionKey).toBe(SESSION_KEY);
      expect(body.messages).toHaveLength(2);
      expect(body.messages?.[0]).toMatchObject({
        content: [{ type: "text", text: "internal reasoning" }],
        openclawStreamFallback: {
          itemId: "item_commentary",
          replacementText: "internal reasoning",
          source: "segment",
        },
      });
      expect(body.messages?.[1]?.content?.map((block) => block.text)).toEqual(["Done."]);
      expect(body.messages?.[1]?.["__openclaw"]).toMatchObject({
        id: visibleMessageId,
        seq: 2,
      });
    });
  });

  test("includes updates committed while opening bounded SSE history", async () => {
    const query = "?limit=2";
    const { storePath } = await seedSession({ text: "first message" });

    await withGatewayHarness(async (harness) => {
      const readSnapshot = sessionHistoryState.readSessionHistorySnapshotAsync;
      const snapshotSpy = vi
        .spyOn(sessionHistoryState, "readSessionHistorySnapshotAsync")
        .mockImplementationOnce(async (params) => {
          const snapshot = await readSnapshot(params);
          await appendText(storePath, "committed during startup");
          return snapshot;
        });
      try {
        await withHistoryStream(
          harness.port,
          async (stream) => {
            await expectHistoryEventTexts(stream, ["first message", "committed during startup"]);
            await appendText(storePath, "live after startup");
            await expectHistoryEventTexts(stream, [
              "committed during startup",
              "live after startup",
            ]);
          },
          query,
        );
      } finally {
        snapshotSpy.mockRestore();
      }
    });
  });

  test("bounds retained SSE history without truncating full history or live updates", async () => {
    const retainedMessageLimit = 1_000;
    const initialMessageCount = retainedMessageLimit + 2;
    const sessionKey = SESSION_KEY;
    const { storePath } = await seedSession();
    await replaceTranscriptEvents(
      {
        agentId: AGENT_ID,
        sessionId: "sess-main",
        sessionKey,
        storePath,
      },
      [
        { type: "session", version: 1, id: "sess-main" },
        ...Array.from({ length: initialMessageCount }, (_, index) => ({
          id: `history-message-${index + 1}`,
          parentId: index === 0 ? null : `history-message-${index}`,
          message: makeTranscriptAssistantMessage({ text: `history message ${index + 1}` }),
        })),
      ],
    );

    const snapshotSpy = vi.spyOn(SessionHistorySseState.prototype, "snapshot");
    try {
      await withGatewayHarness(async (harness) => {
        await withHistoryStream(harness.port, async (stream) => {
          const initialEvent = await readSseEvent(stream.reader, stream.streamState);
          expect(initialEvent.event).toBe("history");
          const initialMessages = (initialEvent.data as SessionHistoryBody).messages ?? [];
          expect(initialMessages).toHaveLength(initialMessageCount);
          expect(initialMessages[0]?.content?.[0]?.text).toBe("history message 1");

          const retained = snapshotSpy.mock.results.at(-1)?.value;
          expect(retained?.messages).toHaveLength(retainedMessageLimit);
          expect(retained?.messages?.[0]?.content?.[0]?.text).toBe("history message 3");

          const cursorStream = await openSessionHistorySse(harness.port, sessionKey, {
            query: `?cursor=${initialMessageCount + 1}`,
          });
          try {
            const cursorEvent = await readSseEvent(cursorStream.reader, cursorStream.streamState);
            expect(cursorEvent.event).toBe("history");
            expect((cursorEvent.data as SessionHistoryBody).messages).toHaveLength(
              initialMessageCount,
            );
            const cursorSnapshot = snapshotSpy.mock.results.at(-1)?.value;
            expect(cursorSnapshot?.messages).toHaveLength(retainedMessageLimit);
            expect(cursorSnapshot?.messages?.[0]?.content?.[0]?.text).toBe("history message 3");

            const messageId = await appendText(storePath, "live history message");
            const lastSequence = initialMessages.at(-1)?.["__openclaw"]?.seq;
            expect(lastSequence).toEqual(expect.any(Number));
            await expectMessageEventMatch(stream, {
              text: "live history message",
              seq: (lastSequence ?? 0) + 1,
              id: messageId,
            });

            const liveRetained = snapshotSpy.mock.results.findLast((result) => {
              const snapshot = result.value;
              return snapshot?.messages?.at(-1)?.content?.[0]?.text === "live history message";
            })?.value;
            expect(liveRetained?.messages).toHaveLength(retainedMessageLimit);
            expect(liveRetained?.messages?.at(-1)?.content?.[0]?.text).toBe("live history message");

            const refreshedCursorEvent = await readSseEvent(
              cursorStream.reader,
              cursorStream.streamState,
            );
            expect(refreshedCursorEvent.event).toBe("history");
            const refreshedCursorMessages =
              (refreshedCursorEvent.data as SessionHistoryBody).messages ?? [];
            expect(refreshedCursorMessages).toHaveLength(initialMessageCount);
            expect(refreshedCursorMessages[0]?.content?.[0]?.text).toBe("history message 1");

            const refreshedCursorSnapshot = snapshotSpy.mock.results.at(-1)?.value;
            expect(refreshedCursorSnapshot?.messages).toHaveLength(retainedMessageLimit);

            const completeHistory = await vi.waitFor(
              async () => await readSessionHistoryBody(harness.port, sessionKey),
              { interval: 25, timeout: 5_000 },
            );
            expect(completeHistory.messages).toHaveLength(initialMessageCount + 1);
            expect(completeHistory.messages?.[0]?.content?.[0]?.text).toBe("history message 1");
            expect(completeHistory.messages?.at(-1)?.content?.[0]?.text).toBe(
              "live history message",
            );
          } finally {
            await cursorStream.reader.cancel();
          }
        });
      });
    } finally {
      snapshotSpy.mockRestore();
    }
  });

  test("refetches durable history for weak identity-only notifications", async () => {
    const { storePath } = await seedSession({ text: "first message" });

    await withGatewayHarness(async (harness) => {
      await withHistoryStream(harness.port, async (stream) => {
        await expectHistoryEventTexts(stream, ["first message"]);
        const appended = await appendExactAssistantMessageToSessionTranscript({
          sessionKey: SESSION_KEY,
          storePath,
          message: makeTranscriptAssistantMessage({ text: "committed second message" }),
          updateMode: "none",
        });
        expect(appended.ok).toBe(true);
        emitSessionTranscriptUpdate({
          target: {
            agentId: "main",
            sessionId: "sess-main",
            sessionKey: SESSION_KEY,
          },
          message: makeTranscriptAssistantMessage({ text: "unwritten carried payload" }),
          messageId: "unproven-message",
          messageSeq: 99,
        });
        await expectHistoryEventTexts(stream, ["first message", "committed second message"]);
      });
    });
  });

  test("resyncs raw sequence numbering after transcript-only SSE refreshes", async () => {
    const { storePath } = await seedSession({ text: "first message" });

    await withGatewayHarness(async ({ port }) =>
      withHistoryStream(port, async (stream) => {
        await expectHistoryEventTexts(stream, ["first message"]);
        await appendText(storePath, "second visible message");

        await expectMessageEventMatch(stream, {
          text: "second visible message",
          seq: 2,
        });
        await appendText(storePath, "NO_REPLY", false);

        await expectHistoryEventTexts(stream, ["first message", "second visible message"]);

        const thirdId = await appendText(storePath, "third visible message");
        await expectMessageEventMatch(stream, {
          text: "third visible message",
          seq: 4,
          id: thirdId,
        });
      }),
    );
  });

  test("rejects session history when operator.read is not requested", async () => {
    await closeHistoryHarness();
    await seedSession({ text: "scope-guarded history" });

    const started = await startServerWithClient("test-gateway-token-1234567890");
    const { server, ws, port: _port, envSnapshot } = started;
    try {
      const connect = await connectReq(ws, {
        token: "test-gateway-token-1234567890",
        scopes: ["operator.approvals"],
      });
      expect(connect.ok).toBe(true);

      const wsHistory = await rpcReq<{ messages?: unknown[] }>(ws, "chat.history", {
        sessionKey: SESSION_KEY,
        limit: 1,
      });
      expect(wsHistory.ok).toBe(false);
      expect(wsHistory.error?.message).toBe("missing scope: operator.read");
    } finally {
      ws.close();
      await server.close();
      envSnapshot.restore();
    }
  });

  test("maintains HTTP SSE streams with shared-secret bearer auth across transcript updates", async () => {
    await closeHistoryHarness();
    const { storePath } = await seedSession({ text: "bearer allowed history" });

    const started = await startServerWithClient("test-gateway-token-1234567890");
    const { server, ws, port, envSnapshot } = started;
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/sessions/${encodeURIComponent(SESSION_KEY)}/history`,
        {
          headers: {
            ...AUTH_HEADER,
            Accept: "text/event-stream",
          },
        },
      );
      expect(res.status).toBe(200);
      const reader = res.body?.getReader();
      expect(reader).toBeDefined();
      const stream = { reader: reader!, streamState: { buffer: "" } };

      await expectHistoryEventTexts(stream, ["bearer allowed history"]);

      const appendedId = await appendText(storePath, "bearer sse update");

      await expectMessageEventMatch(stream, {
        text: "bearer sse update",
        seq: 2,
        id: appendedId,
      });

      await stream.reader.cancel();
    } finally {
      ws.close();
      await server.close();
      envSnapshot.restore();
    }
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
