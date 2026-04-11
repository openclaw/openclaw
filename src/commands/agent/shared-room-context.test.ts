import { describe, expect, it } from "vitest";
import {
  buildSharedRoomContextPrompt,
  mergeExtraSystemPrompts,
  summarizeSharedRoomContext,
} from "./shared-room-context.js";

describe("shared room context", () => {
  it("summarizes admitted room metadata for persistence", () => {
    const summary = summarizeSharedRoomContext({
      roomId: "breakout-123",
      roomLabel: "Break-Out Room",
      truthModel: "shared_room_ledger_v1",
      participantId: "codex",
      participantLabel: "Codex",
      seenThroughSeq: 4,
      participants: [{ id: "codex" }, { id: "voltaris-v2" }],
      messages: [
        { seq: 3, author: "Operator", text: "hello" },
        { seq: 4, author: "Voltaris V2", text: "hi" },
      ],
    });

    expect(summary).toEqual({
      roomId: "breakout-123",
      roomLabel: "Break-Out Room",
      truthModel: "shared_room_ledger_v1",
      participantId: "codex",
      participantLabel: "Codex",
      seenThroughSeq: 4,
      lastMessageSeq: 4,
      participantCount: 2,
    });
  });

  it("builds a prompt from admitted room history only", () => {
    const prompt = buildSharedRoomContextPrompt({
      roomId: "breakout-123",
      roomLabel: "Break-Out Room",
      participantLabel: "Codex",
      seenThroughSeq: 2,
      participants: [
        { id: "operator", label: "Operator", seat: "control" },
        { id: "codex", label: "Codex", seat: "seat-1" },
      ],
      messages: [
        { seq: 1, author: "Operator", text: "What is CyborgClaw?" },
        { seq: 2, author: "Voltaris V2", text: "It is the operator system." },
        { seq: 3, author: "President-A", text: "This should not be admitted yet." },
      ],
    });

    expect(prompt).toContain('You are seated in the shared room "Break-Out Room".');
    expect(prompt).toContain("Your admitted room context includes room events through seq 2.");
    expect(prompt).toContain("[#1] Operator: What is CyborgClaw?");
    expect(prompt).toContain("[#2] Voltaris V2: It is the operator system.");
    expect(prompt).not.toContain("This should not be admitted yet.");
  });

  it("merges prompt additions without losing either section", () => {
    expect(mergeExtraSystemPrompts("Room facts", "One sentence only.")).toBe(
      "Room facts\n\nOne sentence only.",
    );
  });
});
