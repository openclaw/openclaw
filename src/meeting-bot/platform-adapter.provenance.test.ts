import { describe, expect, it } from "vitest";
import {
  readTestMeetingTranscript,
  TEST_CAPTION_SOURCE,
  TEST_MEETING_PLATFORM_ADAPTER,
  testMeetingObservation,
} from "./observation-provenance.test-support.js";

const parseTranscript = (payload: unknown) =>
  TEST_MEETING_PLATFORM_ADAPTER.browser.captions.parseTranscript({
    result: JSON.stringify(payload),
  });

describe("meeting observation provenance parsing", () => {
  it("preserves committed, pending, and source-ineligible row facts through browser forwarding", async () => {
    const committed = {
      at: "2026-09-01T00:00:00.000Z",
      speaker: "Alice",
      text: "Please share the recap",
      source: TEST_CAPTION_SOURCE,
      provenance: testMeetingObservation(),
    };
    const own = {
      text: "My own caption",
      provenance: testMeetingObservation({ observationId: "own-observation", self: "self" }),
    };
    const ambiguous = {
      text: "An ambiguous or capacity-limited row",
      provenance: testMeetingObservation({ observationId: "unknown-observation", self: "unknown" }),
    };
    const stale = {
      text: "A retained row from an older epoch",
      provenance: testMeetingObservation({ observationId: "stale-observation", epoch: "old-page" }),
    };
    const pending = {
      text: "Please wait",
      source: { ...TEST_CAPTION_SOURCE, revision: "3", finalized: false },
      provenance: testMeetingObservation({ observationId: "pending-observation" }),
    };
    const result = await readTestMeetingTranscript({
      urlMatched: true,
      sessionMatched: true,
      droppedLines: 7,
      epoch: "epoch-1",
      lines: [
        {
          ...committed,
          provenance: { ...committed.provenance, authority: { participantId: "untrusted" } },
        },
        own,
        ambiguous,
        { ...stale, source: { ...TEST_CAPTION_SOURCE, epoch: "old-page" } },
      ],
      pendingLines: [pending],
    });

    expect(result).toEqual({
      droppedLines: 7,
      epoch: "epoch-1",
      lines: [committed, own, ambiguous, stale],
      pendingLines: [pending],
    });
    expect(result.lines.slice(1).every((line) => line.source === undefined)).toBe(true);
    expect(result.lines[0]?.provenance).not.toBe(committed.provenance);
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["array", []],
    ["missing observer", { self: "other" }],
    ["blank observer", { ...testMeetingObservation(), observer: " " }],
    ["oversized observer", { ...testMeetingObservation(), observer: "x".repeat(129) }],
    ["oversized observation id", { ...testMeetingObservation(), observationId: "x".repeat(1_025) }],
    ["non-scalar session", { ...testMeetingObservation(), sessionId: { id: "session-1" } }],
    ["oversized epoch", { ...testMeetingObservation(), epoch: "x".repeat(513) }],
    ["invalid time", { ...testMeetingObservation(), observedAt: "not-a-date" }],
    ["invalid speaker", { ...testMeetingObservation(), speaker: ["Alice"] }],
    ["invalid self", { ...testMeetingObservation(), self: false }],
  ])(
    "makes %s envelopes explicitly unknown without inferring self from a source",
    (_name, provenance) => {
      const source = { ...TEST_CAPTION_SOURCE, ownEcho: true };
      const parsed = parseTranscript({
        epoch: "epoch-1",
        lines: [
          { at: "2026-09-01T00:00:00.000Z", speaker: "Alice", text: "Caption", source, provenance },
        ],
      });
      expect(parsed.lines[0]).toEqual({
        at: "2026-09-01T00:00:00.000Z",
        speaker: "Alice",
        text: "Caption",
        source,
        provenance: {
          observer: "test-meeting",
          epoch: "epoch-1",
          observedAt: "2026-09-01T00:00:00.000Z",
          speaker: "Alice",
          self: "unknown",
        },
      });
    },
  );

  it("does not turn malformed raw source fields or fallback facts into attribution", () => {
    const parsed = parseTranscript({
      epoch: "x".repeat(513),
      lines: [
        {
          at: "invalid-time",
          speaker: "x".repeat(513),
          text: "Still retained",
          source: { ...TEST_CAPTION_SOURCE, ownEcho: "false" },
          provenance: { observer: "untrusted", sessionId: "invented", self: "invalid" },
        },
      ],
    });
    expect(parsed.lines[0]?.source).toBeUndefined();
    expect(parsed.lines[0]?.provenance).toEqual({ observer: "test-meeting", self: "unknown" });
    expect(parsed.lines[0]?.text).toBe("Still retained");
  });

  it("retains shared row validation when captions carry source identity", () => {
    const provenance = testMeetingObservation();
    const row = { text: "Caption", source: TEST_CAPTION_SOURCE, provenance };
    const parsed = parseTranscript({
      epoch: "epoch-1",
      lines: [null, 42, { text: " " }, { ...row, at: 42, speaker: false }],
      pendingLines: [false, { text: 42 }, row],
    });
    expect(parsed).toEqual({
      droppedLines: 0,
      epoch: "epoch-1",
      lines: [row],
      pendingLines: [row],
    });
  });

  it("preserves optional legacy provider output without manufacturing an observer or identity", () => {
    const line = { text: "Legacy provider without observation metadata" };
    expect(parseTranscript({ lines: [line] })).toEqual({ droppedLines: 0, lines: [line] });
  });

  it("normalizes status recentTranscript envelopes instead of stripping them", () => {
    const provenance = testMeetingObservation();
    const health = TEST_MEETING_PLATFORM_ADAPTER.browser.parseStatus({
      result: JSON.stringify({
        recentTranscript: [
          { text: "Current", provenance, source: TEST_CAPTION_SOURCE },
          null,
          { text: " " },
          { text: "Unknown", speaker: "Bob", provenance: null },
          { text: "Legacy" },
        ],
      }),
    });
    expect(health?.recentTranscript).toEqual([
      { text: "Current", provenance },
      {
        text: "Unknown",
        speaker: "Bob",
        provenance: { observer: "test-meeting", speaker: "Bob", self: "unknown" },
      },
      { text: "Legacy" },
    ]);
  });

  it.each(["urlMatched", "sessionMatched"])(
    "does not let provenance bypass the browser %s gate",
    async (gate) => {
      await expect(
        readTestMeetingTranscript({
          [gate]: false,
          epoch: "epoch-1",
          lines: [
            {
              text: "Do not accept this page",
              source: TEST_CAPTION_SOURCE,
              provenance: testMeetingObservation(),
            },
          ],
        }),
      ).rejects.toThrow(gate === "urlMatched" ? "meeting URL" : "another OpenClaw meeting session");
    },
  );
});
