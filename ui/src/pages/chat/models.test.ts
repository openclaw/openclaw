// Control UI tests cover models behavior.
import { describe, expect, it } from "vitest";
import { applyModelCatalogResult } from "./models.ts";

describe("applyModelCatalogResult", () => {
  it("preserves availability from metadata results", () => {
    expect(
      applyModelCatalogResult([
        {
          id: "gpt-5.5",
          name: "GPT-5.5",
          provider: "openai",
          available: true,
        },
        {
          id: "gpt-5.3-codex-spark",
          name: "GPT-5.3 Codex Spark",
          provider: "codex",
          available: false,
        },
      ]),
    ).toEqual([
      {
        id: "gpt-5.5",
        name: "GPT-5.5",
        provider: "openai",
        available: true,
      },
      {
        id: "gpt-5.3-codex-spark",
        name: "GPT-5.3 Codex Spark",
        provider: "codex",
        available: false,
      },
    ]);
  });
});
