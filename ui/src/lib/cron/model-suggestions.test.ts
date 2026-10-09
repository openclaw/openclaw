// @vitest-environment node
import { describe, expect, it } from "vitest";
import { resolveConfiguredCronModelSuggestions } from "./model-suggestions.ts";

describe("cron model suggestions", () => {
  it("collects, deduplicates, and sorts configured models", () => {
    expect(
      resolveConfiguredCronModelSuggestions({
        agents: {
          defaults: {
            model: { primary: "p/b", fallbacks: ["p/c", "p/d"] },
            models: { "p/a": {}, "p/b": {} },
          },
          entries: {
            writer: { model: { primary: "p/f", fallbacks: ["p/d"] } },
            planner: { model: "p/e" },
          },
        },
      }),
    ).toEqual(["p/a", "p/b", "p/c", "p/d", "p/e", "p/f"]);
  });

  it("returns no configured model suggestions for invalid or missing config", () => {
    expect(resolveConfiguredCronModelSuggestions(null)).toStrictEqual([]);
    expect(resolveConfiguredCronModelSuggestions({})).toStrictEqual([]);
    expect(
      resolveConfiguredCronModelSuggestions({ agents: { defaults: { model: "" } } }),
    ).toStrictEqual([]);
  });
});
