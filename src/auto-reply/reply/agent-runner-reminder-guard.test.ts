import { describe, expect, it } from "vitest";
import type { ReplyPayload } from "../types.js";
import {
  UNSCHEDULED_REMINDER_NOTE,
  appendUnscheduledReminderNote,
  hasUnbackedReminderCommitment,
} from "./agent-runner-reminder-guard.js";

describe("hasUnbackedReminderCommitment", () => {
  it("detects 'I'll remember'", () => {
    expect(hasUnbackedReminderCommitment("I'll remember to check on that.")).toBe(true);
  });

  it("detects 'I will remind'", () => {
    expect(hasUnbackedReminderCommitment("I will remind you tomorrow.")).toBe(true);
  });

  it("detects 'I'll follow up'", () => {
    expect(hasUnbackedReminderCommitment("I'll follow up on this next week.")).toBe(true);
  });

  it("detects 'I'll set a reminder'", () => {
    expect(hasUnbackedReminderCommitment("I'll set a reminder for 3pm.")).toBe(true);
  });

  it("detects 'I will schedule a reminder'", () => {
    expect(hasUnbackedReminderCommitment("I will schedule a reminder for you.")).toBe(true);
  });

  it("detects 'I'll ping'", () => {
    expect(hasUnbackedReminderCommitment("I'll ping you when it's ready.")).toBe(true);
  });

  it("detects 'I'll check back'", () => {
    expect(hasUnbackedReminderCommitment("I'll check back in an hour.")).toBe(true);
  });

  it("does not match when the note is already appended", () => {
    const text = `I'll remember to do that.\n\n${UNSCHEDULED_REMINDER_NOTE}`;
    expect(hasUnbackedReminderCommitment(text)).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(hasUnbackedReminderCommitment("")).toBe(false);
  });

  it("returns false for whitespace-only string", () => {
    expect(hasUnbackedReminderCommitment("   ")).toBe(false);
  });

  it("does not match unrelated text", () => {
    expect(hasUnbackedReminderCommitment("The weather is nice today.")).toBe(false);
  });

  it("does not match 'remember' without 'I'll' or 'I will'", () => {
    expect(hasUnbackedReminderCommitment("Remember to check the logs.")).toBe(false);
  });

  it("does not match third-person references", () => {
    expect(hasUnbackedReminderCommitment("He'll remember to do it.")).toBe(false);
  });
});

const makePayload = (text: string, overrides?: Partial<ReplyPayload>): ReplyPayload => ({
  text,
  ...overrides,
});

describe("appendUnscheduledReminderNote", () => {
  it("appends note to payload with unbacked reminder commitment", () => {
    const payloads = [makePayload("I'll remember to check on that.")];
    const result = appendUnscheduledReminderNote(payloads);
    expect(result[0].text).toContain(UNSCHEDULED_REMINDER_NOTE);
  });

  it("does not append note when no commitment is detected", () => {
    const payloads = [makePayload("The weather is nice today.")];
    const result = appendUnscheduledReminderNote(payloads);
    expect(result[0].text).toBe("The weather is nice today.");
  });

  it("does not append note to error payloads", () => {
    const payloads = [makePayload("I'll remember to check.", { isError: true })];
    const result = appendUnscheduledReminderNote(payloads);
    expect(result[0].text).not.toContain(UNSCHEDULED_REMINDER_NOTE);
  });

  it("does not append note to payloads without text", () => {
    const payloads: ReplyPayload[] = [{ mediaUrl: "https://example.com/image.png" }];
    const result = appendUnscheduledReminderNote(payloads);
    expect(result[0].text).toBeUndefined();
  });

  it("appends note to only the first matching payload", () => {
    const payloads = [
      makePayload("I'll remember to check on that."),
      makePayload("I'll also follow up on the other thing."),
    ];
    const result = appendUnscheduledReminderNote(payloads);
    expect(result[0].text).toContain(UNSCHEDULED_REMINDER_NOTE);
    expect(result[1].text).not.toContain(UNSCHEDULED_REMINDER_NOTE);
  });

  it("trims trailing whitespace before appending", () => {
    const payloads = [makePayload("I'll remember to check.   \n\n")];
    const result = appendUnscheduledReminderNote(payloads);
    expect(result[0].text).toBe(`I'll remember to check.\n\n${UNSCHEDULED_REMINDER_NOTE}`);
  });

  it("returns original payloads when no commitment found", () => {
    const payloads = [makePayload("All good here."), makePayload("Nothing to report.")];
    const result = appendUnscheduledReminderNote(payloads);
    expect(result).toEqual(payloads);
  });
});

describe("config: messages.unscheduledReminderNote", () => {
  /**
   * The config flag gates the call to appendUnscheduledReminderNote in
   * agent-runner.ts. We replicate that gating logic here to verify the
   * contract: when the flag is false, the note is never appended even
   * when a reminder commitment is detected.
   */
  function applyReminderGuard(
    payloads: ReplyPayload[],
    config: { unscheduledReminderNote?: boolean },
  ): ReplyPayload[] {
    const enabled = config.unscheduledReminderNote !== false;
    if (!enabled) {
      return payloads;
    }
    const hasCommitment = payloads.some(
      (p) => !p.isError && typeof p.text === "string" && hasUnbackedReminderCommitment(p.text),
    );
    return hasCommitment ? appendUnscheduledReminderNote(payloads) : payloads;
  }

  it("appends note when config is undefined (default behavior)", () => {
    const payloads = [makePayload("I'll remember to check on that.")];
    const result = applyReminderGuard(payloads, {});
    expect(result[0].text).toContain(UNSCHEDULED_REMINDER_NOTE);
  });

  it("appends note when config is explicitly true", () => {
    const payloads = [makePayload("I'll remember to check on that.")];
    const result = applyReminderGuard(payloads, { unscheduledReminderNote: true });
    expect(result[0].text).toContain(UNSCHEDULED_REMINDER_NOTE);
  });

  it("does NOT append note when config is false", () => {
    const payloads = [makePayload("I'll remember to check on that.")];
    const result = applyReminderGuard(payloads, { unscheduledReminderNote: false });
    expect(result[0].text).toBe("I'll remember to check on that.");
  });

  it("does NOT append note when config is false even with strong commitment language", () => {
    const payloads = [makePayload("I'll set a reminder and follow up with you tomorrow.")];
    const result = applyReminderGuard(payloads, { unscheduledReminderNote: false });
    expect(result[0].text).not.toContain(UNSCHEDULED_REMINDER_NOTE);
  });

  it("still skips non-commitment text regardless of config", () => {
    const payloads = [makePayload("The weather looks nice.")];
    const result = applyReminderGuard(payloads, { unscheduledReminderNote: true });
    expect(result[0].text).toBe("The weather looks nice.");
  });
});
