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
const observedLine = (
  text: string,
  overrides: Parameters<typeof testMeetingObservation>[0] = {},
) => ({ text, provenance: testMeetingObservation(overrides) });
const captionLine = { ...observedLine("Caption"), source: TEST_CAPTION_SOURCE };
const datedCaption = { ...captionLine, at: "2026-09-01T00:00:00.000Z", speaker: "Alice" };

describe("meeting observation provenance parsing", () => {
  it("preserves committed, pending, and source-ineligible row facts through browser forwarding", async () => {
    const committed = {
      ...datedCaption,
      text: "Please share the recap",
    };
    const own = observedLine("My own caption", { observationId: "own-observation", self: "self" });
    const ambiguous = observedLine("An ambiguous or capacity-limited row", {
      observationId: "unknown-observation",
      self: "unknown",
    });
    const stale = observedLine("A retained row from an older epoch", {
      observationId: "stale-observation",
      epoch: "old-page",
    });
    const pending = {
      ...observedLine("Please wait", { observationId: "pending-observation" }),
      source: { ...TEST_CAPTION_SOURCE, revision: "3", finalized: false },
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
        lines: [{ ...datedCaption, source, provenance }],
      });
      expect(parsed.lines[0]).toEqual({
        ...datedCaption,
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

  const malformedLine = { at: "invalid-time", speaker: "x".repeat(513), text: "Still retained" };
  const legacyLine = { text: "Legacy provider without observation metadata" };
  it.each<[string, unknown, unknown]>([
    [
      "malformed identity and fallback",
      {
        epoch: "x".repeat(513),
        lines: [
          {
            ...malformedLine,
            source: { ...TEST_CAPTION_SOURCE, ownEcho: "false" },
            provenance: { observer: "untrusted", sessionId: "invented", self: "invalid" },
          },
        ],
      },
      {
        droppedLines: 0,
        epoch: "x".repeat(513),
        lines: [{ ...malformedLine, provenance: { observer: "test-meeting", self: "unknown" } }],
      },
    ],
    [
      "invalid caption rows",
      {
        epoch: "epoch-1",
        lines: [null, 42, { text: " " }, { ...captionLine, at: 42, speaker: false }],
        pendingLines: [false, { text: 42 }, captionLine],
      },
      {
        droppedLines: 0,
        epoch: "epoch-1",
        lines: [captionLine],
        pendingLines: [captionLine],
      },
    ],
    ["legacy provider rows", { lines: [legacyLine] }, { droppedLines: 0, lines: [legacyLine] }],
  ])("normalizes %s without manufacturing attribution", (_name, payload, expected) => {
    expect(parseTranscript(payload)).toEqual(expected);
  });

  it("normalizes status recentTranscript envelopes instead of stripping them", () => {
    const provenance = testMeetingObservation();
    const health = TEST_MEETING_PLATFORM_ADAPTER.browser.parseStatus({
      result: JSON.stringify({
        recentTranscript: [
          { ...captionLine, text: "Current" },
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
          lines: [captionLine],
        }),
      ).rejects.toThrow(gate === "urlMatched" ? "meeting URL" : "another OpenClaw meeting session");
    },
  );
});
