import os from "node:os";
import { describe, expect, it } from "vitest";
import {
  REDACTED_PATH_LABEL,
  getDefaultRedactPatterns,
  getSystemRedactPatterns,
  redactSensitiveText,
  redactSystemPaths,
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

  it("masks Telegram Bot API URL tokens", () => {
    const input =
      "GET https://api.telegram.org/bot123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef/getMe HTTP/1.1";
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toBe("GET https://api.telegram.org/bot123456…cdef/getMe HTTP/1.1");
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

  it("ignores unsafe nested-repetition custom patterns", () => {
    const input = `${"a".repeat(28)}!`;
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: ["(a+)+$"],
    });
    expect(output).toBe(input);
  });

  it("redacts large payloads with bounded regex passes", () => {
    const input = `${"x".repeat(40_000)} OPENAI_API_KEY=sk-1234567890abcdef ${"y".repeat(40_000)}`;
    const output = redactSensitiveText(input, {
      mode: "tools",
      patterns: defaults,
    });
    expect(output).toContain("OPENAI_API_KEY=sk-123…cdef");
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

describe("getSystemRedactPatterns", () => {
  it("returns an array (non-empty on a normal OS user)", () => {
    const patterns = getSystemRedactPatterns();
    // On a real system with a valid user, we should have patterns.
    // In edge environments (container with no passwd entry) it returns [].
    expect(Array.isArray(patterns)).toBe(true);
  });

  it("all returned strings compile to valid patterns", () => {
    const patterns = getSystemRedactPatterns();
    for (const p of patterns) {
      expect(() => new RegExp(p, "g")).not.toThrow();
    }
  });
});

describe("redactSystemPaths", () => {
  // Retrieve the real username for tests (skip gracefully if unavailable).
  let username: string;
  let homedir: string;
  let available = false;

  try {
    const info = os.userInfo();
    username = info.username;
    homedir = info.homedir;
    available = Boolean(username && homedir);
  } catch {
    available = false;
  }

  it("returns the input unchanged when given an empty string", () => {
    expect(redactSystemPaths("")).toBe("");
  });

  it("returns plain text unchanged when it contains no paths", () => {
    const text = "hello world, no paths here";
    expect(redactSystemPaths(text)).toBe(text);
  });

  it("redacts the home directory path", { skip: !available }, () => {
    const text = `config loaded from ${homedir}/openclaw.json`;
    const result = redactSystemPaths(text);
    expect(result).not.toContain(username);
    expect(result).toContain(REDACTED_PATH_LABEL);
  });

  it("redacts /Users/<username> macOS-style paths", { skip: !available }, () => {
    const text = `session file at /Users/${username}/Library/something`;
    const result = redactSystemPaths(text);
    expect(result).not.toContain(`/Users/${username}`);
    expect(result).toContain(`/Users/${REDACTED_PATH_LABEL}`);
  });

  it("redacts /home/<username> Linux-style paths", { skip: !available }, () => {
    const text = `reading /home/${username}/.openclaw/config.json`;
    const result = redactSystemPaths(text);
    expect(result).not.toContain(`/home/${username}`);
    expect(result).toContain(`/home/${REDACTED_PATH_LABEL}`);
  });

  it("redacts workspaces/<username> agent workspace paths", { skip: !available }, () => {
    const text = `agent workspace: workspaces/${username}/memory/2026-03-22.md`;
    const result = redactSystemPaths(text);
    expect(result).not.toContain(`workspaces/${username}`);
    expect(result).toContain(`workspaces/${REDACTED_PATH_LABEL}`);
  });

  it("leaves text unchanged when username is not present", { skip: !available }, () => {
    const text = "no personal paths in this log line";
    expect(redactSystemPaths(text)).toBe(text);
  });
});
