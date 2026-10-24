import fs from "node:fs/promises";
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { deriveMeetingTranscriptSessionColumns } from "../../transcripts/store-columns.js";
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

describe("transcripts bounded export names", () => {
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
      expect(typeof asOptionalRecord(result.details)?.sessionId).toBe("string");
      expect(asOptionalRecord(result.details)?.summaryExportError).toBeUndefined();
    }
    await reopenDatabase();
    const entries = await harness.store.listSessionEntries();
    expect(new Set(entries.map((entry) => entry.selector)).size).toBe(2);
    expect(entries.every((entry) => path.basename(entry.sessionDir).startsWith("notes-"))).toBe(
      true,
    );
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
    const queries = getNodeSqliteKysely<DB>(db);
    // Pre-fix admission could persist an overlong projection before an export failed.
    const sourceJson = JSON.stringify(session.source);
    executeSqliteQuerySync(
      db,
      queries.insertInto("meeting_transcript_sessions").values({
        session_id: sessionId,
        started_at: session.startedAt,
        selector,
        session_slug: sessionId,
        export_key: selector,
        provider_id: session.source.providerId,
        source_json: sourceJson,
        ...deriveMeetingTranscriptSessionColumns(sourceJson, null),
        title: null,
        stopped_at: null,
        metadata_json: null,
        export_manifest_json: "{}",
        export_pending_json: "[]",
        next_utterance_seq: 0,
        created_at_ms: 0,
        updated_at_ms: 0,
      }),
    );
    await store.appendUtteranceForSession(session, { text: note, final: true });
    const summary = summarizeTranscripts({ session, utterances: [{ text: note, final: true }] });
    await store.writeSummary(summary, session);
    const markdown = "# Preserved historical notes\n\nCustom formatting stays intact.\n";
    executeSqliteQuerySync(
      db,
      queries
        .updateTable("meeting_transcript_summaries")
        .set({ markdown })
        .where("session_id", "=", sessionId),
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
    const row = executeSqliteQuerySync(
      reopened,
      getNodeSqliteKysely<DB>(reopened)
        .selectFrom("meeting_transcript_sessions")
        .select(["session_slug", "export_key"])
        .where("session_id", "=", sessionId),
    ).rows[0];
    expect(row).toEqual({
      session_slug: path.basename(artifacts.sessionDir),
      export_key: entry!.selector.toLowerCase(),
    });
  });
});
