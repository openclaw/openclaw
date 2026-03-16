import { describe, it, expect } from "vitest";
import type { ReplyPayload } from "../types.js";
import {
  hasUnbackedReminderCommitment,
  UNSCHEDULED_REMINDER_NOTE,
  appendUnscheduledReminderNote,
} from "./agent-runner-reminder-guard.js";

describe("hasUnbackedReminderCommitment", () => {
  describe("should return true for genuine reminder commitments", () => {
    const positives = [
      "I'll remind you about this tomorrow",
      "I'll remind you when it's ready",
      "I will remind you at 3pm",
      "I'll follow up on that next week",
      "I'll follow-up with you later",
      "I'll ping you when it's done",
      "I'll check back in an hour",
      "I'll circle back on this",
      "I'll make sure to remind you",
      "I'll remember to check on that",
      "I'll remember to remind you tomorrow",
      "I'll remember to follow up",
      "I will remember to ping you about this",
      "I'll set a reminder for that",
      "I'll create a reminder for tomorrow",
      "I'll schedule a reminder",
      // Conjunction forms
      "I'll remember and remind you tomorrow",
      "I will remember, then follow up later",
      "I'll remember and then ping you about it",
    ];

    for (const text of positives) {
      it(`"${text}"`, () => {
        expect(hasUnbackedReminderCommitment(text)).toBe(true);
      });
    }
  });

  describe("should return false for memory/knowledge retention statements", () => {
    const negatives = [
      "I'll remember that",
      "I'll remember the specifics",
      "I'll remember your preference",
      "I'll remember this for next time",
      "I will remember what you told me",
      "I'll make sure to remember",
      "I'll remember that you like mango",
      "I'll remember!",
    ];

    for (const text of negatives) {
      it(`"${text}"`, () => {
        expect(hasUnbackedReminderCommitment(text)).toBe(false);
      });
    }
  });

  describe("edge cases", () => {
    it("returns false for empty string", () => {
      expect(hasUnbackedReminderCommitment("")).toBe(false);
    });

    it("returns false for whitespace-only string", () => {
      expect(hasUnbackedReminderCommitment("   ")).toBe(false);
    });

    it("returns false when the note is already present", () => {
      const text = `I'll remind you tomorrow\n\n${UNSCHEDULED_REMINDER_NOTE}`;
      expect(hasUnbackedReminderCommitment(text)).toBe(false);
    });

    it("returns false for unrelated text", () => {
      expect(hasUnbackedReminderCommitment("The weather is nice today")).toBe(false);
    });

    it("returns false for third-person reminder mentions", () => {
      expect(hasUnbackedReminderCommitment("She'll remind you later")).toBe(false);
    });

    it("matches curly/typographic apostrophes", () => {
      // U+2019 RIGHT SINGLE QUOTATION MARK (most common typographic apostrophe)
      expect(hasUnbackedReminderCommitment("I\u2019ll remind you tomorrow")).toBe(true);
    });
  });
});

describe("appendUnscheduledReminderNote", () => {
  it("appends note to payload with reminder commitment", () => {
    const payloads = [{ text: "Sure, I'll remind you tomorrow!" }];
    const result = appendUnscheduledReminderNote(payloads as unknown as ReplyPayload[]);
    expect(result[0].text).toContain(UNSCHEDULED_REMINDER_NOTE);
  });

  it("does not append note to memory retention statements", () => {
    const payloads = [{ text: "I'll remember your preference for dark mode." }];
    const result = appendUnscheduledReminderNote(payloads as unknown as ReplyPayload[]);
    expect(result[0].text).not.toContain(UNSCHEDULED_REMINDER_NOTE);
  });

  it("does not append note to error payloads", () => {
    const payloads = [{ text: "I'll remind you tomorrow!", isError: true }];
    const result = appendUnscheduledReminderNote(payloads as unknown as ReplyPayload[]);
    expect(result[0].text).not.toContain(UNSCHEDULED_REMINDER_NOTE);
  });

  it("only appends once across multiple payloads, to the first match", () => {
    const payloads = [{ text: "I'll remind you about A." }, { text: "I'll remind you about B." }];
    const result = appendUnscheduledReminderNote(payloads as unknown as ReplyPayload[]);
    const count = result.filter((p) => p.text?.includes(UNSCHEDULED_REMINDER_NOTE)).length;
    expect(count).toBe(1);
    expect(result[0].text).toContain(UNSCHEDULED_REMINDER_NOTE);
    expect(result[1].text).not.toContain(UNSCHEDULED_REMINDER_NOTE);
  });

  it("appends note to the first non-error payload with a commitment", () => {
    const payloads = [
      { text: "I'll remind you tomorrow!", isError: true },
      { text: "I'll remind you again!" },
    ];
    const result = appendUnscheduledReminderNote(payloads as unknown as ReplyPayload[]);
    expect(result[0].text).not.toContain(UNSCHEDULED_REMINDER_NOTE);
    expect(result[1].text).toContain(UNSCHEDULED_REMINDER_NOTE);
  });
});
