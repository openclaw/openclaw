import { describe, expect, test } from "vitest";
import { sanitizeModelOutput } from "./send.shared.js";

describe("sanitizeModelOutput", () => {
  test("removes Gemini <think> blocks", () => {
    const input = "Hello\n<think>Let me calculate this...</think>\nThe answer is 42";
    const expected = "Hello\n\nThe answer is 42";
    expect(sanitizeModelOutput(input)).toBe(expected);
  });

  test("removes Thought: blocks", () => {
    const input = "Here's my response:\n\nThought: I need to check the docs\n\nThe docs say...";
    const expected = "Here's my response:\n\nThe docs say...";
    expect(sanitizeModelOutput(input)).toBe(expected);
  });

  test("removes Thinking... markers", () => {
    const input = "Thinking... Let me figure this out. Yes, it works.";
    const expected = "Let me figure this out. Yes, it works.";
    expect(sanitizeModelOutput(input)).toBe(expected);
  });

  test("removes [thinking] brackets", () => {
    const input = "My response: [thinking] Processing... The result is X";
    const expected = "My response: Processing... The result is X";
    expect(sanitizeModelOutput(input)).toBe(expected);
  });

  test("removes (thinking) parentheses", () => {
    const input = "Answer: (thinking) hmm yes The solution is Y";
    const expected = "Answer: hmm yes The solution is Y";
    expect(sanitizeModelOutput(input)).toBe(expected);
  });

  test("collapses multiple blank lines", () => {
    const input = "Line 1\n\n\n\nLine 2";
    const expected = "Line 1\n\nLine 2";
    expect(sanitizeModelOutput(input)).toBe(expected);
  });

  test("protects legitimate 'thinking' in sentences", () => {
    const input = "Thinking outside the box is important. The solution works.";
    const expected = "Thinking outside the box is important. The solution works.";
    expect(sanitizeModelOutput(input)).toBe(expected);
  });

  test("returns empty for reasoning-only content", () => {
    const input = "<think>Just thinking...</think>";
    const expected = "";
    expect(sanitizeModelOutput(input)).toBe(expected);
  });

  test("handles complex real-world example", () => {
    const input = `<think>
The user is asking about Discord integration. Let me think about this:
1. The API endpoint is /api/v10/channels/{id}/messages
2. The limit is 2000 characters
3. I need to handle embeds

Actually, let me reconsider...
</think>

To send a Discord message:
1. Create a REST client
2. Use the API endpoint
3. Send the message`;
    const expected =
      "To send a Discord message:\n1. Create a REST client\n2. Use the API endpoint\n3. Send the message";
    expect(sanitizeModelOutput(input)).toBe(expected);
  });
});
