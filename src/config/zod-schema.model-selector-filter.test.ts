import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("OpenClawSchema modelSelector.filter validation", () => {
  const validFilters = ["all", "authenticated", "configured"] as const;

  it.each(validFilters)('accepts filter value "%s"', (filter) => {
    expect(() =>
      OpenClawSchema.parse({
        gateway: {
          controlUi: {
            modelSelector: { filter },
          },
        },
      }),
    ).not.toThrow();
  });

  it("accepts modelSelector without filter (optional)", () => {
    expect(() =>
      OpenClawSchema.parse({
        gateway: {
          controlUi: {
            modelSelector: {},
          },
        },
      }),
    ).not.toThrow();
  });

  it("accepts gateway.controlUi without modelSelector", () => {
    expect(() =>
      OpenClawSchema.parse({
        gateway: {
          controlUi: {
            enabled: true,
          },
        },
      }),
    ).not.toThrow();
  });

  it("default is undefined (falls back to 'all' in handler)", () => {
    const parsed = OpenClawSchema.parse({
      gateway: {
        controlUi: {
          modelSelector: {},
        },
      },
    });
    expect(parsed.gateway?.controlUi?.modelSelector?.filter).toBeUndefined();
  });

  const invalidFilters = [
    { label: "arbitrary string", value: "foo" },
    { label: "regex pattern", value: "regex:.*" },
    { label: "empty string", value: "" },
    { label: "number", value: 42 },
    { label: "boolean", value: true },
    { label: "null", value: null },
  ];

  it.each(invalidFilters)("rejects invalid filter value: $label", ({ value }) => {
    expect(() =>
      OpenClawSchema.parse({
        gateway: {
          controlUi: {
            modelSelector: { filter: value },
          },
        },
      }),
    ).toThrow();
  });

  it("rejects unknown keys in modelSelector (strict mode)", () => {
    expect(() =>
      OpenClawSchema.parse({
        gateway: {
          controlUi: {
            modelSelector: { filter: "all", unknownKey: true },
          },
        },
      }),
    ).toThrow();
  });
});
