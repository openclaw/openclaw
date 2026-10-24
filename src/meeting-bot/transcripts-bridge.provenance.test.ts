import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import type { TranscriptUtterance } from "../transcripts/provider-types.js";
import { TranscriptsStore } from "../transcripts/store.js";
import {
  readTestMeetingTranscript,
  TEST_CAPTION_SOURCE,
  TEST_MEETING_URL,
  testMeetingObservation,
} from "./observation-provenance.test-support.js";
import { createParticipationTestRuntime } from "./session-runtime.test-support.js";
import type { MeetingTranscriptSnapshot } from "./session-types.js";

type UtteranceHandler = (row: TranscriptUtterance) => void;
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.useRealTimers();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);

it("retains provenance on existing utterance rows and subscriber replay, not on pending or observation-only revisions", async () => {
  vi.useFakeTimers({ now: new Date("2026-09-01T00:00:00.000Z") });
  const stateDir = tempDirs.make("openclaw-meeting-provenance-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const makeStore = () => new TranscriptsStore(path.join(stateDir, "transcripts"), { env });
  const store = makeStore();
  const provenance = testMeetingObservation();
  const ownProvenance = testMeetingObservation({ observationId: "own", self: "self" });
  const committed = { text: "Committed", source: TEST_CAPTION_SOURCE, provenance };
  const ineligible = { text: "Own speech", provenance: ownProvenance };
  const legacy = { text: "Legacy provider line" };
  const pending = {
    ...committed,
    text: "Pending text is not durable",
    source: { ...TEST_CAPTION_SOURCE, revision: "1", finalized: false },
    provenance: testMeetingObservation({ observationId: "pending-observation" }),
  };
  let snapshot: MeetingTranscriptSnapshot = {
    droppedLines: 0,
    epoch: "epoch-1",
    lines: [],
    pendingLines: [pending],
  };
  const { runtime } = createParticipationTestRuntime({
    durableTranscripts: { stateDir },
    transcribe: true,
    captureTranscript: async () => await readTestMeetingTranscript(snapshot),
  });
  const { session } = await runtime.join({ url: TEST_MEETING_URL, agentId: "operator" });
  const delivered = vi.fn<UtteranceHandler>();
  const subscribe = async (sessionId: string, onUtterance: UtteranceHandler = delivered) => {
    const result = await runtime.startTranscriptSource({
      session: {
        sessionId,
        startedAt: session.createdAt,
        source: { providerId: "test-meeting", agentId: "operator", meetingUrl: TEST_MEETING_URL },
      },
      onUtterance,
    });
    expect(result).toMatchObject({ ok: true });
  };
  const ownerMetadata = { agentId: "operator", meetingSessionId: session.id };
  const expectedMetadata = [
    { ...ownerMetadata, meetingObservationProvenance: provenance },
    { ...ownerMetadata, meetingObservationProvenance: ownProvenance },
    ownerMetadata,
  ];
  try {
    const descriptor = await store.readSession(session.id);
    expect(descriptor).toBeDefined();
    expect(await store.readUtterancesForSession(descriptor!)).toEqual([]);
    const editingSubscriber = vi.fn((row: TranscriptUtterance) => {
      const observation = row.metadata?.meetingObservationProvenance;
      if (observation && typeof observation === "object" && "speaker" in observation) {
        observation.speaker = "Subscriber-local edit";
      }
    });
    await subscribe("editing-subscriber", editingSubscriber);
    await subscribe("live-subscriber");

    snapshot = { ...snapshot, lines: [committed, ineligible, legacy], pendingLines: [] };
    await runtime.transcript(session.id);
    const stored = await store.readUtterancesForSession(descriptor!);
    expect(stored.map(({ id, text, metadata }) => [id, text, metadata])).toEqual([
      [`${session.id}:0`, committed.text, expectedMetadata[0]],
      [`${session.id}:1`, ineligible.text, expectedMetadata[1]],
      [`${session.id}:2`, legacy.text, expectedMetadata[2]],
    ]);
    expect(delivered.mock.calls.map(([row]) => row.metadata)).toEqual(expectedMetadata);
    expect(editingSubscriber).toHaveBeenCalledTimes(3);
    expect(editingSubscriber.mock.calls[0]?.[0].metadata).toMatchObject({
      meetingObservationProvenance: { speaker: "Subscriber-local edit" },
    });
    const sourceId = runtime.participationContext(session.id).sources[0]?.sourceId;
    expect(sourceId).toBeTruthy();

    // Observation-only revisions must not create utterances or action sources.
    const later = testMeetingObservation({ observationId: "later" });
    snapshot = { ...snapshot, lines: [{ ...committed, provenance: later }, ineligible, legacy] };
    await runtime.transcript(session.id);
    expect(await store.readUtterancesForSession(descriptor!)).toEqual(stored);
    expect(runtime.participationContext(session.id).sources[0]?.sourceId).toBe(sourceId);
    expect(delivered).toHaveBeenCalledTimes(3);

    const replayed = vi.fn<UtteranceHandler>();
    await subscribe("replay-subscriber", replayed);
    expect(replayed.mock.calls.map(([row]) => row.metadata)).toEqual(expectedMetadata);
  } finally {
    await runtime.leave(session.id);
  }

  // Verify retention after reopening the real database.
  vi.useRealTimers();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  const reopened = makeStore();
  const descriptor = await reopened.readSession(session.id);
  expect(descriptor?.stoppedAt).toBeDefined();
  const retained = await reopened.readUtterancesForSession(descriptor!);
  expect(retained.map((row) => row.metadata)).toEqual(expectedMetadata);
});
