import { describe, expect, it } from "vitest";
import { preflightCheck } from "./preflight.js";
import { SecretStore } from "./secret-store.js";

describe("preflightCheck", () => {
  function makeStore(
    secrets: Record<string, string>,
    opts?: { blockSecretFileReads?: boolean },
  ): SecretStore {
    const store = new SecretStore({
      mask: Object.keys(secrets),
      blockSecretFileReads: opts?.blockSecretFileReads ?? true,
      secretFilePaths: [".env", "credentials.json", "auth-profiles.json"],
    });
    for (const [key, value] of Object.entries(secrets)) {
      process.env[key] = value;
    }
    store.load();
    for (const key of Object.keys(secrets)) {
      delete process.env[key];
    }
    return store;
  }

  describe("env dump blocking", () => {
    it("blocks standalone 'env' command", () => {
      const store = makeStore({ KEY: "secret-value-123456" });
      const result = preflightCheck("env", store);

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("environment variables");
    });

    it("blocks 'printenv'", () => {
      const store = makeStore({ KEY: "secret-value-123456" });
      const result = preflightCheck("printenv", store);

      expect(result.allowed).toBe(false);
    });

    it("blocks 'export -p'", () => {
      const store = makeStore({ KEY: "secret-value-123456" });
      const result = preflightCheck("export -p", store);

      expect(result.allowed).toBe(false);
    });

    it("allows 'env' as part of a longer command (env VAR=val cmd)", () => {
      const store = makeStore({ KEY: "secret-value-123456" });
      const result = preflightCheck("env FOO=bar python script.py", store);

      // "env FOO=bar python script.py" does NOT match "^\s*env\s*$"
      expect(result.allowed).toBe(true);
    });
  });

  describe("secret file read blocking", () => {
    it("blocks 'cat .env'", () => {
      const store = makeStore({ KEY: "secret-value-123456" });
      const result = preflightCheck("cat .env", store);

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("secrets");
    });

    it("blocks 'cat ~/.openclaw/.env'", () => {
      const store = makeStore({ KEY: "secret-value-123456" });
      const result = preflightCheck("cat ~/.openclaw/.env", store);

      expect(result.allowed).toBe(false);
    });

    it("blocks 'less credentials.json'", () => {
      const store = makeStore({ KEY: "secret-value-123456" });
      const result = preflightCheck("less credentials.json", store);

      expect(result.allowed).toBe(false);
    });

    it("allows reading non-secret files", () => {
      const store = makeStore({ KEY: "secret-value-123456" });
      const result = preflightCheck("cat README.md", store);

      expect(result.allowed).toBe(true);
    });

    it("respects blockSecretFileReads=false", () => {
      const store = makeStore({ KEY: "secret-value-123456" }, { blockSecretFileReads: false });
      const result = preflightCheck("cat .env", store);

      expect(result.allowed).toBe(true);
    });
  });

  describe("secret substitution", () => {
    it("substitutes {{secret:NAME}} in allowed commands", () => {
      const store = makeStore({ MY_KEY: "real-api-key-12345" });
      const result = preflightCheck(
        'curl -H "Auth: {{secret:MY_KEY}}" https://api.example.com',
        store,
      );

      expect(result.allowed).toBe(true);
      expect(result.processedCommand).toBe(
        'curl -H "Auth: real-api-key-12345" https://api.example.com',
      );
    });

    it("warns about missing secret references", () => {
      const store = makeStore({});
      const result = preflightCheck("curl -H '{{secret:UNKNOWN}}'", store);

      expect(result.allowed).toBe(true);
      expect(result.warnings).toBeDefined();
      expect(result.warnings!.length).toBeGreaterThan(0);
      expect(result.warnings![0]).toContain("Unknown secret");
    });
  });

  describe("env var echo detection", () => {
    it("warns when command references masked env vars with $", () => {
      const store = makeStore({ SECRET_KEY: "my-secret-12345678" });
      const result = preflightCheck("echo $SECRET_KEY", store);

      expect(result.allowed).toBe(true); // Warn, don't block
      expect(result.warnings).toBeDefined();
      expect(result.warnings!.length).toBeGreaterThan(0);
    });
  });
});
