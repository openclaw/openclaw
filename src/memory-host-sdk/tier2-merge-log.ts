/**
 * Tier 2 Merge Log — ENFORCEMENT-MECHANICS.md §3.2
 *
 * All Tier 2 (Reference) merges are logged with full state-at-approval capture.
 * The log captures the system state at the moment Ray approves a promotion,
 * not after the write completes. This closes the fork-sync gap where post-merge
 * tests fail but the log shows clean passage.
 *
 * Key enforcement properties:
 * - contentHashAtProposal computed at CREATION time, not submission
 * - manifestHashAtProposal computed at CREATION time
 * - isolationTestsStatus captured at SEAL time (before write finalization)
 * - stateAtApproval captures full system state at approval moment
 * - Every entry is append-only (no mutation or deletion)
 *
 * @see ENFORCEMENT-MECHANICS.md §3.2, §1.2
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/** Schema version for the merge log entry format */
const TIER2_MERGE_LOG_SCHEMA_VERSION = "1.0.0";

/** Isolation test result status */
export type IsolationTestStatus = "pass" | "fail" | "skipped";

/** Merge operation types */
export type MergeOperation = "promote" | "demote" | "merge";

/** Tier identifiers */
export type MemoryTier = "daily" | "reference" | "always";

/** Schema for a single merge log entry — ENFORCEMENT-MECHANICS.md §3.2 */
export interface Tier2MergeLogEntry {
  /** Schema version for forward compatibility */
  schemaVersion: typeof TIER2_MERGE_LOG_SCHEMA_VERSION;

  /** ISO-8601 timestamp of the merge operation */
  timestamp: string;

  /** Agent ID that initiated the merge */
  agentId: string;

  /** Type of merge operation */
  operation: MergeOperation;

  /** Source tier (where content is coming from) */
  sourceTier: MemoryTier;

  /** Target tier (where content is going) */
  targetTier: MemoryTier;

  /** SHA-256 hash of the content at proposal creation time (§1.2 Constraint 3) */
  contentHashAtProposal: string;

  /** SHA-256 hash of the manifest at proposal creation time (§1.2 Constraint 3) */
  manifestHashAtProposal: string;

  /** SHA-256 hash of the diff content */
  diffSha: string;

  /** Unique identifier for the sealed proposal (§1.2) */
  sealedProposalId: string;

  /** Isolation test status at seal time — BEFORE write finalization */
  isolationTestsStatus: {
    pre: IsolationTestStatus;
    post: IsolationTestStatus;
  };

  /** Full system state at approval moment (§3.3) */
  stateAtApproval: {
    /** MD5 hash of MEMORY.md content at approval time */
    alwaysMd5: string;
    /** List of all reference-tier files with their content hashes */
    referenceFiles: Array<{ file: string; hash: string }>;
    /** Number of pending proposals at approval time */
    activeProposalCount: number;
  };

  /** Forensics schema additions (Gunn's §2.1 additions) */
  forensics: {
    /** Full commit SHA range for the upstream sync (not single commit) */
    upstreamCommitRange: string;
    /** Classifier version used for this merge (prevents drift masking) */
    classifierVersion: string;
    /** Hash of the test baseline before merge */
    preMergeTestHash: string;
    /** Pass/fail status on the 612-test gate after merge */
    postMergeTestStatus: "pass" | "fail" | "pending";
  };
}

/** Sealed proposal status */
export type SealedProposalStatus = "draft" | "sealed" | "approved" | "rejected" | "expired";

/** Sealed proposal entry — ENFORCEMENT-MECHANICS.md §1.2 */
export interface SealedProposal {
  /** Unique proposal identifier */
  id: string;

  /** ISO-8601 timestamp of proposal creation */
  createdAt: string;

  /** Agent ID that created the proposal */
  proposingAgent: string;

  /** Current status of the proposal */
  status: SealedProposalStatus;

  /** Content hash computed at CREATION time (§1.2 Constraint 3) */
  contentHashAtCreation: string;

  /** Manifest hash computed at CREATION time (§1.2 Constraint 3) */
  manifestHashAtCreation: string;

