import { describe, expect, it } from "vitest";
import { stripImageData } from "./sessions-helpers.js";

describe("stripImageData", () => {
  it("strips base64 data from image blocks", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "Check this image" },
          { type: "image", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" },
        ],
      },
    ];
    
    const result = stripImageData(messages);
    
    expect(result).toHaveLength(1);
    const content = (result[0] as { content: unknown[] }).content;
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({ type: "text", text: "Check this image" });
    expect((content[1] as { data: string }).data).toBe("[base64 image data stripped]");
    expect((content[1] as { _strippedBytes: number })._strippedBytes).toBeGreaterThan(0);
  });

  it("handles source.data format", () => {
    const messages = [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/jpeg",
              data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
            },
          },
        ],
      },
    ];
    
    const result = stripImageData(messages);
    
    const content = (result[0] as { content: unknown[] }).content;
    const source = (content[0] as { source: { data: string; _strippedBytes: number } }).source;
    expect(source.data).toBe("[base64 image data stripped]");
    expect(source._strippedBytes).toBeGreaterThan(0);
  });

  it("preserves messages without images", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      { role: "assistant", content: [{ type: "text", text: "Hi there" }] },
    ];
    
    const result = stripImageData(messages);
    
    expect(result).toEqual(messages);
  });

  it("handles empty and malformed messages", () => {
    const messages = [null, undefined, {}, { role: "user" }, { role: "user", content: "not an array" }];
    
    const result = stripImageData(messages as unknown[]);
    
    expect(result).toHaveLength(5);
  });
});
