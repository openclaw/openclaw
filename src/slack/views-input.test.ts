import { describe, expect, it } from "vitest";
import { parseSlackModalViewInput } from "./views-input.js";

describe("parseSlackModalViewInput", () => {
  it("accepts modal objects", () => {
    expect(
      parseSlackModalViewInput({
        type: "modal",
        callback_id: "openclaw:test",
      }),
    ).toEqual({
      type: "modal",
      callback_id: "openclaw:test",
    });
  });

  it("accepts modal JSON strings", () => {
    expect(
      parseSlackModalViewInput(
        JSON.stringify({
          type: "modal",
          callback_id: "openclaw:test",
        }),
      ),
    ).toEqual({
      type: "modal",
      callback_id: "openclaw:test",
    });
  });

  it("rejects invalid JSON strings", () => {
    expect(() => parseSlackModalViewInput("{bad-json")).toThrow(/valid json/i);
  });

  it("rejects non-object values", () => {
    expect(() => parseSlackModalViewInput("42")).toThrow(/must be an object/i);
  });

  it("rejects views without a type", () => {
    expect(() => parseSlackModalViewInput({ callback_id: "openclaw:test" })).toThrow(
      /view\.type is required/i,
    );
  });

  it("rejects non-modal view types", () => {
    expect(() =>
      parseSlackModalViewInput({
        type: "home",
        callback_id: "openclaw:test",
      }),
    ).toThrow(/view\.type must be modal/i);
  });
});