  /** Source tier */
  sourceTier: MemoryTier;

  /** Target tier */
  targetTier: MemoryTier;

  /** Content of the proposal (non-visible during draft phase) */
  content: string;

  /** ISO-8601 timestamp of seal closure */
  sealedAt?: string;

  /** ISO-8601 timestamp of approval/rejection */
  decidedAt?: string;

  /** Reason for approval or rejection */
  decisionReason?: string;

  /** ISO-8601 timestamp of expiration (if applicable) */
  expiresAt?: string;
}

/**
 * Compute SHA-256 hash of content.
 */
export function computeHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Compute MD5 hash of content (for stateAtApproval.alwaysMd5).
 */
export function computeMd5(content: string): string {
  return createHash("md5").update(content, "utf8").digest("hex");
}

/**
 * Append a merge log entry to the tier2-merge-log.jsonl file.
 *
 * Per ENFORCEMENT-MECHANICS.md §3.2, every Tier 2 merge operation
 * produces a traceable audit trail entry. The log is append-only.
 */
export async function appendMergeLogEntry(
  logDir: string,
  entry: Tier2MergeLogEntry,
): Promise<void> {
  const logPath = path.join(logDir, "tier2-merge-log.jsonl");
  const line = JSON.stringify(entry) + "\n";
  await fs.mkdir(logDir, { recursive: true });
  await fs.appendFile(logPath, line, { encoding: "utf8" });
}

/**
 * Read all merge log entries from the tier2-merge-log.jsonl file.
 */
export async function readMergeLogEntries(logDir: string): Promise<Tier2MergeLogEntry[]> {
  const logPath = path.join(logDir, "tier2-merge-log.jsonl");
  try {
    const content = await fs.readFile(logPath, { encoding: "utf8" });
    return content
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Tier2MergeLogEntry);
  } catch {
    return [];
  }
}

/**
 * Validate that a merge log entry is well-formed.
 *
 * Per ENFORCEMENT-MECHANICS.md §6, fail-closed defaults apply:
 * - If any required field is missing, the entry is invalid
 * - If hash computation fails, the entry is invalid
 */
export function validateMergeLogEntry(entry: Partial<Tier2MergeLogEntry>): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!entry.schemaVersion) errors.push("Missing schemaVersion");
  if (!entry.timestamp) errors.push("Missing timestamp");
  if (!entry.agentId) errors.push("Missing agentId");
  if (!entry.operation) errors.push("Missing operation");
  if (!entry.sourceTier) errors.push("Missing sourceTier");
  if (!entry.targetTier) errors.push("Missing targetTier");
  if (!entry.contentHashAtProposal) errors.push("Missing contentHashAtProposal");
  if (!entry.manifestHashAtProposal) errors.push("Missing manifestHashAtProposal");
  if (!entry.diffSha) errors.push("Missing diffSha");
  if (!entry.sealedProposalId) errors.push("Missing sealedProposalId");
  if (!entry.isolationTestsStatus) {
    errors.push("Missing isolationTestsStatus");
  } else {
    if (!entry.isolationTestsStatus.pre) errors.push("Missing isolationTestsStatus.pre");
    if (!entry.isolationTestsStatus.post) errors.push("Missing isolationTestsStatus.post");
  }
  if (!entry.stateAtApproval) {
    errors.push("Missing stateAtApproval");
  } else {
    if (!entry.stateAtApproval.alwaysMd5) errors.push("Missing stateAtApproval.alwaysMd5");
    if (!entry.stateAtApproval.referenceFiles)
      errors.push("Missing stateAtApproval.referenceFiles");
    if (typeof entry.stateAtApproval.activeProposalCount !== "number") {
      errors.push("Missing stateAtApproval.activeProposalCount");
    }
  }
  if (!entry.forensics) {
    errors.push("Missing forensics");
  } else {
    if (!entry.forensics.upstreamCommitRange) errors.push("Missing forensics.upstreamCommitRange");
    if (!entry.forensics.classifierVersion) errors.push("Missing forensics.classifierVersion");
  }

  return { valid: errors.length === 0, errors };
}
