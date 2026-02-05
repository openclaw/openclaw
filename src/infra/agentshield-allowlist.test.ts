import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AgentShieldAllowlist } from "./agentshield-allowlist.js";

describe("AgentShieldAllowlist", () => {
  let tempDir: string;
  let allowlist: AgentShieldAllowlist;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentshield-allowlist-test-"));
    allowlist = new AgentShieldAllowlist(tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("add", () => {
    it("adds an entry to the allowlist", () => {
      allowlist.add({
        fingerprint: "abc123def456",
        toolName: "file_write",
        createdAt: "2025-01-01T00:00:00Z",
      });

      const entries = allowlist.list();
      expect(entries.length).toBe(1);
      expect(entries[0]?.fingerprint).toBe("abc123def456");
      expect(entries[0]?.toolName).toBe("file_write");
    });

    it("updates existing entry with same fingerprint", () => {
      allowlist.add({
        fingerprint: "same-fp",
        toolName: "tool-1",
        createdAt: "2025-01-01T00:00:00Z",
      });

      allowlist.add({
        fingerprint: "same-fp",
        toolName: "tool-1",
        createdAt: "2025-01-01T00:01:00Z",
        notes: "Updated",
      });

      const entries = allowlist.list();
      expect(entries.length).toBe(1);
      expect(entries[0]?.notes).toBe("Updated");
    });
  });

  describe("isAllowed", () => {
    it("returns true for allowed fingerprint", () => {
      allowlist.add({
        fingerprint: "allowed-fp",
        toolName: "tool",
        createdAt: "2025-01-01T00:00:00Z",
      });

      expect(allowlist.isAllowed("allowed-fp")).toBe(true);
    });

    it("returns false for unknown fingerprint", () => {
      expect(allowlist.isAllowed("unknown-fp")).toBe(false);
    });
  });

  describe("isAllowedForTool", () => {
    it("returns true for matching fingerprint and tool", () => {
      allowlist.add({
        fingerprint: "fp-1",
        toolName: "specific-tool",
        createdAt: "2025-01-01T00:00:00Z",
      });

      expect(allowlist.isAllowedForTool("fp-1", "specific-tool")).toBe(true);
    });

    it("returns false for matching fingerprint but different tool", () => {
      allowlist.add({
        fingerprint: "fp-1",
        toolName: "specific-tool",
        createdAt: "2025-01-01T00:00:00Z",
      });

      expect(allowlist.isAllowedForTool("fp-1", "other-tool")).toBe(false);
    });
  });

  describe("get", () => {
    it("returns entry for fingerprint", () => {
      allowlist.add({
        fingerprint: "get-fp",
        toolName: "tool",
        createdAt: "2025-01-01T00:00:00Z",
        notes: "Test entry",
      });

      const entry = allowlist.get("get-fp");
      expect(entry).not.toBeNull();
      expect(entry?.notes).toBe("Test entry");
    });

    it("returns null for unknown fingerprint", () => {
      expect(allowlist.get("unknown")).toBeNull();
    });
  });

  describe("remove", () => {
    it("removes an entry", () => {
      allowlist.add({
        fingerprint: "remove-fp",
        toolName: "tool",
        createdAt: "2025-01-01T00:00:00Z",
      });

      const removed = allowlist.remove("remove-fp");
      expect(removed).toBe(true);
      expect(allowlist.isAllowed("remove-fp")).toBe(false);
    });

    it("returns false for unknown fingerprint", () => {
      const removed = allowlist.remove("unknown");
      expect(removed).toBe(false);
    });
  });

  describe("list", () => {
    it("returns all entries", () => {
      allowlist.add({
        fingerprint: "fp-1",
        toolName: "tool-1",
        createdAt: "2025-01-01T00:00:00Z",
      });

      allowlist.add({
        fingerprint: "fp-2",
        toolName: "tool-2",
        createdAt: "2025-01-01T00:01:00Z",
      });

      const entries = allowlist.list();
      expect(entries.length).toBe(2);
    });

    it("returns entries sorted by createdAt descending", () => {
      allowlist.add({
        fingerprint: "fp-older",
        toolName: "tool",
        createdAt: "2025-01-01T00:00:00Z",
      });

      allowlist.add({
        fingerprint: "fp-newer",
        toolName: "tool",
        createdAt: "2025-01-01T00:05:00Z",
      });

      const entries = allowlist.list();
      expect(entries[0]?.fingerprint).toBe("fp-newer");
      expect(entries[1]?.fingerprint).toBe("fp-older");
    });
  });

  describe("clear", () => {
    it("removes all entries", () => {
      allowlist.add({
        fingerprint: "fp-1",
        toolName: "tool",
        createdAt: "2025-01-01T00:00:00Z",
      });

      allowlist.add({
        fingerprint: "fp-2",
        toolName: "tool",
        createdAt: "2025-01-01T00:00:00Z",
      });

      allowlist.clear();

      expect(allowlist.list().length).toBe(0);
    });
  });

  describe("persistence", () => {
    it("persists data across instances", () => {
      allowlist.add({
        fingerprint: "persist-fp",
        toolName: "tool",
        createdAt: "2025-01-01T00:00:00Z",
      });

      // Create new instance pointing to same directory
      const allowlist2 = new AgentShieldAllowlist(tempDir);
      expect(allowlist2.isAllowed("persist-fp")).toBe(true);
    });
  });
});
