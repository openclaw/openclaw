import { describe, expect, it, vi } from "vitest";
import { visitObjectContentBlocks } from "./message-content-blocks.js";

describe("visitObjectContentBlocks", () => {
  it("does not visit when message is null", () => {
    const visitor = vi.fn();
    visitObjectContentBlocks(null, visitor);
    expect(visitor).not.toHaveBeenCalled();
  });

  it("does not visit when message is undefined", () => {
    const visitor = vi.fn();
    visitObjectContentBlocks(undefined, visitor);
    expect(visitor).not.toHaveBeenCalled();
  });

  it("does not visit when message is a string", () => {
    const visitor = vi.fn();
    visitObjectContentBlocks("hello", visitor);
    expect(visitor).not.toHaveBeenCalled();
  });

  it("does not visit when message is a number", () => {
    const visitor = vi.fn();
    visitObjectContentBlocks(42, visitor);
    expect(visitor).not.toHaveBeenCalled();
  });

  it("does not visit when message has no content property", () => {
    const visitor = vi.fn();
    visitObjectContentBlocks({ role: "user" }, visitor);
    expect(visitor).not.toHaveBeenCalled();
  });

  it("does not visit when content is not an array", () => {
    const visitor = vi.fn();
    visitObjectContentBlocks({ content: "plain text" }, visitor);
    expect(visitor).not.toHaveBeenCalled();
  });

  it("visits each object block in the content array", () => {
    const visitor = vi.fn();
    visitObjectContentBlocks(
      {
        content: [
          { type: "text", text: "hello" },
          { type: "image", url: "x" },
        ],
      },
      visitor,
    );
    expect(visitor).toHaveBeenCalledTimes(2);
    expect(visitor).toHaveBeenNthCalledWith(1, { type: "text", text: "hello" });
    expect(visitor).toHaveBeenNthCalledWith(2, { type: "image", url: "x" });
  });

  it("skips non-object entries in the content array", () => {
    const visitor = vi.fn();
    visitObjectContentBlocks(
      { content: ["not-an-object", null, { type: "text", text: "ok" }, 123] },
      visitor,
    );
    expect(visitor).toHaveBeenCalledTimes(1);
    expect(visitor).toHaveBeenCalledWith({ type: "text", text: "ok" });
  });

  it("returns undefined (void)", () => {
    const visitor = vi.fn();
    const result = visitObjectContentBlocks({ content: [{ type: "text", text: "x" }] }, visitor);
    expect(result).toBeUndefined();
  });

  it("handles empty content array", () => {
    const visitor = vi.fn();
    visitObjectContentBlocks({ content: [] }, visitor);
    expect(visitor).not.toHaveBeenCalled();
  });
});
