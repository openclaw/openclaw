import fs from "node:fs/promises";
import zlib from "node:zlib";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { clearNodeSqliteKyselyCacheForDatabase } from "../../infra/kysely-sync.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { resetSessionStore } from "./session-accessor.sqlite-reset.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.test-support.js";
import { embedSessionColdArchivesInSnapshot } from "./session-cold-storage-backup.js";
import { readSessionColdChunks } from "./session-cold-storage-chunks.js";
import { resolveSessionColdArchivePath } from "./session-cold-storage-codec.js";
import { readSessionColdTranscript } from "./session-cold-storage-state.js";
import {
  mutateSessionColdTranscriptInWorker,
  prepareSessionColdBatchInWorker,
  prepareSessionColdRestoreInWorker,
} from "./session-cold-storage-worker.js";
import {
  createSessionColdStorageFixture,
  historicalId,
} from "./session-cold-storage.test-support.js";
import { waitForSessionTranscriptIndexReconcile } from "./session-transcript-reconcile.js";

vi.mock("./session-cold-storage-codec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-cold-storage-codec.js")>()),
  MAX_COLD_ARCHIVE_BYTES: 4096,
}));

let state: OpenClawTestState;
let fixture: Awaited<ReturnType<typeof createSessionColdStorageFixture>>;
let original: ReturnType<typeof fixture.snapshot>;
let seedPath: string;

beforeAll(async () => {
  state = await createOpenClawTestState({ scenario: "minimal" });
  fixture = await createSessionColdStorageFixture(state.statePath("chunks.sqlite"));
  await replaceTranscriptEvents(fixture.scope, [
    { type: "session", id: historicalId, version: 3 },
    ...Array.from({ length: 12 }, (_, index) => ({
      type: "message",
      id: `event-${index}`,
      parentId: index ? `event-${index - 1}` : null,
      timestamp: new Date(10 + index).toISOString(),
      message: {
        role: index % 2 ? "assistant" : "user",
        content: [{ type: "text", text: `message ${index}: ${"hello 🦞\n".repeat(30)}` }],
      },
    })),
  ]);
  await waitForSessionTranscriptIndexReconcile(fixture.options);
  fixture
    .database()
    .prepare(
      "UPDATE session_windows SET updated_at = 1, transcript_updated_at = 1 WHERE session_id = ?",
    )
    .run(historicalId);
  fixture
    .database()
    .prepare(
      "UPDATE transcript_event_identities SET message_idempotency_key = 'preserved-key' WHERE session_id = ? AND event_id = 'event-0'",
    )
    .run(historicalId);
  original = fixture.snapshot();
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  seedPath = state.statePath("seed.sqlite");
  await fs.copyFile(fixture.scope.storePath, seedPath);
});
beforeEach(async () => {
  await fs.copyFile(seedPath, fixture.scope.storePath);
});
afterEach(async () => {
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
});
afterAll(async () => {
  await state.cleanup();
});

