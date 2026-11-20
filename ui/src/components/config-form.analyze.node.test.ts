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
});
