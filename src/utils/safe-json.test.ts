import { describe, expect, it } from "vitest";
import { safeJsonStringify } from "./safe-json.js";

describe("safeJsonStringify", () => {
  it("serializes circular references without throwing", () => {
    const payload: Record<string, unknown> = { type: "tool.result" };
    payload.self = payload;

    expect(safeJsonStringify(payload)).toBe('{"type":"tool.result","self":"[Circular]"}');
  });

  it("normalizes nested errors before serializing", () => {
    const payload: Record<string, unknown> = { error: new Error("boom") };
    payload.self = payload;

    expect(JSON.parse(safeJsonStringify(payload) ?? "null")).toMatchObject({
      error: {
        name: "Error",
        message: "boom",
      },
      self: "[Circular]",
    });
  });
});
