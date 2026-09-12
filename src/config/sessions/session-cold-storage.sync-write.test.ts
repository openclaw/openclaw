import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import {
  appendTranscriptEventSync,
  appendTranscriptMessageSync,
  persistCompactionBoundaryWithSessionEntrySync,
  loadTranscriptEventsSync,
  replaceTranscriptSuffixEventsSync,
  replaceSessionEntry,
  replaceTranscriptEvents,
  replaceTranscriptEventsSync,
} from "./session-accessor.js";
import {
  appendTranscriptEventSnapshotSync,
  appendTranscriptMessageSnapshotSync,
} from "./session-accessor.sqlite-transcript-write.js";
import { resolveSessionColdArchivePath } from "./session-cold-storage-codec.js";
import { readSessionColdTranscript } from "./session-cold-storage-state.js";
import { runSessionColdStorageMaintenance } from "./session-cold-storage.js";
import { waitForSessionTranscriptIndexReconcile } from "./session-transcript-reconcile.js";

const tempDirs = createTempDirTracker();
let databasePath: string | undefined;

afterEach(async () => {
  if (databasePath) {
    await waitForSessionTranscriptIndexReconcile({ agentId: "main", path: databasePath });
  }
  closeOpenClawAgentDatabasesForTest();
  tempDirs.cleanup();
});

it("refuses synchronous writes to cold current history without mutating or restoring it", async () => {
  const root = tempDirs.make("openclaw-cold-sync-writes-");
  databasePath = path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite");
  const options = { agentId: "main", path: databasePath };
  const scope = {
    agentId: "main",
    storePath: databasePath,
    sessionKey: "agent:main:cold-sync-writes",
    sessionId: "inactive-current-window",
  };
  await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  await replaceTranscriptEvents(scope, [
    { type: "session", id: scope.sessionId },
    {
      type: "message",
      id: "original-user",
      parentId: null,
      message: { role: "user", content: "Keep this exact conversation", timestamp: 10 },
      timestamp: 10,
    },
  ]);
  await waitForSessionTranscriptIndexReconcile(options);
  await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  runOpenClawAgentWriteTransaction(({ db: database }) => {
    executeSqliteQuerySync(
      database,
      getNodeSqliteKysely<DB>(database)
        .updateTable("session_windows")
        .set({ updated_at: 1, transcript_updated_at: 1 })
        .where("session_id", "=", scope.sessionId),
    );
  }, options);
  const expectedTranscript = loadTranscriptEventsSync(scope);
  expect(
    await runSessionColdStorageMaintenance({
      config: {
        agents: { list: [{ id: scope.agentId }] },
        session: {
          store: scope.storePath,
          maintenance: { coldStorage: { enabled: true, afterDays: 30 } },
        },
      },
    }),
  ).toMatchObject({ archivedTranscripts: 1, externalizedTranscripts: 0 });
  const database = openOpenClawAgentDatabase(options).db;
  const descriptor = readSessionColdTranscript(database, scope.sessionId);
  if (!descriptor) {
    throw new Error("Fixture did not archive its current transcript");
  }
  const archivePath = resolveSessionColdArchivePath(databasePath, descriptor.archive_name);
  const archiveBytes = await fs.readFile(archivePath);
  const snapshot = () => ({
    events: database.prepare("SELECT * FROM transcript_events ORDER BY seq").all(),
    identities: database
      .prepare("SELECT * FROM transcript_event_identities ORDER BY seq, event_id")
      .all(),
    active: database
      .prepare("SELECT * FROM session_transcript_active_events ORDER BY active_position")
      .all(),
    index: database.prepare("SELECT * FROM session_transcript_index_state").all(),
    search: database.prepare("SELECT * FROM session_transcript_fts ORDER BY message_id").all(),
    generations: database.prepare("SELECT * FROM transcript_rewrite_watermarks").all(),
    windows: database.prepare("SELECT * FROM session_windows").all(),
    nodes: database.prepare("SELECT * FROM session_nodes").all(),
    archives: database.prepare("SELECT * FROM session_transcript_cold_archives").all(),
  });
  const before = snapshot();
  expect(before.events).toEqual([]);
  expect(before.nodes).toContainEqual(
    expect.objectContaining({ current_session_id: scope.sessionId }),
  );
  const event = { type: "custom", id: "sync-custom", customType: "sync-write", data: {} };
  const message = { role: "user", content: "A new synchronous message", timestamp: 20 };
  const appendBoundary = vi.fn(() => {
    appendTranscriptEventSync(scope, {
      type: "compaction",
      id: "sync-boundary",
      parentId: "original-user",
      summary: "Compacted",
      firstKeptEntryId: "original-user",
      tokensBefore: 100,
    });
    return "sync-boundary";
  });
  const mutations = [
    { name: "append event", run: () => appendTranscriptEventSync(scope, event) },
    { name: "append event snapshot", run: () => appendTranscriptEventSnapshotSync(scope, event) },
    {
      name: "append message",
      run: () => appendTranscriptMessageSync(scope, { message, eventId: "sync-message" }),
    },
    {
      name: "append message snapshot",
      run: () =>
        appendTranscriptMessageSnapshotSync(scope, { message, eventId: "sync-message-snapshot" }),
    },
    { name: "replace transcript", run: () => replaceTranscriptEventsSync(scope, [event]) },
    {
      name: "replace full suffix",
      run: () =>
        replaceTranscriptSuffixEventsSync(
          scope,
          expectedTranscript,
          expectedTranscript.slice(0, 1),
        ),
    },
    {
      name: "replace incremental suffix",
      run: () =>
        replaceTranscriptSuffixEventsSync(
          scope,
          expectedTranscript.slice(1),
          [],
          1,
          undefined,
          undefined,
          true,
        ),
    },
    {
      name: "compaction boundary",
      run: () =>
        persistCompactionBoundaryWithSessionEntrySync(scope, {
          append: appendBoundary,
          transcriptByteCompactionLatch: {
            sessionId: scope.sessionId,
            activeBytes: 2048,
            maxBytes: 1024,
          },
          validateAppend: (entryId, text) =>
            entryId === "sync-boundary" && text.includes('"type":"compaction"'),
        }),
    },
  ];
  for (const mutation of mutations) {
    expect(mutation.run, mutation.name).toThrow(
      expect.objectContaining({ code: "TRANSCRIPT_COLD" }),
    );
    expect(snapshot(), mutation.name).toEqual(before);
    expect(await fs.readFile(archivePath), mutation.name).toEqual(archiveBytes);
  }
  expect(appendBoundary).not.toHaveBeenCalled();
});
