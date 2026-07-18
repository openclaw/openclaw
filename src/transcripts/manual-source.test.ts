// Tests for the built-in manual transcript import provider.
import { describe, expect, it } from "vitest";
import { manualTranscriptSourceProvider } from "./manual-source.js";
import type { TranscriptSessionDescriptor } from "./provider-types.js";

function makeSession(overrides: Partial<TranscriptSessionDescriptor> = {}): TranscriptSessionDescriptor {
  return {
    sessionId: "test-session-1",
    source: { providerId: "manual-transcript" },
    startedAt: "2026-07-02T10:00:00.000Z",
    ...overrides,
  };
}

describe("manualTranscriptSourceProvider", () => {
  describe("metadata", () => {
    it("has the expected provider id", () => {
      expect(manualTranscriptSourceProvider.id).toBe("manual-transcript");
    });

    it("registers posthoc-transcript as its source kind", () => {
      expect(manualTranscriptSourceProvider.sourceKinds).toContain("posthoc-transcript");
    });

    it("exposes 'import' and 'transcript' aliases", () => {
      expect(manualTranscriptSourceProvider.aliases).toContain("import");
      expect(manualTranscriptSourceProvider.aliases).toContain("transcript");
    });
  });

  describe("importTranscript", () => {
    it('parses "Speaker: text" lines', async () => {
      const session = makeSession();
      const utterances = await manualTranscriptSourceProvider.importTranscript!({
        session,
        text: "Alice: Hello world\nBob: Nice to meet you",
      });

      expect(utterances).toHaveLength(2);
      expect(utterances[0]?.speaker?.label).toBe("Alice");
      expect(utterances[0]?.text).toBe("Hello world");
      expect(utterances[1]?.speaker?.label).toBe("Bob");
      expect(utterances[1]?.text).toBe("Nice to meet you");
    });

    it("treats lines without a colon as speakerless text", async () => {
      const session = makeSession();
      const utterances = await manualTranscriptSourceProvider.importTranscript!({
        session,
        text: "Just a plain line of text",
      });

      expect(utterances).toHaveLength(1);
      expect(utterances[0]?.speaker?.label).toBe("Speaker");
      expect(utterances[0]?.text).toBe("Just a plain line of text");
    });

    it("respects the speakerLabel fallback for lines without a speaker prefix", async () => {
      const session = makeSession();
      const utterances = await manualTranscriptSourceProvider.importTranscript!({
        session,
        text: "Plain text without speaker",
        speakerLabel: "Host",
      });

      expect(utterances).toHaveLength(1);
      expect(utterances[0]?.speaker?.label).toBe("Host");
    });

    it("does not override a parsed speaker with the fallback", async () => {
      const session = makeSession();
      const utterances = await manualTranscriptSourceProvider.importTranscript!({
        session,
        text: "Alice: Specific message",
        speakerLabel: "Fallback",
      });

      expect(utterances[0]?.speaker?.label).toBe("Alice");
    });

    it("handles colons inside the text portion", async () => {
      const session = makeSession();
      const utterances = await manualTranscriptSourceProvider.importTranscript!({
        session,
        text: "Alice: the ratio is 3:1 and that matters",
      });

      expect(utterances).toHaveLength(1);
      expect(utterances[0]?.speaker?.label).toBe("Alice");
      expect(utterances[0]?.text).toBe("the ratio is 3:1 and that matters");
    });

    it("treats lines where the prefix exceeds 80 characters as speakerless", async () => {
      const session = makeSession();
      const longPrefix = "A".repeat(81);
      const utterances = await manualTranscriptSourceProvider.importTranscript!({
        session,
        text: `${longPrefix}: some text after colon`,
      });

      expect(utterances).toHaveLength(1);
      expect(utterances[0]?.speaker?.label).toBe("Speaker");
      expect(utterances[0]?.text).toBe(`${longPrefix}: some text after colon`);
    });

    it("skips empty lines", async () => {
      const session = makeSession();
      const utterances = await manualTranscriptSourceProvider.importTranscript!({
        session,
        text: "Alice: Hello\n\n\nBob: World",
      });

      expect(utterances).toHaveLength(2);
    });

    it("assigns sequential utterance ids", async () => {
      const session = makeSession({ sessionId: "my-session" });
      const utterances = await manualTranscriptSourceProvider.importTranscript!({
        session,
        text: "Line 1\nLine 2\nLine 3",
      });

      expect(utterances[0]?.id).toBe("my-session-1");
      expect(utterances[1]?.id).toBe("my-session-2");
      expect(utterances[2]?.id).toBe("my-session-3");
    });

    it("marks all utterances as final", async () => {
      const session = makeSession();
      const utterances = await manualTranscriptSourceProvider.importTranscript!({
        session,
        text: "One line",
      });

      expect(utterances[0]?.final).toBe(true);
    });

    it("attaches the sessionId to every utterance", async () => {
      const session = makeSession({ sessionId: "sess-xyz" });
      const utterances = await manualTranscriptSourceProvider.importTranscript!({
        session,
        text: "Line 1\nLine 2",
      });

      for (const u of utterances) {
        expect(u.sessionId).toBe("sess-xyz");
      }
    });

    it("trims surrounding whitespace from each line", async () => {
      const session = makeSession();
      const utterances = await manualTranscriptSourceProvider.importTranscript!({
        session,
        text: "  Alice: Hello  \n  Bob: World  ",
      });

      expect(utterances[0]?.text).toBe("Hello");
      expect(utterances[1]?.text).toBe("World");
    });

    it("returns empty array for empty text", async () => {
      const session = makeSession();
      const utterances = await manualTranscriptSourceProvider.importTranscript!({
        session,
        text: "",
      });

      expect(utterances).toEqual([]);
    });

    it("sets startedAt on every utterance", async () => {
      const session = makeSession();
      const utterances = await manualTranscriptSourceProvider.importTranscript!({
        session,
        text: "One line",
      });

      const startedAt = utterances[0]?.startedAt;
      expect(startedAt).toBeTruthy();
      if (startedAt) {
        expect(() => new Date(startedAt)).not.toThrow();
      }
    });
  });
});
