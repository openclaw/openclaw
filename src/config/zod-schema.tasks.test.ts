import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("OpenClawSchema tasks config validation", () => {
  it("accepts a valid tasks block with retention and sweep interval", () => {
    expect(() =>
      OpenClawSchema.parse({
        tasks: {
          retentionMs: 86_400_000,
          sweepIntervalMs: 30_000,
        },
      }),
    ).not.toThrow();
  });

  it("accepts an empty tasks block (use defaults)", () => {
    expect(() => OpenClawSchema.parse({ tasks: {} })).not.toThrow();
  });

  it("accepts no tasks block at all (back-compat)", () => {
    expect(() => OpenClawSchema.parse({})).not.toThrow();
  });

  it("rejects negative retentionMs", () => {
    expect(() => OpenClawSchema.parse({ tasks: { retentionMs: -1 } })).toThrow();
  });

  it("rejects zero retentionMs", () => {
    expect(() => OpenClawSchema.parse({ tasks: { retentionMs: 0 } })).toThrow();
  });

  it("rejects negative sweepIntervalMs", () => {
    expect(() => OpenClawSchema.parse({ tasks: { sweepIntervalMs: -5 } })).toThrow();
  });

  it("rejects non-integer retentionMs", () => {
    expect(() => OpenClawSchema.parse({ tasks: { retentionMs: 1.5 } })).toThrow();
  });

  it("accepts sweepIntervalMs at the Node timer maximum (2^31 - 1)", () => {
    expect(() =>
      OpenClawSchema.parse({
        tasks: { sweepIntervalMs: 2_147_483_647 },
      }),
    ).not.toThrow();
  });

  it("rejects sweepIntervalMs above the Node timer maximum", () => {
    // Node coerces setInterval delays > 2^31 - 1 ms to 1 ms (TimeoutOverflowWarning).
    // Reject at config-load time instead of producing a busy maintenance loop.
    expect(() =>
      OpenClawSchema.parse({
        tasks: { sweepIntervalMs: 2_147_483_648 },
      }),
    ).toThrow();
  });

  it("rejects unknown keys (strict mode)", () => {
    expect(() => OpenClawSchema.parse({ tasks: { foo: "bar" } })).toThrow();
  });
});
