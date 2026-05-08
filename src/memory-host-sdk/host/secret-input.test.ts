import { afterEach, describe, expect, it } from "vitest";
import { resolveMemorySecretInputString } from "./secret-input.js";

describe("resolveMemorySecretInputString", () => {
  afterEach(() => {
    delete process.env.GOOGLE_API_KEY;
  });

  it("uses the daemon env for env-backed SecretRefs", () => {
    process.env.GOOGLE_API_KEY = "resolved-key";

    expect(
      resolveMemorySecretInputString({
        value: {
          source: "env",
          provider: "default",
          id: "GOOGLE_API_KEY",
        },
        path: "agents.main.memorySearch.remote.apiKey",
      }),
    ).toBe("resolved-key");
  });

  it("still throws when an env-backed SecretRef is missing from the daemon env", () => {
    expect(() =>
      resolveMemorySecretInputString({
        value: {
          source: "env",
          provider: "default",
          id: "GOOGLE_API_KEY",
        },
        path: "agents.main.memorySearch.remote.apiKey",
      }),
    ).toThrow(/unresolved SecretRef/);
  });
});
