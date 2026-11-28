import { execFileSync } from "node:child_process";
import { assert, expect, it, vi } from "vitest";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { readTranscriptEventRows } from "./session-accessor.sqlite-read.js";
import { appendTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import type { SessionActorHotState } from "./session-actor-contract.js";
import { withActor, type Fixture, type Mutation } from "./session-actor-worker.test-support.js";

// mock-isolation: Actor ownership proof must not schedule unrelated background maintenance.
vi.mock("./session-accessor.sqlite-maintenance-kick.js", () => ({
  kickSessionEntryMaintenanceAfterWrite() {},
}));
// mock-isolation: The fixture owns its database lifetime without background history eviction.
vi.mock("./session-history-eviction.js", () => ({ kickSessionHistoryDiskBudgetMaintenance() {} }));

const PAYLOAD_COLUMNS = [
  "event_json",
  "event_zstd",
  "event_utf8_bytes",
  "navigation_json",
  "navigation_type",
  "navigation_custom_type",
  "navigation_display",
  "message_role",
  "navigation_last_type",
  "navigation_last_custom_type",
  "navigation_valid",
  "created_at",
].join(", ");

function seed(f: Fixture) {
  runSqliteImmediateTransactionSync(f.database.db, () => {
    writeSessionEntry(f.database, f.target.sessionKey, { ...f.nativeEntry()! });
    appendTranscriptEventsInTransaction(f.database, f.scope, [
      {
        type: "session",
        id: f.scope.sessionId,
        version: 3,
        timestamp: "2026-01-01T00:00:00Z",
        cwd: "/synthetic",
      },
    ]);
  });
}

function appendCommand(
  snapshot: SessionActorHotState,
  sessionId: string,
  id: string,
  pinned = true,
): Mutation {
  return {
    type: "session.actor.appendTranscriptEvent",
    input: {
      target: snapshot.target,
      ...(pinned ? { expected: snapshot.version } : {}),
      commandId: `append-${id}`,
      phaseId: "transcript",
      sessionId,
      lifecycleRevision: snapshot.entry?.lifecycleRevision ?? null,
      eventJson: JSON.stringify({
        type: "custom",
        customType: "synthetic.turn-step",
        id,
        parentId: null,
        timestamp: "2026-01-01T00:00:01Z",
        data: { step: id },
      }),
    },
  };
}

// `openclaw message send` on a channel whose send runs locally (Slack) commits the delivery
// row from the CLI process. The Gateway's resident actor still held rawSeq N-1 and allocated
// seq N for the turn's next event.
it.each([
  ["a pinned version, through the host's stale-version retry", true],
  ["no pinned version (the session-manager append path)", false],
])("allocates past a transcript row another process committed: %s", (_label, pinned) =>
  withActor(async (f) => {
    seed(f);
    const sessionId = f.scope.sessionId;

    const first = f.read();
    const firstCommand = appendCommand(first, sessionId, "turn-step-1");
    await f.prepare(firstCommand);
    const committed = f.mutate(firstCommand);
    assert(committed.kind === "committed", `first append: ${JSON.stringify(committed)}`);
    const afterFirst = readTranscriptEventRows(f.database, sessionId).length;
    // The host captures its version before the turn's tool runs, as in production.
    const beforeForeign = f.read();

    // A child process with its own SQLite handle stands in for the CLI process: it shares no
    // in-process admission registry or write-revision counter with the actor.
    const foreignSeq = Number(
      execFileSync(
        "node",
        [
          "--no-warnings",
          "-e",
          `const { DatabaseSync } = require("node:sqlite");
           const db = new DatabaseSync(process.argv[1]);
           db.exec("PRAGMA busy_timeout = 5000");
           db.prepare(\`INSERT INTO transcript_events (session_id, seq, ${PAYLOAD_COLUMNS})
             SELECT session_id, seq + 1, ${PAYLOAD_COLUMNS} FROM transcript_events
             WHERE session_id = ? ORDER BY seq DESC LIMIT 1\`).run(process.argv[2]);
           const row = db.prepare("SELECT max(seq) AS m FROM transcript_events WHERE session_id = ?").get(process.argv[2]);
           process.stdout.write(String(row.m));
           db.close();`,
          f.database.path,
          sessionId,
        ],
        { encoding: "utf8" },
      ),
    );

    const secondCommand = appendCommand(beforeForeign, sessionId, "turn-step-2", pinned);
    await f.prepare(secondCommand);
    let outcome = f.mutate(secondCommand);
    // Hosts retry a foreign-append refusal exactly once (runSessionActorCommand, appendSessionManagerActor).
    if (outcome.kind === "stale-version") {
      // A pinned host retries on the postimage; the session-manager append host retries
      // the same unpinned append as a new command.
      const retry = appendCommand(outcome.postimage, sessionId, "turn-step-2", pinned);
      await f.prepare(retry);
      outcome = f.mutate(retry);
    }
    expect(
      outcome.kind === "rolled-back" ? outcome.error : undefined,
      "the actor must not reuse a seq another connection already committed",
    ).toBeUndefined();
    expect(outcome.kind).toBe("committed");
    const seqs = (
      f.database.db
        .prepare("SELECT seq FROM transcript_events WHERE session_id = ? ORDER BY seq")
        .all(sessionId) as { seq: number }[]
    ).map((row) => Number(row.seq));
    expect(seqs.length).toBe(afterFirst + 2);
    expect(seqs.at(-1)).toBe(foreignSeq + 1);
  }),
);
