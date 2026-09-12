import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { listTranscriptLibrary } from "./library.js";
import {
  createTranscriptLibraryStoreFixture,
  transcriptLibrarySession as session,
} from "./library.store.test-support.js";
import { meetingTranscriptDb } from "./store-sqlite.js";
import { transcriptSessionSelector } from "./store.js";
import { summarizeTranscripts } from "./summary.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawStateDatabaseForTest());

function fixture() {
  return createTranscriptLibraryStoreFixture(tempDirs.make("transcript-library-search-"));
}

describe("transcript library search", () => {
  it("searches stored notes and speech once per capture with stable filtered pagination", async () => {
    const { store } = fixture();
    const phrase = '100% launch_ "review"';
    const source = { providerId: "manual-transcript", accountId: "work" };
    const common = { source, metadata: { agentId: "ops" } };
    const speech = session("recurring", { ...common, startedAt: "2026-08-21T10:00:00Z" });
    const notes = session("notes", common);
    const otherOwner = session("other-owner", { ...common, metadata: { agentId: "main" } });
    for (const target of [speech, notes, session("recurring", common), otherOwner]) {
      await store.writeSession(target);
    }
    for (const target of [speech, otherOwner]) {
      await store.appendUtteranceForSession(target, { text: phrase });
      await store.appendUtteranceForSession(target, { text: phrase });
    }
    await store.writeSummary(
      { ...summarizeTranscripts({ session: notes, utterances: [] }), decisions: [phrase] },
      notes,
    );
    const filters = {
      query: phrase.toUpperCase(),
      providerId: source.providerId,
      accountId: source.accountId,
      agentId: "ops",
      startedAfter: "2026-08-20T00:00:00Z",
      startedBefore: "2026-08-22T00:00:00Z",
      limit: 1,
    };
    const first = await listTranscriptLibrary(store, filters);
    expect(first.sessions.map((entry) => entry.selector)).toEqual([
      transcriptSessionSelector(speech),
    ]);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await listTranscriptLibrary(store, { ...filters, cursor: first.nextCursor! });
    expect(second.sessions.map((entry) => entry.selector)).toEqual([
      transcriptSessionSelector(notes),
    ]);
    expect(second.nextCursor).toBeNull();
    expect(
      (await listTranscriptLibrary(store, { ...filters, accountId: "personal" })).sessions,
    ).toEqual([]);
  });

  it("finds historical structured overviews and canonical Markdown notes", async () => {
    const { store, database } = fixture();
    const target = session("historical-notes");
    await store.writeSession(target);
    await store.writeSummary(
      {
        ...summarizeTranscripts({ session: target, utterances: [] }),
        overview: "Separate overview",
      },
      target,
    );
    const db = database();
    const summary = meetingTranscriptDb(db)
      .updateTable("meeting_transcript_summaries")
      .where("session_id", "=", target.sessionId)
      .where("session_started_at", "=", target.startedAt);
    executeSqliteQuerySync(db, summary.set({ markdown: null }));
    expect(
      (await listTranscriptLibrary(store, { query: "SEPARATE OVERVIEW" })).sessions.map(
        (entry) => entry.selector,
      ),
    ).toEqual([transcriptSessionSelector(target)]);
    executeSqliteQuerySync(
      db,
      summary.set({ markdown: "# Earlier notes\nCanonical decision", summary_json: null }),
    );
    expect(
      (await listTranscriptLibrary(store, { query: "CANONICAL DECISION" })).sessions.map(
        (entry) => entry.selector,
      ),
    ).toEqual([transcriptSessionSelector(target)]);
  });
});
