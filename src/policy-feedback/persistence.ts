/**
 * JSONL append-only persistence for the policy feedback subsystem.
 *
 * Storage layout:
 *   ~/.openclaw/policy-feedback/
 *     actions.jsonl
 *     outcomes.jsonl
 *     aggregates.json
 *     policy-config.json
 *     agents/<agentId>/
 *       actions.jsonl
 *       outcomes.jsonl
 *       aggregates.json
 */

import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import type { ActionRecord, AggregateStats, OutcomeRecord, PolicyFeedbackConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

const STATE_DIRNAME = ".openclaw";
const SUBSYSTEM_DIRNAME = "policy-feedback";

const ACTIONS_FILE = "actions.jsonl";
const OUTCOMES_FILE = "outcomes.jsonl";
const AGGREGATES_FILE = "aggregates.json";
const CONFIG_FILE = "policy-config.json";

/** Resolve the root policy-feedback storage directory. */
export function resolveStorageDir(home?: string): string {
  const base = home ?? os.homedir();
  return path.join(base, STATE_DIRNAME, SUBSYSTEM_DIRNAME);
}

/**
 * Validate an agentId for safe filesystem use.
 * Rejects path separators, `..` sequences, null bytes, and empty values.
 */
function validateAgentId(agentId: string): void {
  if (
    !agentId ||
    agentId.includes("/") ||
    agentId.includes("\\") ||
    agentId.includes("..") ||
    agentId.includes("\0")
  ) {
    throw new Error(
      `Invalid agentId: must not contain path separators, ".." sequences, or null bytes`,
    );
  }
}

/** Resolve a per-agent storage directory (for per-agent scoping). */
export function resolveAgentDir(agentId: string, home?: string): string {
  validateAgentId(agentId);
  return path.join(resolveStorageDir(home), "agents", agentId);
}

/** Resolve the path to a specific storage file. */
function resolveFilePath(filename: string, agentId?: string, home?: string): string {
  const dir = agentId ? resolveAgentDir(agentId, home) : resolveStorageDir(home);
  return path.join(dir, filename);
}

// ---------------------------------------------------------------------------
// Directory creation
// ---------------------------------------------------------------------------

/** Ensure a directory exists, creating it recursively if needed. */
async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

// ---------------------------------------------------------------------------
// JSONL Operations
// ---------------------------------------------------------------------------

/**
 * Append a single record as a JSON line to a JSONL file.
 * Creates the parent directory on first write.
 */
async function appendJsonl<T>(filePath: string, record: T): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const line = JSON.stringify(record) + "\n";
  await fs.appendFile(filePath, line, "utf-8");
}

/**
 * Read all records from a JSONL file. Returns an empty array if the file
 * does not exist. Skips malformed lines silently.
 */
async function readJsonl<T>(filePath: string): Promise<T[]> {
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === "ENOENT") {
      return [];
    }
    throw err;
  }

  const results: T[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    try {
      results.push(JSON.parse(trimmed) as T);
    } catch {
      // Skip malformed lines
    }
  }
  return results;
}

/**
 * Stream records from a JSONL file one at a time using readline.
 * Yields parsed records as they are read, keeping memory usage constant
 * regardless of file size. Yields nothing if the file does not exist.
 * Skips malformed lines with a warning (same behavior as readJsonl).
 */
async function* streamJsonl<T>(filePath: string): AsyncGenerator<T, void, undefined> {
  // Check existence before opening a stream to avoid unhandled errors
  try {
    await fs.access(filePath);
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === "ENOENT") {
      return;
    }
    throw err;
  }

  const fileStream = fsSync.createReadStream(filePath, { encoding: "utf-8" });
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      try {
        yield JSON.parse(trimmed) as T;
      } catch {
        // Skip malformed lines (consistent with readJsonl)
      }
    }
  } finally {
    rl.close();
    fileStream.destroy();
  }
}

// ---------------------------------------------------------------------------
// JSON file Operations
// ---------------------------------------------------------------------------

/** Read a JSON file, returning undefined if it does not exist. */
async function readJson<T>(filePath: string): Promise<T | undefined> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return JSON.parse(content) as T;
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === "ENOENT") {
      return undefined;
    }
    throw err;
  }
}

/** Write a JSON file atomically (write to temp, then rename). */
async function writeJson<T>(filePath: string, data: T): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  const content = JSON.stringify(data, null, 2) + "\n";
  await fs.writeFile(tmpPath, content, "utf-8");
  await fs.rename(tmpPath, filePath);
}

// ---------------------------------------------------------------------------
// Typed helpers (Node error narrowing)
// ---------------------------------------------------------------------------

interface NodeError extends Error {
  code?: string;
}

function isNodeError(err: unknown): err is NodeError {
  return err instanceof Error && "code" in err;
}

// ---------------------------------------------------------------------------
// Public API: Actions
// ---------------------------------------------------------------------------

/** Append an action record to the JSONL log. */
export async function appendAction(
  record: ActionRecord,
  options?: { agentId?: string; home?: string },
): Promise<void> {
  const filePath = resolveFilePath(ACTIONS_FILE, options?.agentId, options?.home);
  await appendJsonl(filePath, record);
}

