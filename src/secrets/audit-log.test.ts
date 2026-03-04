import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { auditLog, type AuditEntry } from "./audit-log.js";

// vi.hoisted runs before imports — use require() inline
const { mockDataDir } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require("node:path") as typeof import("node:path");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeOs = require("node:os") as typeof import("node:os");
  return { mockDataDir: path.join(nodeOs.tmpdir(), `openclaw-audit-test-${Date.now()}`) };
});

vi.mock("../config/paths.js", () => ({
  STATE_DIR: mockDataDir,
  resolveStateDir: () => mockDataDir,
  resolveConfigPath: () => require("node:path").join(mockDataDir, "openclaw.json"),
}));

describe("audit", () => {
  const auditLogPath = join(mockDataDir, "audit", "credentials.jsonl");

  beforeEach(async () => {
    // Clean up previous test data
    try {
      await rm(mockDataDir, { recursive: true, force: true });
    } catch {
      // Ignore if doesn't exist
    }
  });

  describe("auditLog", () => {
    test("creates audit directory if missing", async () => {
      const entry: AuditEntry = {
        event: "credential_accessed",
        name: "test_secret",
        timestamp: Date.now(),
      };

      await auditLog(entry);

      // Verify directory was created
      const stats = await readFile(auditLogPath, "utf-8");
      expect(stats).toBeDefined();
    });

    test("appends JSONL line", async () => {
      const entry1: AuditEntry = {
        event: "credential_accessed",
        name: "test_secret",
        timestamp: 1234567890000,
      };

      const entry2: AuditEntry = {
        event: "grant_created",
        name: "another_secret",
        timestamp: 1234567891000,
        details: { ttlMinutes: 60 },
      };

      await auditLog(entry1);
      await auditLog(entry2);

      const content = await readFile(auditLogPath, "utf-8");
      const lines = content.trim().split("\n");

      expect(lines).toHaveLength(2);
    });

    test("entry format is valid JSON", async () => {
      const entry: AuditEntry = {
        event: "credential_resolved",
        name: "api_key",
        tool: "exec",
        timestamp: Date.now(),
        details: { ref: "secret:api_key" },
      };

      await auditLog(entry);

      const content = await readFile(auditLogPath, "utf-8");
      const line = content.trim();

      // Should not throw
      const parsed = JSON.parse(line);
      expect(parsed.event).toBe("credential_resolved");
      expect(parsed.name).toBe("api_key");
      expect(parsed.tool).toBe("exec");
      expect(parsed.timestamp).toBeTypeOf("number");
      expect(parsed.details).toEqual({ ref: "secret:api_key" });
    });

    test("handles multiple entries correctly", async () => {
      const entries: AuditEntry[] = [
        { event: "credential_accessed", name: "secret1", timestamp: 1000 },
        { event: "grant_created", name: "secret2", timestamp: 2000 },
        {
          event: "credential_denied",
          name: "secret3",
          timestamp: 3000,
          details: { reason: "expired" },
        },
      ];

      for (const entry of entries) {
        await auditLog(entry);
      }

      const content = await readFile(auditLogPath, "utf-8");
      const lines = content.trim().split("\n");

      expect(lines).toHaveLength(3);

      const parsed = lines.map((line) => JSON.parse(line));
      expect(parsed[0].event).toBe("credential_accessed");
      expect(parsed[1].event).toBe("grant_created");
      expect(parsed[2].event).toBe("credential_denied");
      expect(parsed[2].details).toEqual({ reason: "expired" });
    });

    test("preserves existing log entries when appending", async () => {
      // Write first entry
      const entry1: AuditEntry = {
        event: "credential_accessed",
        name: "existing_secret",
        timestamp: 1000,
      };
      await auditLog(entry1);

      // Write second entry
      const entry2: AuditEntry = {
        event: "grant_created",
        name: "new_secret",
        timestamp: 2000,
      };
      await auditLog(entry2);

      const content = await readFile(auditLogPath, "utf-8");
      const lines = content.trim().split("\n");

      expect(lines).toHaveLength(2);

      const parsed0 = JSON.parse(lines[0]);
      const parsed1 = JSON.parse(lines[1]);

      expect(parsed0.name).toBe("existing_secret");
      expect(parsed1.name).toBe("new_secret");
    });
  });
});
