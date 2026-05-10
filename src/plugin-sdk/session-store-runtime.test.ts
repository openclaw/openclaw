import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  getSessionEntry,
  loadActiveSqliteSessionTranscriptProjections,
  loadSqliteSessionTranscriptProjections,
  replaceSqliteSessionTranscriptEvents,
  upsertSessionEntry,
} from "./session-store-runtime.js";

function createTempDir(): string {
  return fsSync.mkdtempSync(path.join(os.tmpdir(), "openclaw-session-store-runtime-"));
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

describe("plugin-sdk session-store-runtime projections", () => {
  it("rebuilds canonical transcript projections from the owned session row scope", () => {
    const stateDir = createTempDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };

    upsertSessionEntry({
      env,
      agentId: "main",
      sessionKey: "agent:main:main",
      entry: {
        sessionId: "session-1",
        updatedAt: 100,
      },
    });

    replaceSqliteSessionTranscriptEvents({
      env,
      agentId: "main",
      sessionId: "session-1",
      events: [
        { type: "session", id: "session-1" },
        {
          type: "message",
          id: "m1",
          parentId: null,
          message: { role: "user", content: "search" },
        },
        {
          type: "message",
          id: "stale",
          parentId: "m1",
          message: { role: "assistant", content: "old branch" },
        },
        {
          type: "message",
          id: "active",
          parentId: "m1",
          message: {
            role: "assistant",
            content: [{ type: "toolCall", id: "call_content", name: "read", arguments: {} }],
            tool_calls: [{ id: "call_openai", function: { name: "shell", arguments: "{}" } }],
          },
        },
      ],
      now: () => 200,
    });

    replaceSqliteSessionTranscriptEvents({
      env,
      agentId: "main",
      sessionId: "checkpoint-only",
      events: [
        { type: "session", id: "checkpoint-only" },
        {
          type: "message",
          id: "snapshot-msg",
          parentId: null,
          message: { role: "assistant", content: "maintenance transcript" },
        },
      ],
      now: () => 300,
    });

    const sessionEntry = getSessionEntry({
      env,
      agentId: "main",
      sessionKey: "agent:main:main",
    });

    expect(sessionEntry?.sessionId).toBe("session-1");
    expect(
      loadSqliteSessionTranscriptProjections({
        env,
        agentId: "main",
        sessionId: sessionEntry!.sessionId,
      }).map((entry) => ({
        eventId: entry.eventId,
        messageRole: entry.messageRole,
        toolCallIds: entry.toolCallIds,
      })),
    ).toEqual([
      { eventId: "session-1", messageRole: undefined, toolCallIds: [] },
      { eventId: "m1", messageRole: "user", toolCallIds: [] },
      { eventId: "stale", messageRole: "assistant", toolCallIds: [] },
      {
        eventId: "active",
        messageRole: "assistant",
        toolCallIds: ["call_openai", "call_content"],
      },
    ]);
    expect(
      loadActiveSqliteSessionTranscriptProjections({
        env,
        agentId: "main",
        sessionId: sessionEntry!.sessionId,
      }).map((entry) => entry.eventId),
    ).toEqual(["m1", "active"]);
  });
});
