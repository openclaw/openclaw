import { describe, expect, it } from "vitest";
import { SecretStore } from "./secret-store.js";
import { extractSecretRefs, hasSecretRefs, substituteSecrets } from "./substitution.js";

describe("substituteSecrets", () => {
  function makeStore(secrets: Record<string, string>): SecretStore {
    const store = new SecretStore({ mask: Object.keys(secrets) });
    for (const [key, value] of Object.entries(secrets)) {
      process.env[key] = value;
    }
    store.load();
    for (const key of Object.keys(secrets)) {
      delete process.env[key];
    }
    return store;
  }

  it("substitutes a single secret reference", () => {
    const store = makeStore({ MY_KEY: "real-value-123" });
    const result = substituteSecrets(
      'curl -H "Authorization: Bearer {{secret:MY_KEY}}" https://api.example.com',
      store,
    );

    expect(result.text).toBe(
      'curl -H "Authorization: Bearer real-value-123" https://api.example.com',
    );
    expect(result.substituted).toEqual(["MY_KEY"]);
    expect(result.missing).toEqual([]);
  });

  it("substitutes multiple secret references", () => {
    const store = makeStore({
      API_KEY: "key-123",
      API_SECRET: "secret-456",
    });
    const result = substituteSecrets(
      "export KEY={{secret:API_KEY}} SECRET={{secret:API_SECRET}}",
      store,
    );

    expect(result.text).toBe("export KEY=key-123 SECRET=secret-456");
    expect(result.substituted).toEqual(["API_KEY", "API_SECRET"]);
  });

  it("reports missing secrets without removing the reference", () => {
    const store = makeStore({});
    const result = substituteSecrets("curl -H '{{secret:NONEXISTENT}}'", store);

    expect(result.text).toBe("curl -H '{{secret:NONEXISTENT}}'");
    expect(result.substituted).toEqual([]);
    expect(result.missing).toEqual(["NONEXISTENT"]);
  });

  it("handles text with no secret references", () => {
    const store = makeStore({ KEY: "value" });
    const result = substituteSecrets("echo hello world", store);

    expect(result.text).toBe("echo hello world");
    expect(result.substituted).toEqual([]);
    expect(result.missing).toEqual([]);
  });
});

describe("hasSecretRefs", () => {
  it("returns true when text contains {{secret:...}}", () => {
    expect(hasSecretRefs("use {{secret:MY_KEY}} here")).toBe(true);
  });

  it("returns false for plain text", () => {
    expect(hasSecretRefs("no secrets here")).toBe(false);
  });

  it("returns false for partial patterns", () => {
    expect(hasSecretRefs("{{secret:}}")).toBe(false);
    expect(hasSecretRefs("{{secret}}")).toBe(false);
  });
});

describe("extractSecretRefs", () => {
  it("extracts all referenced secret names", () => {
    const refs = extractSecretRefs("{{secret:A}} and {{secret:B}} and {{secret:A}}");
    expect(refs).toEqual(["A", "B", "A"]);
  });

  it("returns empty array for no refs", () => {
    expect(extractSecretRefs("no refs")).toEqual([]);
  });
});
