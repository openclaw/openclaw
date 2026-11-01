import fs from "node:fs/promises";
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { summarizeTranscripts } from "../../transcripts/summary.js";
import { createTranscriptsTool } from "./transcripts-tool.js";
import {
  registerTranscriptTestProvider,
  useTranscriptTestState,
} from "./transcripts-tool.test-support.js";

const testState = useTranscriptTestState();
const note = "Keep the captured notes.";
async function reopenDatabase() {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
}

function createHarness() {
  const { stateDir, store } = testState();
  const databaseOptions = { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
  registerTranscriptTestProvider({
    id: "room-audio",
    name: "Room Audio",
    sourceKinds: ["live-audio", "posthoc-transcript"],
    importTranscript: async () => [{ text: note }],
  });
  const tool = createTranscriptsTool({ caller: { kind: "operator", source: "local" } });
  return { databaseOptions, store, tool };
}

it("separates IDs with identical safe prefixes and different discarded punctuation", async () => {
  const harness = createHarness();
  const ids = ["?", "!"].map((suffix) => "notes-" + "x".repeat(900) + suffix);
  for (const sessionId of ids) {
    const result = await harness.tool.execute("import", {
      action: "import",
      sessionId,
      providerId: "room-audio",
      transcript: note,
    });
    expect(asOptionalRecord(result.details)?.summaryExportError).toBeUndefined();
  }
  await reopenDatabase();
  const entries = await harness.store.listSessionEntries();
  expect(new Set(entries.map((entry) => entry.selector)).size).toBe(2);
  for (const entry of entries) {
    const artifacts = await harness.store.materializeSessionArtifacts(entry.selector, "all");
    const metadata = JSON.parse(await fs.readFile(artifacts.metadataPath, "utf8"));
    expect(metadata.sessionId).toBe(entry.session.sessionId);
  }
});

it("preserves historical overlong identities and existing notes during finalization", async () => {
  const { store, databaseOptions } = createHarness();
  const sessionId = "notes-0-" + "x".repeat(2200);
  const session = {
    sessionId,
    startedAt: "2026-07-01T10:00:00.000Z",
    source: { providerId: "room-audio" },
  };
  const selector = `2026-07-01/${sessionId}`;
  await store.listSessionEntries();
  const { db } = openOpenClawStateDatabase(databaseOptions);
  // Seed the pre-fix projection directly; ordinary admission normalizes these names.
  // Nullable and defaulted columns retain their schema defaults.
  db.prepare(`INSERT INTO meeting_transcript_sessions
    (session_id, started_at, selector, session_slug, export_key, provider_id,
     source_json, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)`).run(
    sessionId,
    session.startedAt,
    selector,
    sessionId,
    selector,
    session.source.providerId,
    JSON.stringify(session.source),
  );
  await store.appendUtteranceForSession(session, { text: note, final: true });
  const summary = summarizeTranscripts({ session, utterances: [{ text: note, final: true }] });
  await store.writeSummary(summary, session);
  const markdown = "# Preserved historical notes\n\nCustom formatting stays intact.\n";
  db.prepare("UPDATE meeting_transcript_summaries SET markdown = ? WHERE session_id = ?").run(
    markdown,
    sessionId,
  );
  await reopenDatabase();

  await store.writeSession({ ...session, stoppedAt: "2026-07-01T11:00:00.000Z" });
  await reopenDatabase();
  const entry = await store.readSessionEntry(sessionId);
  expect(entry?.session).toMatchObject({ ...session, stoppedAt: "2026-07-01T11:00:00.000Z" });
  expect(entry!.selector).toBe(`2026-07-01/${path.basename(entry!.sessionDir)}`);
  expect((await store.readSession(entry!.selector))?.sessionId).toBe(sessionId);
  expect(await store.readSummary(session)).toEqual({ summary, markdown });
  expect(
    (await store.readUtterancesForSession(session)).map((utterance) => utterance.text),
  ).toEqual([note]);
  const artifacts = await store.materializeSessionArtifacts(entry!.selector, "all");
  expect(await fs.readFile(artifacts.summaryPath, "utf8")).toBe(markdown);
  expect(
    JSON.parse(await fs.readFile(path.join(artifacts.sessionDir, "summary.json"), "utf8")),
  ).toEqual(summary);
  const reopened = openOpenClawStateDatabase(databaseOptions).db;
  const row = reopened
    .prepare(
      "SELECT session_slug, export_key FROM meeting_transcript_sessions WHERE session_id = ?",
    )
    .get(sessionId);
  expect(row).toEqual({
    session_slug: path.basename(artifacts.sessionDir),
    export_key: entry!.selector.toLowerCase(),
  });
});
