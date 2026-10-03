import assert from "node:assert/strict";
import path from "node:path";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { listTranscriptLibrary } from "./library.js";
import { transcriptLibrarySession as session } from "./library.store.test-support.js";
import { TranscriptsStore, transcriptSessionSelector } from "./store.js";

const stateDir = process.argv[2];
assert.ok(stateDir);
const store = new TranscriptsStore(path.join(stateDir, "transcripts"));
const local = session("local", { startedAt: "2026-08-20T06:00:00" });
const earlier = session("earlier", { startedAt: "2026-08-20T06:30:00Z" });
try {
  await store.writeSession(local);
  await store.writeSession(earlier);
  const first = await listTranscriptLibrary(store, { limit: 1 });
  assert.deepEqual(
    first.sessions.map((row) => row.sessionId),
    ["local"],
  );
  assert.ok(typeof first.nextCursor === "string");
  const next = await listTranscriptLibrary(store, { limit: 1, cursor: first.nextCursor });
  assert.deepEqual(
    next.sessions.map((row) => row.sessionId),
    ["earlier"],
  );
  assert.equal(next.nextCursor, null);
  assert.deepEqual(
    (
      await listTranscriptLibrary(store, {
        startedAfter: "2026-08-20T06:00:00",
        startedBefore: "2026-08-20T13:00:00.001Z",
      })
    ).sessions.map((row) => row.sessionId),
    ["local"],
  );
  assert.deepEqual(
    (
      await listTranscriptLibrary(store, {
        startedAfter: "2026-08-20T13:00:00.000Z",
        startedBefore: "2026-08-20T13:00:00.001Z",
      })
    ).sessions.map((row) => row.sessionId),
    ["local"],
  );
  assert.deepEqual(await store.readSession(transcriptSessionSelector(local)), local);
} finally {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
}
