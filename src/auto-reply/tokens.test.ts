/** Tests silent-reply and heartbeat token parsing helpers. */
import { describe, it, expect } from "vitest";
import { isInternalFormattingArtifact } from "./tokens.js";

describe("isInternalFormattingArtifact", () => {
  it("matches Harmony channel markers (#88128)", () => {
    expect(isInternalFormattingArtifact("  <channel|>  ")).toBe(true);
    expect(isInternalFormattingArtifact("<channel|answer>")).toBe(true);
    expect(isInternalFormattingArtifact("<lane|reasoning>")).toBe(true);
    expect(isInternalFormattingArtifact("<|>")).toBe(true);
    expect(isInternalFormattingArtifact("<|channel|>")).toBe(true);
    expect(isInternalFormattingArtifact("set-thought <lane|reasoning>")).toBe(true);
  });

  it("matches box-drawing HR separators (#88128)", () => {
    expect(isInternalFormattingArtifact("  ───  ")).toBe(true);
  });

  it("returns false for undefined/empty", () => {
    expect(isInternalFormattingArtifact(undefined)).toBe(false);
    expect(isInternalFormattingArtifact("")).toBe(false);
  });

  it("returns false for text that merely contains an artifact pattern", () => {
    expect(isInternalFormattingArtifact("Here are the options:\n───\n1. Option A")).toBe(false);
    expect(isInternalFormattingArtifact("Use <channel|> in your config.")).toBe(false);
    expect(isInternalFormattingArtifact("The set-thought mechanism works like this...")).toBe(
      false,
    );
  });
});
