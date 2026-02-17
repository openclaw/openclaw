import { describe, it, expect } from "vitest";
import { redactObject, redactSensitiveText } from "./redact.js";

describe("redactObject", () => {
  it("redacts sensitive string values in nested objects (long tokens)", () => {
    const input = {
      name: "test",
      config: {
        apiKey: "sk-1234567890abcdef12345678", // 26 chars, >= 18
        nested: {
          clientSecret: "secret-value-1234567890abc", // 26 chars
          publicData: "visible",
        },
      },
    };

    const output = redactObject(input);

    // Long strings get prefix…suffix masking (first 6 + "…" + last 4)
    expect(output.config.apiKey).toBe("sk-123…5678");
    expect(output.config.nested.clientSecret).toBe("secret…0abc");
    expect(output.config.nested.publicData).toBe("visible");
  });

  it("redacts short sensitive strings as ***", () => {
    const input = {
      apiKey: "short-key", // < 18 chars
      password: "abc",
    };

    const output = redactObject(input);

    expect(output.apiKey).toBe("***");
    expect(output.password).toBe("***");
  });

  it("redacts sensitive non-string values as ***", () => {
    const input = {
      privateKey: { kty: "RSA" },
      secretNumber: 12345,
    };

    const output = redactObject(input);

    expect(output.privateKey).toBe("***");
    expect(output.secretNumber).toBe("***");
  });

  it("does not redact keys without sensitive names", () => {
    const input = {
      name: "hello",
      publicKey: "this-is-public", // "key" + "public" → not sensitive
      count: 42,
    };

    const output = redactObject(input);

    expect(output.name).toBe("hello");
    expect(output.publicKey).toBe("this-is-public");
    expect(output.count).toBe(42);
  });

  it("handles arrays recursively", () => {
    const input = {
      items: [{ token: "my-long-token-value-1234567890" }],
    };

    const output = redactObject(input);

    expect(output.items[0].token).not.toBe("my-long-token-value-1234567890");
    expect(output.items[0].token).toContain("…");
  });
});

describe("redactSensitiveText", () => {
  it("removes sensitive values from JSON-style text", () => {
    const input = '{ "apiKey": "sk-1234567890abcdef12345678", "name": "test" }';
    const output = redactSensitiveText(input);

    // The full token must not appear in output
    expect(output).not.toContain("sk-1234567890abcdef12345678");
    // Non-sensitive data preserved
    expect(output).toContain('"name": "test"');
  });

  it("removes sk- prefixed tokens", () => {
    const input = "my key is sk-1234567890abcdef12345678 here";
    const output = redactSensitiveText(input);

    expect(output).not.toContain("sk-1234567890abcdef12345678");
  });

  it("removes ghp_ prefixed tokens", () => {
    const input = "token: ghp_abcdefghijklmnopqrstuvwx";
    const output = redactSensitiveText(input);

    expect(output).not.toContain("ghp_abcdefghijklmnopqrstuvwx");
  });

  it("preserves non-sensitive text", () => {
    const input = "Hello world, this is a normal message.";
    const output = redactSensitiveText(input);

    expect(output).toBe(input);
  });
});
