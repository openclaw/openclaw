import { describe, expect, it } from "vitest";
import { normalizeGenericTerminalToolResultText } from "./terminal-reply.js";

describe("generic terminal tool result text", () => {
  it("redacts secrets before presenting captured tool output", () => {
    expect(normalizeGenericTerminalToolResultText("TOKEN=secret-value\nstatus: ok")).toBe(
      "TOKEN=***\nstatus: ok",
    );
  });

  it("truncates long output after redaction", () => {
    const normalized = normalizeGenericTerminalToolResultText("x".repeat(20), 18);

    expect(normalized).toBe("xxx\n...[truncated]");
  });

  it.each([0, 1, 5, 14])("never exceeds a small maxChars limit of %s", (maxChars) => {
    const normalized = normalizeGenericTerminalToolResultText("x".repeat(20), maxChars);

    expect(normalized?.length ?? 0).toBeLessThanOrEqual(maxChars);
  });
});
