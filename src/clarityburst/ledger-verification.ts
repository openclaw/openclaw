/**
 * Ledger Verification API for ClarityBurst
 *
 * Provides programmatic verification of the usage ledger invariants,
 * extracted from CLI subprocess logic into a reusable API.
 */

import fs from "node:fs";
import path from "node:path";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

/**
 * Failure reasons for ledger verification failures.
 */
export type LedgerVerificationFailureReason =
  | "FILE_NOT_FOUND"
  | "FILE_READ_ERROR"
  | "INVALID_JSONL_FORMAT"
  | "EMPTY_LEDGER"
  | "DUPLICATE_RUN_IDS"
  | "BASELINE_GATED_MISMATCH"
  | "MISSING_REQUIRED_FIELD"
  | "UNKNOWN_ERROR";

/**
 * Result of ledger verification with detailed error information.
 */
export interface LedgerVerificationResult {
  /** true if all invariants hold, false if any failed */
  valid: boolean;
  /** Number of entries checked in the verification window */
  entries_checked: number;
  /** Window size (typically 50 entries) */
  window_size: number;
  /** Specific failure reason if valid === false */
  failure_reason?: LedgerVerificationFailureReason;
  /** Detailed error message for operator debugging */
  error_message?: string;
  /** Timestamp of verification */
  verified_at: string;
}

/**
 * Load and verify the clarityburst usage ledger.
 *
 * Checks:
 * 1. File exists and is readable
 * 2. All entries are valid JSONL
 * 3. Last N entries (window) are checked for invariants:
 *    - Each entry has a non-empty runId
 *    - No duplicate runIds in the window
 *    - If a workloadId appears in both "baseline" and "gated" modes,
 *      they must have different runIds (not the same run)
 *
 * @param ledgerPath Path to the ledger file (defaults to docs/internal/clarityburst-usage-ledger.jsonl)
 * @param windowSize Number of recent entries to check (defaults to 50)
 * @returns LedgerVerificationResult with detailed status
 */
export async function verifyLedgerInvariants(
  ledgerPath: string = path.join(process.cwd(), "docs/internal/clarityburst-usage-ledger.jsonl"),
  windowSize: number = 50
): Promise<LedgerVerificationResult> {
  const verifiedAt = new Date().toISOString();

  // Check if file exists
  if (!fs.existsSync(ledgerPath)) {
    return {
      valid: false,
      entries_checked: 0,
      window_size: windowSize,
      failure_reason: "FILE_NOT_FOUND",
      error_message: `Ledger file not found at ${ledgerPath}`,
      verified_at: verifiedAt,
    };
  }

  // Read the file line by line and keep last N entries
  const entries: Array<Record<string, unknown>> = [];
  const fileStream = createReadStream(ledgerPath);
  const rl = createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  try {
    for await (const line of rl) {
      if (line.trim()) {
        try {
          const entry = JSON.parse(line) as Record<string, unknown>;
          entries.push(entry);
        } catch {
          return {
            valid: false,
            entries_checked: 0,
            window_size: windowSize,
            failure_reason: "INVALID_JSONL_FORMAT",
            error_message: `Invalid JSON on line: ${line.substring(0, 100)}...`,
            verified_at: verifiedAt,
          };
        }
      }
    }
  } catch (err) {
    return {
      valid: false,
      entries_checked: 0,
      window_size: windowSize,
      failure_reason: "FILE_READ_ERROR",
      error_message: `Error reading ledger file: ${err instanceof Error ? err.message : String(err)}`,
      verified_at: verifiedAt,
    };
  }

  // Keep only last N entries
  const lastN = entries.slice(-windowSize);
  if (lastN.length === 0) {
    return {
      valid: false,
      entries_checked: 0,
      window_size: windowSize,
      failure_reason: "EMPTY_LEDGER",
      error_message: "No entries found in ledger",
      verified_at: verifiedAt,
    };
  }

  // Check 1: every entry has a non-empty runId
  const runIdSet = new Set<string>();
  for (const entry of lastN) {
    const runId = entry.runId;
    if (!runId || typeof runId !== "string" || (runId as string).trim() === "") {
      return {
        valid: false,
        entries_checked: lastN.length,
        window_size: windowSize,
        failure_reason: "MISSING_REQUIRED_FIELD",
        error_message: "Entry missing or empty runId",
        verified_at: verifiedAt,
      };
    }
    runIdSet.add(runId as string);
  }

  // Check 2: no duplicate runIds exist within the window
  if (runIdSet.size !== lastN.length) {
    return {
      valid: false,
      entries_checked: lastN.length,
      window_size: windowSize,
      failure_reason: "DUPLICATE_RUN_IDS",
      error_message: `Duplicate runIds found in ledger window (checked ${lastN.length} entries)`,
      verified_at: verifiedAt,
    };
  }

  // Check 3: for workloadIds that appear in both mode="baseline" and mode="gated",
  // the runIds must differ (not the same run).
  const workloadMap: Record<string, Array<Record<string, unknown>>> = {};
  for (const entry of lastN) {
    const wid = entry.workloadId;
    if (!workloadMap[String(wid)]) {
      workloadMap[String(wid)] = [];
    }
    workloadMap[String(wid)].push(entry);
  }

  // Find the most recent workloadId with both baseline and gated
  let targetWorkloadId: string | null = null;
  for (let i = lastN.length - 1; i >= 0; i--) {
    const wid = String(lastN[i].workloadId);
    if (!targetWorkloadId) {
      const modes = new Set(workloadMap[wid].map((e) => e.mode));
      if (modes.has("baseline") && modes.has("gated")) {
        targetWorkloadId = wid;
      }
    }
  }

  if (targetWorkloadId) {
    const workloadEntries = workloadMap[targetWorkloadId];

    // Check exactly 2 entries
    if (workloadEntries.length !== 2) {
      return {
        valid: false,
        entries_checked: lastN.length,
        window_size: windowSize,
        failure_reason: "BASELINE_GATED_MISMATCH",
        error_message: `WorkloadId ${targetWorkloadId} has ${workloadEntries.length} entries, expected exactly 2`,
        verified_at: verifiedAt,
      };
    }

    // Check different runIds
    const runIds = new Set(workloadEntries.map((e) => e.runId));
    if (runIds.size !== 2) {
      return {
        valid: false,
        entries_checked: lastN.length,
        window_size: windowSize,
        failure_reason: "BASELINE_GATED_MISMATCH",
        error_message: `WorkloadId ${targetWorkloadId} baseline and gated have same runId`,
        verified_at: verifiedAt,
      };
    }
  }

  // All checks passed
  return {
    valid: true,
    entries_checked: lastN.length,
    window_size: windowSize,
    verified_at: verifiedAt,
  };
}
