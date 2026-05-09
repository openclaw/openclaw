import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  getSqliteSessionTranscriptFrontier,
  loadSqliteSessionTranscriptDelta,
  replaceSqliteSessionTranscriptEvents,
} from "./session-store-runtime.js";

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-sdk-session-store-runtime-"));
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

describe("plugin-sdk session-store-runtime", () => {
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
});
