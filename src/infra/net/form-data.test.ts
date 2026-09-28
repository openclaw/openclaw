import { describe, expect, it } from "vitest";
import { isFormDataLike } from "./form-data.js";

describe("isFormDataLike", () => {
  it.each([
    { name: "null", value: null },
    { name: "string", value: "form-data" },
    {
      name: "tag only",
      value: { [Symbol.toStringTag]: "FormData" },
    },
    {
      name: "wrong tag",
      value: { entries: () => {}, [Symbol.toStringTag]: "NotFormData" },
    },
  ])("rejects $name", ({ value }) => {
    expect(isFormDataLike(value)).toBe(false);
  });
});
