import { describe, expect, it } from "vitest";

describe("sandbox security error handling", () => {
  // Helper to detect sandbox security errors
  const isSandboxSecurityError = (message: string) => /^Sandbox security:/i.test(message);

  // Helper to sanitize messages for public channels
  const sanitizeForChannel = (message: string): string => {
    if (isSandboxSecurityError(message)) {
      return "⚠️ Agent failed to start due to a configuration error. Check logs with `openclaw logs --follow` for details.";
    }
    return message;
  };

  describe("isSandboxSecurityError", () => {
    it("detects sandbox security errors", () => {
      expect(
        isSandboxSecurityError("Sandbox security: bind mount source is outside allowed roots"),
      ).toBe(true);
      expect(isSandboxSecurityError("Sandbox security: network mode is blocked")).toBe(true);
      expect(isSandboxSecurityError("Sandbox security: seccomp profile is blocked")).toBe(true);
    });

    it("rejects non-sandbox errors", () => {
      expect(isSandboxSecurityError("normal error")).toBe(false);
      expect(isSandboxSecurityError("Context overflow")).toBe(false);
      expect(isSandboxSecurityError("HTTP 500")).toBe(false);
    });
  });

  describe("sanitizeForChannel", () => {
    it("redacts sandbox security errors for public channels", () => {
      const sandboxError =
        'Sandbox security: bind mount "/home/user/.config:/app/config:ro" source "/home/user/.config" is outside allowed roots';
      const sanitized = sanitizeForChannel(sandboxError);

      // Should NOT contain the internal path
      expect(sanitized).not.toContain("/home/user/.config");
      expect(sanitized).not.toContain("bind mount");
      // Should contain generic message
      expect(sanitized).toContain("⚠️");
      expect(sanitized).toContain("configuration error");
    });

    it("does not modify other errors", () => {
      const normalError = "Something went wrong";
      const sanitized = sanitizeForChannel(normalError);
      expect(sanitized).toBe(normalError);
    });
  });
});
