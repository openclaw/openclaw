import { describe, expect, it } from "vitest";
import {
  createSensitiveRedactor,
  getDefaultRedactPatterns,
  redactSensitiveArgs,
  redactSensitiveText,
  redactSensitiveValue,
} from "./redact.js";

const defaults = getDefaultRedactPatterns();

describe("redactSensitiveText", () => {
  it("masks env assignments while keeping the key", () => {
    const input = "OPENAI_API_KEY=sk-1234567890abcdef";
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toBe("OPENAI_API_KEY=sk-123…cdef");
  });

  it("masks CLI flags", () => {
    const input = "curl --token abcdef1234567890ghij https://api.test";
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toBe("curl --token abcdef…ghij https://api.test");
  });

  it("masks JSON fields", () => {
    const input = '{"token":"abcdef1234567890ghij"}';
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toBe('{"token":"abcdef…ghij"}');
  });

  it("masks bearer tokens", () => {
    const input = "Authorization: Bearer abcdef1234567890ghij";
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toBe("Authorization: Bearer abcdef…ghij");
  });

  it("masks Telegram-style tokens", () => {
    const input = "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef";
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toBe("123456…cdef");
  });

  it("redacts short tokens fully", () => {
    const input = "TOKEN=shortvalue";
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toBe("TOKEN=***");
  });

  it("redacts private key blocks", () => {
    const input = [
      "-----BEGIN PRIVATE KEY-----",
      "ABCDEF1234567890",
      "ZYXWVUT987654321",
      "-----END PRIVATE KEY-----",
    ].join("\n");
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toBe(
      ["-----BEGIN PRIVATE KEY-----", "…redacted…", "-----END PRIVATE KEY-----"].join("\n"),
    );
  });

  it("honors custom patterns with flags", () => {
    const input = "token=abcdef1234567890ghij";
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: ["/token=([A-Za-z0-9]+)/i"],
    });
    expect(output).toBe("token=abcdef…ghij");
  });

  it("skips redaction when mode is off", () => {
    const input = "OPENAI_API_KEY=sk-1234567890abcdef";
    const output = redactSensitiveText(input, {
      mode: "off",
      patterns: defaults,
    });
    expect(output).toBe(input);
  });
});

describe("redactSensitiveValue", () => {
  it("redacts password fields in objects", () => {
    const input = { username: "user", password: "secret123" };
    const output = redactSensitiveValue(input) as Record<string, unknown>;
    expect(output.username).toBe("user");
    expect(output.password).toBe("***");
  });

  it("redacts token fields in objects", () => {
    const input = { name: "test", token: "abcdef1234567890ghij" };
    const output = redactSensitiveValue(input) as Record<string, unknown>;
    expect(output.name).toBe("test");
    expect(output.token).toBe("abcdef…ghij");
  });

  it("redacts nested sensitive fields", () => {
    const input = {
      user: { name: "test", password: "secret" },
      config: { apiKey: "sk-1234567890abcdef" },
    };
    const output = redactSensitiveValue(input) as Record<string, unknown>;
    expect((output.user as Record<string, unknown>).name).toBe("test");
    expect((output.user as Record<string, unknown>).password).toBe("***");
    expect((output.config as Record<string, unknown>).apiKey).toBe("sk-123…cdef");
  });

  it("redacts sensitive fields in arrays", () => {
    const input = [{ password: "secret1" }, { password: "secret2" }];
    const output = redactSensitiveValue(input) as Array<Record<string, unknown>>;
    expect(output[0].password).toBe("***");
    expect(output[1].password).toBe("***");
  });

  it("handles circular references", () => {
    const input: Record<string, unknown> = { name: "test" };
    input.self = input;
    const output = redactSensitiveValue(input) as Record<string, unknown>;
    expect(output.name).toBe("test");
    expect(output.self).toBe("[Circular]");
  });

  it("preserves null and undefined values in sensitive fields", () => {
    const input = { password: null, token: undefined, name: "test" };
    const output = redactSensitiveValue(input) as Record<string, unknown>;
    expect(output.password).toBeNull();
    expect(output.token).toBeUndefined();
    expect(output.name).toBe("test");
  });

  it("redacts strings containing sensitive patterns within objects", () => {
    const input = {
      message: "Set API_KEY=sk-1234567890abcdef in env",
      debug: false,
    };
    const output = redactSensitiveValue(input) as Record<string, unknown>;
    expect(output.message).toBe("Set API_KEY=sk-123…cdef in env");
    expect(output.debug).toBe(false);
  });

  it("handles Date objects without modification", () => {
    const date = new Date("2026-01-01");
    const input = { createdAt: date, password: "secret" };
    const output = redactSensitiveValue(input) as Record<string, unknown>;
    expect(output.createdAt).toBe(date);
    expect(output.password).toBe("***");
  });

  it("redacts Error message and stack", () => {
    const error = new Error("Failed with key sk-1234567890abcdef");
    const output = redactSensitiveValue(error) as Record<string, unknown>;
    expect(output.name).toBe("Error");
    expect(output.message).toBe("Failed with key sk-123…cdef");
  });

  it("redacts URL objects containing sensitive data", () => {
    const url = new URL("https://api.test?token=abcdef1234567890ghij");
    const output = redactSensitiveValue(url);
    expect(output).toContain("token=abcdef…ghij");
  });

  it("respects mode=off", () => {
    const input = { password: "secret123", token: "abc" };
    const output = redactSensitiveValue(input, { mode: "off" }) as Record<string, unknown>;
    expect(output.password).toBe("secret123");
    expect(output.token).toBe("abc");
  });
});

describe("redactSensitiveArgs", () => {
  it("redacts sensitive fields in argument arrays", () => {
    const args = [{ password: "secret" }, "message", { token: "abc123" }];
    const output = redactSensitiveArgs(args);
    expect((output[0] as Record<string, unknown>).password).toBe("***");
    expect(output[1]).toBe("message");
    expect((output[2] as Record<string, unknown>).token).toBe("***");
  });

  it("returns empty array unchanged", () => {
    const output = redactSensitiveArgs([]);
    expect(output).toEqual([]);
  });
});

describe("createSensitiveRedactor", () => {
  it("creates a redactor with all methods", () => {
    const redactor = createSensitiveRedactor();
    expect(redactor.mode).toBe("tools");
    expect(typeof redactor.redactText).toBe("function");
    expect(typeof redactor.redactValue).toBe("function");
    expect(typeof redactor.redactArgs).toBe("function");
  });

  it("redactor.redactText works correctly", () => {
    const redactor = createSensitiveRedactor();
    const output = redactor.redactText("TOKEN=abcdef1234567890ghij");
    expect(output).toBe("TOKEN=abcdef…ghij");
  });

  it("redactor.redactValue works correctly", () => {
    const redactor = createSensitiveRedactor();
    const output = redactor.redactValue({ password: "secret" }) as Record<string, unknown>;
    expect(output.password).toBe("***");
  });

  it("redactor.redactArgs works correctly", () => {
    const redactor = createSensitiveRedactor();
    const output = redactor.redactArgs([{ token: "secret123456789" }]) as Array<
      Record<string, unknown>
    >;
    expect(output[0].token).toBe("***");
  });

  it("returns pass-through redactor when mode is off", () => {
    const redactor = createSensitiveRedactor({ mode: "off" });
    expect(redactor.mode).toBe("off");
    const input = { password: "secret" };
    expect(redactor.redactValue(input)).toBe(input);
  });
});
