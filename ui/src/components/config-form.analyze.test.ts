// UI tests cover config-form schema analysis for union nodes (issue #143646).
import { describe, expect, it } from "vitest";
import { analyzeConfigSchema } from "./config-form.analyze.ts";

describe("analyzeConfigSchema mixed literal unions", () => {
  it("keeps a string + literal(false) union renderable instead of unsupported", () => {
    // cron.sessionRetention is authored as union([string(), literal(false)]).
    const analysis = analyzeConfigSchema({
      type: "object",
      properties: {
        cron: {
          type: "object",
          properties: {
            sessionRetention: {
              anyOf: [{ type: "string" }, { type: "boolean", const: false }],
              title: "Automations Session Retention",
            },
          },
        },
      },
    });

    expect(analysis.unsupportedPaths).not.toContain("cron.sessionRetention");
    expect(analysis.schema).not.toBeNull();
  });

  it("keeps a string + literal(true) union renderable (same failure class)", () => {
    const analysis = analyzeConfigSchema({
      type: "object",
      properties: {
        test2: {
          anyOf: [{ type: "string" }, { type: "boolean", const: true }],
        },
      },
    });

    expect(analysis.unsupportedPaths).not.toContain("test2");
  });

  it("still routes literal + non-scalar branches to Raw mode", () => {
    const analysis = analyzeConfigSchema({
      type: "object",
      properties: {
        weird: {
          anyOf: [{ const: "preset" }, { type: "array", items: { type: "string" } }],
        },
      },
    });

    expect(analysis.unsupportedPaths).toContain("weird");
  });
});
