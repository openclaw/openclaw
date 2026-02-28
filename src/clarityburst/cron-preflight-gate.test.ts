/**
 * Tests for CronPreflightGate
 *
 * Comprehensive test coverage for ledger verification,
 * task validation, and immutability enforcement.
 *
 * NOTE: This test file imports core components only (ledger-verification,
 * cron-task, decision-cron, cron-preflight-gate) to avoid triggering
 * the ClarityBurst pack registry initialization which expects
 * src/ontology-packs to exist during test setup.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

// Import only the core components; do NOT import from pack-load or pack-registry
// because those initialize on module load and fail if ontology-packs doesn't exist
// in the test environment.
import { CronPreflightGate } from "./cron-preflight-gate.js";
import { assertCronTaskLocked, lockCronTask } from "./decision-cron.js";
import type { CronDecisionRecord } from "./decision-cron.js";

// Test fixture directory
const testDir = path.join(process.cwd(), ".test-cron-ledger");

/**
 * Helper: Create a test ledger file with valid entries
 */
function createValidLedger(filePath: string): void {
  const entries = [
    { runId: "run-001", workloadId: "w1", mode: "baseline", timestamp: "2026-01-01T00:00:00Z" },
    { runId: "run-002", workloadId: "w1", mode: "gated", timestamp: "2026-01-01T00:01:00Z" },
    { runId: "run-003", workloadId: "w2", mode: "baseline", timestamp: "2026-01-01T00:02:00Z" },
    { runId: "run-004", workloadId: "w3", mode: "baseline", timestamp: "2026-01-01T00:03:00Z" },
  ];
  const content = entries.map((e) => JSON.stringify(e)).join("\n");
  fs.writeFileSync(filePath, content);
}

/**
 * Helper: Create a test ledger with corrupt JSONL
 */
function createCorruptLedger(filePath: string): void {
  fs.writeFileSync(
    filePath,
    '{"valid": true}\n{invalid json line\n{"runId": "run-001"}'
  );
}

/**
 * Helper: Create a ledger with duplicate runIds
 */
function createDuplicateRunIdLedger(filePath: string): void {
  const entries = [
    { runId: "run-001", workloadId: "w1", mode: "baseline", timestamp: "2026-01-01T00:00:00Z" },
    { runId: "run-001", workloadId: "w2", mode: "baseline", timestamp: "2026-01-01T00:01:00Z" }, // duplicate
  ];
  const content = entries.map((e) => JSON.stringify(e)).join("\n");
  fs.writeFileSync(filePath, content);
}

/**
 * Helper: Create a ledger with baseline/gated mismatch (same runId)
 */
function createBaselineGatedMismatchLedger(filePath: string): void {
  const entries = [
    { runId: "run-001", workloadId: "w1", mode: "baseline", timestamp: "2026-01-01T00:00:00Z" },
    { runId: "run-001", workloadId: "w1", mode: "gated", timestamp: "2026-01-01T00:01:00Z" }, // same runId!
  ];
  const content = entries.map((e) => JSON.stringify(e)).join("\n");
  fs.writeFileSync(filePath, content);
}

