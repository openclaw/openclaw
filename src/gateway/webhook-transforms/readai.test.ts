import { describe, expect, test } from "vitest";
import { transformReadAiPayload } from "./readai.js";

describe("transformReadAiPayload", () => {
  test("formats a full meeting_end payload", () => {
    const payload = {
      trigger: "meeting_end",
      session_id: "sess-123",
      title: "Weekly Standup",
      start_time: "2026-02-08T10:00:00Z",
      end_time: "2026-02-08T10:30:00Z",
      summary: "Discussed sprint progress and blockers.",
      report_url: "https://read.ai/reports/sess-123",
      owner: { name: "John", email: "john@example.com" },
      participants: [
        { name: "Alice", email: "alice@example.com" },
        { name: "Bob", email: "bob@example.com" },
      ],
      action_items: ["Review PR #42", "Update docs"],
      key_questions: ["When is the deadline?"],
      topics: ["Sprint review", "Deployment plan"],
    };

    const result = transformReadAiPayload(payload);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("Read.ai");
    expect(result!.sessionKey).toBe("webhook:readai:sess-123");
    expect(result!.message).toContain("## Meeting Notes: Weekly Standup");
    expect(result!.message).toContain("**Organizer:** John");
    expect(result!.message).toContain("Alice, Bob");
    expect(result!.message).toContain("### Summary");
    expect(result!.message).toContain("Discussed sprint progress");
    expect(result!.message).toContain("- Review PR #42");
    expect(result!.message).toContain("- Update docs");
    expect(result!.message).toContain("- When is the deadline?");
    expect(result!.message).toContain("- Sprint review");
    expect(result!.message).toContain("https://read.ai/reports/sess-123");
  });

  test("returns null for non-meeting_end triggers", () => {
    const payload = {
      trigger: "meeting_start",
      session_id: "sess-456",
      title: "Team Sync",
    };
    expect(transformReadAiPayload(payload)).toBeNull();
  });

  test("returns null when trigger is missing", () => {
    const payload = {
      session_id: "sess-789",
      title: "No Trigger",
    };
    expect(transformReadAiPayload(payload)).toBeNull();
  });

  test("handles missing optional fields gracefully", () => {
    const payload = {
      trigger: "meeting_end",
      session_id: "sess-minimal",
      title: "Quick Chat",
    };

    const result = transformReadAiPayload(payload);
    expect(result).not.toBeNull();
    expect(result!.message).toContain("## Meeting Notes: Quick Chat");
    expect(result!.message).not.toContain("### Summary");
    expect(result!.message).not.toContain("### Action Items");
    expect(result!.message).not.toContain("### Key Questions");
    expect(result!.message).not.toContain("### Topics Discussed");
    expect(result!.sessionKey).toBe("webhook:readai:sess-minimal");
  });

  test("handles string participants", () => {
    const payload = {
      trigger: "meeting_end",
      session_id: "sess-str",
      title: "Test",
      participants: ["Alice", "Bob"],
    };
    const result = transformReadAiPayload(payload);
    expect(result).not.toBeNull();
    expect(result!.message).toContain("Alice, Bob");
  });

  test("session key derivation", () => {
    const result = transformReadAiPayload({
      trigger: "meeting_end",
      session_id: "abc-def-123",
    });
    expect(result).not.toBeNull();
    expect(result!.sessionKey).toBe("webhook:readai:abc-def-123");
  });

  test("defaults title when missing", () => {
    const result = transformReadAiPayload({
      trigger: "meeting_end",
      session_id: "x",
    });
    expect(result).not.toBeNull();
    expect(result!.message).toContain("Untitled Meeting");
  });
});
