/**
 * Credential Audit - Phase 5 Security Hardening
 *
 * Tamper-evident audit trail with hash chain verification
 * for credential access forensics.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveUserPath } from "../utils.js";
import type { CredentialScope } from "./credential-vault.js";

const log = createSubsystemLogger("security/credential-audit");

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export type CredentialAuditAction = "read" | "write" | "rotate" | "delete" | "list";

export type CredentialAuditEntry = {
  timestamp: number;
  action: CredentialAuditAction;
  credentialName: string;
  scope: CredentialScope;
  requestor: string;
  success: boolean;
  error?: string;
  /**
   * SHA-256 hex digest of this entry (computed without this field itself).
   * Used for tamper detection via hash-chain verification — **not** a keyed
   * MAC.  The full 64-char hex is stored and compared; the 8-char prefix
   * shown in log messages is display-only for human readability.
   */
  entryHash: string;
  /** SHA-256 of the preceding entry (genesis = 64 zeros), for chain linking. */
  prevEntryHash: string;
};

export type AuditLogIntegrity =
  | { valid: true; entryCount: number }
  | { valid: false; brokenAt: number; reason: string; entryIndex: number };

export type AuditQueryFilters = {
  credentialName?: string;
  scope?: CredentialScope;
  action?: CredentialAuditAction;
  requestor?: string;
  since?: number;
  until?: number;
  limit?: number;
};

export type AuditOptions = {
  auditDir?: string;
};

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const DEFAULT_AUDIT_DIR = "~/.openclaw/vault";
const AUDIT_FILENAME = "audit.jsonl";
const MAX_AUDIT_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_ROTATED_FILES = 5;
const GENESIS_HASH = "0000000000000000000000000000000000000000000000000000000000000000";

// -----------------------------------------------------------------------------
// Last-hash cache (P-H4)
//
// Reading and re-parsing the entire audit JSONL on every logCredentialAccess
// call is O(n) in log size. Instead we keep a per-path cache of the last
// written entry hash and update it in-place after each append.
// The cache is invalidated on log rotation and on purge (both rewrite the file
// with new hashes).
// -----------------------------------------------------------------------------

const lastHashCache = new Map<string, string>();

function invalidateHashCache(auditPath: string): void {
  lastHashCache.delete(auditPath);
}

/** Reset the hash cache — for unit tests only. */
export function resetAuditHashCacheForTest(): void {
  lastHashCache.clear();
}

// -----------------------------------------------------------------------------
// File Operations
// -----------------------------------------------------------------------------

function resolveAuditDir(options?: AuditOptions): string {
  const dir = options?.auditDir ?? DEFAULT_AUDIT_DIR;
  return resolveUserPath(dir);
}

function resolveAuditPath(options?: AuditOptions): string {
  return path.join(resolveAuditDir(options), AUDIT_FILENAME);
}

function ensureAuditDir(options?: AuditOptions): void {
  const auditDir = resolveAuditDir(options);
  if (!fs.existsSync(auditDir)) {
    fs.mkdirSync(auditDir, { recursive: true, mode: 0o700 });
  }
}

function rotateAuditLogIfNeeded(options?: AuditOptions): void {
  const auditPath = resolveAuditPath(options);
  if (!fs.existsSync(auditPath)) {
    return;
  }

  const stat = fs.statSync(auditPath);
  if (stat.size < MAX_AUDIT_FILE_SIZE) {
    return;
  }

  // Rotate existing files
  const auditDir = resolveAuditDir(options);
  for (let i = MAX_ROTATED_FILES - 1; i >= 1; i--) {
    const from = path.join(auditDir, `audit.${i}.jsonl`);
    const to = path.join(auditDir, `audit.${i + 1}.jsonl`);
    if (fs.existsSync(from)) {
      if (i === MAX_ROTATED_FILES - 1) {
        fs.unlinkSync(from); // Delete oldest
      } else {
        fs.renameSync(from, to);
      }
    }
  }

  // Rotate current file
  const rotatedPath = path.join(auditDir, "audit.1.jsonl");
  fs.renameSync(auditPath, rotatedPath);

  // The active file is now gone — the next write starts a fresh file (P-H4).
  invalidateHashCache(auditPath);

  log.info("rotated audit log", { oldPath: auditPath, newPath: rotatedPath });
}

function readAuditEntries(options?: AuditOptions): CredentialAuditEntry[] {
  const auditPath = resolveAuditPath(options);
  if (!fs.existsSync(auditPath)) {
    return [];
  }

  let content: string;
  try {
    content = fs.readFileSync(auditPath, "utf8");
  } catch (error) {
    log.warn("failed to read audit log", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }

  const lines = content.split("\n").filter((line) => line.trim());
  const entries: CredentialAuditEntry[] = [];
  let skipped = 0;

  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as CredentialAuditEntry);
    } catch {
      skipped++;
      log.warn("skipping malformed audit log line", { line: line.slice(0, 80) });
    }
  }

  if (skipped > 0) {
    log.warn("audit log contained malformed lines", { skipped, total: lines.length });
  }

  return entries;
}

