import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("OpenClawSchema gateway readiness validation", () => {
  it("accepts explicit required and advisory criteria", () => {
    expect(
      OpenClawSchema.safeParse({
        gateway: {
          readiness: {
            requiredCriteria: ["openclaw.workspace-writable", "plugin.storage.backend"],
            advisoryCriteria: ["plugin.metrics.exporter"],
          },
        },
      }).success,
    ).toBe(true);
  });

  it("rejects a criterion selected as both required and advisory", () => {
    expect(() =>
      OpenClawSchema.parse({
        gateway: {
          readiness: {
            requiredCriteria: ["plugin.storage.backend"],
            advisoryCriteria: ["plugin.storage.backend"],
          },
        },
      }),
    ).toThrow(/both required and advisory/i);
  });

  it("rejects selectors outside the reserved readiness namespaces", () => {
    expect(() =>
      OpenClawSchema.parse({
        gateway: {
          readiness: {
            requiredCriteria: ["ConfigLoaded"],
          },
        },
      }),
    ).toThrow(/namespaced openclaw.* or plugin.*/i);
  });

  it("bounds selector ids to the canonical wire limit", () => {
    const atLimit = `plugin.${"x".repeat(121)}`;
    const overLimit = `plugin.${"x".repeat(122)}`;

    expect(
      OpenClawSchema.safeParse({
        gateway: { readiness: { requiredCriteria: [atLimit] } },
      }).success,
    ).toBe(true);
    expect(
      OpenClawSchema.safeParse({
        gateway: { readiness: { requiredCriteria: [overLimit] } },
      }).success,
    ).toBe(false);
  });
});
