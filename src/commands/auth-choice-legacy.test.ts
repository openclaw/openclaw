import { describe, expect, it } from "vitest";
import { isDeprecatedAuthChoice, normalizeLegacyOnboardAuthChoice } from "./auth-choice-legacy.js";

describe("normalizeLegacyOnboardAuthChoice", () => {
  it("maps oauth to setup-token", () => {
    expect(normalizeLegacyOnboardAuthChoice("oauth")).toBe("setup-token");
  });

  it("maps claude-cli to claude-code-cli", () => {
    expect(normalizeLegacyOnboardAuthChoice("claude-cli")).toBe("claude-code-cli");
  });

  it("maps codex-cli to openai-codex", () => {
    expect(normalizeLegacyOnboardAuthChoice("codex-cli")).toBe("openai-codex");
  });

  it("keeps non-legacy choices unchanged", () => {
    expect(normalizeLegacyOnboardAuthChoice("claude-code-cli")).toBe("claude-code-cli");
    expect(normalizeLegacyOnboardAuthChoice("token")).toBe("token");
  });
});

describe("isDeprecatedAuthChoice", () => {
  it("still marks claude-cli and codex-cli as deprecated aliases", () => {
    expect(isDeprecatedAuthChoice("claude-cli")).toBe(true);
    expect(isDeprecatedAuthChoice("codex-cli")).toBe(true);
  });

  it("does not mark current choices as deprecated", () => {
    expect(isDeprecatedAuthChoice("claude-code-cli")).toBe(false);
    expect(isDeprecatedAuthChoice("token")).toBe(false);
  });
});
