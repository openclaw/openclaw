import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { exportTranscriptLibrary, getTranscriptLibrary } from "./library.js";
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

it("presents overlapping speech by its start time while cursors follow appends", async () => {
  const { store } = createTranscriptLibraryStoreFixture(tempDirs.make("speech-order-"));
  const target = session("overlap");
  const selector = transcriptSessionSelector(target);
  await store.writeSession(target);
  for (const [id, text, startedAt] of [
    ["a", "Reply", "2026-08-20T10:00:08Z"],
    ["b", "Question", "2026-08-20T12:00:02+02:00"],
    ["a", "Overlapping reply", "2026-08-20T10:00:08Z"],
    ["b", "Untimed caption", undefined],
    ["a", "After the gap", "2026-08-20T10:00:01Z"],
    ["b", "Local clock", "2026-08-20T10:00:00"],
    ["a", "After the local clock", "2026-08-20T10:00:00Z"],
  ] as const) {
    await store.appendUtteranceForSession(target, {
      text,
      startedAt,
      speaker: { id, label: "Sam" },
    });
  }

  const expected = [
    "Sam (2): Question",
    "Sam: Reply",
    "Sam: Overlapping reply",
    "Sam (2): Untimed caption",
    "Sam: After the gap",
    "Sam (2): Local clock",
    "Sam: After the local clock",
  ];
  const live = await store.readSummarySnapshot(target, 10);
  expect(
    summarizeTranscripts({ session: target, utterances: live!.utterances }).transcript,
  ).toEqual(expected);
  const stopped = { ...target, stoppedAt: "2026-08-20T10:01:00Z" };
  await store.writeSession(stopped);
  const final = await store.readSummarySnapshot(stopped, 10);
  expect(
    summarizeTranscripts({ session: stopped, utterances: final!.utterances }).transcript,
  ).toEqual(expected);

  const download = await exportTranscriptLibrary(store, { selector, format: "markdown" });
  expect(Buffer.from(download.data, "base64").toString()).toContain(
    expected.map((line) => `- ${line}`).join("\n"),
  );
  const get = (options: { limit?: number; cursor?: string } = {}) =>
    getTranscriptLibrary(store, { selector, includeUtterances: true, ...options });
  expect((await get()).utterances?.map((u) => u.sequence)).toEqual([1, 0, 2, 3, 4, 5, 6]);
  const page = await get({ limit: 1 });
  expect(page.utterances?.map((u) => u.sequence)).toEqual([0]);
  expect(
    (await get({ limit: 1, cursor: page.nextCursor! })).utterances?.map((u) => u.sequence),
  ).toEqual([1]);
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
  const next = await store.readSummarySnapshot(nextMeeting, 1);
  expect(next?.hasSpeakerAliases).toBeUndefined();
  expect(next?.utterances).toMatchObject([{ speaker: second, text: "Next response." }]);
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
