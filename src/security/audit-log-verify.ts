import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { AuditLogEntry } from "./audit-log.js";
import { canonicalize, computeHash } from "./audit-log.js";

export type VerifyResult =
  | { valid: true; entryCount: number }
  | { valid: false; entryCount: number; failedAtSeq: number; error: string };

/**
 * Verify the integrity of a hash-chained audit log.
 * Streams the file line-by-line for memory efficiency.
 * Returns failure details on first mismatch.
 */
export async function verifyAuditLogChain(logPath: string): Promise<VerifyResult> {
  let entryCount = 0;
  let prevHash = "GENESIS";
  let lastValidLine: string | undefined;

  const lines: string[] = [];

  try {
    const stream = createReadStream(logPath, { encoding: "utf-8" });
    const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });

    for await (const line of rl) {
      if (line.trim().length > 0) {
        lines.push(line);
      }
    }
  } catch (err: unknown) {
    // File doesn't exist or can't be read — treat as empty
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { valid: true, entryCount: 0 };
    }
    throw err;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    let entry: AuditLogEntry;

    try {
      entry = JSON.parse(line) as AuditLogEntry;
    } catch {
      // If this is the last line and it fails to parse, treat as truncated (skip it)
      if (i === lines.length - 1) {
        break;
      }
      return {
        valid: false,
        entryCount,
        failedAtSeq: entryCount,
        error: `Invalid JSON at line ${i + 1}`,
      };
    }

    // Check sequence continuity
    if (entry.seq !== entryCount + 1) {
      return {
        valid: false,
        entryCount,
        failedAtSeq: entry.seq,
        error: `Expected seq ${entryCount + 1} but got ${entry.seq}`,
      };
    }

    // Check prevHash linkage
    if (entry.prevHash !== prevHash) {
      return {
        valid: false,
        entryCount,
        failedAtSeq: entry.seq,
        error: `prevHash mismatch at seq ${entry.seq}: expected ${prevHash} but got ${entry.prevHash}`,
      };
    }

    // Recompute hash and verify
    const { hash, ...rest } = entry;
    const canonicalized = canonicalize(rest);
    const expectedHash = computeHash(canonicalized);

    if (hash !== expectedHash) {
      return {
        valid: false,
        entryCount,
        failedAtSeq: entry.seq,
        error: `Hash mismatch at seq ${entry.seq}: expected ${expectedHash} but got ${hash}`,
      };
    }

    prevHash = hash;
    entryCount++;
    lastValidLine = line;
  }

  return { valid: true, entryCount };
}
