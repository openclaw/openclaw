import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("OpenClawSchema talk validation", () => {
  it("accepts a positive integer talk.silenceTimeoutMs", () => {
    expect(() =>
      OpenClawSchema.parse({
        talk: {
          silenceTimeoutMs: 1500,
        },
      }),
    ).not.toThrow();
  });

  it.each([
    ["boolean", true],
    ["string", "1500"],
    ["float", 1500.5],
  ])("rejects %s talk.silenceTimeoutMs", (_label, value) => {
    expect(() =>
      OpenClawSchema.parse({
        talk: {
          silenceTimeoutMs: value,
        },
      }),
    ).toThrow(/silenceTimeoutMs|number|integer/i);
  });
});
