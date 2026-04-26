import { describe, expect, it } from "vitest";
import { isSecretRef } from "./types.secrets.js";

describe("isSecretRef with plugin-owned sources", () => {
  it("accepts a SecretRef whose source is a plugin-owned string", () => {
    expect(isSecretRef({ source: "gcp", provider: "prod", id: "OPENAI_KEY" })).toBe(true);
    expect(isSecretRef({ source: "keyring", provider: "default", id: "slack-bot" })).toBe(true);
    expect(isSecretRef({ source: "aws", provider: "ops", id: "db/password" })).toBe(true);
  });

  it("still rejects empty/whitespace sources", () => {
    expect(isSecretRef({ source: "", provider: "p", id: "i" })).toBe(false);
    expect(isSecretRef({ source: "   ", provider: "p", id: "i" })).toBe(false);
  });

  it("still rejects non-string sources", () => {
    expect(isSecretRef({ source: 42, provider: "p", id: "i" })).toBe(false);
    expect(isSecretRef({ source: null, provider: "p", id: "i" })).toBe(false);
    expect(isSecretRef({ source: undefined, provider: "p", id: "i" })).toBe(false);
  });

  it("still accepts the three legacy literals", () => {
    expect(isSecretRef({ source: "env", provider: "default", id: "X" })).toBe(true);
    expect(isSecretRef({ source: "file", provider: "p", id: "X" })).toBe(true);
    expect(isSecretRef({ source: "exec", provider: "p", id: "X" })).toBe(true);
  });

  it("still requires non-empty provider and id", () => {
    expect(isSecretRef({ source: "gcp", provider: "", id: "X" })).toBe(false);
    expect(isSecretRef({ source: "gcp", provider: "p", id: "" })).toBe(false);
    expect(isSecretRef({ source: "gcp", provider: "  ", id: "X" })).toBe(false);
  });
});