function getLastEntryHash(options?: AuditOptions): string {
  const auditPath = resolveAuditPath(options);
  const cached = lastHashCache.get(auditPath);
  if (cached !== undefined) {
    return cached;
  }
  // Cache miss — read the file and populate the cache.
  const entries = readAuditEntries(options);
  const hash = entries.length === 0 ? GENESIS_HASH : entries[entries.length - 1].entryHash;
  lastHashCache.set(auditPath, hash);
  return hash;
}

function computeEntryHash(entry: Omit<CredentialAuditEntry, "entryHash">): string {
  const data = JSON.stringify({
    timestamp: entry.timestamp,
    action: entry.action,
    credentialName: entry.credentialName,
    scope: entry.scope,
    requestor: entry.requestor,
    success: entry.success,
    error: entry.error,
    prevEntryHash: entry.prevEntryHash,
  });
  return createHash("sha256").update(data).digest("hex");
}

function appendAuditEntry(entry: CredentialAuditEntry, options?: AuditOptions): void {
  ensureAuditDir(options);
  rotateAuditLogIfNeeded(options); // may invalidate the cache on rotation

  const auditPath = resolveAuditPath(options);
  const line = JSON.stringify(entry) + "\n";

  fs.appendFileSync(auditPath, line, { encoding: "utf8", mode: 0o600 });

  // Update the cache so the next logCredentialAccess skips the file read (P-H4).
  lastHashCache.set(auditPath, entry.entryHash);
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/**
 * Log a credential access event to the audit trail.
 */
export function logCredentialAccess(params: {
  action: CredentialAuditAction;
  credentialName: string;
  scope: CredentialScope;
  requestor: string;
  success: boolean;
  error?: string;
  options?: AuditOptions;
}): void {
  const { action, credentialName, scope, requestor, success, error, options } = params;

  const prevEntryHash = getLastEntryHash(options);
  const timestamp = Date.now();

  const partialEntry = {
    timestamp,
    action,
    credentialName,
    scope,
    requestor,
    success,
    error,
    prevEntryHash,
  };

  const entryHash = computeEntryHash(partialEntry);

  const entry: CredentialAuditEntry = {
    ...partialEntry,
    entryHash,
  };

  appendAuditEntry(entry, options);

  log.debug("audit entry logged", {
    action,
    credentialName,
    scope,
    requestor,
    success,
    entryHash: entryHash.slice(0, 8), // display prefix only — full hash stored in file
  });
}

/**
 * Query the audit log with optional filters.
 */
export function queryAuditLog(
  filters?: AuditQueryFilters,
  options?: AuditOptions,
): CredentialAuditEntry[] {
  let entries = readAuditEntries(options);

  if (!filters) {
    return entries;
  }

  if (filters.credentialName) {
    entries = entries.filter((e) => e.credentialName === filters.credentialName);
  }

  if (filters.scope) {
    entries = entries.filter((e) => e.scope === filters.scope);
  }

  if (filters.action) {
    entries = entries.filter((e) => e.action === filters.action);
  }

  if (filters.requestor) {
    entries = entries.filter((e) => e.requestor === filters.requestor);
  }

  if (filters.since) {
    entries = entries.filter((e) => e.timestamp >= filters.since!);
  }

  if (filters.until) {
    entries = entries.filter((e) => e.timestamp <= filters.until!);
  }

  if (filters.limit && entries.length > filters.limit) {
    entries = entries.slice(-filters.limit);
  }

  return entries;
}

/**
 * Verify the integrity of the audit log hash chain.
 */
export function verifyAuditLogIntegrity(options?: AuditOptions): AuditLogIntegrity {
  const entries = readAuditEntries(options);

  if (entries.length === 0) {
    return { valid: true, entryCount: 0 };
  }

  let expectedPrevHash = GENESIS_HASH;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];

    // Verify chain link
    if (entry.prevEntryHash !== expectedPrevHash) {
      return {
        valid: false,
        brokenAt: entry.timestamp,
        reason: `Chain broken: expected prevEntryHash ${expectedPrevHash.slice(0, 8)}..., got ${entry.prevEntryHash.slice(0, 8)}...`,
        entryIndex: i,
      };
    }

    // Verify entry hash
    const { entryHash, ...partialEntry } = entry;
    const computedHash = computeEntryHash(partialEntry);

    if (computedHash !== entryHash) {
      return {
        valid: false,
        brokenAt: entry.timestamp,
        reason: `Entry hash mismatch: computed ${computedHash.slice(0, 8)}..., stored ${entryHash.slice(0, 8)}...`,
        entryIndex: i,
      };
    }

    expectedPrevHash = entryHash;
  }

  return { valid: true, entryCount: entries.length };
}

