import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { exportTranscriptLibrary } from "./library.js";
import {
  createTranscriptLibraryStoreFixture,
  transcriptLibrarySession as session,
} from "./library.store.test-support.js";
import { transcriptSessionSelector } from "./store.js";
import { summarizeTranscripts } from "./summary.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
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
  expect(live?.utterances).toMatchObject([
    { speaker: { ...second, label: "Sam (2)" }, text: "We agreed to review." },
  ]);
  await store.appendUtteranceForSession(target, { speaker: first, text: "I will send the draft." });
  await store.appendUtteranceForSession(target, {
    speaker: { label: "Sam" },
    text: "Closing remark.",
  });
  const stopped = { ...target, stoppedAt: "2026-08-20T11:00:00.000Z" };
  await store.writeSession(stopped);
  const final = await store.readSummarySnapshot(stopped, 3);
  expect(final?.stoppedAt).toBe(stopped.stoppedAt);
  expect(summarizeTranscripts({ session: stopped, utterances: final!.utterances })).toMatchObject({
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
  expect((await store.readSummarySnapshot(nextMeeting, 1))?.utterances).toMatchObject([
    { speaker: second, text: "Next response." },
  ]);
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
  expect(snapshot?.utterances.map((utterance) => utterance.speaker)).toEqual([
    { id: "second", label: "Sam (2)" },
    { id: "first", label: "Sam" },
  ]);
});
