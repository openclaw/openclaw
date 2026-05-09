import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  clearSessionStoreCacheForTest,
  getSqliteSessionTranscriptFrontier,
  loadSessionStore,
  loadSqliteSessionTranscriptDelta,
  replaceSqliteSessionTranscriptEvents,
  resolveAndPersistSessionFile,
  resolveSessionStoreEntry,
  resolveSessionTranscriptPathInDir,
  resolveStorePath,
  saveSessionStore,
  updateSessionStore,
  updateSessionStoreEntry,
} from "./session-store-runtime.js";

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-sdk-session-store-runtime-"));
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

describe("plugin-sdk session-store-runtime", () => {
  it("keeps legacy compatibility exports while hiding raw database handles", async () => {
    const stateDir = createTempDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const storePath = resolveStorePath(undefined, { agentId: "main", env });
    const runtime = await import("./session-store-runtime.js");

    expect("openOpenClawAgentDatabase" in runtime).toBe(false);
    expect("openOpenClawStateDatabase" in runtime).toBe(false);
    expect("resolveOpenClawAgentSqlitePath" in runtime).toBe(false);

    clearSessionStoreCacheForTest();

    await saveSessionStore(storePath, {
      "User:1": {
        sessionId: "session-1",
        updatedAt: 10,
      },
    });

    expect(loadSessionStore(storePath)).toEqual({
      "User:1": {
        sessionId: "session-1",
        updatedAt: 10,
      },
    });

    expect(
      resolveSessionStoreEntry({
        store: loadSessionStore(storePath),
        sessionKey: "user:1",
      }),
    ).toEqual({
      normalizedKey: "user:1",
      existing: {
        sessionId: "session-1",
        updatedAt: 10,
      },
      legacyKeys: ["User:1"],
    });

    const updated = await updateSessionStoreEntry({
      storePath,
      sessionKey: "user:1",
      update: async () => ({
        sessionId: "session-2",
        updatedAt: 20,
      }),
    });

    expect(updated).toEqual({
      sessionId: "session-2",
      updatedAt: 20,
    });
    expect(loadSessionStore(storePath)).toEqual({
      "user:1": {
        sessionId: "session-2",
        updatedAt: 20,
      },
    });

    const updateResult = await updateSessionStore(storePath, async (store) => {
      store["thread:2"] = {
        sessionId: "session-3",
        updatedAt: 30,
      };
      return "ok";
    });

    expect(updateResult).toBe("ok");
    expect(loadSessionStore(storePath)).toEqual({
      "user:1": {
        sessionId: "session-2",
        updatedAt: 20,
      },
      "thread:2": {
        sessionId: "session-3",
        updatedAt: 30,
      },
    });

    const compatibilityStore: Record<string, { sessionId: string; updatedAt: number }> = {};
    const sessionsDir = path.join(stateDir, "compat-sessions");
    const { sessionFile, sessionEntry } = await resolveAndPersistSessionFile({
      sessionId: "session-4",
      sessionKey: "thread:4",
      sessionStore: compatibilityStore,
      sessionsDir,
      storePath,
    });

    expect(sessionFile).toBe(resolveSessionTranscriptPathInDir("session-4", sessionsDir));
    expect(sessionEntry).toMatchObject({
      sessionId: "session-4",
    });
    expect(loadSessionStore(storePath)).toMatchObject({
      "thread:4": {
        sessionId: "session-4",
      },
    });
  });

  it("exports a transcript frontier and append/reset delta seam", () => {
    const stateDir = createTempDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };

    replaceSqliteSessionTranscriptEvents({
      env,
      agentId: "main",
      sessionId: "session-1",
      events: [
        { type: "session", id: "session-1" },
        { type: "message", id: "m1", message: { role: "user", content: "one" } },
      ],
      now: () => 100,
    });

    const frontier = getSqliteSessionTranscriptFrontier({
      env,
      agentId: "main",
      sessionId: "session-1",
    });

    expect(frontier).toEqual({
      sessionId: "session-1",
      updatedAt: 100,
      eventCount: 2,
      lastSeq: 1,
      baseCreatedAt: 100,
    });

    expect(
      loadSqliteSessionTranscriptDelta({
        env,
        agentId: "main",
        sessionId: "session-1",
        cursor: {
          eventCount: 1,
          lastSeq: 0,
          baseCreatedAt: 100,
        },
      }),
    ).toMatchObject({
      mode: "append",
      frontier,
      events: [{ seq: 1, event: { type: "message", id: "m1" } }],
    });

    replaceSqliteSessionTranscriptEvents({
      env,
      agentId: "main",
      sessionId: "session-1",
      events: [
        { type: "session", id: "session-1" },
        { type: "message", id: "m2", message: { role: "assistant", content: "two" } },
      ],
      now: () => 200,
    });

    expect(
      loadSqliteSessionTranscriptDelta({
        env,
        agentId: "main",
        sessionId: "session-1",
        cursor: {
          eventCount: 2,
          lastSeq: 1,
          baseCreatedAt: 100,
        },
      }),
    ).toMatchObject({
      mode: "reset",
      frontier: {
        sessionId: "session-1",
        updatedAt: 200,
        eventCount: 2,
        lastSeq: 1,
        baseCreatedAt: 200,
      },
      events: [{ seq: 0, event: { type: "session", id: "session-1" } }, { seq: 1 }],
    });
  });

  it("resets transcript cursors after same-millisecond rewrites with the same frontier shape", () => {
    const stateDir = createTempDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };

    replaceSqliteSessionTranscriptEvents({
      env,
      agentId: "main",
      sessionId: "session-1",
      events: [
        { type: "session", id: "session-1" },
        { type: "message", id: "m1", message: { role: "user", content: "one" } },
      ],
      now: () => 100,
    });

    replaceSqliteSessionTranscriptEvents({
      env,
      agentId: "main",
      sessionId: "session-1",
      events: [
        { type: "session", id: "session-1" },
        { type: "message", id: "m2", message: { role: "assistant", content: "rewritten" } },
      ],
      now: () => 100,
    });

    expect(
      loadSqliteSessionTranscriptDelta({
        env,
        agentId: "main",
        sessionId: "session-1",
        cursor: {
          eventCount: 2,
          lastSeq: 1,
          baseCreatedAt: 100,
        },
      }),
    ).toMatchObject({
      mode: "reset",
      frontier: {
        sessionId: "session-1",
        updatedAt: 101,
        eventCount: 2,
        lastSeq: 1,
        baseCreatedAt: 101,
      },
      events: [{ seq: 0 }, { seq: 1, event: { type: "message", id: "m2" } }],
    });
  });
});