describe("CronPreflightGate", () => {
  let gate: CronPreflightGate;
  let ledgerPath: string;

  beforeEach(() => {
    gate = new CronPreflightGate();
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }
    ledgerPath = path.join(testDir, "ledger.jsonl");
  });

  afterEach(() => {
    // Clean up test files
    if (fs.existsSync(ledgerPath)) {
      fs.unlinkSync(ledgerPath);
    }
    if (fs.existsSync(testDir)) {
      try {
        fs.rmdirSync(testDir);
      } catch {
        // Directory might not be empty, that's ok
      }
    }
  });

  describe("Test 1: Valid ledger + valid task → PROCEED with locked task", () => {
    it("should return PROCEED and lock the task", async () => {
      createValidLedger(ledgerPath);

      const result = await gate.validate("test-run-001", ledgerPath, "HEARTBEAT_CHECK");

      expect(result.outcome).toBe("PROCEED");
      if (result.outcome === "PROCEED") {
        expect(result.decision_record.nextCronTask).toBe("HEARTBEAT_CHECK");
        expect(result.decision_record.task_committed_at).toBeDefined();
        expect(result.decision_record.ledger_verification.valid).toBe(true);
      }
    });
  });

  describe("Test 2: Invalid ledger (corrupt JSONL) → ESCALATE_CRON_STATE_INVALID", () => {
    it("should escalate on corrupt JSONL", async () => {
      createCorruptLedger(ledgerPath);

      const result = await gate.validate("test-run-002", ledgerPath, "HEARTBEAT_CHECK");

      expect(result.outcome).toBe("ESCALATE_CRON_STATE_INVALID");
      if (result.outcome === "ESCALATE_CRON_STATE_INVALID") {
        expect(result.reason).toBe("INVALID_JSONL_FORMAT");
        expect(result.details).toContain("Invalid JSON");
      }
    });
  });

  describe("Test 3: Missing ledger file → ESCALATE_CRON_STATE_INVALID", () => {
    it("should escalate on missing ledger file", async () => {
      const missingPath = path.join(testDir, "does-not-exist.jsonl");

      const result = await gate.validate("test-run-003", missingPath, "HEARTBEAT_CHECK");

      expect(result.outcome).toBe("ESCALATE_CRON_STATE_INVALID");
      if (result.outcome === "ESCALATE_CRON_STATE_INVALID") {
        expect(result.reason).toBe("LEDGER_FILE_NOT_FOUND");
      }
    });
  });

  describe("Test 4: Invalid task enum value → ESCALATE_CRON_STATE_INVALID", () => {
    it("should escalate on invalid task enum value", async () => {
      createValidLedger(ledgerPath);

      const result = await gate.validate("test-run-004", ledgerPath, "INVALID_TASK");

      expect(result.outcome).toBe("ESCALATE_CRON_STATE_INVALID");
      if (result.outcome === "ESCALATE_CRON_STATE_INVALID") {
        expect(result.reason).toBe("TASK_ENUM_MISMATCH");
        expect(result.details).toContain("INVALID_TASK");
      }
    });
  });

  describe("Test 5: Task locked after validation → assertCronTaskLocked() passes", () => {
    it("should successfully assert locked task", async () => {
      createValidLedger(ledgerPath);

      const result = await gate.validate("test-run-005", ledgerPath, "CACHE_REFRESH");

      expect(result.outcome).toBe("PROCEED");
      if (result.outcome === "PROCEED") {
        const lockedTask = assertCronTaskLocked(result.decision_record);
        expect(lockedTask).toBe("CACHE_REFRESH");
      }
    });
  });

  describe("Test 6: Attempt to modify locked task → fails with clear error", () => {
    it("should throw error when trying to re-lock task", async () => {
      createValidLedger(ledgerPath);

      const result = await gate.validate("test-run-006", ledgerPath, "LOG_ROTATION");

      expect(result.outcome).toBe("PROCEED");
      if (result.outcome === "PROCEED") {
        const record = result.decision_record;

        // Attempt to lock a different task on same record
        expect(() => {
          lockCronTask(record, "BACKUP_EXECUTION");
        }).toThrowError(
          /already locked to LOG_ROTATION.*cannot change to BACKUP_EXECUTION/
        );

        // Verify original task is still locked
        expect(assertCronTaskLocked(record)).toBe("LOG_ROTATION");
      }
    });
  });

  describe("Test 7: Baseline/gated mismatch in ledger → ESCALATE_CRON_STATE_INVALID", () => {
    it("should escalate on baseline/gated mismatch (same runId)", async () => {
      createBaselineGatedMismatchLedger(ledgerPath);

      const result = await gate.validate("test-run-007", ledgerPath, "HEARTBEAT_CHECK");

      expect(result.outcome).toBe("ESCALATE_CRON_STATE_INVALID");
      if (result.outcome === "ESCALATE_CRON_STATE_INVALID") {
        // Note: baseline/gated mismatch with same runId is caught as DUPLICATE_RUN_IDS
        // because the duplicate runId check (Check 2) runs before baseline/gated check (Check 3)
        expect(result.reason).toBe("DUPLICATE_RUN_IDS");
      }
    });
  });

  describe("Test 8: Duplicate runIds → ESCALATE_CRON_STATE_INVALID", () => {
    it("should escalate on duplicate runIds in ledger", async () => {
      createDuplicateRunIdLedger(ledgerPath);

      const result = await gate.validate("test-run-008", ledgerPath, "HEARTBEAT_CHECK");

      expect(result.outcome).toBe("ESCALATE_CRON_STATE_INVALID");
      if (result.outcome === "ESCALATE_CRON_STATE_INVALID") {
        expect(result.reason).toBe("DUPLICATE_RUN_IDS");
      }
    });
  });

  describe("Additional: Verify decision record immutability", () => {
    it("should have immutable task field after locking", async () => {
      createValidLedger(ledgerPath);

      const result = await gate.validate("test-run-009", ledgerPath, "STATE_SYNC");

      expect(result.outcome).toBe("PROCEED");
      if (result.outcome === "PROCEED") {
        const record = result.decision_record;
        const originalTask = record.nextCronTask;

        // Try to modify nextCronTask directly (should fail on re-lock)
        expect(originalTask).toBe("STATE_SYNC");

        // Using lockCronTask should prevent any change
        expect(() => {
          lockCronTask(record, "METRICS_AGGREGATION");
        }).toThrow();
      }
    });
  });

  describe("Additional: Verify ledger verification result is attached", () => {
    it("should include ledger verification result in decision record", async () => {
      createValidLedger(ledgerPath);

      const result = await gate.validate(
        "test-run-010",
        ledgerPath,
        "CREDENTIAL_ROTATION"
      );

      expect(result.outcome).toBe("PROCEED");
      if (result.outcome === "PROCEED") {
        const record = result.decision_record;
        expect(record.ledger_verification).toBeDefined();
        expect(record.ledger_verification.valid).toBe(true);
        expect(record.ledger_verification.entries_checked).toBeGreaterThan(0);
        expect(record.ledger_verification.verified_at).toMatch(
          /^\d{4}-\d{2}-\d{2}T/
        ); // ISO 8601
      }
    });
  });

  describe("Additional: All valid cron tasks", () => {
    it("should accept all valid cron task IDs", async () => {
      createValidLedger(ledgerPath);

      const validTasks = [
        "HEARTBEAT_CHECK",
        "MEMORY_MAINTENANCE",
        "CACHE_REFRESH",
        "LOG_ROTATION",
        "BACKUP_EXECUTION",
        "SCHEDULED_REPORT",
        "CREDENTIAL_ROTATION",
        "HEALTH_PROBE",
        "INDEX_REBUILD",
        "STATE_SYNC",
        "METRICS_AGGREGATION",
        "CLEANUP_TEMP_DATA",
        "UPDATE_CONFIG_CACHE",
      ];

      for (const task of validTasks) {
        const result = await gate.validate("run-" + task, ledgerPath, task);
        expect(result.outcome).toBe("PROCEED");
        if (result.outcome === "PROCEED") {
          expect(result.decision_record.nextCronTask).toBe(task);
        }
      }
    });
  });
});
