import { describe, expect, it } from "vitest";
import { getReplyPayloadMetadata, setReplyPayloadMetadata } from "../reply-payload.js";
import { appendUnscheduledReminderNote } from "./agent-runner-reminder-guard.js";

describe("appendUnscheduledReminderNote", () => {
  it("preserves transcript ownership metadata when appending the guard note", () => {
    const payload = setReplyPayloadMetadata(
      { text: "I'll remind you tomorrow." },
      { assistantTranscriptOwned: true },
    );

    const [guarded] = appendUnscheduledReminderNote([payload]);

    expect(guarded?.text).toContain("I did not schedule a reminder");
    expect(getReplyPayloadMetadata(guarded ?? {})).toEqual({
      assistantTranscriptOwned: true,
    });
  });
});
