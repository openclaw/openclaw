import { describe, expect, it } from "vitest";
import { AgentDefaultsSchema } from "./zod-schema.agent-defaults.js";
import { OpenClawSchema } from "./zod-schema.js";

describe("guard policy schema", () => {
  it("accepts guard taxonomy metadata on configured model entries", () => {
    expect(() =>
      AgentDefaultsSchema.parse({
        models: {
          "chutes/Qwen/Qwen3Guard": {
            guardTaxonomy: {
              labels: ["Safe", "Unsafe", "Controversial"],
              categories: ["Violent", "PII", "None"],
            },
          },
        },
      }),
    ).not.toThrow();
  });

  it("accepts per-path guard policy selections keyed by model ref", () => {
    expect(() =>
      OpenClawSchema.parse({
        agents: {
          defaults: {
            inputGuardPolicy: {
              "chutes/Qwen/Qwen3Guard": {
                enabledLabels: ["Unsafe"],
                enabledCategories: ["PII"],
              },
            },
            outputGuardPolicy: {
              "chutes/Qwen/Qwen3Guard": {
                enabledLabels: ["Controversial", "Unsafe"],
                enabledCategories: ["Violent"],
              },
            },
          },
        },
      }),
    ).not.toThrow();
  });
});
