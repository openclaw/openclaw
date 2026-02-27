import { describe, expect, it } from "vitest";
import { normalizeBrowserFormField } from "./form-fields.js";

describe("normalizeBrowserFormField", () => {
  it("rejects non-primitive values", () => {
    expect(() => normalizeBrowserFormField({ ref: "e1", value: { text: "hi" } })).toThrow(
      /must be a string, number, or boolean/i,
    );
  });
});
