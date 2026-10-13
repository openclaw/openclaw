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

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    vi.useRealTimers();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  });
});

it("retains provenance on existing utterance rows and subscriber replay, not on pending or observation-only revisions", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-01T00:00:00.000Z"));
  const stateDir = tempDirs.make("openclaw-meeting-provenance-");
  const makeStore = () =>
    new TranscriptsStore(path.join(stateDir, "transcripts"), {
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
  const store = makeStore();
  const committed = {
    at: "2026-09-01T00:00:00.000Z",
    speaker: "Alice",
    text: "First committed line",
    source: TEST_CAPTION_SOURCE,
    provenance: testMeetingObservation(),
  };
  const ineligible = {
    text: "Retained own speech without an action source",
    provenance: testMeetingObservation({ observationId: "own-observation", self: "self" }),
  };
  const legacy = { text: "Legacy provider line" };
  let snapshot: MeetingTranscriptSnapshot = {
    droppedLines: 0,
    epoch: "epoch-1",
    lines: [],
    pendingLines: [
      {
        text: "Pending text is not durable",
        source: { ...TEST_CAPTION_SOURCE, revision: "1", finalized: false },
        provenance: testMeetingObservation({ observationId: "pending-observation" }),
      },
    ],
  };
  const { runtime } = createParticipationTestRuntime({
    durableTranscripts: { stateDir },
    transcribe: true,
    captureTranscript: async () => await readTestMeetingTranscript(snapshot),
  });
  const { session } = await runtime.join({ url: TEST_MEETING_URL, agentId: "operator" });
  const delivered = vi.fn<(utterance: TranscriptUtterance) => void>();
  const subscriber = (sessionId: string) => ({
    session: {
      sessionId,
      startedAt: session.createdAt,
      source: { providerId: "test-meeting", agentId: "operator", meetingUrl: TEST_MEETING_URL },
    },
    onUtterance: delivered,
  });
  const expectedMetadata = [
    {
      agentId: "operator",
      meetingSessionId: session.id,
      meetingObservationProvenance: committed.provenance,
    },
    {
      agentId: "operator",
      meetingSessionId: session.id,
      meetingObservationProvenance: ineligible.provenance,
    },
    { agentId: "operator", meetingSessionId: session.id },
  ];
  try {
    const descriptor = await store.readSession(session.id);
    expect(descriptor).toBeDefined();
    expect(await store.readUtterancesForSession(descriptor!)).toEqual([]);
    const editingSubscriber = vi.fn((row: TranscriptUtterance) => {
      const provenance = row.metadata?.meetingObservationProvenance;
      if (provenance && typeof provenance === "object" && "speaker" in provenance) {
        provenance.speaker = "Subscriber-local edit";
      }
    });
    await expect(
      runtime.startTranscriptSource({
        ...subscriber("editing-subscriber"),
        onUtterance: editingSubscriber,
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      runtime.startTranscriptSource(subscriber("live-subscriber")),
    ).resolves.toMatchObject({ ok: true });

    snapshot = { ...snapshot, lines: [committed, ineligible, legacy], pendingLines: [] };
    await runtime.transcript(session.id);
    const stored = await store.readUtterancesForSession(descriptor!);
    expect(stored.map((row) => row.text)).toEqual([committed.text, ineligible.text, legacy.text]);
    expect(stored.map((row) => row.id)).toEqual([
      `${session.id}:0`,
      `${session.id}:1`,
      `${session.id}:2`,
    ]);
    expect(stored.map((row) => row.metadata)).toEqual(expectedMetadata);
    expect(delivered.mock.calls.map(([row]) => row.metadata)).toEqual(expectedMetadata);
    expect(editingSubscriber).toHaveBeenCalledTimes(3);
    expect(editingSubscriber.mock.calls[0]?.[0].metadata).toMatchObject({
      meetingObservationProvenance: { speaker: "Subscriber-local edit" },
    });
    const sourceId = runtime.participationContext(session.id).sources[0]?.sourceId;
    expect(sourceId).toBeTruthy();

    // A new observation envelope on the same committed row is not a new utterance or action source.
    snapshot = {
      ...snapshot,
      lines: [
        {
          ...committed,
          provenance: testMeetingObservation({ observationId: "later-observation" }),
        },
        ineligible,
        legacy,
      ],
    };
    await runtime.transcript(session.id);
    expect(await store.readUtterancesForSession(descriptor!)).toEqual(stored);
    expect(runtime.participationContext(session.id).sources[0]?.sourceId).toBe(sourceId);
    expect(delivered).toHaveBeenCalledTimes(3);

    const replayed = vi.fn<(utterance: TranscriptUtterance) => void>();
    await expect(
      runtime.startTranscriptSource({
        ...subscriber("replay-subscriber"),
        onUtterance: replayed,
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(replayed.mock.calls.map(([row]) => row.metadata)).toEqual(expectedMetadata);
  } finally {
    await runtime.leave(session.id);
  }

  // Reopen the real database; an in-memory callback or assertion against the input is not retention proof.
  vi.useRealTimers();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  const reopened = makeStore();
  const descriptor = await reopened.readSession(session.id);
  expect(descriptor?.stoppedAt).toBeDefined();
  expect((await reopened.readUtterancesForSession(descriptor!)).map((row) => row.metadata)).toEqual(
    expectedMetadata,
  );
});
