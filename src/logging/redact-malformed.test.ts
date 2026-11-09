import { expect, it, vi } from "vitest";
import { redactSensitiveText } from "./redact.js";

it("retains valid and default protection when malformed policy warnings re-enter and fail", () => {
  const token = "ghp_abcdefghijklmnopqrstuvwxyz123456";
  const options = JSON.parse('{"patterns":[null,"customer-[0-9]+"]}');
  let nested: string | undefined;
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {
    nested = redactSensitiveText(token, options);
    throw new Error("synthetic warning sink failure");
  });
  try {
    for (const patterns of [
      "[1]",
      "[null]",
      '[false, {}, {"exec": 1}, [], "private-marker[", "customer-[0-9]+"]',
      '"customer-[0-9]+"',
      '{"length": 1}',
      "null",
    ]) {
      const malformed = JSON.parse('{"patterns":' + patterns + "}");
      expect(redactSensitiveText(token, malformed)).toBe("ghp_ab…3456");
    }
    expect(redactSensitiveText("customer-1234567890", options)).toBe("custom…7890");
    expect(nested).toBe("ghp_ab…3456");
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "[openclaw] Ignoring invalid logging.redactPatterns entries; keeping valid patterns and built-in redaction. Fix logging.redactPatterns in your config.",
    );
  } finally {
    warn.mockRestore();
  }
});
