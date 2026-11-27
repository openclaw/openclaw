import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { exportTranscriptLibrary } from "./library.js";
import {
  createTranscriptLibraryStoreFixture,
  transcriptLibrarySession as session,
} from "./library.store.test-support.js";
import { formatTranscriptTurn } from "./speaker-labels.js";
import { meetingTranscriptDb } from "./store-sqlite.js";
import { transcriptSessionSelector } from "./store.js";
import { summarizeTranscriptTurns } from "./summary.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
});

it("attributes ID-only speech using only names already observed in the recording", async () => {
  const { database, store } = createTranscriptLibraryStoreFixture(
    tempDirs.make("speaker-sequence-"),
  );
  const target = session("id-only");
  await store.writeSession(target);
  for (const [id, label, text] of [
    ["alice", "Sam", "Opening"],
    ["bob", "Transient", "Before a name is known"],
    ["bob", "Sam", "First named reply"],
    ["alice", "Transient", "I will send the notes"],
  ] as const) {
    await store.appendUtteranceForSession(target, { text, speaker: { id, label } });
  }
  const db = database();
  executeSqliteQuerySync(
    db,
    meetingTranscriptDb(db)
      .updateTable("meeting_transcript_utterances")
      .set({ speaker_label: null })
      .where("session_id", "=", target.sessionId)
      .where("session_started_at", "=", target.startedAt)
      .where("sequence", "in", [1, 3]),
  );
  const expected = [
    "Sam: Opening",
    "Before a name is known",
    "Sam (2): First named reply",
    "Sam: I will send the notes",
  ];
  const exported = await exportTranscriptLibrary(store, {
    selector: transcriptSessionSelector(target),
    format: "markdown",
  });
  expect(Buffer.from(exported.data, "base64").toString()).toContain(
    expected.map((line) => `- ${line}`).join("\n"),
  );
  for (const limit of [4, 3, 1]) {
    const snapshot = await store.readSummarySnapshot(target, limit);
    expect(snapshot?.turns.map(formatTranscriptTurn)).toEqual(expected.slice(-limit));
  }
});

it("keeps session-first speaker names in capped live and final summary snapshots", async () => {
  const { store } = createTranscriptLibraryStoreFixture(tempDirs.make("transcript-snapshot-"));
  const target = session("shared-names");
  const first = { id: "z-user", label: "Sam" };
  const second = { id: "a-user", label: "Sam" };
  await store.writeSession(target);
  for (const utterance of [
    { speaker: first, text: "Opening remarks." },
    { speaker: second, text: "First response." },
    { speaker: second, text: "We agreed to review." },
  ]) {
    await store.appendUtteranceForSession(target, utterance);
  }
  const live = await store.readSummarySnapshot(target, 1);
  expect(live?.hasSpeakerAliases).toBe(true);
  expect(live?.turns).toEqual([{ speakerLabel: "Sam (2)", text: "We agreed to review." }]);
  await store.appendUtteranceForSession(target, { speaker: first, text: "I will send the draft." });
  await store.appendUtteranceForSession(target, {
    speaker: { label: "Sam" },
    text: "Closing remark.",
  });
  const stopped = { ...target, stoppedAt: "2026-08-20T11:00:00.000Z" };
  await store.writeSession(stopped);
  const final = await store.readSummarySnapshot(stopped, 3);
  expect(final?.stoppedAt).toBe(stopped.stoppedAt);
  expect(summarizeTranscriptTurns(stopped, final!.turns, final!.utteranceCount)).toMatchObject({
    transcript: [
      "Sam (2): We agreed to review.",
      "Sam: I will send the draft.",
      "Sam (3): Closing remark.",
    ],
    decisions: ["Sam (2): We agreed to review."],
    actionItems: ["Sam: I will send the draft."],
  });
  expect((await store.readUtterancesForSession(target)).map((row) => row.speaker)).toEqual([
    first,
    second,
    second,
    first,
    { label: "Sam" },
  ]);
  const exported = await exportTranscriptLibrary(store, {
    selector: transcriptSessionSelector(target),
    format: "jsonl",
  });
  const raw = Buffer.from(exported.data, "base64").toString("utf8");
  expect(
    raw
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).speakerLabel),
  ).toEqual(["Sam", "Sam", "Sam", "Sam", "Sam"]);

  const nextMeeting = session(target.sessionId, { startedAt: "2026-08-21T10:00:00.000Z" });
  await store.writeSession(nextMeeting);
  await store.appendUtteranceForSession(nextMeeting, { speaker: second, text: "Next meeting." });
  await store.appendUtteranceForSession(nextMeeting, { speaker: second, text: "Next response." });
  const next = await store.readSummarySnapshot(nextMeeting, 1);
  expect(next?.hasSpeakerAliases).toBeUndefined();
  expect(next?.turns).toEqual([{ speakerLabel: "Sam", text: "Next response." }]);
});

it("primes capped names from the first usable label for each identity", async () => {
  const { store } = createTranscriptLibraryStoreFixture(tempDirs.make("transcript-snapshot-"));
  const target = session("first-usable-name");
  await store.writeSession(target);
  for (const utterance of [
    { speaker: { id: "first", label: "  " }, text: "Before a name is available." },
    { speaker: { id: "first", label: "Sam" }, text: "The first named speaker." },
    { speaker: { id: "second", label: "Sam" }, text: "The second named speaker." },
    { speaker: { id: "first", label: "Sam" }, text: "The first speaker again." },
  ]) {
    await store.appendUtteranceForSession(target, utterance);
  }
  const snapshot = await store.readSummarySnapshot(target, 2);
  expect(snapshot?.turns.map((turn) => turn.speakerLabel)).toEqual(["Sam (2)", "Sam"]);
});
