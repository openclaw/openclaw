/**
 * Tests for Security Hardening Module
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  generateSecureToken,
  generateApiKey,
  validateTokenStrength,
  validateInput,
  sanitizePath,
  ensureSecureDirectory,
  ensureSecureFile,
  isSymlink,
  hardenConfig,
  RateLimiter,
  getSecurityHeaders,
  createAuditLogEntry,
  MIN_TOKEN_LENGTH,
  SECURE_DIR_MODE,
  SECURE_FILE_MODE,
} from "./hardening.js";
import type { OpenClawConfig } from "../config/config.js";

describe("Security Hardening Module", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-hardening-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("Token Generation", () => {
    it("should generate tokens of correct length", () => {
      const token = generateSecureToken(32);
      expect(token).toHaveLength(64); // hex encoding doubles length
    });

    it("should generate unique tokens", () => {
      const tokens = new Set<string>();
      for (let i = 0; i < 100; i++) {
        tokens.add(generateSecureToken());
      }
      expect(tokens.size).toBe(100);
    });

    it("should generate API keys with correct format", () => {
      const key = generateApiKey("oc_live");
      expect(key).toMatch(/^oc_live_[a-z0-9]+_[A-Za-z0-9_-]+$/);
    });
  });

  describe("Token Strength Validation", () => {
    it("should validate strong tokens", () => {
      const token = generateSecureToken(32);
      const result = validateTokenStrength(token);
      expect(result.valid).toBe(true);
      expect(result.score).toBeGreaterThanOrEqual(70);
    });

    it("should reject short tokens", () => {
      const result = validateTokenStrength("short");
      expect(result.valid).toBe(false);
      expect(result.issues).toContain(`Token too short: 5 < ${MIN_TOKEN_LENGTH}`);
    });

    it("should reject repeated character tokens", () => {
      const result = validateTokenStrength("a".repeat(40));
      expect(result.valid).toBe(false);
      expect(result.issues).toContain("Token contains repeated characters");
    });

    it("should detect sequential patterns", () => {
      const result = validateTokenStrength("123456789012345678901234567890ab");
      expect(result.issues).toContain("Token starts with sequential characters");
    });
  });

  describe("Input Validation", () => {
    it("should accept clean input", () => {
      const result = validateInput("Hello, world!");
      expect(result.valid).toBe(true);
      expect(result.sanitized).toBe("Hello, world!");
    });

    it("should truncate long input", () => {
      const longInput = "a".repeat(20000);
      const result = validateInput(longInput, { maxLength: 100 });
      expect(result.sanitized).toHaveLength(100);
      expect(result.warnings).toContain("Input truncated to 100 characters");
    });

    it("should detect command injection patterns", () => {
      const result = validateInput("hello; rm -rf /");
      expect(result.warnings.length).toBeGreaterThan(0);
    });

    it("should detect path traversal", () => {
      const result = validateInput("../../../etc/passwd");
      expect(result.warnings.length).toBeGreaterThan(0);
    });

    it("should remove null bytes", () => {
      const result = validateInput("hello\x00world");
      expect(result.sanitized).toBe("helloworld");
      expect(result.warnings).toContain("Null bytes removed from input");
    });

    it("should handle newlines based on config", () => {
      const withNewlines = validateInput("hello\nworld", { allowNewlines: true });
      expect(withNewlines.sanitized).toBe("hello\nworld");

      const withoutNewlines = validateInput("hello\nworld", { allowNewlines: false });
      expect(withoutNewlines.sanitized).toBe("hello world");
    });
  });

  describe("Path Sanitization", () => {
    it("should allow paths within base directory", () => {
      const result = sanitizePath("subdir/file.txt", "/home/user");
      expect(result).toBe("/home/user/subdir/file.txt");
    });

    it("should reject path traversal attempts", () => {
      const result = sanitizePath("../../../etc/passwd", "/home/user");
      expect(result).toBeNull();
    });

    it("should handle absolute paths correctly", () => {
      const result = sanitizePath("/etc/passwd", "/home/user");
      expect(result).toBeNull();
    });
  });

  describe("File Permission Hardening", () => {
    it("should create directory with secure permissions", () => {
      const dirPath = path.join(tempDir, "secure-dir");
      ensureSecureDirectory(dirPath);

      expect(fs.existsSync(dirPath)).toBe(true);
      const stats = fs.statSync(dirPath);
      expect(stats.mode & 0o777).toBe(SECURE_DIR_MODE);
    });

    it("should fix existing directory permissions", () => {
      const dirPath = path.join(tempDir, "insecure-dir");
      fs.mkdirSync(dirPath, { mode: 0o755 });

      ensureSecureDirectory(dirPath);
      const stats = fs.statSync(dirPath);
      expect(stats.mode & 0o777).toBe(SECURE_DIR_MODE);
    });

    it("should fix file permissions", () => {
      const filePath = path.join(tempDir, "insecure-file.txt");
      fs.writeFileSync(filePath, "test", { mode: 0o644 });

      ensureSecureFile(filePath);
      const stats = fs.statSync(filePath);
      expect(stats.mode & 0o777).toBe(SECURE_FILE_MODE);
    });

    it("should detect symlinks", () => {
      const realPath = path.join(tempDir, "real-file.txt");
      const linkPath = path.join(tempDir, "link-file.txt");

      fs.writeFileSync(realPath, "test");
      fs.symlinkSync(realPath, linkPath);

      expect(isSymlink(realPath)).toBe(false);
      expect(isSymlink(linkPath)).toBe(true);
    });
  });

  describe("Configuration Hardening", () => {
    it("should generate gateway token for non-loopback binding", () => {
      const config: OpenClawConfig = {
        gateway: {
          bind: "lan",
        },
      } as OpenClawConfig;

      const { config: hardened, changes } = hardenConfig(config);

      expect(hardened.gateway?.auth?.token).toBeDefined();
      expect(hardened.gateway?.auth?.token).toHaveLength(64);
      expect(changes).toContain("Generated secure gateway auth token");
    });

    it("should enable log redaction", () => {
      const config: OpenClawConfig = {
        logging: {
          redactSensitive: "off",
        },
      } as OpenClawConfig;

      const { config: hardened, changes } = hardenConfig(config);

      expect(hardened.logging?.redactSensitive).toBe("on");
      expect(changes).toContain("Enabled sensitive data redaction in logs");
    });

    it("should disable dangerous browser features", () => {
      const config: OpenClawConfig = {
        browser: {
          evaluateEnabled: true,
        },
      } as OpenClawConfig;

      const { config: hardened, changes } = hardenConfig(config);

      expect(hardened.browser?.evaluateEnabled).toBe(false);
      expect(changes).toContain("Disabled browser evaluate endpoint");
    });

    it("should not modify already secure config", () => {
      const config: OpenClawConfig = {
        gateway: {
          bind: "loopback",
          auth: {
            token: generateSecureToken(),
          },
        },
        logging: {
          redactSensitive: "on",
        },
      } as OpenClawConfig;

      const { changes } = hardenConfig(config);
      expect(changes).toHaveLength(0);
    });
  });

  describe("Rate Limiter", () => {
    it("should allow requests within limit", () => {
      const limiter = new RateLimiter({ maxRequestsPerIp: 5 });

      for (let i = 0; i < 5; i++) {
        expect(limiter.check("test-ip")).toBe(true);
      }
    });

    it("should block requests exceeding limit", () => {
      const limiter = new RateLimiter({ maxRequestsPerIp: 3 });

      expect(limiter.check("test-ip")).toBe(true);
      expect(limiter.check("test-ip")).toBe(true);
      expect(limiter.check("test-ip")).toBe(true);
      expect(limiter.check("test-ip")).toBe(false);
    });

    it("should track remaining requests", () => {
      const limiter = new RateLimiter({ maxRequestsPerIp: 5 });

      expect(limiter.remaining("new-ip")).toBe(5);
      limiter.check("new-ip");
      expect(limiter.remaining("new-ip")).toBe(4);
    });

    it("should reset after window expires", async () => {
      const limiter = new RateLimiter({
        windowMs: 50,
        maxRequestsPerIp: 1,
      });

      expect(limiter.check("test-ip")).toBe(true);
      expect(limiter.check("test-ip")).toBe(false);

      await new Promise((r) => setTimeout(r, 60));

      expect(limiter.check("test-ip")).toBe(true);
    });
  });

  describe("Security Headers", () => {
    it("should return all required security headers", () => {
      const headers = getSecurityHeaders();

      expect(headers["X-Content-Type-Options"]).toBe("nosniff");
      expect(headers["X-Frame-Options"]).toBe("DENY");
      expect(headers["X-XSS-Protection"]).toBe("1; mode=block");
      expect(headers["Content-Security-Policy"]).toBeDefined();
      expect(headers["Strict-Transport-Security"]).toBeDefined();
    });
  });

  describe("Audit Log", () => {
    it("should create properly formatted audit entries", () => {
      const entry = createAuditLogEntry(
        "user.login",
        "user@example.com",
        "/api/login",
        "success",
        { method: "password" }
      );

      expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(entry.action).toBe("user.login");
      expect(entry.actor).toBe("user@example.com");
      expect(entry.resource).toBe("/api/login");
      expect(entry.outcome).toBe("success");
      expect(entry.details).toEqual({ method: "password" });
    });
  });
});
