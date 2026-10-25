import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, describe, expect, test, vi } from "vitest";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import { commitMemory } from "../config/sessions/session-actor-memory-publication.test-support.js";
import { withSessionActorStorage } from "../config/sessions/session-actor-storage-binding.js";
import type { SessionActorStorageWrites } from "../config/sessions/session-actor-storage-contract.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { emitSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import { runOpenClawAgentWriteTransaction } from "../state/openclaw-agent-db.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import * as sessionHistoryState from "./session-history-state.js";
import {
  appendHistoryMessage,
  expectErrorResponse,
  fetchSessionHistory,
  historyStream,
  historyTexts,
  openHistoryStream,
  readSessionHistoryBody,
  type SessionHistoryBody,
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
          "  TEXT/EVENT-STREAM;Q=1.000;charset=UTF-8;  ",
          "text/event-stream;q=0, text/event-stream;q=0.5",
          "text/event-stream;q=0, text/event-stream;charset=utf-8;q=0.5",
        ],
        "application/json": [
          'text/event-stream; note="quoted,comma;semicolon\\\"quote"; q=0.5',
          "text/event-stream;q=1, text/event-stream;charset=utf-8;q=0",
          "text/event-stream;charset=utf-16",
          "text/event-streaming",
          'application/json; note="text/event-stream"',
          "text/*",
          "*/*",
          "text/event-stream;q=0, */*;q=1",
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

  test("treats blank cursor queries as default history", async () => {
    await seedSession({ text: "hello from history" });
    await withGatewayHarness(async (harness) => {
      for (const query of ["", "?cursor=", "?cursor=%20"]) {
        expect(await readSessionHistoryBody(harness.port, SESSION_KEY, { query })).toMatchObject({
          sessionKey: SESSION_KEY,
          messages: [{ content: [{ text: "hello from history" }], __openclaw: { seq: 1 } }],
        });
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

  test("serves complete history and live updates beyond the SSE retention window", async () => {
    const initialCount = 1_002;
    const { storePath } = await seedSession();
    await replaceHistory(
      storePath,
      Array.from({ length: initialCount }, (_, index) => ({
        id: `history-message-${index + 1}`,
        parentId: index === 0 ? null : `history-message-${index}`,
        message: makeTranscriptAssistantMessage({ text: `history message ${index + 1}` }),
      })),
    );

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
    await withGatewayHistoryStream(async (stream, port) => {
      const initial = await stream.next();
      expectWindow(initial, initialCount, "history message 1");
      await using cursorStream = await openHistoryStream(
        port,
        SESSION_KEY,
        `?cursor=${initialCount + 1}`,
      );
      expectWindow(await cursorStream.next(), initialCount);

      const messageId = await appendText(storePath, "live history message");
      const lastSequence = initial.messages?.at(-1)?.["__openclaw"]?.seq;
      expect(lastSequence).toEqual(expect.any(Number));
      await stream.expectMessage("live history message", (lastSequence ?? 0) + 1, messageId);

      expectWindow(await cursorStream.next(), initialCount, "history message 1");

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
