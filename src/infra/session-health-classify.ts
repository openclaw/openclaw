/**
 * Session Health — Classification Functions
 *
 * Pure functions for classifying session keys and disk artifacts for health
 * monitoring. These are *sibling* classifiers — they do NOT modify or replace
 * the existing `classifySessionKey()` used by the gateway session list.
 */

import {
  isAcpSessionKey,
  isCronRunSessionKey,
  isCronSessionKey,
  isSubagentSessionKey,
  parseAgentSessionKey,
} from "../sessions/session-key-utils.js";
import type { DiskArtifactState, SessionHealthClass } from "./session-health-types.js";

/**
 * Classify a session key into one of the 10 health-domain session classes.
 *
 * Uses the existing predicate functions from `session-key-utils` where
 * available, falling back to pattern matching for classes that don't have
 * dedicated predicates (heartbeat, thread, channel, direct, main).
 *
 * Order matters: more specific patterns are checked first to avoid
 * misclassification (e.g., cron-run before cron-definition).
 */
export function classifySessionKeyForHealth(key: string | undefined | null): SessionHealthClass {
  const raw = (key ?? "").trim();
  if (!raw) {
    return "unknown";
  }

  // Use existing predicates for well-defined patterns
  if (isCronRunSessionKey(raw)) {
    return "cron-run";
  }
  if (isCronSessionKey(raw)) {
    return "cron-definition";
  } // cron but not cron-run
  if (isAcpSessionKey(raw)) {
    return "acp";
  }
  if (isSubagentSessionKey(raw)) {
    return "subagent";
  }

  // Normalize for pattern matching
  const lower = raw.toLowerCase();

  // Pattern-based checks for remaining classes
  if (lower.includes(":heartbeat:") || lower.includes(":heartbeat")) {
    return "heartbeat";
  }
  if (lower.includes(":thread:") || lower.includes(":topic:")) {
    return "thread";
  }
  if (lower.includes(":group:") || lower.includes(":channel:")) {
    return "channel";
  }
  if (lower.includes(":direct:")) {
    return "direct";
  }

  // Main session detection: agent:{id}:{mainKey} where mainKey is a simple token
  const parsed = parseAgentSessionKey(raw);
  if (parsed) {
    const rest = parsed.rest;
    // Main session keys are simple tokens like "main", "default", etc.
    // They don't contain colons (those would be classified above).
    if (!rest.includes(":")) {
      return "main";
    }
  }

  return "unknown";
}

/**
 * Classify a disk filename into its artifact state category.
 *
 * Checks for specific file patterns to distinguish between active transcripts,
 * soft-deleted files, reset files, orphaned temp files, index files, and backups.
 */
export function classifyDiskArtifact(filename: string): DiskArtifactState {
  if (!filename) {
    return "active";
  }

  // Index-related files
  if (filename === "sessions.json") {
    return "index";
  }
  if (filename === "sessions.json.backup") {
    return "backup";
  }

  // Backup rotation files (sessions.json.bak.*)
  if (filename.startsWith("sessions.json.bak.")) {
    return "backup";
  }

  // Orphaned temp files from crashed atomic writes
  if (filename.endsWith(".tmp")) {
    return "orphanedTemp";
  }

  // Soft-deleted and reset transcript files
  if (filename.includes(".deleted.")) {
    return "deleted";
  }
  if (filename.includes(".reset.")) {
    return "reset";
  }

  // Everything else is an active artifact
  return "active";
}
