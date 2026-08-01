import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  loadTranscriptEventRowsAfterSeqSync,
  readSessionTranscriptRestorableMessageSnapshot,
  replaceTranscriptEvents,
  rewriteTranscriptEventRowsExact,
  upsertSessionEntry,
} from "./session-accessor.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("SQLite restorable transcript messages", () => {
  let scope: {
    agentId: string;
    env: NodeJS.ProcessEnv;
    sessionId: string;
    sessionKey: string;
  };

  beforeEach(async () => {
    const stateDir = tempDirs.make("openclaw-restorable-messages-");
    scope = {
      agentId: "main",
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      sessionId: "restorable-messages",
      sessionKey: "agent:main:restorable-messages",
    };
    await upsertSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: Date.now() });
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
  });

  function ids() {
    return readSessionTranscriptRestorableMessageSnapshot(scope).events.map(
      ({ event }) => (event as { id?: unknown }).id,
    );
  }

  it("returns active and inactive branch messages once in storage order", async () => {
    await replaceTranscriptEvents(scope, [
      { type: "session", id: scope.sessionId, version: 3 },
      { type: "message", id: "u1", parentId: null, message: { role: "user", content: "one" } },
      {
        type: "message",
        id: "a1",
        parentId: "u1",
        message: { role: "assistant", content: "one" },
      },
      { type: "message", id: "u2", parentId: "a1", message: { role: "user", content: "two" } },
      {
        type: "message",
        id: "a2",
        parentId: "u2",
        message: { role: "assistant", content: "two" },
      },
      { type: "message", id: "u3", parentId: "a2", message: { role: "user", content: "three" } },
      {
        type: "leaf",
        id: "rewind-leaf",
        parentId: "u3",
        targetId: "a1",
      },
    ]);

    expect(ids()).toEqual(["u1", "a1", "u2", "a2", "u3"]);
  });

  it("applies reset replay semantics and lets a newer compaction shadow the window", async () => {
    const baseEvents = [
      { type: "session", id: scope.sessionId, version: 3 },
      { type: "message", id: "old", parentId: null, message: { role: "user", content: "old" } },
      {
        type: "message",
        id: "pre-reset-tip",
        parentId: "old",
        message: { role: "assistant", content: "retired branch" },
      },
      {
        type: "message",
        id: "kept-user",
        parentId: "old",
        message: { role: "user", content: "kept" },
      },
      {
        type: "message",
        id: "kept-tool",
        parentId: "kept-user",
        message: { role: "toolResult", content: "not replayed" },
      },
      {
        type: "message",
        id: "kept-assistant",
        parentId: "kept-tool",
        message: { role: "assistant", content: "kept answer" },
      },
      {
        type: "reset",
        id: "reset-boundary",
        parentId: "kept-assistant",
        firstKeptEntryId: "kept-user",
      },
      {
        type: "message",
        id: "post-reset",
        parentId: "reset-boundary",
        message: { role: "user", content: "new active branch" },
      },
      {
        type: "message",
        id: "post-reset-inactive",
        parentId: "reset-boundary",
        message: { role: "assistant", content: "new inactive branch" },
      },
      {
        type: "leaf",
        id: "active-leaf",
        parentId: "post-reset-inactive",
        targetId: "post-reset",
      },
    ];
    await replaceTranscriptEvents(scope, baseEvents);

    expect(ids()).toEqual([
      "kept-user",
      "kept-assistant",
      "post-reset",
      "post-reset-inactive",
    ]);

    await replaceTranscriptEvents(scope, [
      ...baseEvents,
      {
        type: "compaction",
        id: "newer-compaction",
        parentId: "post-reset",
        firstKeptEntryId: "post-reset",
      },
    ]);

    expect(ids()).toEqual([
      "old",
      "kept-user",
      "kept-tool",
      "kept-assistant",
      "post-reset",
      "post-reset-inactive",
    ]);
  });

  it("rotates generation for exact-row rewrites without changing max sequence", async () => {
    await replaceTranscriptEvents(scope, [
      { type: "session", id: scope.sessionId, version: 3 },
      {
        type: "message",
        id: "assistant",
        parentId: null,
        message: { role: "assistant", content: "before" },
      },
    ]);
    const before = readSessionTranscriptRestorableMessageSnapshot(scope);
    const row = loadTranscriptEventRowsAfterSeqSync(scope, -1).find(
      ({ event }) => (event as { id?: unknown }).id === "assistant",
    );
    if (!row) {
      throw new Error("expected assistant transcript row");
    }

    await expect(
      rewriteTranscriptEventRowsExact(scope, {
        expectedGeneration: before.generation,
        rows: [
          {
            event: {
              ...(row.event as Record<string, unknown>),
              message: { role: "assistant", content: "after" },
            },
            expectedEventJson: JSON.stringify(row.event),
            seq: row.seq,
          },
        ],
      }),
    ).resolves.toEqual({ generation: expect.any(String) });

    const after = readSessionTranscriptRestorableMessageSnapshot(scope);
    expect(after.generation).not.toBe(before.generation);
    expect(after.maxSeq).toBe(before.maxSeq);
    expect(after.events).toEqual([
      expect.objectContaining({
        event: expect.objectContaining({
          id: "assistant",
          message: { role: "assistant", content: "after" },
        }),
      }),
    ]);
  });
});
