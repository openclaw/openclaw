import { describe, expect, it } from "vitest";
import { projectAutoSteerEvidence } from "./chat-send-auto-steer-evidence.js";
const source = {
  role: "user",
  idempotencyKey: "source:user",
  content: [{ type: "text", text: "Write a parser." }],
};
describe("Auto bounded visible evidence", () => {
  it("keeps only visible text after the exact initiating source and never mutates rows", () => {
    const rows = [
      { role: "user", content: "unrelated previous task" },
      source,
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private" },
          { type: "text", text: "Working." },
          { type: "toolCall", arguments: { secret: "private" } },
        ],
      },
      { role: "toolResult", content: "private tool output" },
      { role: "system", content: "private instructions" },
      { role: "assistant", display: false, content: "hidden" },
      { role: "user", provenance: { kind: "internal_system" }, content: "coordination" },
      {
        role: "user",
        __openclaw: { workContext: { text: "authored" } },
        content: "decorated context",
      },
    ];
    const original = structuredClone(rows);
    expect(projectAutoSteerEvidence(rows, "source", "Handle tabs.")).toEqual({
      currentTurn: [
        { role: "user", text: "Write a parser." },
        { role: "assistant", text: "Working." },
      ],
      newMessage: "Handle tabs.",
    });
    expect(rows).toEqual(original);
  });
  it.each(
    [
      [],
      [{ ...source, idempotencyKey: "other:user" }],
      [{ ...source, display: false }],
      [{ ...source, __openclaw: { workContext: {} } }],
      [{ ...source, content: "x".repeat(12_001) }],
    ].map((rows) => ({ rows })),
  )("abstains rather than substituting or truncating an unusable source", ({ rows }) => {
    expect(projectAutoSteerEvidence(rows, "source", "Handle tabs.")).toBeUndefined();
  });
  it("does not forward oversized input or context", () => {
    expect(projectAutoSteerEvidence([source], "source", "x".repeat(8_001))).toBeUndefined();
    const evidence = projectAutoSteerEvidence(
      [source, { role: "assistant", content: "x".repeat(12_000) }],
      "source",
      "tabs",
    );
    expect(evidence?.currentTurn).toHaveLength(1);
  });
});
