import { beforeEach, describe, expect, it } from "vitest";
import { SecretStore } from "./secret-store.js";

describe("SecretStore", () => {
  let store: SecretStore;

  describe("auto-detection mode (empty mask list)", () => {
    beforeEach(() => {
      store = new SecretStore({ mask: [] });
    });

    it("detects common API key env var names", () => {
      process.env.OPENAI_API_KEY = "sk-test-1234567890";
      process.env.GITHUB_TOKEN = "ghp_abc123";
      process.env.SOME_NORMAL_VAR = "not-a-secret";

      store.load();

      expect(store.has("OPENAI_API_KEY")).toBe(true);
      expect(store.has("GITHUB_TOKEN")).toBe(true);
      expect(store.has("SOME_NORMAL_VAR")).toBe(false);

      delete process.env.OPENAI_API_KEY;
      delete process.env.GITHUB_TOKEN;
      delete process.env.SOME_NORMAL_VAR;
    });

    it("detects *_SECRET, *_PASSWORD, *_TOKEN patterns", () => {
      process.env.MY_APP_SECRET = "supersecret";
      process.env.DB_PASSWORD = "hunter2";
      process.env.AUTH_TOKEN = "tok_123";

      store.load();

      expect(store.has("MY_APP_SECRET")).toBe(true);
      expect(store.has("DB_PASSWORD")).toBe(true);
      expect(store.has("AUTH_TOKEN")).toBe(true);

      delete process.env.MY_APP_SECRET;
      delete process.env.DB_PASSWORD;
      delete process.env.AUTH_TOKEN;
    });
  });

  describe("explicit mask list", () => {
    beforeEach(() => {
      store = new SecretStore({ mask: ["MY_KEY", "CUSTOM_*"] });
    });

    it("masks explicitly named secrets", () => {
      process.env.MY_KEY = "secret-value";
      process.env.UNMASKED = "visible";

      store.load();

      expect(store.has("MY_KEY")).toBe(true);
      expect(store.has("UNMASKED")).toBe(false);

      delete process.env.MY_KEY;
      delete process.env.UNMASKED;
    });

    it("supports glob patterns", () => {
      process.env.CUSTOM_API_KEY = "key1";
      process.env.CUSTOM_SECRET = "key2";
      process.env.OTHER_KEY = "key3";

      store.load();

      expect(store.has("CUSTOM_API_KEY")).toBe(true);
      expect(store.has("CUSTOM_SECRET")).toBe(true);
      expect(store.has("OTHER_KEY")).toBe(false);

      delete process.env.CUSTOM_API_KEY;
      delete process.env.CUSTOM_SECRET;
      delete process.env.OTHER_KEY;
    });
  });

  describe("resolve", () => {
    it("returns the secret value for known secrets", () => {
      store = new SecretStore({ mask: ["TEST_SECRET"] });
      process.env.TEST_SECRET = "my-secret-value";

      store.load();

      expect(store.resolve("TEST_SECRET")).toBe("my-secret-value");

      delete process.env.TEST_SECRET;
    });

    it("returns undefined for unknown secrets", () => {
      store = new SecretStore({ mask: [] });
      store.load();

      expect(store.resolve("NONEXISTENT")).toBeUndefined();
    });
  });

  describe("getValues", () => {
    it("excludes very short values (< 8 chars) to prevent false positives", () => {
      store = new SecretStore({ mask: ["SHORT", "LONG"] });
      process.env.SHORT = "abc";
      process.env.LONG = "this-is-a-long-secret-value";

      store.load();

      const values = store.getValues();
      expect(values).toContain("this-is-a-long-secret-value");
      expect(values).not.toContain("abc");

      delete process.env.SHORT;
      delete process.env.LONG;
    });
  });

  describe("disabled mode", () => {
    it("loads nothing when disabled", () => {
      store = new SecretStore({ enabled: false, mask: ["ANYTHING"] });
      process.env.ANYTHING = "secret";

      store.load();

      expect(store.listNames()).toHaveLength(0);

      delete process.env.ANYTHING;
    });
  });
});
