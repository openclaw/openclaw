import { describe, expect, it } from "vitest";
import { summarizeResult } from "./channel-shared.js";

describe("summarizeResult", () => {
  it("returns count-only text when no data is provided", () => {
    const result = summarizeResult("messages", 3);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toBe("messages: 3");
  });

  it("includes serialized data in text when data is provided", () => {
    const data = [{ id: "a", role: "user", content: "hello" }];
    const result = summarizeResult("messages", 1, data);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toContain("messages: 1");
    expect(result.content[0].text).toContain('"id": "a"');
    expect(result.content[0].text).toContain('"role": "user"');
  });

  it("handles empty array data", () => {
    const result = summarizeResult("messages", 0, []);
    expect(result.content[0].text).toBe("messages: 0\n[]");
  });

  it("handles undefined data same as no-data", () => {
    const result = summarizeResult("events", 5, undefined);
    expect(result.content[0].text).toBe("events: 5");
  });
});
