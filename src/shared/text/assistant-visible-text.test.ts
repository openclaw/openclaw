import { describe, expect, it } from "vitest";
import { stripAssistantInternalScaffolding } from "./assistant-visible-text.js";

describe("stripAssistantInternalScaffolding", () => {
  it("strips reasoning tags", () => {
    const input = ["<thinking>", "secret", "</thinking>", "Visible"].join("\n");
    expect(stripAssistantInternalScaffolding(input)).toBe("Visible");
  });

  it("strips relevant-memories scaffolding blocks", () => {
    const input = [
      "<relevant-memories>",
      "The following memories may be relevant to this conversation:",
      "- Internal memory note",
      "</relevant-memories>",
      "",
      "User-visible answer",
    ].join("\n");
    expect(stripAssistantInternalScaffolding(input)).toBe("User-visible answer");
  });

  it("supports relevant_memories tag variants", () => {
    const input = [
      "<relevant_memories>",
      "Internal memory note",
      "</relevant_memories>",
      "Visible",
    ].join("\n");
    expect(stripAssistantInternalScaffolding(input)).toBe("Visible");
  });

  it("keeps relevant-memories tags inside fenced code", () => {
    const input = [
      "```xml",
      "<relevant-memories>",
      "sample",
      "</relevant-memories>",
      "```",
      "",
      "Visible text",
    ].join("\n");
    expect(stripAssistantInternalScaffolding(input)).toBe(input);
  });

  it("keeps relevant-memories tags inside inline code", () => {
    const input = "Use `<relevant-memories>example</relevant-memories>` literally.";
    expect(stripAssistantInternalScaffolding(input)).toBe(input);
  });

  it("hides unfinished relevant-memories blocks", () => {
    const input = ["Hello", "<relevant-memories>", "internal-only"].join("\n");
    expect(stripAssistantInternalScaffolding(input)).toBe("Hello\n");
  });

  it("trims leading whitespace after stripping scaffolding", () => {
    const input = [
      "<thinking>",
      "secret",
      "</thinking>",
      "   ",
      "<relevant-memories>",
      "internal note",
      "</relevant-memories>",
      "  Visible",
    ].join("\n");
    expect(stripAssistantInternalScaffolding(input)).toBe("Visible");
  });

  it("preserves unfinished reasoning text while still stripping memory blocks", () => {
    const input = [
      "Before",
      "<thinking>",
      "secret",
      "<relevant-memories>",
      "internal note",
      "</relevant-memories>",
      "After",
    ].join("\n");
    expect(stripAssistantInternalScaffolding(input)).toBe("Before\n\nsecret\n\nAfter");
  });
});
