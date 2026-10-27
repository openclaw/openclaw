import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import * as workerCpu from "../../infra/worker-cpu.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import {
  closeOpenClawAgentDatabasesAsync,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { resolveSessionColdArchivePath } from "./session-cold-storage-codec.js";
import { readSessionColdTranscript } from "./session-cold-storage-state.js";
import { runSessionColdStorageMaintenance } from "./session-cold-storage.js";
import {
  createSessionColdStorageFixture,
  currentId,
  historicalId,
  maintenanceConfig,
} from "./session-cold-storage.test-support.js";
import { prepareTranscriptPayload } from "./transcript-payload.js";
import { CURRENT_SESSION_VERSION } from "./version.js";

let state: OpenClawTestState;
let fixture: Awaited<ReturnType<typeof createSessionColdStorageFixture>>;
let seedPath: string;
const archives: Array<{ sessionId: string; path: string; bytes: Buffer }> = [];
const countsPath = process.env.OPENCLAW_COLD_ELIGIBILITY_COUNTS;

function addTinyWindows(ids: string[]) {
  runOpenClawAgentWriteTransaction(({ db: database }) => {
    const db = getNodeSqliteKysely<DB>(database);
    for (const sessionId of ids) {
      executeSqliteQuerySync(
        database,
        db.insertInto("session_windows").values({
          session_id: sessionId,
          session_key: fixture.scope.sessionKey,
          created_at: 1,
          updated_at: 1,
          transcript_updated_at: 1,
        }),
      );
      executeSqliteQuerySync(
        database,
        db.insertInto("transcript_rewrite_watermarks").values({
          session_id: sessionId,
          generation: "generation-" + sessionId,
          updated_at: 1,
        }),
      );
      executeSqliteQuerySync(
        database,
        db.insertInto("transcript_events").values({
          session_id: sessionId,
          seq: 0,
          created_at: 1,
          ...prepareTranscriptPayload(
            database,
            JSON.stringify({ type: "session", id: sessionId, version: CURRENT_SESSION_VERSION }),
          ),
        }),
      );
    }
  }, fixture.options);
}

async function maintain(workload: "fixture" | "full" | "mixed") {
  if (countsPath) {
    await fs.appendFile(countsPath, JSON.stringify({ workload }) + "\n");
  }
  return runSessionColdStorageMaintenance({ config: maintenanceConfig(fixture.scope.storePath) });
}

beforeAll(async () => {
  // Opt-in native work counting uses this same fixture, never a second maintenance implementation.
  if (countsPath) {
    const preload = fileURLToPath(
      new URL(
        "../../../scripts/perf/session-cold-storage-eligibility-preload.mjs",
        import.meta.url,
      ),
    );
    const createWorker = workerCpu.createCpuTrackedWorker;
    vi.spyOn(workerCpu, "createCpuTrackedWorker").mockImplementation((url, options) =>
      createWorker(url, {
        ...options,
        execArgv: [...(options?.execArgv ?? []), "--import", preload],
      }),
    );
  }
  state = await createOpenClawTestState({ scenario: "minimal" });
  fixture = await createSessionColdStorageFixture(state.statePath("externalization.sqlite"));
  // Maintenance has a fixed 128-window pass, not a configurable small batch.
  addTinyWindows(Array.from({ length: 127 }, (_, index) => "tiny-" + index));
  await expect(maintain("fixture")).resolves.toEqual({
    archivedTranscripts: 128,
    externalizedTranscripts: 0,
  });
  const archiveDatabase = fixture.database();
  const archiveDb = getNodeSqliteKysely<DB>(archiveDatabase);
  for (const row of executeSqliteQuerySync(
    archiveDatabase,
    archiveDb
      .selectFrom("session_transcript_cold_archives")
      .select(["session_id", "archive_name"])
      .orderBy("session_id"),
  ).rows) {
    const archivePath = resolveSessionColdArchivePath(fixture.scope.storePath, row.archive_name);
    archives.push({
      sessionId: row.session_id,
      path: archivePath,
      bytes: await fs.readFile(archivePath),
    });
  }
  expect(archives).toHaveLength(128);
  runOpenClawAgentWriteTransaction(({ db: database }) => {
    const db = getNodeSqliteKysely<DB>(database);
    for (const archive of archives) {
      executeSqliteQuerySync(
        database,
        db
          .updateTable("session_transcript_cold_archives")
          .set({ storage: "sqlite", archive_blob: archive.bytes })
          .where("session_id", "=", archive.sessionId),
      );
    }
  }, fixture.options);
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  seedPath = state.statePath("externalization-seed.sqlite");
  await fs.copyFile(fixture.scope.storePath, seedPath);
});
beforeEach(async () => {
  await fs.copyFile(seedPath, fixture.scope.storePath);
  for (const archive of archives) {
    await fs.writeFile(archive.path, archive.bytes);
  }
});
afterEach(async () => {
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
});
afterAll(async () => {
  vi.restoreAllMocks();
  await state.cleanup();
});

it("externalizes a full pass without changing hot history or archive bytes", async () => {
  for (const archive of archives) {
    await fs.unlink(archive.path);
  }
  const before = fixture.snapshot();
  await expect(maintain("full")).resolves.toEqual({
    archivedTranscripts: 0,
    externalizedTranscripts: 128,
  });
  expect(fixture.snapshot()).toEqual(before);
  expect(
    fixture
      .database()
      .prepare(
        "SELECT count(*) AS count FROM session_transcript_cold_archives WHERE storage = 'file' AND archive_blob IS NULL",
      )
      .get(),
  ).toEqual({ count: 128 });
  for (const archive of archives) {
    expect(await fs.readFile(archive.path)).toEqual(archive.bytes);
  }
});

it("keeps cross-generation history hot while archiving and externalizing a mixed pass", async () => {
  runOpenClawAgentWriteTransaction(({ db: database }) => {
    const db = getNodeSqliteKysely<DB>(database);
    executeSqliteQuerySync(
      database,
      db
        .updateTable("session_transcript_cold_archives")
        .set({ storage: "file", archive_blob: null })
        .where("session_id", "!=", historicalId),
    );
  }, fixture.options);
  addTinyWindows(["mixed-eligible", "mixed-protected"]);
  replaceSessionEntrySync(fixture.scope, {
    sessionId: currentId,
    updatedAt: 1,
    previousSessionId: "mixed-protected",
  });
  const before = fixture.snapshot();
  await expect(maintain("mixed")).resolves.toEqual({
    archivedTranscripts: 1,
    externalizedTranscripts: 1,
  });
  const after = fixture.snapshot();
  expect(after.events).toEqual(before.events.filter((row) => row.session_id !== "mixed-eligible"));
  expect(after.nodes).toEqual(before.nodes);
  expect(after.windows).toEqual(before.windows);
  expect(readSessionColdTranscript(fixture.database(), "mixed-eligible")?.event_count).toBe(1);
  expect(readSessionColdTranscript(fixture.database(), "mixed-protected")).toBeUndefined();
  for (const archive of archives) {
    expect(await fs.readFile(archive.path)).toEqual(archive.bytes);
  }
});
