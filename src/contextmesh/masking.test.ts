import { describe, expect, it } from "vitest";
import { maskSensitiveText } from "./masking.js";

describe("contextmesh masking", () => {
  it("redacts common sensitive patterns", () => {
    const result = maskSensitiveText(
      "Email alice@example.com bearer Bearer secret123 password=hunter2",
    );
    expect(result.maskedText).toContain("[REDACTED_EMAIL]");
    expect(result.maskedText).toContain("[REDACTED_BEARER]");
    expect(result.maskedText).toContain("[REDACTED_PASSWORD]");
  });
});
