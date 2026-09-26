import { describe, expect, it } from "vitest";
import { normalizeReplyPayloadOutcome } from "./normalize-reply.js";

const invocation = '<invoke name="example"><parameter name="value">a</parameter></invoke>';

describe("reply normalization of tool-call XML", () => {
  it.each([
    invocation,
    `<function_calls>${invocation}</function_calls>`,
    '<antml:invoke name="example"><antml:parameter name="value">a</antml:parameter></antml:invoke>',
  ])("suppresses a complete artifact with no user-facing content: %s", (text) => {
    expect(normalizeReplyPayloadOutcome({ text })).toMatchObject({ kind: "suppress" });
  });

  it("does not consume the answer between two invocations", () => {
    const result = normalizeReplyPayloadOutcome({
      text: `${invocation}The answer is 42.${invocation}`,
    });
    expect(result).toMatchObject({ kind: "deliver" });
    if (result.kind !== "deliver") {
      throw new Error("the answer was suppressed with tool markup");
    }
    expect(result.payload.text).toContain("The answer is 42.");
  });

  it.each([
    `    ${invocation}`,
    `\t${invocation}`,
    `\`\`\`xml\n${invocation}\n\`\`\``,
    `\`${invocation}\``,
  ])("preserves literal Markdown code: %s", (text) => {
    expect(normalizeReplyPayloadOutcome({ text })).toEqual({
      kind: "deliver",
      payload: { text },
    });
  });

  it.each([
    { mediaUrl: "https://example.test/image.png" },
    { presentation: { blocks: [{ type: "text" as const, text: "Visible card content" }] } },
  ])("clears artifact text without dropping non-text content: %j", (content) => {
    const input = { text: invocation, ...content };
    expect(normalizeReplyPayloadOutcome(input)).toEqual({
      kind: "deliver",
      payload: { ...content, text: "" },
    });
    expect(input.text).toBe(invocation);
  });
});