/**
 * Export the audit log in a specified format.
 */
export function exportAuditLog(params: {
  format: "json" | "csv";
  since?: number;
  until?: number;
  options?: AuditOptions;
}): string {
  const { format, since, until, options } = params;

  const entries = queryAuditLog({ since, until }, options);

  if (format === "json") {
    return JSON.stringify(entries, null, 2);
  }

  // CSV format
  const headers = [
    "timestamp",
    "action",
    "credentialName",
    "scope",
    "requestor",
    "success",
    "error",
    "entryHash",
    "prevEntryHash",
  ];

  const rows = entries.map((entry) => [
    new Date(entry.timestamp).toISOString(),
    entry.action,
    entry.credentialName,
    entry.scope,
    entry.requestor,
    entry.success ? "true" : "false",
    entry.error ?? "",
    entry.entryHash,
    entry.prevEntryHash,
  ]);

  const csvRows = [
    headers.join(","),
    ...rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")),
  ];

  return csvRows.join("\n");
}

/**
 * Get audit statistics for a time period.
 */
export function getAuditStats(params?: {
  since?: number;
  until?: number;
  options?: AuditOptions;
}): {
  totalEntries: number;
  byAction: Record<CredentialAuditAction, number>;
  byScope: Record<CredentialScope, number>;
  successRate: number;
  uniqueRequestors: number;
  uniqueCredentials: number;
} {
  const entries = queryAuditLog({ since: params?.since, until: params?.until }, params?.options);

  const byAction: Record<CredentialAuditAction, number> = {
    read: 0,
    write: 0,
    rotate: 0,
    delete: 0,
    list: 0,
  };

  const byScope: Record<CredentialScope, number> = {
    provider: 0,
    channel: 0,
    integration: 0,
    internal: 0,
  };

  const requestors = new Set<string>();
  const credentials = new Set<string>();
  let successCount = 0;

  for (const entry of entries) {
    byAction[entry.action] = (byAction[entry.action] || 0) + 1;
    byScope[entry.scope] = (byScope[entry.scope] || 0) + 1;
    requestors.add(entry.requestor);
    credentials.add(`${entry.scope}:${entry.credentialName}`);
    if (entry.success) {
      successCount++;
    }
  }

  return {
    totalEntries: entries.length,
    byAction,
    byScope,
    successRate: entries.length > 0 ? successCount / entries.length : 1,
    uniqueRequestors: requestors.size,
    uniqueCredentials: credentials.size,
  };
}

/**
 * Remove audit entries older than `olderThanDays` days and rewrite the audit
 * file with recomputed entry hashes for the retained entries.
 *
 * **Destructive / forensic consequence (DC-8):** This operation rewrites the
 * entire audit chain from scratch.  Entry hashes computed before the purge
 * will NOT match the hashes in the new file — any previously exported hash
 * references become stale.  Do not call this after exporting an audit log for
 * legal or compliance review without recording the pre-purge state first.
 *
 * Returns the number of entries removed.
 */
export function purgeOldAuditEntries(params: {
  olderThanDays: number;
  options?: AuditOptions;
}): number {
  const { olderThanDays, options } = params;
  const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;

  const entries = readAuditEntries(options);
  const retained = entries.filter((e) => e.timestamp >= cutoff);
  const removed = entries.length - retained.length;

  if (removed === 0) {
    return 0;
  }

  // Rewrite the audit file with retained entries
  // Need to recompute hashes to maintain chain integrity
  const auditPath = resolveAuditPath(options);
  const newEntries: CredentialAuditEntry[] = [];
  let prevHash = GENESIS_HASH;

  for (const entry of retained) {
    const { entryHash: _, ...partial } = entry;
    const newPartial = { ...partial, prevEntryHash: prevHash };
    const newHash = computeEntryHash(newPartial);
    const newEntry: CredentialAuditEntry = { ...newPartial, entryHash: newHash };
    newEntries.push(newEntry);
    prevHash = newHash;
  }

  // Write new file
  const content =
    newEntries.map((e) => JSON.stringify(e)).join("\n") + (newEntries.length > 0 ? "\n" : "");
  fs.writeFileSync(auditPath, content, { encoding: "utf8", mode: 0o600 });

  // All hashes were recomputed — stale cache entry would hand out the wrong hash (P-H4).
  invalidateHashCache(auditPath);

  log.info("purged old audit entries", {
    removed,
    retained: retained.length,
    cutoffDays: olderThanDays,
  });

  return removed;
}
