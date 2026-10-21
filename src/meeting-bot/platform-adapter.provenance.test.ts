import { expect, it } from "vitest";
import {
  readTestMeetingTranscript,
  TEST_CAPTION_SOURCE,
  TEST_MEETING_PLATFORM_ADAPTER,
  testMeetingObservation,
} from "./observation-provenance.test-support.js";

const browser = TEST_MEETING_PLATFORM_ADAPTER.browser;
const wire = (payload: unknown) => ({ result: JSON.stringify(payload) });
const parseTranscript = (payload: unknown) => browser.captions.parseTranscript(wire(payload));
const observedLine = (
  text: string,
  overrides: Parameters<typeof testMeetingObservation>[0] = {},
) => ({ text, provenance: testMeetingObservation(overrides) });
const captionLine = { ...observedLine("Caption"), source: TEST_CAPTION_SOURCE };
const datedCaption = { ...captionLine, at: "2026-09-01T00:00:00.000Z", speaker: "Alice" };
const unknownProvenance = { observer: "test-meeting", self: "unknown" };
const transcriptDefaults = { droppedLines: 0, epoch: "epoch-1" };

it("preserves committed, pending, and source-ineligible row facts through browser forwarding", async () => {
  const committed = { ...datedCaption, text: "Committed" };
  const own = observedLine("Own", { observationId: "own", self: "self" });
  const ambiguous = observedLine("Unknown", { observationId: "unknown", self: "unknown" });
  const stale = observedLine("Stale", { observationId: "stale", epoch: "old-page" });
  const pending = {
    ...observedLine("Please wait", { observationId: "pending-observation" }),
    source: { ...TEST_CAPTION_SOURCE, revision: "3", finalized: false },
  };
  const snapshot = {
    droppedLines: 7,
    epoch: "epoch-1",
    lines: [committed, own, ambiguous, stale],
    pendingLines: [pending],
  };
  const result = await readTestMeetingTranscript({
    ...snapshot,
    urlMatched: true,
    sessionMatched: true,
    lines: [
      {
        ...committed,
        provenance: { ...committed.provenance, authority: { participantId: "untrusted" } },
      },
      own,
      ambiguous,
      { ...stale, source: { ...TEST_CAPTION_SOURCE, epoch: "old-page" } },
    ],
  });
  expect(result).toEqual(snapshot);
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
])("never infers self from a source with %s provenance", (_name, provenance) => {
  const source = { ...TEST_CAPTION_SOURCE, ownEcho: true };
  const parsed = parseTranscript({
    epoch: "epoch-1",
    lines: [{ ...datedCaption, source, provenance }],
  });
  expect(parsed.lines[0]).toEqual({
    ...datedCaption,
    source,
    provenance: {
      ...unknownProvenance,
      epoch: "epoch-1",
      observedAt: datedCaption.at,
      speaker: datedCaption.speaker,
    },
  });
});

const malformedLine = { at: "invalid-time", speaker: "x".repeat(513), text: "Still retained" };
const legacyLine = { text: "Legacy provider without observation metadata" };
it("normalizes malformed identity and fallback without manufacturing attribution", () => {
  const epoch = "x".repeat(513);
  const line = {
    ...malformedLine,
    source: { ...TEST_CAPTION_SOURCE, ownEcho: "false" },
    provenance: { observer: "untrusted", sessionId: "invented", self: "invalid" },
  };
  expect(parseTranscript({ epoch, lines: [line] })).toEqual({
    droppedLines: 0,
    epoch,
    lines: [{ ...malformedLine, provenance: unknownProvenance }],
  });
});

it("drops invalid caption rows and non-string display fields", () => {
  expect(
    parseTranscript({
      epoch: "epoch-1",
      lines: [null, 42, { text: " " }, { ...captionLine, at: 42, speaker: false }],
      pendingLines: [false, { text: 42 }, captionLine],
    }),
  ).toEqual({ ...transcriptDefaults, lines: [captionLine], pendingLines: [captionLine] });
});

it("preserves legacy provider rows without manufacturing attribution", () => {
  const lines = [legacyLine];
  expect(parseTranscript({ lines })).toEqual({ droppedLines: 0, lines });
});

it("normalizes status recentTranscript envelopes instead of stripping them", () => {
  const unknown = { text: "Unknown", speaker: "Bob" };
  const health = browser.parseStatus(
    wire({
      recentTranscript: [
        { ...captionLine, text: "Current" },
        null,
        { text: " " },
        { ...unknown, provenance: null },
        { text: "Legacy" },
      ],
    }),
  );
  expect(health?.recentTranscript).toEqual([
    { text: "Current", provenance: captionLine.provenance },
    { ...unknown, provenance: { ...unknownProvenance, speaker: "Bob" } },
    { text: "Legacy" },
  ]);
});

it.each(["urlMatched", "sessionMatched"])("enforces the browser %s gate", async (gate) => {
  await expect(
    readTestMeetingTranscript({
      [gate]: false,
      epoch: "epoch-1",
      lines: [captionLine],
    }),
  ).rejects.toThrow(gate === "urlMatched" ? "meeting URL" : "another OpenClaw meeting session");
});
