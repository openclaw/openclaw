import { describe, expect, it } from "vitest";
import { normalizeReplyPayload } from "./normalize-reply.js";

describe("normalizeReplyPayload", () => {
  it("strips <relevant-memories> scaffolding from reply text", () => {
    const result = normalizeReplyPayload({
      text: "<relevant-memories>\n1. [personal] likes coffee\n</relevant-memories>\nHere is my answer.",
    });
    expect(result).not.toBeNull();
    expect(result!.text).toBe("\nHere is my answer.");
  });

  it("strips <relevant_memories> (underscore variant) from reply text", () => {
    const result = normalizeReplyPayload({
      text: "<relevant_memories>\ndata\n</relevant_memories>\nActual reply.",
    });
    expect(result).not.toBeNull();
    expect(result!.text).toBe("\nActual reply.");
  });

  it("passes through text without relevant-memories tags unchanged", () => {
    const result = normalizeReplyPayload({ text: "Hello world" });
    expect(result).not.toBeNull();
    expect(result!.text).toBe("Hello world");
  });

  it("returns null for empty text after stripping", () => {
    const result = normalizeReplyPayload({
      text: "<relevant-memories>\nonly memory\n</relevant-memories>",
    });
    expect(result).toBeNull();
  });
});
