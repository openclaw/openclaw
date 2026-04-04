import { describe, expect, it } from "vitest";
import { resolveEffectivePromptConfig } from "./system-prompt-config.js";

describe("resolveEffectivePromptConfig", () => {
  it("applies custom sections on full prompts", () => {
    expect(
      resolveEffectivePromptConfig({
        baseMode: "full",
        override: {
          mode: "custom",
          sections: ["tooling", "runtime"],
        },
      }),
    ).toEqual({
      mode: "custom",
      sections: ["tooling", "runtime"],
    });
  });

  it("respects explicit non-custom overrides on minimal prompts", () => {
    expect(
      resolveEffectivePromptConfig({
        baseMode: "minimal",
        override: {
          mode: "none",
        },
      }),
    ).toEqual({
      mode: "none",
    });

    expect(
      resolveEffectivePromptConfig({
        baseMode: "minimal",
        override: {
          mode: "full",
        },
      }),
    ).toEqual({
      mode: "full",
    });
  });

  it("ignores per-agent custom overrides for minimal prompts", () => {
    expect(
      resolveEffectivePromptConfig({
        baseMode: "minimal",
        override: {
          mode: "custom",
          sections: ["tooling", "runtime"],
        },
      }),
    ).toEqual({
      mode: "minimal",
    });
  });
});
