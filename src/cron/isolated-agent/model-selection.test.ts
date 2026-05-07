import { describe, expect, it } from "vitest";
import { formatCronPayloadModelRejection } from "./model-selection.js";

describe("formatCronPayloadModelRejection", () => {
  it("produces a non-tautological message when model key equals model override", () => {
    const msg = formatCronPayloadModelRejection(
      "anthropic/claude-haiku-4-5",
      "model not allowed: anthropic/claude-haiku-4-5",
    );
    expect(msg).toContain("is not in the agents.defaults.models allowlist");
    expect(msg).not.toMatch(/allowlist: anthropic\/claude-haiku-4-5/);
  });

  it("includes resolved key in parens when it differs from the raw override", () => {
    const msg = formatCronPayloadModelRejection(
      "haiku",
      "model not allowed: anthropic/claude-haiku-4-5",
    );
    expect(msg).toContain("(resolved: 'anthropic/claude-haiku-4-5')");
    expect(msg).toContain("is not in the agents.defaults.models allowlist");
  });

  it("appends allowed model keys when provided", () => {
    const msg = formatCronPayloadModelRejection(
      "anthropic/claude-haiku-4-5",
      "model not allowed: anthropic/claude-haiku-4-5",
      ["claude-cli/claude-haiku-4-5", "openai-codex/gpt-5.3-codex-spark"],
    );
    expect(msg).toContain("Allowed: claude-cli/claude-haiku-4-5, openai-codex/gpt-5.3-codex-spark");
  });

  it("omits allowed section when no keys provided", () => {
    const msg = formatCronPayloadModelRejection(
      "anthropic/claude-haiku-4-5",
      "model not allowed: anthropic/claude-haiku-4-5",
      [],
    );
    expect(msg).not.toContain("Allowed:");
  });

  it("falls through to generic format for non-allowlist errors", () => {
    const msg = formatCronPayloadModelRejection("bad-model", "invalid model: bad-model");
    expect(msg).toContain("rejected: invalid model: bad-model");
  });
});