async function archive() {
  const batch = await prepareSessionColdBatchInWorker({
    databaseOptions: fixture.options,
    admissionIdentities: [],
    liveSessionKeys: [],
    cooledSessionIds: [],
    beforeMs: 100,
    maxTranscripts: 128,
    maxBytes: 4096,
  });
  return mutateSessionColdTranscriptInWorker(
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
}

it("archives a window larger than the per-file bound and restores all bytes and metadata", async () => {
  expect((await archive()).archivedTranscripts).toBe(1);
  const descriptor = readSessionColdTranscript(fixture.database(), historicalId)!;
  expect(descriptor.event_count).toBe(13);
  const chunks = readSessionColdChunks(fixture.database(), descriptor);
  expect(chunks.length).toBeGreaterThan(2);
  for (const chunk of chunks) {
    const bytes = await fs.readFile(
      resolveSessionColdArchivePath(fixture.scope.storePath, chunk.archive_name),
    );
    expect(zlib.zstdDecompressSync(bytes).byteLength).toBeLessThanOrEqual(4096);
  }
  const plan = {
    kind: "cold-restore" as const,
    databaseOptions: fixture.options,
    sessionId: historicalId,
    archive: descriptor,
  };
  const records = await prepareSessionColdRestoreInWorker(plan);
  expect(mutateSessionColdTranscriptInWorker(plan, records, () => {}).restored).toBe(true);
  expect(fixture.snapshot()).toEqual(original);
});

it.each(["missing", "corrupt"])(
  "rolls back restoration when a middle chunk becomes %s",
  async (failure) => {
    expect((await archive()).archivedTranscripts).toBe(1);
    const descriptor = readSessionColdTranscript(fixture.database(), historicalId)!;
    const chunks = readSessionColdChunks(fixture.database(), descriptor);
    const middle = chunks[Math.floor(chunks.length / 2)]!;
    const file = resolveSessionColdArchivePath(fixture.scope.storePath, middle.archive_name);
    const bytes = await fs.readFile(file);
    const plan = {
      kind: "cold-restore" as const,
      databaseOptions: fixture.options,
      sessionId: historicalId,
      archive: descriptor,
    };
    const records = await prepareSessionColdRestoreInWorker(plan);
    const before = fixture.snapshot();
    try {
      if (failure === "missing") {
        await fs.unlink(file);
      } else {
        await fs.writeFile(file, Buffer.alloc(bytes.length));
      }
      await expect(prepareSessionColdRestoreInWorker(plan)).rejects.toThrow(
        failure === "missing" ? "missing or unreadable" : "failed verification",
      );
      expect(() => mutateSessionColdTranscriptInWorker(plan, records, () => {})).toThrow(
        failure === "missing" ? "missing or unreadable" : "failed verification",
      );
      expect(fixture.snapshot()).toEqual(before);
      expect(readSessionColdTranscript(fixture.database(), historicalId)).toEqual(descriptor);
    } finally {
      await fs.writeFile(file, bytes);
    }
  },
);

it("embeds every chunk for a self-contained backup and re-externalizes it", async () => {
  expect((await archive()).archivedTranscripts).toBe(1);
  const descriptor = readSessionColdTranscript(fixture.database(), historicalId)!;
  const chunks = readSessionColdChunks(fixture.database(), descriptor);
  const database = fixture.database();
  clearNodeSqliteKyselyCacheForDatabase(database);
  const hostPrepare = vi.spyOn(database, "prepare");
  try {
    await embedSessionColdArchivesInSnapshot({
      database,
      sourceStorePath: fixture.scope.storePath,
    });
    expect(
      hostPrepare.mock.calls.filter(([statement]) =>
        statement.includes("session_transcript_cold_archive"),
      ),
    ).toEqual([]);
  } finally {
    hostPrepare.mockRestore();
  }
  for (const chunk of chunks) {
    await fs.unlink(resolveSessionColdArchivePath(fixture.scope.storePath, chunk.archive_name));
  }
  const plan = {
    kind: "cold-restore" as const,
    databaseOptions: fixture.options,
    sessionId: historicalId,
    archive: descriptor,
  };
  // All original files are absent: successful verification depends on the embedded child blobs.
  await prepareSessionColdRestoreInWorker(plan);
  expect((await archive()).externalizedTranscripts).toBe(1);
  expect(
    fixture
      .database()
      .prepare(
        "SELECT count(*) AS count FROM session_transcript_cold_archive_chunks WHERE archive_blob IS NOT NULL",
      )
      .get()?.count,
  ).toBe(0);
  const records = await prepareSessionColdRestoreInWorker(plan);
  expect(mutateSessionColdTranscriptInWorker(plan, records, () => {}).restored).toBe(true);
  expect(fixture.snapshot()).toEqual(original);
});

it("removes every chunk file and cascading child row on full-history deletion", async () => {
  expect((await archive()).archivedTranscripts).toBe(1);
  const descriptor = readSessionColdTranscript(fixture.database(), historicalId)!;
  const chunks = readSessionColdChunks(fixture.database(), descriptor);
  await resetSessionStore({ agentId: "main", storePath: fixture.scope.storePath });
  expect(
    fixture
      .database()
      .prepare("SELECT count(*) AS count FROM session_transcript_cold_archive_chunks")
      .get()?.count,
  ).toBe(0);
  for (const chunk of chunks) {
    await expect(
      fs.stat(resolveSessionColdArchivePath(fixture.scope.storePath, chunk.archive_name)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  }
});
