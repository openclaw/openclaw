import { describe, expect, it } from "vitest";
import { getDefaultRedactPatterns, redactSensitiveText } from "./redact.js";

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

  it("handles patterns with escaped slashes correctly", () => {
    // Pattern: /https:\/\/secret\.example\.com\/key=([A-Za-z0-9]+)/i
    const input = "https://secret.example.com/key=abcdef1234567890ghij";
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: ["/https:\\/\\/secret\\.example\\.com\\/key=([A-Za-z0-9]+)/i"],
    });
    expect(output).toBe("https://secret.example.com/key=abcdef…ghij");
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

describe("redactSensitiveText — single-pass stability for JSONL scrubbing", () => {
  const opts = { mode: "tools" as const, patterns: defaults };

  function assertStableInOnePass(input: string, description?: string) {
    const pass1 = redactSensitiveText(input, opts);
    const pass2 = redactSensitiveText(pass1, opts);
    expect(pass2, description ?? "output should be stable after one pass").toBe(pass1);
  }

  // Use clearly fake values that match real patterns but won't trigger GitHub push protection.
  const FAKE_HEX_48 = "aa".repeat(24);
  const FAKE_ALPHA_24 = "A".repeat(24);

  it("ENV-style assignment with prefixed token", () => {
    const input = `MY_SECRET_TOKEN=sk-FAKE${FAKE_ALPHA_24}`;
    assertStableInOnePass(input);
  });

  it("ENV-style assignment with generic secret", () => {
    const input = `OPENCLAW_GATEWAY_TOKEN=${FAKE_HEX_48}`;
    assertStableInOnePass(input);
  });

  it("JSON field containing a prefixed token", () => {
    const input = `{"token":"sk-FAKE${FAKE_ALPHA_24}"}`;
    assertStableInOnePass(input);
  });

  it("JSON field containing a non-prefixed secret", () => {
    const input = `{"apiKey":"${FAKE_HEX_48}"}`;
    assertStableInOnePass(input);
  });

  it("double-encoded JSON (JSONL with escaped inner JSON)", () => {
    const inner = JSON.stringify({ apiKey: `sk-FAKE${FAKE_ALPHA_24}` });
    const jsonl = JSON.stringify({ role: "assistant", content: inner });
    assertStableInOnePass(jsonl, "double-encoded JSON secret");
  });

  it("double-encoded JSON with prefixed token in non-standard field", () => {
    const inner = JSON.stringify({ botToken: `sk-FAKE${FAKE_ALPHA_24}` });
    const jsonl = JSON.stringify({ role: "tool", content: inner });
    assertStableInOnePass(jsonl, "double-encoded prefixed token");
  });

  it("double-encoded JSON with env-style content", () => {
    const content = `export MY_SECRET_TOKEN=sk-FAKE${FAKE_ALPHA_24}`;
    const jsonl = JSON.stringify({ role: "tool", content });
    assertStableInOnePass(jsonl, "env-style in JSON content");
  });

  it("triple-encoded JSON (tool result containing stringified config)", () => {
    const config = JSON.stringify({
      secrets: { provider: "gcp" },
      gateway: { auth: { token: FAKE_HEX_48 } },
    });
    const toolResult = JSON.stringify({ output: config });
    const jsonl = JSON.stringify({ role: "tool", content: toolResult });
    assertStableInOnePass(jsonl, "triple-encoded JSON secret");
  });

  it("multiple secrets on one line", () => {
    const input = `MY_SECRET_TOKEN=sk-FAKE${FAKE_ALPHA_24} GEMINI_API_KEY=AIzaSyFAKE${FAKE_ALPHA_24}`;
    assertStableInOnePass(input, "multiple secrets on one line");
  });

  it("masked output does not re-trigger patterns", () => {
    const input = `sk-FAKE${FAKE_ALPHA_24}`;
    const pass1 = redactSensitiveText(input, opts);
    expect(pass1).not.toBe(input); // should be redacted
    const pass2 = redactSensitiveText(pass1, opts);
    expect(pass2).toBe(pass1); // should be stable
  });
});
