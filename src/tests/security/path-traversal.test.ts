/**
 * Path Traversal Security Tests
 * Tests for preventing path traversal attacks
 */

import * as fs from "fs/promises";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { sanitizeSessionKey, ensureInboxDirectory, writeInboxMessage } from "../../teams/inbox.js";
import {
  validateTeamName,
  validateTeamNameOrThrow,
  getTeamDirectory,
} from "../../teams/storage.js";

vi.mock("fs/promises");
vi.mock("path", () => ({
  join: vi.fn((...args: string[]) => args.join("/")),
}));

describe("Path Traversal Prevention", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Given team name with path traversal sequences", () => {
    it("When team name contains ../ Then validation should fail", () => {
      const maliciousName = "../../../etc/passwd";
      expect(validateTeamName(maliciousName)).toBe(false);
      expect(() => validateTeamNameOrThrow(maliciousName)).toThrow();
    });

    it("When team name contains encoded path traversal Then validation should fail", () => {
      const maliciousName = "..%2F..%2Fetc%2Fpasswd";
      expect(validateTeamName(maliciousName)).toBe(false);
    });
  });

  describe("Given absolute path team name", () => {
    it("When team name is absolute path Then validation should fail", () => {
      const absolutePath = "/etc/passwd";
      expect(validateTeamName(absolutePath)).toBe(false);
      expect(() => validateTeamNameOrThrow(absolutePath)).toThrow();
    });

    it("When team name starts with / Then validation should fail", () => {
      const absolutePath = "/my-team";
      expect(validateTeamName(absolutePath)).toBe(false);
    });
  });

  describe("Given session key with dangerous characters", () => {
    it("When session key contains path separators Then sanitization should replace them", () => {
      const dangerousKey = "../../../etc/passwd";
      const sanitized = sanitizeSessionKey(dangerousKey);
      expect(sanitized).not.toContain("..");
      expect(sanitized).not.toContain("/");
    });

    it("When session key contains dangerous chars Then sanitization should handle them", () => {
      const dangerousKey = "session/.\\:key";
      const sanitized = sanitizeSessionKey(dangerousKey);
      expect(sanitized).not.toContain("/");
      expect(sanitized).not.toContain("\\");
      expect(sanitized).not.toContain(":");
      expect(sanitized).not.toContain(".");
    });
  });

  describe("Given team name length validation", () => {
    it("When team name exceeds 50 characters Then validation should fail", () => {
      const longName = "a".repeat(51);
      expect(validateTeamName(longName)).toBe(false);
      expect(() => validateTeamNameOrThrow(longName)).toThrow();
    });

    it("When team name is exactly 50 characters Then validation should pass", () => {
      const maxName = "a".repeat(50);
      expect(validateTeamName(maxName)).toBe(true);
      expect(() => validateTeamNameOrThrow(maxName)).not.toThrow();
    });
  });

  describe("Given directory path operations", () => {
    it("When getting team directory with valid name Then path should be safe", () => {
      const result = getTeamDirectory("/teams", "my-team");
      expect(result).toBe("/teams/my-team");
      expect(result).not.toContain("..");
    });

    it("When getting team directory with malicious name Then validation should reject it", () => {
      const maliciousName = "../../../etc";
      expect(validateTeamName(maliciousName)).toBe(false);
      expect(() => validateTeamNameOrThrow(maliciousName)).toThrow();
    });
  });

  describe("Given inbox operations with session keys", () => {
    it("When ensuring inbox with path traversal key Then directory should be safe", async () => {
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);

      await ensureInboxDirectory("my-team", "/teams", "../../../etc/passwd");

      const mkdirCall = vi.mocked(fs.mkdir).mock.calls[0];
      expect(mkdirCall[0]).not.toContain("..");
      expect(mkdirCall[0]).not.toMatch(/\/etc$/);
    });

    it("When writing inbox message with dangerous key Then file path should be safe", async () => {
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.appendFile).mockResolvedValue(undefined);

      await writeInboxMessage("my-team", "/teams", "../../../etc/passwd", {
        id: "test",
        content: "test",
      });

      const appendCall = vi.mocked(fs.appendFile).mock.calls[0];
      expect(appendCall[0]).not.toContain("..");
      expect(appendCall[0]).not.toMatch(/\/etc/);
    });
  });
});
