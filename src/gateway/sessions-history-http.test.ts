import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, describe, expect, test, vi } from "vitest";
import { HEARTBEAT_PROMPT } from "../auto-reply/heartbeat.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import * as sessionEntryRows from "../config/sessions/session-accessor.sqlite-status.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import { commitMemory } from "../config/sessions/session-actor-memory-publication.test-support.js";
import { withSessionActorStorage } from "../config/sessions/session-actor-storage-binding.js";
import type { SessionActorStorageWrites } from "../config/sessions/session-actor-storage-contract.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { emitSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { persistUserTurnTranscript } from "../sessions/user-turn-transcript.test-support.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import { runOpenClawAgentWriteTransaction } from "../state/openclaw-agent-db.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { setAvatar, setDisplayName } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { resolveCurrentUserProfileDisplay } from "./current-user-profile-display.js";
import * as sessionHistoryState from "./session-history-state.js";
import { SessionHistorySseState } from "./session-history-state.js";
import {
  appendHistoryMessage,
  expectErrorResponse,
  fetchSessionHistory,
  historyStream,
  historyTexts,
  openHistoryStream,
  readSessionHistoryBody,
  type SessionHistoryBody,
  type SessionHistoryMessage,
  type SessionHistorySseStream,
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

const cleanupDirs: string[] = [];

const AGENT_ID = "main";
const SESSION_KEY = "agent:main:main";

async function createSessionStoreFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-history-"));
  cleanupDirs.push(dir);
  const storePath = path.join(dir, "sessions.json");
  testState.sessionStorePath = storePath;
  await writeSessionStore({ entries: {}, storePath });
  return storePath;
}

async function seedSession(params?: { text?: string; sessionId?: string; updatedAt?: number }) {
  const storePath = await createSessionStoreFile();
  const sessionId = params?.sessionId ?? "sess-main";
  await writeSessionStore({
    entries: { main: { sessionId, updatedAt: params?.updatedAt ?? Date.now() } },
    storePath,
  });
  if (params?.text) {
    await appendText(storePath, params.text);
  }
  return { storePath };
}

async function appendText(storePath: string, text: string, emitInlineMessage = true) {
  return (await appendMessage(storePath, text, emitInlineMessage ? "inline" : "file-only"))
    .messageId;
}

async function appendMessage(
  storePath: string,
  text: string,
  updateMode: "inline" | "file-only" | "none",
) {
  const message = makeTranscriptAssistantMessage({ text });
  const appended = await appendHistoryMessage({
    sessionKey: SESSION_KEY,
    storePath,
    message,
    updateMode,
  });
  return { ...appended, message };
}

function persistHistoryTurn(
  storePath: string,
  input: Parameters<typeof persistUserTurnTranscript>[0]["input"],
) {
  return persistUserTurnTranscript({
    agentId: AGENT_ID,
    sessionEntry: { sessionId: "sess-main", updatedAt: 1 },
    sessionId: "sess-main",
    sessionKey: SESSION_KEY,
    storePath,
    input,
  });
}

function replaceHistory(
  storePath: string,
  events: Parameters<typeof replaceTranscriptEvents>[1],
  sessionId = "sess-main",
) {
  return replaceTranscriptEvents(
    { agentId: AGENT_ID, sessionId, sessionKey: SESSION_KEY, storePath },
    [{ type: "session", version: 1, id: sessionId }, ...events],
  );
}

const sessionHistoryRowIdentity = (message: SessionHistoryMessage) =>
  `${message["__openclaw"]?.seq}:${message.role}:${message.content?.[0]?.text}`;

function withMockedDateNow<T>(now: number, run: () => T): T {
  using _ = vi.spyOn(Date, "now").mockReturnValue(now);
  return run();
}

function currentProfileAvatarUrl(profileId: string): string {
  const display = resolveCurrentUserProfileDisplay(profileId);
  expect(display.kind).toBe("resolved");
  if (display.kind !== "resolved") {
    throw new Error("expected a resolved current profile display");
  }
  return display.avatarUrl;
}

