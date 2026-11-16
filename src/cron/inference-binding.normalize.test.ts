import { describe, expect, it } from "vitest";
import { normalizeCronInferenceBinding } from "./inference-binding.js";

const binding = {
  version: 1 as const,
  provider: "anthropic",
  profileId: "anthropic:manual",
  authorizationId: "a".repeat(64),
  authRequirement: "subscription" as const,
  source: "user" as const,
};

describe("cron inference binding runtime", () => {
  it("keeps a captured runtime and accepts bindings recorded before it", () => {
    expect(normalizeCronInferenceBinding({ ...binding, runtime: "claude-cli" })).toEqual({
      ...binding,
      runtime: "claude-cli",
    });
    expect(normalizeCronInferenceBinding(binding)).toEqual(binding);
    expect(() => normalizeCronInferenceBinding({ ...binding, runtime: " " })).toThrow(
      /Invalid automation inference binding/,
    );
  });
});
