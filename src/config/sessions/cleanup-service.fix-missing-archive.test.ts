// `sessions cleanup --fix-missing` must never destroy recoverable transcript
// content: a single torn row can no longer condemn a readable session, and any
// session it does prune leaves a compressed archive behind.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { readSessionArchiveContentSync } from "./archive-compression.js";
import { runSessionsCleanup } from "./cleanup-service.js";
import { loadSessionEntry, replaceSessionEntry } from "./session-accessor.js";
import type { TranscriptEvent } from "./session-accessor.js";
import { replaceSqliteTranscriptEvents } from "./session-accessor.sqlite.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const cfg = {} as OpenClawConfig;

describe("sessions cleanup --fix-missing archive safety", () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(() => {
    tempDir = tempDirs.make("openclaw-fix-missing-archive-");
    storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
  });

  function messageEvent(id: string, content: string): TranscriptEvent {
    return {
      type: "message",
      id,
      parentId: null,
      message: { role: "user", content },
    } as unknown as TranscriptEvent;
  }

  function tearTranscriptRow(sessionId: string, seq: number): void {
    const databasePath = resolveSqliteTargetFromSessionStorePath(storePath, {
      agentId: "main",
    }).path;
    if (!databasePath) {
      throw new Error("expected an agent database path");
    }
    const database = openOpenClawAgentDatabase({ agentId: "main", path: databasePath });
    // Simulate a partially written row like the reporter observed: the row still
    // exists but its JSON is truncated, so a parse-all probe would throw.
    database.db
      .prepare("UPDATE transcript_events SET event_json = '{' WHERE session_id = ? AND seq = ?")
      .run(sessionId, seq);
  }

  function readTranscriptRowCount(sessionId: string): number {
    const databasePath = resolveSqliteTargetFromSessionStorePath(storePath, {
      agentId: "main",
    }).path;
    if (!databasePath) {
      throw new Error("expected an agent database path");
    }
    const database = openOpenClawAgentDatabase({ agentId: "main", path: databasePath });
    const row = database.db
      .prepare("SELECT COUNT(*) AS count FROM transcript_events WHERE session_id = ?")
      .get(sessionId) as { count: number };
    return row.count;
  }

  function listArchiveFiles(sessionId: string): string[] {
    // Archives land beside the store; the directory only exists once one is
    // written, so a missing directory is itself proof of "no archive".
    const archiveDir = path.dirname(storePath);
    if (!fs.existsSync(archiveDir)) {
      return [];
    }
    return fs
      .readdirSync(archiveDir)
      .filter((file) => file.startsWith(`${sessionId}.jsonl.deleted.`));
  }

  it("keeps a readable session that carries one torn transcript row", async () => {
    const sessionKey = "agent:main:torn-among-readable";
    const sessionId = "torn-among-readable-session";
    // Fresh updatedAt: isolate the missing-transcript probe from stale pruning,
    // so a surviving session proves the probe kept it, not its recency.
    await replaceSessionEntry({ sessionKey, storePath }, { sessionId, updatedAt: Date.now() });
    await replaceSqliteTranscriptEvents({ sessionKey, sessionId, storePath }, [
      messageEvent("first", "keep me"),
      messageEvent("second", "and me"),
      messageEvent("third", "me too"),
    ]);
    // Middle row is torn; the two others remain readable message records.
    tearTranscriptRow(sessionId, 1);

    await runSessionsCleanup({
      cfg,
      opts: { fixMissing: true },
      targets: [{ agentId: "main", storePath }],
    });

    // Regression: a parse-all probe threw on the torn row and pruned the whole
    // session; the per-row-tolerant probe must find the readable messages and
    // keep the entry in place.
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({ sessionId });
    expect(readTranscriptRowCount(sessionId)).toBe(3);
    // A surviving session is never routed through the delete/archive path.
    expect(listArchiveFiles(sessionId)).toEqual([]);
  });

  it("archives a pruned message-free session that still holds transcript rows", async () => {
    const sessionKey = "agent:main:metadata-only";
    const sessionId = "metadata-only-session";
    // Fresh: only the missing-transcript probe should reclaim it, so the archive
    // it writes proves the fix-missing path archives (not the stale-prune path).
    await replaceSessionEntry({ sessionKey, storePath }, { sessionId, updatedAt: Date.now() });
    // Non-message metadata row: readable content that must be preserved on prune.
    const metadataContent = "diagnostic metadata worth preserving";
    const metadataEvent = {
      type: "session",
      id: sessionId,
      content: metadataContent,
    } as unknown as TranscriptEvent;
    await replaceSqliteTranscriptEvents({ sessionKey, sessionId, storePath }, [metadataEvent]);

    await runSessionsCleanup({
      cfg,
      opts: { fixMissing: true },
      targets: [{ agentId: "main", storePath }],
    });

    // Provably message-free, so it is reclaimed — but its rows are recoverable
    // content, so the removal must leave a compressed archive behind.
    expect(loadSessionEntry({ sessionKey, storePath })).toBeUndefined();
    const archives = listArchiveFiles(sessionId);
    expect(archives).toHaveLength(1);
    expect(
      readSessionArchiveContentSync(path.join(path.dirname(storePath), archives[0] ?? ""))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([expect.objectContaining({ id: sessionId, content: metadataContent })]);
  });

  it("keeps a session whose every transcript row is torn", async () => {
    const sessionKey = "agent:main:all-rows-torn";
    const sessionId = "all-rows-torn-session";
    // Fresh updatedAt: only the missing-transcript probe could reclaim it, so a
    // surviving session proves the probe refused to prune on unreadable rows.
    await replaceSessionEntry({ sessionKey, storePath }, { sessionId, updatedAt: Date.now() });
    await replaceSqliteTranscriptEvents({ sessionKey, sessionId, storePath }, [
      messageEvent("only", "unreadable after tear"),
    ]);
    // Every row is torn: the probe cannot confirm the transcript is empty, so it
    // must not treat "no readable message" as "message-free" and reclaim it.
    tearTranscriptRow(sessionId, 0);

    await runSessionsCleanup({
      cfg,
      opts: { fixMissing: true },
      targets: [{ agentId: "main", storePath }],
    });

    // Regression: an all-malformed transcript is indistinguishable from empty to
    // a match-or-nothing probe; the tri-state classifier keeps the entry and its
    // recoverable rows rather than destroying them, and never archives.
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({ sessionId });
    expect(readTranscriptRowCount(sessionId)).toBe(1);
    expect(listArchiveFiles(sessionId)).toEqual([]);
  });

  it("prunes an empty session without writing a phantom archive", async () => {
    const sessionKey = "agent:main:empty-session";
    const sessionId = "empty-session-id";
    await replaceSessionEntry({ sessionKey, storePath }, { sessionId, updatedAt: Date.now() });

    await runSessionsCleanup({
      cfg,
      opts: { fixMissing: true },
      targets: [{ agentId: "main", storePath }],
    });

    // No transcript rows means nothing to preserve; the empty archive guard must
    // not fabricate a `.deleted.<ts>.zst` file for zero-length content.
    expect(loadSessionEntry({ sessionKey, storePath })).toBeUndefined();
    expect(listArchiveFiles(sessionId)).toEqual([]);
  });
});
