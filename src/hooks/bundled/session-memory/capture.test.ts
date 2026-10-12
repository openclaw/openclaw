import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { observeHostDataSql } from "../../../../test/helpers/sqlite-statement-execution-counter.js";
import * as accessor from "../../../config/sessions/session-accessor.js";
import {
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "../../../config/sessions/session-accessor.sqlite-scope.js";
import { replaceTranscriptEvents } from "../../../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { waitForSessionTranscriptIndexReconcile } from "../../../config/sessions/session-transcript-reconcile.js";
import { openOpenClawAgentDatabase } from "../../../state/openclaw-agent-db.js";
import { useSessionStoreTempDirs } from "../../../test-utils/session-state-cleanup.js";
import { captureSessionMemoryTranscript } from "./capture.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-memory-capture-");

function message(id: string, parentId: string | null, role: string, content = id) {
  return { type: "message", id, parentId, message: { role, content } };
}

describe("session memory capture", () => {
  let scope: { agentId: string; sessionId: string; sessionKey: string; storePath: string };

  beforeEach(() => {
    scope = {
      agentId: "main",
      sessionId: "capture",
      sessionKey: "agent:main:capture",
      storePath: path.join(sessionDirs.make(), "sessions.json"),
    };
  });

  async function captureReady() {
    await accessor.waitForSessionTranscriptProjection(scope);
    return captureWithoutCallerSql();
  }

  async function captureWithoutCallerSql() {
    const hostSql = observeHostDataSql();
    try {
      const captured = await captureSessionMemoryTranscript(scope, undefined);
      expect(hostSql.queries).toEqual([]);
      return captured;
    } finally {
      hostSql.restore();
    }
  }

  async function captureDuringRepair() {
    const databaseOptions = toDatabaseOptions(resolveSqliteTranscriptReadScope(scope));
    // Projection readiness precedes the reconciliation writer's final orphan sweep.
    await waitForSessionTranscriptIndexReconcile(databaseOptions);
    const database = openOpenClawAgentDatabase(databaseOptions);
    database.db
      .prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?")
      .run(scope.sessionId);
    database.db
      .prepare("DELETE FROM session_transcript_active_events WHERE session_id = ?")
      .run(scope.sessionId);
    return captureWithoutCallerSql();
  }

  it.each(
    [false, true].flatMap((preserve) =>
      [false, true].map((compacted) => ({ preserve, compacted })),
    ),
  )(
    "respects an earlier reset (preserve: $preserve, compacted: $compacted)",
    async ({ preserve, compacted }) => {
      await replaceTranscriptEvents(scope, [
        message("closed", null, "user"),
        message("kept", "closed", "user"),
        message("answer", "kept", "assistant"),
        message("tool", "answer", "toolResult"),
        {
          type: "reset",
          id: "reset",
          parentId: "tool",
          ...(preserve ? { firstKeptEntryId: "kept" } : {}),
        },
        ...(compacted
          ? [
              {
                type: "compaction",
                id: "compact",
                parentId: "reset",
                firstKeptEntryId: "kept",
                summary: "earlier summary",
              },
            ]
          : []),
        message("current", compacted ? "compact" : "reset", "user"),
      ]);
      const expected = {
        status: "available",
        originClass: "untrusted",
        content: preserve
          ? 'user: "kept"\nassistant: "answer"\nuser: "current"'
          : 'user: "current"',
      };
      expect(await captureReady()).toEqual(expected);
      expect(await captureDuringRepair()).toEqual(expected);
    },
  );

  it("spans compaction and selects the explicit branch without changing provenance", async () => {
    await replaceTranscriptEvents(scope, [
      {
        ...message("restricted", null, "user"),
        message: { role: "user", content: "restricted", __openclaw: { senderIsOwner: false } },
      },
      { type: "compaction", id: "compact", parentId: "restricted", summary: "summary" },
      message("chosen", "compact", "assistant"),
      message("other", "compact", "assistant"),
      { type: "leaf", id: "leaf", parentId: "other", targetId: "chosen" },
    ]);
    const expected = {
      status: "available",
      originClass: "untrusted",
      content: 'user: "restricted"\nassistant: "chosen"',
    };
    expect(await captureReady()).toEqual(expected);
    expect(await captureDuringRepair()).toEqual(expected);
  });

  it("does not charge discarded reset-tail tools against the capture budget", async () => {
    await replaceTranscriptEvents(scope, [
      message("kept", null, "assistant", "k".repeat(1_024)),
      message("tool", "kept", "toolResult", "x".repeat(8 * 1024 * 1024 - 512)),
      { type: "reset", id: "reset", parentId: "tool", firstKeptEntryId: "kept" },
      message("current", "reset", "assistant"),
    ]);
    const captured = await captureReady();
    expect(captured.status === "available" && captured.content?.includes("k".repeat(1_024))).toBe(
      true,
    );
    expect(await captureDuringRepair()).toEqual(captured);
  });

  it("skips oversized rows while retaining the bounded recent conversation", async () => {
    await replaceTranscriptEvents(scope, [
      message("older", null, "assistant"),
      message("oversized", "older", "assistant", "x".repeat(8 * 1024 * 1024)),
      message("latest", "oversized", "assistant"),
    ]);
    const expected = {
      status: "available",
      originClass: "untrusted",
      content: 'assistant: "older"\nassistant: "latest"',
    };
    expect(await captureReady()).toEqual(expected);
    expect(await captureDuringRepair()).toEqual(expected);
  });

  it("does not scan beyond the message cap to fill an excerpt", async () => {
    await replaceTranscriptEvents(
      scope,
      Array.from({ length: 4_097 }, (_, index) =>
        message(
          String(index),
          index ? String(index - 1) : null,
          "assistant",
          index === 0 ? "beyond the cap" : "NO_REPLY",
        ),
      ),
    );
    const expected = { status: "available", content: null, originClass: "agent" };
    expect(await captureReady()).toEqual(expected);
    expect(await captureDuringRepair()).toEqual(expected);
  });
});
