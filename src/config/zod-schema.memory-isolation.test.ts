import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("OpenClawSchema memory.isolation validation", () => {
  it("accepts memory.isolation with full options", () => {
    const parsed = OpenClawSchema.parse({
      memory: {
        backend: "builtin",
        isolation: {
          enabled: true,
          scope: "user",
          fallbackPolicy: "deny",
          pathEncoding: "hash",
        },
      },
    });
    expect(parsed.memory?.isolation?.enabled).toBe(true);
    expect(parsed.memory?.isolation?.scope).toBe("user");
    expect(parsed.memory?.isolation?.fallbackPolicy).toBe("deny");
    expect(parsed.memory?.isolation?.pathEncoding).toBe("hash");
  });

  it("accepts memory.isolation with only enabled flag", () => {
    expect(() =>
      OpenClawSchema.parse({
        memory: {
          isolation: { enabled: false },
        },
      }),
    ).not.toThrow();
  });

  it("applies defaults when isolation fields omitted", () => {
    const parsed = OpenClawSchema.parse({
      memory: {
        isolation: {},
      },
    });
    expect(parsed.memory?.isolation?.enabled).toBe(true);
    expect(parsed.memory?.isolation?.scope).toBe("user");
    expect(parsed.memory?.isolation?.fallbackPolicy).toBe("deny");
    expect(parsed.memory?.isolation?.pathEncoding).toBe("hash");
  });

  it("rejects unknown isolation keys (strict)", () => {
    expect(() =>
      OpenClawSchema.parse({
        memory: {
          isolation: { enabled: true, bogus: 1 },
        },
      }),
    ).toThrow();
  });

  it("rejects invalid scope value", () => {
    expect(() =>
      OpenClawSchema.parse({
        memory: {
          isolation: { scope: "tenant-bogus" },
        },
      }),
    ).toThrow(/scope|enum/i);
  });

  it("rejects invalid fallbackPolicy value", () => {
    expect(() =>
      OpenClawSchema.parse({
        memory: {
          isolation: { fallbackPolicy: "permit-all" },
        },
      }),
    ).toThrow(/fallbackPolicy|enum/i);
  });

  it("rejects invalid pathEncoding value", () => {
    expect(() =>
      OpenClawSchema.parse({
        memory: {
          isolation: { pathEncoding: "raw" },
        },
      }),
    ).toThrow(/pathEncoding|enum/i);
  });

  it("rejects non-boolean enabled", () => {
    expect(() =>
      OpenClawSchema.parse({
        memory: {
          isolation: { enabled: "yes" },
        },
      }),
    ).toThrow();
  });

  it("memory remains optional when omitted", () => {
    expect(() => OpenClawSchema.parse({})).not.toThrow();
  });
});
