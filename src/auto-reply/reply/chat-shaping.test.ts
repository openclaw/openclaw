import { describe, expect, it } from "vitest";
import { buildChatShapingNote, shouldApplyChatShaping } from "./chat-shaping.js";

describe("chat shaping guidance", () => {
  it("applies to short conversational follow-ups", () => {
    expect(shouldApplyChatShaping({ userText: "これどうなってる？" })).toBe(true);
    expect(shouldApplyChatShaping({ userText: "お願い！" })).toBe(true);
  });

  it("does not apply to clearly structured-output requests", () => {
    expect(shouldApplyChatShaping({ userText: "JSONで出して" })).toBe(false);
    expect(shouldApplyChatShaping({ userText: "箇条書きで手順をください" })).toBe(false);
  });

  it("does not apply to dense technical payloads", () => {
    expect(shouldApplyChatShaping({ userText: "```ts\nconst x = 1\n```" })).toBe(false);
    expect(shouldApplyChatShaping({ userText: "stack trace を見て" })).toBe(false);
  });

  it("can apply when nearby thread context exists", () => {
    expect(
      shouldApplyChatShaping({
        userText: "進捗どう",
        threadHistoryBody: "直前にPRの文面修正をしていた",
      }),
    ).toBe(true);
  });

  it("does not apply to admin-style status requests", () => {
    expect(shouldApplyChatShaping({ userText: "状況を要約して" })).toBe(false);
    expect(shouldApplyChatShaping({ userText: "status recap" })).toBe(false);
  });

  it("does not apply broadly in groups without nearby context", () => {
    expect(
      shouldApplyChatShaping({
        userText: "これどう？",
        isGroupChat: true,
      }),
    ).toBe(false);
  });

  it("builds a bounded shaping note", () => {
    const note = buildChatShapingNote({
      userText: "これどうなってる？",
      replyToBody: "proposalの文面を修正中",
    });

    expect(note).toContain("[Chat shaping guidance]");
    expect(note).toContain("respond before explaining");
    expect(note).toContain("Use bullets or headings only if they materially improve clarity");
    expect(note).toContain("bounded under the user's existing intent");
  });
});
