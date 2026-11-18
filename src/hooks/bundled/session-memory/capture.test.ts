import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
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

function control(type: string, id: string, parentId: string, extra = {}) {
  return { type, id, parentId, ...extra };
}

describe("session memory capture", () => {
  async function expectCapture(
    events: Parameters<typeof replaceTranscriptEvents>[1],
    content: string | null,
    originClass = "untrusted",
  ) {
    const scope = {
      agentId: "main",
      sessionId: "capture",
      sessionKey: "agent:main:capture",
      storePath: path.join(sessionDirs.make(), "sessions.json"),
    };
    await replaceTranscriptEvents(scope, events);
    await accessor.waitForSessionTranscriptProjection(scope);
    for (const repair of [false, true]) {
      if (repair) {
        const options = toDatabaseOptions(resolveSqliteTranscriptReadScope(scope));
        // Projection readiness precedes the reconciliation writer's final orphan sweep.
        await waitForSessionTranscriptIndexReconcile(options);
        const { db } = openOpenClawAgentDatabase(options);
        db.prepare(
          "UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?",
        ).run(scope.sessionId);
        db.prepare("DELETE FROM session_transcript_active_events WHERE session_id = ?").run(
          scope.sessionId,
        );
      }
      const hostSql = observeHostDataSql();
      try {
        expect(await captureSessionMemoryTranscript(scope, undefined)).toEqual({
          status: "available",
          originClass,
          content,
        });
        expect(hostSql.queries).toEqual([]);
      } finally {
        hostSql.restore();
      }
    }
  }

  it.each(
    [false, true].flatMap((preserve) =>
      [false, true].map((compacted) => ({ preserve, compacted })),
    ),
  )(
    "respects an earlier reset (preserve: $preserve, compacted: $compacted)",
    async ({ preserve, compacted }) => {
      await expectCapture(
        [
          message("closed", null, "user"),
          message("kept", "closed", "user"),
          message("answer", "kept", "assistant"),
          message("tool", "answer", "toolResult"),
          control("reset", "reset", "tool", preserve ? { firstKeptEntryId: "kept" } : {}),
          ...(compacted
            ? [
                control("compaction", "compact", "reset", {
                  firstKeptEntryId: "kept",
                  summary: "earlier summary",
                }),
              ]
            : []),
          message("current", compacted ? "compact" : "reset", "user"),
        ],
        preserve ? 'user: "kept"\nassistant: "answer"\nuser: "current"' : 'user: "current"',
      );
    },
  );

  it("spans compaction and selects the explicit branch without changing provenance", async () => {
    await expectCapture(
      [
        {
          ...message("restricted", null, "user"),
          message: { role: "user", content: "restricted", __openclaw: { senderIsOwner: false } },
        },
        control("compaction", "compact", "restricted", { summary: "summary" }),
        message("chosen", "compact", "assistant"),
        message("other", "compact", "assistant"),
        control("leaf", "leaf", "other", { targetId: "chosen" }),
      ],
      'user: "restricted"\nassistant: "chosen"',
    );
  });

  it("does not charge discarded reset-tail tools against the capture budget", async () => {
    await expectCapture(
      [
        message("kept", null, "assistant", "k".repeat(1_024)),
        message("tool", "kept", "toolResult", "x".repeat(8 * 1024 * 1024 - 512)),
        control("reset", "reset", "tool", { firstKeptEntryId: "kept" }),
        message("current", "reset", "assistant"),
      ],
      `assistant: "${"k".repeat(1_024)}"\nassistant: "current"`,
    );
  });

  it("skips oversized rows while retaining the bounded recent conversation", async () => {
    await expectCapture(
      [
        message("older", null, "assistant"),
        message("oversized", "older", "assistant", "x".repeat(8 * 1024 * 1024)),
        message("latest", "oversized", "assistant"),
      ],
      'assistant: "older"\nassistant: "latest"',
    );
  });

  it("does not scan beyond the message cap to fill an excerpt", async () => {
    await expectCapture(
      Array.from({ length: 4_097 }, (_, index) =>
        message(
          String(index),
          index ? String(index - 1) : null,
          "assistant",
          index === 0 ? "beyond the cap" : "NO_REPLY",
        ),
      ),
      null,
      "agent",
    );
  });
});
