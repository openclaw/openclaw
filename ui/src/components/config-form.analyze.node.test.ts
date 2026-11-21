import { describe, expect, it } from "vitest";
import { analyzeConfigSchema } from "./config-form.analyze.ts";

describe("analyzeConfigSchema", () => {
  it("keeps provider-pattern model maps editable in form mode", () => {
    // Regression: bundled providers (e.g. vLLM) contribute patternProperties to the
    // models map schema; the keyword only refines matching entries and must not push
    // the whole map into Raw mode.
    const analysis = analyzeConfigSchema({
      type: "object",
      properties: {
        models: {
          type: "object",
          propertyNames: { type: "string" },
          additionalProperties: {
            type: "object",
            properties: { alias: { type: "string" } },
            additionalProperties: false,
          },
          patternProperties: {
            "^vllm/.+$": {
              type: "object",
              properties: {
                params: {
                  type: "object",
                  properties: { priorityScheduling: { type: "boolean" } },
                },
              },
            },
          },
        },
      },
    });
    expect(analysis.unsupportedPaths).toEqual([]);
  });

  it("keeps the Raw-mode fallback for pattern-only object maps", () => {
    // Counterexample from the knowledge plugin stores schema: patternProperties with
    // additionalProperties:false defines every entry through the pattern, which the
    // map editor cannot render; the node must stay unsupported (#202730 review).
    const analysis = analyzeConfigSchema({
      type: "object",
      properties: {
        stores: {
          type: "object",
          additionalProperties: false,
          patternProperties: {
            "^[a-z0-9-]+$": {
              type: "object",
              properties: { agents: { type: "array", items: { type: "string" } } },
            },
          },
        },
      },
    });
    expect(analysis.unsupportedPaths).toEqual(["stores"]);
  });

  it("admits pattern-refined maps whose named properties stay editable", () => {
    const analysis = analyzeConfigSchema({
      type: "object",
      properties: {
        models: {
          type: "object",
          properties: { default: { type: "string" } },
          additionalProperties: false,
          patternProperties: { "^vllm/.+$": { type: "string" } },
        },
      },
    });
    expect(analysis.unsupportedPaths).toEqual([]);
  });
});
