import { describe, expect, it } from "vitest";
import {
  sanitizeAssistantForDelivery,
  sanitizeAssistantTextForDelivery,
} from "./assistant-delivery-sanitizer.js";

describe("sanitizeAssistantForDelivery", () => {
  it("strips assistant tagged thinking when thinking is off", () => {
    expect(sanitizeAssistantTextForDelivery("<think>hidden</think>Visible")).toBe("Visible");
  });

  it("preserves assistant tagged thinking when thinking is enabled", () => {
    expect(
      sanitizeAssistantTextForDelivery("<think>hidden</think>Visible", {
        thinkingEnabled: true,
      }),
    ).toBe("<think>hidden</think>Visible");
  });

  it("does not sanitize non-assistant literal examples", () => {
    expect(
      sanitizeAssistantTextForDelivery("<think>example</think>", {
        role: "user",
      }),
    ).toBe("<think>example</think>");
  });

  it("drops reasoning-only outbound payloads", () => {
    expect(sanitizeAssistantForDelivery({ text: "Reasoning:\n_private step_" })).toBeNull();
    expect(sanitizeAssistantForDelivery({ text: "private step", isReasoning: true })).toBeNull();
  });

  it("preserves blank text when payload metadata has channel content", () => {
    expect(sanitizeAssistantForDelivery({ text: " \n\t ", channelData: { mode: "flex" } })).toEqual(
      {
        text: " \n\t ",
        channelData: { mode: "flex" },
      },
    );
  });

  it("preserves final answer content from mixed structured reasoning", () => {
    expect(
      sanitizeAssistantForDelivery({
        text: "Reasoning:\n_private step_\n\nFinal answer:\nVisible answer",
      }),
    ).toEqual({ text: "Visible answer" });
  });

  it("does not alter tagged thinking inside fenced code blocks", () => {
    expect(
      sanitizeAssistantTextForDelivery(
        "```xml\n<think>example</think>\n```\n<think>hidden</think>Visible",
      ),
    ).toBe("```xml\n<think>example</think>\n```\nVisible");
  });
});