function withGatewayHistoryStream(
  run: (stream: SessionHistorySseStream, port: number) => Promise<void>,
  query?: string,
) {
  return withGatewayHarness(async ({ port }) => {
    await using stream = await openHistoryStream(port, SESSION_KEY, query);
    await run(stream, port);
  });
}

async function withBearerServer(
  run: (started: Awaited<ReturnType<typeof startServerWithClient>>) => Promise<void>,
) {
  const started = await startServerWithClient("test-gateway-token-1234567890");
  try {
    await run(started);
  } finally {
    started.ws.close();
    await started.server.close();
    started.envSnapshot.restore();
  }
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

  test("reads unbound memory history without creating missing owners and withholds a closed owner's snapshot", async () => {
    await createSessionStoreFile();
    await withGatewayHarness(async (harness) => {
      const sessionKey = "agent:main:dashboard:incognito-http-history";
      const sessionId = "memory-http-history";
      const text = "Private memory reply";
      const location = {
        agentId: AGENT_ID,
        path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: AGENT_ID }),
      };
      const expectMissing = async () => {
        const response = await fetchSessionHistory(harness.port, sessionKey);
        expect(response.status).toBe(404);
        expectErrorResponse(await response.json(), {
          type: "not_found",
          message: `Session not found: ${sessionKey}`,
        });
        expect(memorySessionActorOwners.read(location)).toBeUndefined();
      };
      expect(memorySessionActorOwners.read(location)).toBeUndefined();
      try {
        await expectMissing();

        const authority = { assertCurrent() {}, authorize() {} };
        const lifetime = { assertCurrent() {}, assertReadable() {} };
        const input: SessionActorStorageWrites["session.entry.create"]["input"] = {
          entry: { sessionId, updatedAt: Date.now(), incognito: true },
          transcriptEvents: [
            { type: "session", id: sessionId, version: 3, cwd: "/synthetic" },
            {
              type: "message",
              id: "memory-http-reply",
              parentId: null,
              message: makeTranscriptAssistantMessage({ text }),
            },
          ],
        };
        await withSessionActorStorage(
          { agentId: AGENT_ID, sessionKey, storePath: location.path },
          { create: true, authority, lifetime },
          ({ actor }) => commitMemory(actor.storage, "session.entry.create", input, authority),
        );

        const history = await readSessionHistoryBody(harness.port, sessionKey);
        expect(history.sessionKey).toBe(sessionKey);
        expect(history.messages?.map((message) => message.content?.[0]?.text)).toEqual([text]);

        const readSnapshot = sessionHistoryState.readSessionHistorySnapshotAsync;
        using snapshotSpy = vi
          .spyOn(sessionHistoryState, "readSessionHistorySnapshotAsync")
          .mockImplementationOnce(async (params) => {
            const snapshot = await readSnapshot(params);
            memorySessionActorOwners.closeDatabase(location);
            return snapshot;
          });
        await expectMissing();
        expect(snapshotSpy).toHaveBeenCalledOnce();
      } finally {
        memorySessionActorOwners.closeDatabase(location);
      }
    });
  });

  test("uses SSE only for an explicit acceptable event-stream media range", async () => {
    const expectedText = "accept negotiation sentinel";
    await seedSession({ text: expectedText });
    await withGatewayHarness(async (harness) => {
      const cases = {
        "text/event-stream": [
          "text/event-stream",
          "TEXT/EVENT-STREAM",
          "  text/event-stream  ",
          "text/event-stream;",
          "text/event-stream; charset=utf-8",
          "text/event-stream;q=0.001",
          "text/event-stream;Q=1.000",
          "text/event-stream;q=0, text/event-stream;q=0.5",
          "text/event-stream;q=0, text/event-stream;charset=utf-8;q=0.5",
          "text/event-stream;q=0.5;charset=utf-8",
        ],
        "application/json": [
          'text/event-stream; note="quoted,comma;semicolon\\\"quote"; q=0.5',
          "text/event-stream;q=1, text/event-stream;charset=utf-8;q=0",
          "text/event-stream;q=1;charset=utf-16",
          "text/event-stream;charset=utf-16",
          "text/event-streaming",
          "text/event-streamx",
          'application/json; note="text/event-stream"',
          "text/*",
          "*/*",
          "text/event-stream;q=0",
          "text/event-stream;q=0, */*;q=1",
          "text/event-stream;q=0.1234",
          "text/event-stream;q =0.5",
          "text/event-stream;q= 0.5",
          "text/event-stream;\u00a0q=0.5",
        ],
      };

      for (const [contentType, accepts] of Object.entries(cases)) {
        for (const accept of accepts) {
          const response = await fetchSessionHistory(harness.port, SESSION_KEY, {
            headers: { Accept: accept },
          });
          expect(response.status, accept).toBe(200);
          expect(response.headers.get("content-type"), accept).toContain(contentType);
          let body: SessionHistoryBody;
          if (contentType === "text/event-stream") {
            await using stream = historyStream(response);
            body = await stream.next();
          } else {
            body = (await response.json()) as SessionHistoryBody;
          }
          expect(body.messages?.[0]?.content?.[0]?.text, accept).toBe(expectedText);
        }
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
      using decode = vi.spyOn(sessionEntryRows, "parseSessionEntryJson");
      for (const query of ["", "?cursor=", "?cursor=%20"]) {
        decode.mockClear();
        const context = `query ${JSON.stringify(query)}`;
        const res = await fetchSessionHistory(harness.port, SESSION_KEY, { query });
        expect(res.status, context).toBe(200);
        const body = (await res.json()) as SessionHistoryBody;
        expect(body, context).toMatchObject({
          sessionKey: SESSION_KEY,
          messages: [{ content: [{ text: "hello from history" }], __openclaw: { seq: 1 } }],
        });
        expect(
          decode.mock.calls.some(([row]) => row.entry_json.includes(unrelatedPrompt)),
          context,
        ).toBe(false);
      }
    });
  });

  test("shares revisioned current-profile projection across REST and initial and inline SSE", async () => {
    const { storePath } = await seedSession();

    const profile = withMockedDateNow(1_800_000_000_000, () => {
      const created = ensureProfileForEmail("session-history-profile@example.com");
      setDisplayName(created.id, "Old Display Name");
      expect(setAvatar(created.id, new Uint8Array([1, 2, 3]), "image/png").ok).toBe(true);
      return created;
    });
    const oldAvatarUrl = currentProfileAvatarUrl(profile.id);
    const persistAttributedTurn = async (id: string, senderName: string, text: string) => {
      const turn = await persistHistoryTurn(storePath, {
        idempotencyKey: `session-history-profile:${id}`,
        sender: {
          id: profile.id,
          identity: { type: "profile", id: profile.id },
          name: senderName,
          username: "ada",
        },
        text,
      });
      expect(turn).toBeDefined();
      return turn!;
    };
    const first = await persistAttributedTurn("first", "Historical Ada", "first turn");
    const turn = (id: string, seq: number, name: string, text: string, avatarUrl: string) => ({
      role: "user",
      content: text,
      __openclaw: {
        id,
        seq,
        senderId: profile.id,
        senderName: name,
        senderUsername: "ada",
        senderProfileAvatarUrl: avatarUrl,
      },
    });

    await withGatewayHarness(async (harness) => {
      const initialRest = await readSessionHistoryBody(harness.port, SESSION_KEY);
      await using stream = await openHistoryStream(harness.port, SESSION_KEY);
      const initialSse = await stream.next();
      const oldExpected = turn(first.messageId, 1, "Historical Ada", "first turn", oldAvatarUrl);
      expect(initialRest.messages?.[0]).toMatchObject(oldExpected);
      expect(initialSse.messages?.[0]).toMatchObject(oldExpected);

      withMockedDateNow(1_900_000_000_000, () => {
        setDisplayName(profile.id, "Current Ada");
        expect(setAvatar(profile.id, new Uint8Array([4, 5, 6]), "image/png").ok).toBe(true);
      });
      const newAvatarUrl = currentProfileAvatarUrl(profile.id);
      expect(newAvatarUrl).not.toBe(oldAvatarUrl);

      const inlineEventPromise = stream.next();
      const second = await persistAttributedTurn("second", "Current Ada", "second turn");
      const refreshEvent = await inlineEventPromise;
      const expected = [
        turn(first.messageId, 1, "Historical Ada", "first turn", newAvatarUrl),
        turn(second.messageId, 2, "Current Ada", "second turn", newAvatarUrl),
      ];
      for (const body of [refreshEvent, await readSessionHistoryBody(harness.port, SESSION_KEY)]) {
        expect(body.messages).toMatchObject(expected);
      }
    });
  });

  test("attributes forwarded history only from structured provenance across transports and pages", async () => {
    const { storePath } = await seedSession();
    const sessionKey = SESSION_KEY;
    const cases = [
      {
        body: "Verified sender body\n    indented line",
        sourceSessionKey: "agent:helper:ops",
        senderLabel: "Forwarded from helper",
        senderSession: { sessionKey: "agent:helper:ops", agentId: "helper" },
      },
      {
        body: "Unverified sender body\n    indented line",
        sourceSessionKey: undefined,
        senderLabel: "Forwarded agent message",
        senderSession: undefined,
      },
    ];
    for (const entry of cases) {
      const persisted = await persistHistoryTurn(storePath, {
        text: `[Inter-session message] sourceSession=agent:grimwald:asserted sourceTool=sessions_send isUser=false\n${entry.body}`,
        provenance: {
          kind: "inter_session",
          sourceTool: "sessions_send",
          ...(entry.sourceSessionKey ? { sourceSessionKey: entry.sourceSessionKey } : {}),
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
    await fs.writeFile(
      path.join(path.dirname(storePath), `${sessionId}.jsonl.reset.2026-02-16T22-26-34.000Z`),
      [
        { type: "session", version: 1, id: sessionId },
        {
          message: {
            role: "assistant",
            content: [{ type: "text", text: "archived before reset" }],
          },
        },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n"),
    );
    await writeSessionStore({ entries: { [SESSION_KEY]: { sessionId, updatedAt: 1 } }, storePath });

    await withGatewayHistoryStream(async (stream) => {
      await stream.expectTexts(["archived before reset"]);

      const appended = await appendMessage(storePath, "active after reset", "none");
      emitSessionTranscriptUpdate({
        sessionFile: appended.target.sessionKey,
        sessionKey: SESSION_KEY,
        target: {
          agentId: appended.target.agentId ?? "main",
          sessionId: appended.target.sessionId,
          sessionKey: appended.target.sessionKey,
        },
        message: appended.message,
        messageId: appended.messageId,
        messageSeq: 2,
      });

      await stream.expectTexts(["active after reset"]);
    });
  });

  test("claims invalid encoded session keys on a listening Gateway", async () => {
    await withGatewayHarness(async (harness) => {
      for (const encodedSessionKey of ["%20", "%zz"]) {
        const response = await fetch(
          `http://127.0.0.1:${harness.port}/sessions/${encodedSessionKey}/history`,
        );
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
          error: { type: "invalid_request_error", message: "invalid session key" },
        });
      }
    });
  });

  test("returns 404 without initializing a missing configured session store", async () => {
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
    const missingDatabasePath = expectDefined(
      resolveSqliteTargetFromSessionStorePath(storeTemplate.replace("{agentId}", agentId), {
        agentId,
      }).path,
      "configured database path",
    );
    await withGatewayHarness(
      async ({ port }) => {
        await expect(fs.stat(missingDatabasePath)).rejects.toMatchObject({ code: "ENOENT" });
        const res = await fetchSessionHistory(port, sessionKey);
        expect(res.status).toBe(404);
        expectErrorResponse(await res.json(), {
          type: "not_found",
          message: `Session not found: ${sessionKey}`,
        });
        await expect(fs.stat(missingDatabasePath)).rejects.toMatchObject({ code: "ENOENT" });
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
        const databasePath = expectDefined(
          resolveSqliteTargetFromSessionStorePath(storePath, {
            agentId: AGENT_ID,
          }).path,
          "SQLite session store path",
        );
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
    const sessionId = "sess-hidden-turn-replies";
    const sessionKey = SESSION_KEY;
    const { storePath } = await seedSession({ sessionId });
    const timestamp = Date.UTC(2026, 7, 15, 9, 30, 0);
    const assistantMessage = (text: string, model: string) => ({
      ...makeTranscriptAssistantMessage({ text, provider: "openclaw", model }),
      timestamp,
    });
    const replies = ["First reply.", "Second reply.", "Third reply."];
    await replaceHistory(
      storePath,
      replies.flatMap((text, index) => [
        { message: assistantMessage(text, "acp-runtime") },
        { message: { role: "user", content: index ? HEARTBEAT_PROMPT : "" } },
        ...(index === 2 ? [{ message: { role: "assistant", content: "HEARTBEAT_OK" } }] : []),
        { message: assistantMessage(text, "gateway-injected") },
      ]),
      sessionId,
    );

    const expectedRows = [
      [1, 3],
      [4, 6],
      [7, 10],
    ].flatMap((sequences, index) => sequences.map((seq) => `${seq}:assistant:${replies[index]}`));
    await withGatewayHarness(async (harness) => {
      const history = await readSessionHistoryBody(harness.port, sessionKey);
      expect(history.messages?.map(sessionHistoryRowIdentity)).toEqual(expectedRows);
      expect(history.messages?.map((message) => message.timestamp)).toEqual(
        Array.from({ length: 6 }, () => timestamp),
      );
      expect(history.messages?.map((message) => message["__openclaw"]?.turnBoundary)).toEqual([
        undefined,
        undefined,
        undefined,
        true,
        undefined,
        true,
      ]);

      await using stream = await openHistoryStream(harness.port, SESSION_KEY);
      const streamedHistory = await stream.next();
      expect(streamedHistory.messages?.map(sessionHistoryRowIdentity)).toEqual(expectedRows);
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

      expect(historyTexts(body)).toEqual(["first message", "second message", "third message"]);
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
    const { storePath } = await seedSession();

    await withGatewayHarness(async (harness) => {
      const visibleMessageId = "visible-phased-assistant";
      await replaceHistory(storePath, [
        { id: "hidden-control", message: makeTranscriptAssistantMessage({ text: "NO_REPLY" }) },
        {
          id: visibleMessageId,
          message: {
            ...makeTranscriptAssistantMessage({ text: "Done." }),
            content: [
              { id: "item_commentary", phase: "commentary", text: "internal reasoning" },
              { id: "item_final", phase: "final_answer", text: "Done." },
            ].map(({ text, ...signature }) => ({
              type: "output_text",
              text,
              textSignature: JSON.stringify({ v: 1, ...signature }),
            })),
          },
        },
      ]);

      const body = await readSessionHistoryBody(harness.port, SESSION_KEY);
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
    const { storePath } = await seedSession({ text: "first message" });

    await withGatewayHarness(async (harness) => {
      const readSnapshot = sessionHistoryState.readSessionHistorySnapshotAsync;
      using _ = vi
        .spyOn(sessionHistoryState, "readSessionHistorySnapshotAsync")
        .mockImplementationOnce(async (params) => {
          const snapshot = await readSnapshot(params);
          await appendText(storePath, "during startup");
          return snapshot;
        });
      await using stream = await openHistoryStream(harness.port, SESSION_KEY, "?limit=2");
      await stream.expectTexts(["first message", "during startup"]);
      await appendText(storePath, "after startup");
      await stream.expectTexts(["during startup", "after startup"]);
    });
  });

  test("bounds retained SSE history without truncating full history or live updates", async () => {
    const retainedLimit = 1_000;
    const initialCount = retainedLimit + 2;
    const { storePath } = await seedSession();
    await replaceHistory(
      storePath,
      Array.from({ length: initialCount }, (_, index) => ({
        id: `history-message-${index + 1}`,
        parentId: index === 0 ? null : `history-message-${index}`,
        message: makeTranscriptAssistantMessage({ text: `history message ${index + 1}` }),
      })),
    );

    using snapshotSpy = vi.spyOn(SessionHistorySseState.prototype, "snapshot");
    const expectWindow = (
      body: SessionHistoryBody | undefined,
      length: number,
      first?: string,
      last?: string,
    ) => {
      expect(body?.messages).toHaveLength(length);
      if (first) {
        expect(body?.messages?.[0]?.content?.[0]?.text).toBe(first);
      }
      if (last) {
        expect(body?.messages?.at(-1)?.content?.[0]?.text).toBe(last);
      }
    };
    const retainedSnapshot = () => snapshotSpy.mock.results.at(-1)?.value;
    await withGatewayHistoryStream(async (stream, port) => {
      const initial = await stream.next();
      expectWindow(initial, initialCount, "history message 1");
      expectWindow(retainedSnapshot(), retainedLimit, "history message 3");
      await using cursorStream = await openHistoryStream(
        port,
        SESSION_KEY,
        `?cursor=${initialCount + 1}`,
      );
      expectWindow(await cursorStream.next(), initialCount);
      expectWindow(retainedSnapshot(), retainedLimit, "history message 3");

      const messageId = await appendText(storePath, "live history message");
      const lastSequence = initial.messages?.at(-1)?.["__openclaw"]?.seq;
      expect(lastSequence).toEqual(expect.any(Number));
      await stream.expectMessage("live history message", (lastSequence ?? 0) + 1, messageId);

      const liveRetained = snapshotSpy.mock.results.findLast((result) => {
        const snapshot = result.value;
        return snapshot?.messages?.at(-1)?.content?.[0]?.text === "live history message";
      })?.value;
      expectWindow(liveRetained, retainedLimit, undefined, "live history message");
      expectWindow(await cursorStream.next(), initialCount, "history message 1");
      expectWindow(retainedSnapshot(), retainedLimit);

      const completeHistory = await vi.waitFor(() => readSessionHistoryBody(port, SESSION_KEY), {
        interval: 25,
        timeout: 5_000,
      });
      expectWindow(completeHistory, initialCount + 1, "history message 1", "live history message");
    });
  });

  test("resyncs raw sequence numbering after transcript-only SSE refreshes", async () => {
    const { storePath } = await seedSession({ text: "first message" });

    await withGatewayHistoryStream(async (stream) => {
      await stream.expectTexts(["first message"]);
      await appendText(storePath, "second visible message");

      await stream.expectMessage("second visible message", 2);
      await appendText(storePath, "NO_REPLY", false);

      await stream.expectTexts(["first message", "second visible message"]);

      const thirdId = await appendText(storePath, "third visible message");
      await stream.expectMessage("third visible message", 4, thirdId);
    });
  });

  test("rejects session history when operator.read is not requested", async () => {
    await closeHistoryHarness();
    await seedSession({ text: "scope-guarded history" });

    await withBearerServer(async ({ ws }) => {
      const connect = await connectReq(ws, {
        token: "test-gateway-token-1234567890",
        scopes: ["operator.approvals"],
      });
      expect(connect.ok).toBe(true);

      const wsHistory = await rpcReq<{ messages?: unknown[] }>(ws, "chat.history", {
        sessionKey: SESSION_KEY,
        limit: 1,
      });
      expect(wsHistory).toMatchObject({
        ok: false,
        error: { message: "missing scope: operator.read" },
      });
    });
  });
});