/** Read all action records from the JSONL log. */
export async function readActions(options?: {
  agentId?: string;
  home?: string;
}): Promise<ActionRecord[]> {
  const filePath = resolveFilePath(ACTIONS_FILE, options?.agentId, options?.home);
  return readJsonl<ActionRecord>(filePath);
}

/** Stream action records one at a time from the JSONL log. */
export async function* streamActions(options?: {
  agentId?: string;
  home?: string;
}): AsyncGenerator<ActionRecord, void, undefined> {
  const filePath = resolveFilePath(ACTIONS_FILE, options?.agentId, options?.home);
  yield* streamJsonl<ActionRecord>(filePath);
}

// ---------------------------------------------------------------------------
// Public API: Outcomes
// ---------------------------------------------------------------------------

/** Append an outcome record to the JSONL log. */
export async function appendOutcome(
  record: OutcomeRecord,
  options?: { agentId?: string; home?: string },
): Promise<void> {
  const filePath = resolveFilePath(OUTCOMES_FILE, options?.agentId, options?.home);
  await appendJsonl(filePath, record);
}

/** Read all outcome records from the JSONL log. */
export async function readOutcomes(options?: {
  agentId?: string;
  home?: string;
}): Promise<OutcomeRecord[]> {
  const filePath = resolveFilePath(OUTCOMES_FILE, options?.agentId, options?.home);
  return readJsonl<OutcomeRecord>(filePath);
}

/** Stream outcome records one at a time from the JSONL log. */
export async function* streamOutcomes(options?: {
  agentId?: string;
  home?: string;
}): AsyncGenerator<OutcomeRecord, void, undefined> {
  const filePath = resolveFilePath(OUTCOMES_FILE, options?.agentId, options?.home);
  yield* streamJsonl<OutcomeRecord>(filePath);
}

// ---------------------------------------------------------------------------
// Public API: Aggregates
// ---------------------------------------------------------------------------

/** Read the aggregate stats file. Returns undefined if not yet computed. */
export async function readAggregates(options?: {
  agentId?: string;
  home?: string;
}): Promise<AggregateStats | undefined> {
  const filePath = resolveFilePath(AGGREGATES_FILE, options?.agentId, options?.home);
  return readJson<AggregateStats>(filePath);
}

/** Write the aggregate stats file (atomic via temp + rename). */
export async function writeAggregates(
  stats: AggregateStats,
  options?: { agentId?: string; home?: string },
): Promise<void> {
  const filePath = resolveFilePath(AGGREGATES_FILE, options?.agentId, options?.home);
  await writeJson(filePath, stats);
}

// ---------------------------------------------------------------------------
// Public API: Log Retention
// ---------------------------------------------------------------------------

/**
 * Prune action and outcome JSONL records older than the given retention period.
 * Reads the full file, filters by timestamp, and rewrites. Idempotent and
 * safe to call concurrently (atomic write via temp file).
 *
 * @param retentionDays - Max age of records to keep.
 * @param options.agentId - Scope to a specific agent's logs.
 * @param options.home - Override home directory.
 * @returns Number of records pruned (actions + outcomes).
 */
export async function pruneOldRecords(
  retentionDays: number,
  options?: { agentId?: string; home?: string },
): Promise<number> {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let pruned = 0;

  // Prune actions
  const actionsPath = resolveFilePath(ACTIONS_FILE, options?.agentId, options?.home);
  pruned += await pruneJsonlByTimestamp(actionsPath, cutoff);

  // Prune outcomes
  const outcomesPath = resolveFilePath(OUTCOMES_FILE, options?.agentId, options?.home);
  pruned += await pruneJsonlByTimestamp(outcomesPath, cutoff);

  return pruned;
}

/**
 * Filter a JSONL file in-place, keeping only records with timestamp >= cutoff.
 * Returns the number of records removed.
 */
async function pruneJsonlByTimestamp(filePath: string, cutoffMs: number): Promise<number> {
  let records: { timestamp?: string }[];
  try {
    records = await readJsonl<{ timestamp?: string }>(filePath);
  } catch {
    return 0;
  }

  if (records.length === 0) {
    return 0;
  }

  const kept = records.filter((r) => {
    if (!r.timestamp) {
      return true; // Keep records without timestamps
    }
    return new Date(r.timestamp).getTime() >= cutoffMs;
  });

  const pruned = records.length - kept.length;
  if (pruned === 0) {
    return 0;
  }

  // Rewrite the file atomically
  await ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  const content = kept.map((r) => JSON.stringify(r)).join("\n") + (kept.length > 0 ? "\n" : "");
  await fs.writeFile(tmpPath, content, "utf-8");
  await fs.rename(tmpPath, filePath);

  return pruned;
}

// ---------------------------------------------------------------------------
// Public API: Config
// ---------------------------------------------------------------------------

/** Read the runtime policy config overrides. Returns undefined if not set. */
export async function readPolicyConfig(options?: {
  home?: string;
}): Promise<PolicyFeedbackConfig | undefined> {
  const filePath = resolveFilePath(CONFIG_FILE, undefined, options?.home);
  return readJson<PolicyFeedbackConfig>(filePath);
}

/** Write the runtime policy config overrides (atomic). */
export async function writePolicyConfig(
  config: PolicyFeedbackConfig,
  options?: { home?: string },
): Promise<void> {
  const filePath = resolveFilePath(CONFIG_FILE, undefined, options?.home);
  await writeJson(filePath, config);
}
