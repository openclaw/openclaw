import { expect, it, vi } from "vitest";
import * as sessionEvents from "../auto-reply/reply/session-event-handoff.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import { appendTranscriptMessage } from "../config/sessions/session-accessor.sqlite-transcript-write.js";
import { retainSessionColdNavigationInTransaction } from "../config/sessions/session-cold-storage-navigation.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";
import { resumeMarkedSessions } from "./session-restart-resume.js";

it.for(["archived", "done", "killed", "failed", "unset"] as const)(
  "settles a cold %s restart marker once without restoring its transcript",
  (kind) =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = { agents: { entries: { main: {} } } };
      setRuntimeConfigSnapshot(cfg);
      const target = { agentId: "main", sessionKey: "agent:main:cold-restart" };
      const sessionId = "cold-restart";
      replaceSessionEntrySync(target, {
        sessionId,
        updatedAt: 1,
        ...(kind === "archived"
          ? { archivedAt: 2, status: "done" as const }
          : kind === "unset"
            ? {}
            : { status: kind }),
        lastRunId: "announce:requester-settle:old-child",
      });
      await appendTranscriptMessage(
        { ...target, sessionId },
        {
          message: {
            role: "user",
            content: "Old child result",
            timestamp: 1,
            idempotencyKey: "announce:requester-settle:old-child:user",
            provenance: { kind: "inter_session", sourceTool: "subagent_settle" },
          },
        },
      );
      const marker =
        kind === "archived"
          ? { resumeAfterRestart: {} }
          : { mainRestartRecovery: { cycleId: "old-cycle" } };
      // Persist the stale historical shape: current writers already clear markers on archive.
      runOpenClawAgentWriteTransaction(
        (database) => {
          const { db } = database;
          db.prepare(
            "UPDATE session_nodes SET entry_json = json_patch(entry_json, ?) WHERE session_key = ?",
          ).run(JSON.stringify(marker), target.sessionKey);
          db.prepare(`INSERT INTO session_transcript_cold_archives
        (session_id, generation, archive_name, archive_sha256, event_count, raw_bytes,
         archive_bytes, last_seq, archived_at, storage, archive_blob)
        VALUES (?, 'generation', 'unavailable.zst', ?, 1, 1, 1, 0, 1, 'file', NULL)`).run(
            sessionId,
            "0".repeat(64),
          );
          retainSessionColdNavigationInTransaction(database, sessionId, -1, 100);
        },
        { agentId: "main" },
      );
      const warn = vi.fn();
      const resume = vi.spyOn(sessionEvents, "enqueueSessionEventForHost");
      try {
        expect(await readSessionEntryReadOnlyInWorker(target)).toMatchObject(marker);
        for (let restart = 0; restart < 2; restart++) {
          await resumeMarkedSessions({
            context: createContext([], () => cfg),
            signal: new AbortController().signal,
            log: { warn },
          });
          const entry = (await readSessionEntryReadOnlyInWorker(target))!;
          expect(entry.resumeAfterRestart).toBeUndefined();
          expect(entry.mainRestartRecovery).toBeUndefined();
          expect(resume).not.toHaveBeenCalled();
          expect(
            warn.mock.calls.some(([message]) => message.includes("SessionTranscriptColdError")),
          ).toBe(false);
          if (restart === 0) {
            warn.mockClear();
          }
        }
        expect(warn).not.toHaveBeenCalled();
        expect(
          openOpenClawAgentDatabase({ agentId: "main" })
            .db.prepare(
              "SELECT archive_name FROM session_transcript_cold_archives WHERE session_id = ?",
            )
            .get(sessionId),
        ).toEqual({ archive_name: "unavailable.zst" });
      } finally {
        resume.mockRestore();
      }
    }),
);
