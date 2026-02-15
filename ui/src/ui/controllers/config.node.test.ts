import { describe, expect, it } from "vitest";
import { formatUiError } from "./config.ts";

describe("formatUiError", () => {
  it("serializes object errors to JSON", () => {
    const msg = formatUiError({
      action: "config.set",
      errors: [{ path: "models.providers.openai.models.0.maxTokens", message: "expected number" }],
    });
    expect(msg).toContain('"action":"config.set"');
    expect(msg).toContain("maxTokens");
    expect(msg).not.toContain("[object Object]");
  });

  it("prefers Error.message for Error instances", () => {
    expect(formatUiError(new Error("invalid config"))).toBe("invalid config");
  });
});
