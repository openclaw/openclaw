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
import type { TranscriptSourceProvider } from "../../transcripts/provider-types.js";
import { summarizeTranscripts } from "../../transcripts/summary.js";
import { createTranscriptsTool } from "./transcripts-tool.js";
import {
  registerTranscriptTestProvider,
  useTranscriptTestState,
} from "./transcripts-tool.test-support.js";

const testState = useTranscriptTestState();
const note = "Keep the captured notes.";

function createHarness() {
  const { stateDir, store } = testState();
  const databaseOptions = { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
  const provider: TranscriptSourceProvider = {
    id: "room-audio",
    name: "Room Audio",
    sourceKinds: ["live-audio", "posthoc-transcript"],
    importTranscript: async () => [{ text: note }],
  };
  registerTranscriptTestProvider(provider);
  const tool = createTranscriptsTool({ stateDir, caller: { kind: "operator", source: "local" } });
  return {
    databaseOptions,
    store,
    tool,
  };
}

async function importTranscript(harness: ReturnType<typeof createHarness>, sessionId: string) {
  const result = await harness.tool.execute("import", {
    action: "import",
    sessionId,
    providerId: "room-audio",
    transcript: note,
  });
  const handle = asOptionalRecord(result.details)?.sessionId;
  if (typeof handle !== "string") {
    throw new Error("Expected a transcript session handle");
  }
  expect(asOptionalRecord(result.details)?.summaryExportError).toBeUndefined();
  return handle;
}

describe("transcripts bounded export names", () => {
  it("separates IDs with identical safe prefixes and different discarded punctuation", async () => {
    const harness = createHarness();
    const ids = ["?", "!"].map((suffix) => "notes-" + "x".repeat(900) + suffix);
    for (const sessionId of ids) {
      await importTranscript(harness, sessionId);
    }
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    const entries = await harness.store.listSessionEntries();
    expect(new Set(entries.map((entry) => entry.selector)).size).toBe(2);
    expect(entries.every((entry) => path.basename(entry.sessionDir).startsWith("notes-"))).toBe(
      true,
    );
    for (const entry of entries) {
      const artifacts = await harness.store.materializeSessionArtifacts(entry.selector, "all");
      expect(
        JSON.parse(await fs.readFile(artifacts.metadataPath, "utf8")).sessionId ===
          entry.session.sessionId,
      ).toBe(true);
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
    const queries =
      getNodeSqliteKysely<Pick<DB, "meeting_transcript_sessions" | "meeting_transcript_summaries">>(
        db,
      );
    // Pre-fix admission could persist an overlong projection before an export failed.
    executeSqliteQuerySync(
      db,
      queries.insertInto("meeting_transcript_sessions").values({
        session_id: sessionId,
        started_at: session.startedAt,
        selector,
        session_slug: sessionId,
        export_key: selector,
        provider_id: session.source.providerId,
        source_json: JSON.stringify(session.source),
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
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();

    await store.writeSession({ ...session, stoppedAt: "2026-07-01T11:00:00.000Z" });
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    const entry = await store.readSessionEntry(sessionId);
    expect(entry?.session.sessionId === sessionId).toBe(true);
    expect(entry?.session.startedAt).toBe(session.startedAt);
    expect(entry?.session.stoppedAt).toBe("2026-07-01T11:00:00.000Z");
    expect(entry!.selector).toBe(`2026-07-01/${path.basename(entry!.sessionDir)}`);
    expect((await store.readSession(entry!.selector))?.sessionId === sessionId).toBe(true);
    expect(await store.readSummary(session)).toEqual({ summary, markdown });
    expect(
      (await store.readUtterancesForSession(session)).map((utterance) => utterance.text),
    ).toEqual([note]);
    const artifacts = await store.materializeSessionArtifacts(entry!.selector, "all");
    expect(await fs.readFile(artifacts.summaryPath, "utf8")).toBe(markdown);
    expect(JSON.parse(await fs.readFile(artifacts.summaryJsonPath, "utf8"))).toEqual(summary);
    const reopened = openOpenClawStateDatabase(databaseOptions).db;
    const row = executeSqliteQuerySync(
      reopened,
      getNodeSqliteKysely<Pick<DB, "meeting_transcript_sessions">>(reopened)
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
