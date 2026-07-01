// Tests for FormData detection helper.
import { describe, expect, it } from "vitest";
import { isFormDataLike } from "./form-data.js";

describe("isFormDataLike", () => {
  it("returns false for null", () => {
    expect(isFormDataLike(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isFormDataLike(undefined)).toBe(false);
  });

  it("returns false for plain object", () => {
    expect(isFormDataLike({})).toBe(false);
  });

  it("returns false for string", () => {
    expect(isFormDataLike("form-data")).toBe(false);
  });

  it("returns false for object with entries", () => {
    expect(isFormDataLike({ entries: () => {} })).toBe(false);
  });

  it("returns false for non-FormData with toStringTag", () => {
    const obj = {
      entries: () => {},
      [Symbol.toStringTag]: "NotFormData",
    };
    expect(isFormDataLike(obj)).toBe(false);
  });
});
