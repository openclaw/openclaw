import fs from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import * as snapshots from "../../infra/sqlite-transaction.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { readSessionColdTranscript } from "./session-cold-storage-state.js";
import {
  mutateSessionColdTranscriptInWorker,
  prepareSessionColdBatchInWorker,
} from "./session-cold-storage-worker.js";
import {
  createSessionColdStorageFixture,
  currentId,
  historicalId,
} from "./session-cold-storage.test-support.js";

vi.mock("./session-cold-storage-codec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-cold-storage-codec.js")>()),
  MAX_COLD_ARCHIVE_BYTES: 4096,
}));

let state: OpenClawTestState;
let fixture: Awaited<ReturnType<typeof createSessionColdStorageFixture>>;
let seedPath: string;

beforeAll(async () => {
  state = await createOpenClawTestState({ scenario: "minimal" });
  fixture = await createSessionColdStorageFixture(state.statePath("oversized.sqlite"));
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  seedPath = state.statePath("oversized-seed.sqlite");
  await fs.copyFile(fixture.scope.storePath, seedPath);
});
beforeEach(async () => {
  await fs.copyFile(seedPath, fixture.scope.storePath);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
});
afterAll(async () => {
  await state.cleanup();
});

function prepare() {
  return prepareSessionColdBatchInWorker({
    databaseOptions: fixture.options,
    admissionIdentities: [],
    liveSessionKeys: [],
    cooledSessionIds: [],
    beforeMs: 100,
    maxTranscripts: 128,
    maxBytes: 4096,
  });
}

it("rejects oversized raw event bytes without preparing a transcript snapshot", async () => {
  // Exercise legacy identity accounting alongside the fixture's compressed event payload.
  fixture
    .database()
    .prepare("UPDATE transcript_events SET event_utf8_bytes = NULL WHERE seq = 0")
    .run();
  const snapshot = vi.spyOn(snapshots, "runSqliteReadSnapshotSync");
  const batch = await prepare();
  expect(
    snapshot.mock.calls.filter((call) => call[2]?.operationLabel === "cold transcript snapshot"),
  ).toHaveLength(0);
  expect(batch.oversizedTranscripts).toEqual([
    {
      sessionId: historicalId,
      lowerBoundBytes: fixture.original.events
        .filter((event) => event.session_id === historicalId)
        .reduce((bytes, event) => bytes + Buffer.byteLength(event.event_json), 0),
    },
  ]);
  expect(batch.envelopeBytes).toBe(0);
});

it("bounds UTF-16 stores by UTF-8 bytes instead of stored UTF-16 bytes", async () => {
  const storePath = state.statePath("oversized-utf16.sqlite");
  const seed = new DatabaseSync(storePath);
  try {
    seed.exec(
      "PRAGMA encoding='UTF-16le'; CREATE TABLE encoding_probe(value TEXT); DROP TABLE encoding_probe;",
    );
  } finally {
    seed.close();
  }
  const utf16 = await createSessionColdStorageFixture(storePath);
  const batch = await prepareSessionColdBatchInWorker({
    databaseOptions: utf16.options,
    admissionIdentities: [],
    liveSessionKeys: [],
    cooledSessionIds: [],
    beforeMs: 100,
    maxTranscripts: 128,
    maxBytes: 4096,
  });
  const utf8Bytes = utf16.original.events
    .filter((event) => event.session_id === historicalId)
    .reduce((bytes, event) => bytes + Buffer.byteLength(event.event_json), 0);
  const [oversized] = batch.oversizedTranscripts;
  expect(oversized?.sessionId).toBe(historicalId);
  // Stored UTF-16 bytes double ASCII text; a larger "lower bound" would skip archivable windows.
  expect(oversized?.lowerBoundBytes).toBeLessThanOrEqual(utf8Bytes);
});

it("archives the next eligible window in the same pass after an oversized window", async () => {
  fixture
    .database()
    .prepare(
      "UPDATE session_windows SET updated_at = 2, transcript_updated_at = 2 WHERE session_id = ?",
    )
    .run(currentId);
  const batch = await prepare();
  const result = mutateSessionColdTranscriptInWorker(
    {
      kind: "cold-batch",
      databaseOptions: fixture.options,
      prepared: batch.prepared,
      externalizations: batch.externalizations,
      protectionKeys: batch.protectionKeys,
      beforeMs: 100,
      liveSessionKeys: [],
    },
    undefined,
    () => {},
  );
  expect(result.archivedTranscripts).toBe(1);
  expect(readSessionColdTranscript(fixture.database(), currentId)?.event_count).toBe(1);
  expect(readSessionColdTranscript(fixture.database(), historicalId)).toBeUndefined();
});
