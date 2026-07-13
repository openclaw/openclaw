/** SQLite-native transcript search: in-transaction indexing, reconcile, and query bounds. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { TranscriptEvent } from "./session-accessor.js";
import {
  appendSqliteTranscriptEvent,
  appendSqliteTranscriptMessage,
  replaceSqliteTranscriptEvents,
} from "./session-accessor.sqlite.js";
import { listSessionsNeedingTranscriptIndexReconcile } from "./session-transcript-index.js";
import { searchSessionTranscripts } from "./session-transcript-search.js";

vi.mock("../config.js", async () => ({
  ...(await vi.importActual<typeof import("../config.js")>("../config.js")),
  getRuntimeConfig: vi.fn().mockReturnValue({}),
}));

type TestPaths = { stateDir: string; tempDir: string };

let paths: TestPaths;

beforeEach(() => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-session-search-"));
  paths = {
    stateDir: path.join(tempDir, "state"),
    tempDir,
  };
});

function env(): NodeJS.ProcessEnv {
  return { ...process.env, OPENCLAW_STATE_DIR: paths.stateDir };
}

function transcriptScope(sessionId: string, sessionKey: string) {
  return {
    agentId: "main",
    env: env(),
    sessionId,
    sessionKey,
  };
}

async function appendUserMessage(sessionId: string, sessionKey: string, text: string) {
  await appendSqliteTranscriptMessage(transcriptScope(sessionId, sessionKey), {
    message: { role: "user", content: [{ type: "text", text }] },
  });
}

async function appendAssistantMessage(sessionId: string, sessionKey: string, text: string) {
  await appendSqliteTranscriptMessage(transcriptScope(sessionId, sessionKey), {
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
}

function search(query: string, options: { limit?: number; sessionKeys?: string[] } = {}) {
  return searchSessionTranscripts({
    agentId: "main",
    env: env(),
    query,
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
    ...(options.sessionKeys ? { sessionKeys: options.sessionKeys } : {}),
  });
}

function agentKysely() {
  const database = openOpenClawAgentDatabase({ agentId: "main", env: env() });
  return {
    db: database.db,
    kysely: getNodeSqliteKysely<
      Pick<
        OpenClawAgentKyselyDatabase,
        "session_transcript_fts" | "session_transcript_index_state" | "transcript_events"
      >
    >(database.db),
  };
}

describe("searchSessionTranscripts", () => {
  it("indexes appended messages synchronously and returns bounded hits", async () => {
    await appendUserMessage("session-1", "agent:main:main", "the deployment failed on friday");
    await appendAssistantMessage("session-1", "agent:main:main", "the deployment fix is rolling");

    const result = search("deployment");
    expect(result.indexing).toBe(false);
    expect(result.truncated).toBe(false);
    expect(result.hits).toHaveLength(2);
    const roles = result.hits.map((hit) => hit.role).toSorted();
    expect(roles).toEqual(["assistant", "user"]);
    for (const hit of result.hits) {
      expect(hit.sessionKey).toBe("agent:main:main");
      expect(hit.sessionId).toBe("session-1");
      expect(hit.snippet).toContain("deployment");
      expect(hit.messageId).toBeTruthy();
    }
  });

  it("ignores non-message events and misses non-matching queries", async () => {
    await appendUserMessage("session-1", "agent:main:main", "alpha topic");
    await appendSqliteTranscriptEvent(transcriptScope("session-1", "agent:main:main"), {
      type: "model_change",
      id: "model-change-1",
      model: "sonnet-4.6",
    } as unknown as TranscriptEvent);

    expect(search("sonnet").hits).toHaveLength(0);
    expect(search("alpha").hits).toHaveLength(1);
  });

  it("filters hits to the requested session keys", async () => {
    await appendUserMessage("session-1", "agent:main:main", "shared keyword payload");
    await appendUserMessage("session-2", "agent:main:other", "shared keyword payload");

    const all = search("keyword");
    expect(all.hits).toHaveLength(2);

    const filtered = search("keyword", { sessionKeys: ["agent:main:other"] });
    expect(filtered.hits).toHaveLength(1);
    expect(filtered.hits[0]?.sessionKey).toBe("agent:main:other");
    expect(filtered.hits[0]?.sessionId).toBe("session-2");
  });

  it("caps hits at the limit and reports truncation", async () => {
    for (let index = 0; index < 4; index += 1) {
      await appendUserMessage("session-1", "agent:main:main", `needle number ${index}`);
    }
    const result = search("needle", { limit: 3 });
    expect(result.hits).toHaveLength(3);
    expect(result.truncated).toBe(true);
  });

  it("rejects empty and oversized queries", () => {
    expect(() => search("   ")).toThrow(/query must not be empty/);
    expect(() => search("x".repeat(4097))).toThrow(/must not exceed/);
  });

  it("reindexes synchronously when a linear transcript is replaced", async () => {
    await appendUserMessage("session-1", "agent:main:main", "obsolete branch text");
    await replaceSqliteTranscriptEvents(transcriptScope("session-1", "agent:main:main"), [
      {
        type: "message",
        id: "m-new",
        parentId: null,
        message: { role: "user", content: [{ type: "text", text: "replacement text" }] },
        timestamp: 1720000000000,
      } as unknown as TranscriptEvent,
    ]);

    expect(search("obsolete").hits).toHaveLength(0);
    const result = search("replacement");
    expect(result.indexing).toBe(false);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.messageId).toBe("m-new");
  });

  it("detects missing, dirty, and lagging transcript index watermarks", async () => {
    await appendUserMessage("session-1", "agent:main:main", "indexed message");
    const { db, kysely } = agentKysely();
    const pending = () => listSessionsNeedingTranscriptIndexReconcile(db);

    expect(pending()).toEqual([]);

    executeSqliteQuerySync(
      db,
      kysely
        .updateTable("session_transcript_index_state")
        .set({ needs_rebuild: 1 })
        .where("session_id", "=", "session-1"),
    );
    expect(pending()).toEqual(["session-1"]);

    executeSqliteQuerySync(
      db,
      kysely
        .updateTable("session_transcript_index_state")
        .set({ indexed_seq: -1, needs_rebuild: 0 })
        .where("session_id", "=", "session-1"),
    );
    expect(pending()).toEqual(["session-1"]);

    executeSqliteQuerySync(
      db,
      kysely.deleteFrom("session_transcript_index_state").where("session_id", "=", "session-1"),
    );
    expect(pending()).toEqual(["session-1"]);
  });
});
