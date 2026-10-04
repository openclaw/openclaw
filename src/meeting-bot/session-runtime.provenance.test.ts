import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TEST_CAPTION_SOURCE,
  TEST_MEETING_URL,
  testMeetingObservation,
} from "./observation-provenance.test-support.js";
import { createParticipationTestRuntime } from "./session-runtime.test-support.js";
import type { MeetingTranscriptSnapshot } from "./session-types.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("MeetingSessionRuntime observation provenance", () => {
  it("isolates retained row, input, context, and inspect envelopes without renewing unchanged sources", async () => {
    vi.useFakeTimers();
    const firstObservedAt = Date.parse("2026-09-01T00:00:00.000Z");
    vi.setSystemTime(firstObservedAt);
    const provenance = testMeetingObservation();
    const expected = { ...provenance };
    let snapshot: MeetingTranscriptSnapshot = {
      droppedLines: 0,
      epoch: "epoch-1",
      lines: [
        { text: "An invitation", source: { ...TEST_CAPTION_SOURCE }, provenance },
        { text: "Another retained row", provenance },
      ],
    };
    const { runtime } = createParticipationTestRuntime({
      transcribe: true,
      captureTranscript: async () => snapshot,
    });
    const { session } = await runtime.join({ url: TEST_MEETING_URL, agentId: "operator" });
    try {
      const transcript = await runtime.transcript(session.id);
      const context = runtime.participationContext(session.id);
      const sourceId = context.sources[0]!.sourceId;
      const inspected = runtime.inspectParticipationSource(session.id, sourceId);
      expect(inspected).toBeDefined();
      expect(transcript.lines?.map((line) => line.provenance)).toEqual([expected, expected]);

      provenance.speaker = "Changed input";
      transcript.lines![0]!.provenance!.speaker = "Changed returned row";
      context.sources[0]!.provenance!.speaker = "Changed returned context";
      inspected!.source.provenance!.speaker = "Changed returned inspection";
      expect(transcript.lines?.[1]?.provenance).toEqual(expected);
      expect(runtime.participationContext(session.id).sources[0]?.provenance).toEqual(expected);
      expect(runtime.inspectParticipationSource(session.id, sourceId)?.source.provenance).toEqual(
        expected,
      );

      const lines: MeetingTranscriptSnapshot["lines"] = [];
      for (const line of snapshot.lines) {
        lines.push({
          ...line,
          provenance: testMeetingObservation({
            observationId: "later-observation",
            observedAt: new Date(firstObservedAt + 119_999).toISOString(),
            self: "self",
          }),
        });
      }
      snapshot = { ...snapshot, lines };
      vi.setSystemTime(firstObservedAt + 119_999);
      const retained = await runtime.transcript(session.id);
      expect(retained.lines?.map((line) => line.provenance)).toEqual([expected, expected]);
      expect(runtime.participationContext(session.id)).toMatchObject({
        sourceOrder: 1,
        sources: [{ sourceId, order: 1, provenance: expected }],
      });
      expect(() => inspected!.assertCurrent()).not.toThrow();

      vi.setSystemTime(firstObservedAt + 120_001);
      await runtime.transcript(session.id);
      expect(runtime.participationContext(session.id)).toMatchObject({
        sourceOrder: 1,
        sources: [],
      });
      expect(runtime.inspectParticipationSource(session.id, sourceId)).toBeUndefined();
      expect(() => inspected!.assertCurrent()).toThrow("no longer current");
    } finally {
      await runtime.leave(session.id);
    }
  });
});
