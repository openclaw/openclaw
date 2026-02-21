import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./config.js";

describe("vault config schema validation", () => {
  it("accepts valid vault config with all fields", () => {
    const res = validateConfigObject({
      vault: {
        enabled: true,
        proxies: {
          openai: "http://vault:8081",
          anthropic: "http://vault:8082",
        },
        file: "/path/to/vault.age",
        publicKey: "age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p",
      },
    });

    expect(res.ok).toBe(true);
  });

  it("accepts vault config with only enabled field", () => {
    const res = validateConfigObject({
      vault: { enabled: false },
    });

    expect(res.ok).toBe(true);
  });

  it("accepts empty vault object", () => {
    const res = validateConfigObject({
      vault: {},
    });

    expect(res.ok).toBe(true);
  });

  it("accepts config without vault section", () => {
    const res = validateConfigObject({});

    expect(res.ok).toBe(true);
  });

  it("rejects invalid proxy URL", () => {
    const res = validateConfigObject({
      vault: {
        enabled: true,
        proxies: { openai: "not-a-url" },
      },
    });

    expect(res.ok).toBe(false);
  });

  it("rejects empty string as proxy URL", () => {
    const res = validateConfigObject({
      vault: {
        enabled: true,
        proxies: { openai: "" },
      },
    });

    expect(res.ok).toBe(false);
  });

  it("rejects publicKey without age1 prefix", () => {
    const res = validateConfigObject({
      vault: {
        publicKey: "RSA-1234-not-age",
      },
    });

    expect(res.ok).toBe(false);
  });

  it("accepts publicKey with age1 prefix", () => {
    const res = validateConfigObject({
      vault: {
        publicKey: "age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p",
      },
    });

    expect(res.ok).toBe(true);
  });

  it("rejects unknown fields in vault object (strict mode)", () => {
    const res = validateConfigObject({
      vault: {
        enabled: true,
        unknownField: "should-fail",
      },
    });

    expect(res.ok).toBe(false);
  });

  it("rejects non-boolean enabled field", () => {
    const res = validateConfigObject({
      vault: {
        enabled: "yes",
      },
    });

    expect(res.ok).toBe(false);
  });
});
