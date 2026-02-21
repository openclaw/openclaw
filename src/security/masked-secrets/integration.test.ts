import { afterEach, describe, expect, it } from "vitest";
import { createMaskedSecrets, type MaskedSecrets } from "./index.js";

/**
 * Integration tests for masked-secrets wiring into exec/process pipelines.
 * These test the MaskedSecrets facade end-to-end (preflight + redaction)
 * as it would be used in bash-tools.exec.ts and bash-tools.process.ts.
 */

describe("MaskedSecrets integration", () => {
  const TEST_SECRETS: Record<string, string> = {
    TEST_API_KEY: "sk-ant-test-1234567890abcdef",
    TEST_GITHUB_TOKEN: "ghp_test0123456789abcdef0123456789abcdef",
    TEST_AWS_KEY: "AKIAIOSFODNN7EXAMPLE1",
  };

  function setupEnvAndCreate(): MaskedSecrets {
    for (const [key, value] of Object.entries(TEST_SECRETS)) {
      process.env[key] = value;
    }
    const ms = createMaskedSecrets({
      enabled: true,
      mask: Object.keys(TEST_SECRETS),
      blockSecretFileReads: true,
      secretFilePaths: [".env", "credentials.json"],
    });
    for (const key of Object.keys(TEST_SECRETS)) {
      delete process.env[key];
    }
    return ms;
  }

  afterEach(() => {
    for (const key of Object.keys(TEST_SECRETS)) {
      delete process.env[key];
    }
  });

  describe("exec pipeline simulation", () => {
    it("preflight blocks env dump commands", () => {
      const ms = setupEnvAndCreate();

      const result = ms.preflight("env");
      expect(result.allowed).toBe(false);
      expect(result.reason).toBeDefined();
    });

    it("preflight blocks printenv", () => {
      const ms = setupEnvAndCreate();

      expect(ms.preflight("printenv").allowed).toBe(false);
      expect(ms.preflight("export -p").allowed).toBe(false);
    });

    it("preflight blocks reading .env files", () => {
      const ms = setupEnvAndCreate();

      expect(ms.preflight("cat .env").allowed).toBe(false);
      expect(ms.preflight("cat /app/.env").allowed).toBe(false);
      expect(ms.preflight("less credentials.json").allowed).toBe(false);
    });

    it("preflight allows safe commands", () => {
      const ms = setupEnvAndCreate();

      const result = ms.preflight("ls -la");
      expect(result.allowed).toBe(true);
    });

    it("preflight substitutes {{secret:NAME}} refs", () => {
      const ms = setupEnvAndCreate();

      const result = ms.preflight(
        'curl -H "Authorization: Bearer {{secret:TEST_API_KEY}}" https://api.example.com',
      );
      expect(result.allowed).toBe(true);
      expect(result.processedCommand).toContain("sk-ant-test-1234567890abcdef");
      expect(result.processedCommand).not.toContain("{{secret:");
    });

    it("preflight substitutes multiple secrets in one command", () => {
      const ms = setupEnvAndCreate();

      const result = ms.preflight(
        "GH_TOKEN={{secret:TEST_GITHUB_TOKEN}} AWS_KEY={{secret:TEST_AWS_KEY}} ./deploy.sh",
      );
      expect(result.allowed).toBe(true);
      expect(result.processedCommand).toContain(TEST_SECRETS.TEST_GITHUB_TOKEN);
      expect(result.processedCommand).toContain(TEST_SECRETS.TEST_AWS_KEY);
    });

    it("preflight warns about unknown secret references", () => {
      const ms = setupEnvAndCreate();

      const result = ms.preflight("curl -H '{{secret:NONEXISTENT}}'");
      expect(result.allowed).toBe(true);
      expect(result.warnings).toBeDefined();
      expect(result.warnings!.some((w: string) => w.includes("NONEXISTENT"))).toBe(true);
    });

    it("redaction scrubs secret values from output", () => {
      const ms = setupEnvAndCreate();

      const output = `API key is: sk-ant-test-1234567890abcdef\nGitHub: ghp_test0123456789abcdef0123456789abcdef`;
      const result = ms.redact(output);

      expect(result.text).not.toContain("sk-ant-test-1234567890abcdef");
      expect(result.text).not.toContain("ghp_test0123456789abcdef0123456789abcdef");
      expect(result.count).toBeGreaterThan(0);
      expect(result.text).toContain("[REDACTED]");
    });

    it("redaction leaves clean output untouched", () => {
      const ms = setupEnvAndCreate();

      const output = "Hello, world!\nSuccess: 200 OK";
      const result = ms.redact(output);

      expect(result.text).toBe(output);
      expect(result.count).toBe(0);
    });

    it("full exec flow: preflight + execute + redact", () => {
      const ms = setupEnvAndCreate();

      // Step 1: Preflight (substitute secrets in command)
      const preflight = ms.preflight(
        'curl -H "Auth: {{secret:TEST_API_KEY}}" https://api.test.com',
      );
      expect(preflight.allowed).toBe(true);
      const realCommand = preflight.processedCommand!;
      expect(realCommand).toContain("sk-ant-test-1234567890abcdef");

      // Step 2: Simulate command output that accidentally leaks the secret
      const simulatedOutput = `> GET /api HTTP/1.1
> Host: api.test.com
> Auth: sk-ant-test-1234567890abcdef
< HTTP/1.1 200 OK
{"status": "ok"}`;

      // Step 3: Redact before returning to agent
      const redacted = ms.redact(simulatedOutput);
      expect(redacted.text).not.toContain("sk-ant-test-1234567890abcdef");
      expect(redacted.text).toContain("[REDACTED]");
      expect(redacted.text).toContain('{"status": "ok"}');
    });
  });

  describe("process pipeline simulation (poll/log output)", () => {
    it("redacts secrets from poll drain output", () => {
      const ms = setupEnvAndCreate();

      // Simulate what bash-tools.process.ts does on poll
      const stdout = `Deploying with key sk-ant-test-1234567890abcdef...\nDone.`;
      const stderr = "";
      const output = [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join("\n").trim();
      const safeOutput = ms.redact(output).text;

      expect(safeOutput).not.toContain("sk-ant-test-1234567890abcdef");
      expect(safeOutput).toContain("Deploying with key");
      expect(safeOutput).toContain("Done.");
    });

    it("redacts secrets from log slice output", () => {
      const ms = setupEnvAndCreate();

      const logSlice = `Line 1: normal output
Line 2: token=ghp_test0123456789abcdef0123456789abcdef
Line 3: continuing work
Line 4: AWS key AKIAIOSFODNN7EXAMPLE1 used`;
      const safeSlice = ms.redact(logSlice).text;

      expect(safeSlice).not.toContain("ghp_test0123456789abcdef0123456789abcdef");
      expect(safeSlice).not.toContain("AKIAIOSFODNN7EXAMPLE1");
      expect(safeSlice).toContain("Line 1: normal output");
      expect(safeSlice).toContain("Line 3: continuing work");
    });

    it("redacts from finished session tail", () => {
      const ms = setupEnvAndCreate();

      const tail = `Last 5 lines:\nConfig loaded with sk-ant-test-1234567890abcdef\nServer started on :8080`;
      const safeTail = ms.redact(tail).text;

      expect(safeTail).not.toContain("sk-ant-test-1234567890abcdef");
      expect(safeTail).toContain("Server started on :8080");
    });
  });

  describe("disabled mode", () => {
    it("passes through everything when disabled", () => {
      for (const [key, value] of Object.entries(TEST_SECRETS)) {
        process.env[key] = value;
      }
      const ms = createMaskedSecrets({
        enabled: false,
        mask: Object.keys(TEST_SECRETS),
      });
      for (const key of Object.keys(TEST_SECRETS)) {
        delete process.env[key];
      }

      // Preflight should allow everything
      expect(ms.preflight("env").allowed).toBe(true);
      expect(ms.preflight("cat .env").allowed).toBe(true);

      // Redaction should be a no-op
      const output = `secret: sk-ant-test-1234567890abcdef`;
      expect(ms.redact(output).text).toBe(output);
      expect(ms.redact(output).count).toBe(0);
    });

    it("isEnabled returns false when disabled", () => {
      const ms = createMaskedSecrets({ enabled: false });
      expect(ms.isEnabled()).toBe(false);
    });
  });

  describe("listSecretNames", () => {
    it("returns configured secret names without values", () => {
      const ms = setupEnvAndCreate();
      const names = ms.listSecretNames();

      expect(names).toContain("TEST_API_KEY");
      expect(names).toContain("TEST_GITHUB_TOKEN");
      expect(names).toContain("TEST_AWS_KEY");
      // Must not contain actual values
      expect(names.join(",")).not.toContain("sk-ant-");
      expect(names.join(",")).not.toContain("ghp_");
    });
  });

  describe("config schema integration", () => {
    it("creates instance from config-shaped object", () => {
      // Simulate what pi-tools.ts does: extract config and create instance
      const config = {
        security: {
          maskedSecrets: {
            enabled: true,
            mask: ["SOME_KEY"],
            blockSecretFileReads: true,
          },
        },
      };

      const maskedSecretsConfig = (config as Record<string, unknown>).security as
        | { maskedSecrets?: Record<string, unknown> }
        | undefined;

      expect(maskedSecretsConfig?.maskedSecrets).toBeDefined();
      const ms = createMaskedSecrets(maskedSecretsConfig!.maskedSecrets);
      expect(ms.isEnabled()).toBe(true);
    });

    it("handles missing security config gracefully", () => {
      const config = {};
      const maskedSecretsConfig = (config as Record<string, unknown>).security as
        | { maskedSecrets?: Record<string, unknown> }
        | undefined;

      expect(maskedSecretsConfig).toBeUndefined();
      // This is the path pi-tools.ts takes — no MaskedSecrets created
    });
  });

  describe("system prompt integration", () => {
    it("listSecretNames provides names for system prompt", () => {
      const ms = setupEnvAndCreate();
      const names = ms.listSecretNames();

      // Simulate what system-prompt.ts does
      const promptSection = `Available secrets: ${names.join(", ")}`;
      expect(promptSection).toContain("TEST_API_KEY");
      expect(promptSection).toContain("TEST_GITHUB_TOKEN");
      expect(promptSection).not.toContain("sk-ant-");
    });
  });

  describe("pattern-based redaction (defense in depth)", () => {
    it("catches common API key patterns even without explicit config", () => {
      const ms = createMaskedSecrets({ enabled: true, mask: [] });

      // These should be caught by built-in patterns
      const output = `Found key: sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890`;
      const result = ms.redact(output);

      // Pattern-based redaction should catch sk-ant- prefix
      expect(result.text).not.toContain("sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890");
    });

    it("catches GitHub token patterns", () => {
      const ms = createMaskedSecrets({ enabled: true, mask: [] });

      const output = `token=ghp_abcdefghijklmnopqrstuvwxyz1234567890`;
      const result = ms.redact(output);

      expect(result.text).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz1234567890");
    });

    it("catches AWS key patterns", () => {
      const ms = createMaskedSecrets({ enabled: true, mask: [] });

      const output = `AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE2`;
      const result = ms.redact(output);

      expect(result.text).not.toContain("AKIAIOSFODNN7EXAMPLE2");
    });
  });
});
