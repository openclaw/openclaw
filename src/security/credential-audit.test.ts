import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  exportAuditLog,
  getAuditStats,
  logCredentialAccess,
  purgeOldAuditEntries,
  queryAuditLog,
  resetAuditHashCacheForTest,
  verifyAuditLogIntegrity,
  type AuditOptions,
  type CredentialAuditAction,
} from "./credential-audit.js";
import type { CredentialScope } from "./credential-vault.js";

describe("credential-audit", () => {
  let testAuditDir: string;
  let auditOptions: AuditOptions;

  beforeEach(() => {
    testAuditDir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-test-"));
    auditOptions = { auditDir: testAuditDir };
  });

  afterEach(() => {
    if (testAuditDir && fs.existsSync(testAuditDir)) {
      fs.rmSync(testAuditDir, { recursive: true, force: true });
    }
  });

  describe("logCredentialAccess", () => {
    it("should log a credential access event", () => {
      logCredentialAccess({
        action: "read",
        credentialName: "test-api-key",
        scope: "provider",
        requestor: "test-module",
        success: true,
        options: auditOptions,
      });

      const entries = queryAuditLog(undefined, auditOptions);
      expect(entries).toHaveLength(1);
      expect(entries[0].action).toBe("read");
      expect(entries[0].credentialName).toBe("test-api-key");
      expect(entries[0].scope).toBe("provider");
      expect(entries[0].requestor).toBe("test-module");
      expect(entries[0].success).toBe(true);
    });

    it("should log failed access attempts", () => {
      logCredentialAccess({
        action: "read",
        credentialName: "missing-key",
        scope: "provider",
        requestor: "test-module",
        success: false,
        error: "Credential not found",
        options: auditOptions,
      });

      const entries = queryAuditLog(undefined, auditOptions);
      expect(entries).toHaveLength(1);
      expect(entries[0].success).toBe(false);
      expect(entries[0].error).toBe("Credential not found");
    });

    it("should chain entry hashes correctly", () => {
      logCredentialAccess({
        action: "write",
        credentialName: "key-1",
        scope: "provider",
        requestor: "test",
        success: true,
        options: auditOptions,
      });

      logCredentialAccess({
        action: "read",
        credentialName: "key-1",
        scope: "provider",
        requestor: "test",
        success: true,
        options: auditOptions,
      });

      const entries = queryAuditLog(undefined, auditOptions);
      expect(entries).toHaveLength(2);

      // First entry should have genesis hash as prev
      expect(entries[0].prevEntryHash).toBe(
        "0000000000000000000000000000000000000000000000000000000000000000",
      );

      // Second entry should chain to first
      expect(entries[1].prevEntryHash).toBe(entries[0].entryHash);
    });

    it("should log all action types", () => {
      const actions: CredentialAuditAction[] = ["read", "write", "rotate", "delete", "list"];

      for (const action of actions) {
        logCredentialAccess({
          action,
          credentialName: `test-${action}`,
          scope: "provider",
          requestor: "test",
          success: true,
          options: auditOptions,
        });
      }

      const entries = queryAuditLog(undefined, auditOptions);
      expect(entries).toHaveLength(5);
    });
  });

  describe("queryAuditLog", () => {
    beforeEach(() => {
      // Create test entries
      const testData: Array<{
        action: CredentialAuditAction;
        name: string;
        scope: CredentialScope;
        requestor: string;
      }> = [
        { action: "write", name: "api-key", scope: "provider", requestor: "setup" },
        { action: "read", name: "api-key", scope: "provider", requestor: "agent" },
        { action: "read", name: "bot-token", scope: "channel", requestor: "bot" },
        { action: "rotate", name: "api-key", scope: "provider", requestor: "admin" },
        { action: "delete", name: "old-key", scope: "integration", requestor: "cleanup" },
      ];

      for (const entry of testData) {
        logCredentialAccess({
          action: entry.action,
          credentialName: entry.name,
          scope: entry.scope,
          requestor: entry.requestor,
          success: true,
          options: auditOptions,
        });
      }
    });

    it("should return all entries without filter", () => {
      const entries = queryAuditLog(undefined, auditOptions);
      expect(entries).toHaveLength(5);
    });

    it("should filter by credential name", () => {
      const entries = queryAuditLog({ credentialName: "api-key" }, auditOptions);
      expect(entries).toHaveLength(3);
    });

    it("should filter by scope", () => {
      const entries = queryAuditLog({ scope: "provider" }, auditOptions);
      expect(entries).toHaveLength(3);
    });

    it("should filter by action", () => {
      const entries = queryAuditLog({ action: "read" }, auditOptions);
      expect(entries).toHaveLength(2);
    });

    it("should filter by requestor", () => {
      const entries = queryAuditLog({ requestor: "agent" }, auditOptions);
      expect(entries).toHaveLength(1);
    });

    it("should apply limit", () => {
      const entries = queryAuditLog({ limit: 2 }, auditOptions);
      expect(entries).toHaveLength(2);
    });

    it("should combine filters", () => {
      const entries = queryAuditLog({ scope: "provider", action: "read" }, auditOptions);
      expect(entries).toHaveLength(1);
    });
  });

  describe("verifyAuditLogIntegrity", () => {
    it("should verify intact audit log", () => {
      // Create valid chain
      for (let i = 0; i < 5; i++) {
        logCredentialAccess({
          action: "read",
          credentialName: `key-${i}`,
          scope: "provider",
          requestor: "test",
          success: true,
          options: auditOptions,
        });
      }

      const integrity = verifyAuditLogIntegrity(auditOptions);
      expect(integrity.valid).toBe(true);
      if (integrity.valid) {
        expect(integrity.entryCount).toBe(5);
      }
    });

    it("should detect modified entry", () => {
      logCredentialAccess({
        action: "write",
        credentialName: "key-1",
        scope: "provider",
        requestor: "test",
        success: true,
        options: auditOptions,
      });

      logCredentialAccess({
        action: "read",
        credentialName: "key-1",
        scope: "provider",
        requestor: "test",
        success: true,
        options: auditOptions,
      });

      // Tamper with the audit log
      const auditPath = path.join(testAuditDir, "audit.jsonl");
      const content = fs.readFileSync(auditPath, "utf8");
      const lines = content.trim().split("\n");
      const entry = JSON.parse(lines[0]);
      entry.requestor = "hacker"; // Modify entry
      lines[0] = JSON.stringify(entry);
      fs.writeFileSync(auditPath, lines.join("\n") + "\n");

      const integrity = verifyAuditLogIntegrity(auditOptions);
      expect(integrity.valid).toBe(false);
      if (!integrity.valid) {
        expect(integrity.reason).toContain("hash mismatch");
      }
    });

    it("should detect broken chain", () => {
      for (let i = 0; i < 3; i++) {
        logCredentialAccess({
          action: "read",
          credentialName: `key-${i}`,
          scope: "provider",
          requestor: "test",
          success: true,
          options: auditOptions,
        });
      }

      // Break the chain by removing middle entry
      const auditPath = path.join(testAuditDir, "audit.jsonl");
      const content = fs.readFileSync(auditPath, "utf8");
      const lines = content.trim().split("\n");
      // Remove middle entry
      lines.splice(1, 1);
      fs.writeFileSync(auditPath, lines.join("\n") + "\n");

      const integrity = verifyAuditLogIntegrity(auditOptions);
      expect(integrity.valid).toBe(false);
      if (!integrity.valid) {
        expect(integrity.reason).toContain("Chain broken");
      }
    });

    it("should handle empty log", () => {
      const integrity = verifyAuditLogIntegrity(auditOptions);
      expect(integrity.valid).toBe(true);
      if (integrity.valid) {
        expect(integrity.entryCount).toBe(0);
      }
    });
  });

  describe("exportAuditLog", () => {
    beforeEach(() => {
      logCredentialAccess({
        action: "write",
        credentialName: "test-key",
        scope: "provider",
        requestor: "setup",
        success: true,
        options: auditOptions,
      });

      logCredentialAccess({
        action: "read",
        credentialName: "test-key",
        scope: "provider",
        requestor: "agent",
        success: true,
        options: auditOptions,
      });
    });

    it("should export as JSON", () => {
      const json = exportAuditLog({ format: "json", options: auditOptions });
      const parsed = JSON.parse(json);

      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(2);
      expect(parsed[0].action).toBe("write");
    });

    it("should export as CSV", () => {
      const csv = exportAuditLog({ format: "csv", options: auditOptions });
      const lines = csv.split("\n");

      expect(lines[0]).toContain("timestamp");
      expect(lines[0]).toContain("action");
      expect(lines[0]).toContain("credentialName");
      expect(lines).toHaveLength(3); // header + 2 entries
    });

    it("should filter by time range", () => {
      const now = Date.now();
      const future = now + 1000000;

      const json = exportAuditLog({
        format: "json",
        since: future,
        options: auditOptions,
      });
      const parsed = JSON.parse(json);

      expect(parsed).toHaveLength(0);
    });
  });

  describe("getAuditStats", () => {
    beforeEach(() => {
      // Create varied test data
      const testData = [
        { action: "write" as const, scope: "provider" as const, success: true },
        { action: "read" as const, scope: "provider" as const, success: true },
        { action: "read" as const, scope: "provider" as const, success: true },
        { action: "read" as const, scope: "channel" as const, success: false },
        { action: "rotate" as const, scope: "provider" as const, success: true },
      ];

      let idx = 0;
      for (const entry of testData) {
        logCredentialAccess({
          action: entry.action,
          credentialName: `key-${idx}`,
          scope: entry.scope,
          requestor: `req-${idx % 2}`,
          success: entry.success,
          options: auditOptions,
        });
        idx++;
      }
    });

    it("should count by action", () => {
      const stats = getAuditStats({ options: auditOptions });

      expect(stats.byAction.read).toBe(3);
      expect(stats.byAction.write).toBe(1);
      expect(stats.byAction.rotate).toBe(1);
      expect(stats.byAction.delete).toBe(0);
    });

    it("should count by scope", () => {
      const stats = getAuditStats({ options: auditOptions });

      expect(stats.byScope.provider).toBe(4);
      expect(stats.byScope.channel).toBe(1);
    });

    it("should calculate success rate", () => {
      const stats = getAuditStats({ options: auditOptions });

      expect(stats.successRate).toBe(0.8); // 4 out of 5
    });

    it("should count unique requestors", () => {
      const stats = getAuditStats({ options: auditOptions });

      expect(stats.uniqueRequestors).toBe(2); // req-0 and req-1
    });

    it("should count unique credentials", () => {
      const stats = getAuditStats({ options: auditOptions });

      expect(stats.uniqueCredentials).toBe(5);
    });
  });

  describe("purgeOldAuditEntries", () => {
    it("should remove entries older than threshold", () => {
      // Create entries
      for (let i = 0; i < 5; i++) {
        logCredentialAccess({
          action: "read",
          credentialName: `key-${i}`,
          scope: "provider",
          requestor: "test",
          success: true,
          options: auditOptions,
        });
      }

      // Modify timestamps to make some entries old
      const auditPath = path.join(testAuditDir, "audit.jsonl");
      const content = fs.readFileSync(auditPath, "utf8");
      const lines = content.trim().split("\n");

      const oldTimestamp = Date.now() - 100 * 24 * 60 * 60 * 1000; // 100 days ago
      for (let i = 0; i < 3; i++) {
        const entry = JSON.parse(lines[i]);
        entry.timestamp = oldTimestamp;
        lines[i] = JSON.stringify(entry);
      }
      fs.writeFileSync(auditPath, lines.join("\n") + "\n");

      // Purge
      const removed = purgeOldAuditEntries({ olderThanDays: 30, options: auditOptions });

      expect(removed).toBe(3);

      // Verify remaining entries
      const entries = queryAuditLog(undefined, auditOptions);
      expect(entries).toHaveLength(2);

      // Verify chain is still valid
      const integrity = verifyAuditLogIntegrity(auditOptions);
      expect(integrity.valid).toBe(true);
    });

    it("should return 0 if nothing to purge", () => {
      logCredentialAccess({
        action: "read",
        credentialName: "recent",
        scope: "provider",
        requestor: "test",
        success: true,
        options: auditOptions,
      });

      const removed = purgeOldAuditEntries({ olderThanDays: 30, options: auditOptions });

      expect(removed).toBe(0);
    });
  });

  describe("file permissions", () => {
    it("should create audit file with secure permissions", () => {
      logCredentialAccess({
        action: "read",
        credentialName: "test",
        scope: "provider",
        requestor: "test",
        success: true,
        options: auditOptions,
      });

      const auditPath = path.join(testAuditDir, "audit.jsonl");
      const stat = fs.statSync(auditPath);

      const mode = stat.mode & 0o777;
      expect(mode).toBe(0o600);
    });
  });

  describe("malformed JSONL resilience (H-04 / TC-2)", () => {
    const auditPath = () => path.join(testAuditDir, "audit.jsonl");

    function writeLines(lines: string[]): void {
      fs.writeFileSync(auditPath(), lines.join("\n") + "\n", { mode: 0o600 });
    }

    it("returns valid entries when one line is corrupted", () => {
      // Write two valid entries then inject a corrupt line in the middle
      logCredentialAccess({
        action: "write",
        credentialName: "key-a",
        scope: "provider",
        requestor: "test",
        success: true,
        options: auditOptions,
      });
      logCredentialAccess({
        action: "read",
        credentialName: "key-b",
        scope: "channel",
        requestor: "test",
        success: true,
        options: auditOptions,
      });

      const content = fs.readFileSync(auditPath(), "utf8");
      const lines = content.trim().split("\n");
      // Insert a malformed line between the two valid entries
      lines.splice(1, 0, "NOT VALID JSON {{{{");
      writeLines(lines);

      // queryAuditLog should still return 2 valid entries (not 0 and not throw)
      const entries = queryAuditLog(undefined, auditOptions);
      expect(entries).toHaveLength(2);
      expect(entries[0].credentialName).toBe("key-a");
      expect(entries[1].credentialName).toBe("key-b");
    });

    it("returns all valid entries when the last line is truncated", () => {
      for (let i = 0; i < 3; i++) {
        logCredentialAccess({
          action: "read",
          credentialName: `cred-${i}`,
          scope: "provider",
          requestor: "test",
          success: true,
          options: auditOptions,
        });
      }

      const content = fs.readFileSync(auditPath(), "utf8");
      const lines = content.trim().split("\n");
      // Truncate the last line to simulate a torn write
      lines[lines.length - 1] = lines[lines.length - 1].slice(0, 10);
      writeLines(lines);

      const entries = queryAuditLog(undefined, auditOptions);
      expect(entries).toHaveLength(2); // first two survive; third is malformed
    });

    it("returns empty array when every line is malformed", () => {
      writeLines(["garbage", "also garbage", "{"]);

      const entries = queryAuditLog(undefined, auditOptions);
      expect(entries).toHaveLength(0);
    });

    it("verifyAuditLogIntegrity skips malformed lines and reports invalid chain", () => {
      // 3 valid chained entries
      for (let i = 0; i < 3; i++) {
        logCredentialAccess({
          action: "read",
          credentialName: "chain-key",
          scope: "provider",
          requestor: "test",
          success: true,
          options: auditOptions,
        });
      }

      const content = fs.readFileSync(auditPath(), "utf8");
      const lines = content.trim().split("\n");
      // Replace the middle entry with garbage — chain is now broken
      lines[1] = "INVALID";
      writeLines(lines);

      // Integrity check should detect the broken chain (entries 0 and 2 are not linked)
      const integrity = verifyAuditLogIntegrity(auditOptions);
      expect(integrity.valid).toBe(false);
    });
  });

  describe("last-hash cache (P-H4)", () => {
    beforeEach(() => {
      // Each test starts with a clean cache to avoid cross-test interference.
      resetAuditHashCacheForTest();
    });

    it("reads the audit file only once for 3 sequential logCredentialAccess calls", () => {
      // Pre-populate the audit file so readAuditEntries actually calls readFileSync
      // on the first (cache-miss) lookup.  Without an existing file, readAuditEntries
      // short-circuits via existsSync and never calls readFileSync.
      logCredentialAccess({
        action: "read",
        credentialName: "seed-key",
        scope: "provider",
        requestor: "test",
        success: true,
        options: auditOptions,
      });
      // Reset the cache so the next call is a genuine cache miss against the existing file.
      resetAuditHashCacheForTest();

      // Spy on readFileSync and count calls to the audit.jsonl file.
      // Call-through is preserved so real behaviour is unaffected.
      const spy = vi.spyOn(fs, "readFileSync");
      const auditReads = () =>
        spy.mock.calls.filter((args) => String(args[0]).endsWith("audit.jsonl")).length;

      for (let i = 0; i < 3; i++) {
        logCredentialAccess({
          action: "read",
          credentialName: `key-${i}`,
          scope: "provider",
          requestor: "test",
          success: true,
          options: auditOptions,
        });
      }

      // First call has a cache miss (1 read); calls 2 and 3 are served from the cache.
      expect(auditReads()).toBe(1);
      spy.mockRestore();
    });

    it("produces a valid hash chain when using the cached last-hash", () => {
      for (let i = 0; i < 5; i++) {
        logCredentialAccess({
          action: "read",
          credentialName: `ckey-${i}`,
          scope: "provider",
          requestor: "test",
          success: true,
          options: auditOptions,
        });
      }

      const integrity = verifyAuditLogIntegrity(auditOptions);
      expect(integrity.valid).toBe(true);
      if (integrity.valid) {
        expect(integrity.entryCount).toBe(5);
      }
    });

    it("re-reads the file after resetAuditHashCacheForTest (simulates external change)", () => {
      // Write 2 entries, warming the cache.
      for (let i = 0; i < 2; i++) {
        logCredentialAccess({
          action: "read",
          credentialName: `init-${i}`,
          scope: "provider",
          requestor: "test",
          success: true,
          options: auditOptions,
        });
      }

      resetAuditHashCacheForTest();

      const spy = vi.spyOn(fs, "readFileSync");
      logCredentialAccess({
        action: "write",
        credentialName: "post-reset",
        scope: "provider",
        requestor: "test",
        success: true,
        options: auditOptions,
      });

      const auditReads = spy.mock.calls.filter((args) =>
        String(args[0]).endsWith("audit.jsonl"),
      ).length;
      expect(auditReads).toBeGreaterThan(0); // cache was cleared; file re-read
      spy.mockRestore();

      // Chain integrity should still hold.
      expect(verifyAuditLogIntegrity(auditOptions).valid).toBe(true);
    });

    it("invalidates the cache after purgeOldAuditEntries and chain remains valid", () => {
      for (let i = 0; i < 3; i++) {
        logCredentialAccess({
          action: "read",
          credentialName: `purge-key-${i}`,
          scope: "provider",
          requestor: "test",
          success: true,
          options: auditOptions,
        });
      }

      // Purge removes nothing (entries are recent) but still invalidates the cache.
      purgeOldAuditEntries({ olderThanDays: 30, options: auditOptions });

      // Write a new entry — if the cache had stale data this would break the chain.
      logCredentialAccess({
        action: "write",
        credentialName: "after-purge",
        scope: "provider",
        requestor: "test",
        success: true,
        options: auditOptions,
      });

      const integrity = verifyAuditLogIntegrity(auditOptions);
      expect(integrity.valid).toBe(true);
    });
  });
});
