/**
 * Spool event dispatcher - processes events by running agent turns.
 *
 * Uses runSpoolIsolatedAgentTurn() which delegates to the shared
 * isolated agent turn infrastructure.
 */

import path from "node:path";
import type { CliDeps } from "../cli/deps.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SpoolEvent, SpoolDispatchResult } from "./types.js";
import { moveToDeadLetter } from "./dead-letter.js";
import { runSpoolIsolatedAgentTurn } from "./isolated-agent/index.js";
import { deleteSpoolEvent, readSpoolEventFile } from "./reader.js";
import { writeSpoolEvent } from "./writer.js";

const DEFAULT_MAX_RETRIES = 3;

/**
 * Check if an event has expired.
 */
export function isEventExpired(event: SpoolEvent): boolean {
  if (!event.expiresAt) {
    return false;
  }
  const expiresAtMs = new Date(event.expiresAt).getTime();
  return Date.now() > expiresAtMs;
}

/**
 * Check if an event has exceeded its retry limit.
 * Note: retryCount tracks failed attempts, so we allow the first execution
 * (retryCount=0) and only block after exceeding maxRetries failures.
 *
 * @param event - The spool event to check
 * @param configMaxRetries - Default maxRetries from spool config (optional)
 */
export function hasExceededRetries(event: SpoolEvent, configMaxRetries?: number): boolean {
  // Priority: event.maxRetries > config.spool.maxRetries > DEFAULT_MAX_RETRIES
  const maxRetries = event.maxRetries ?? configMaxRetries ?? DEFAULT_MAX_RETRIES;
  const retryCount = event.retryCount ?? 0;
  return retryCount > maxRetries;
}

export type DispatchSpoolEventParams = {
  cfg: OpenClawConfig;
  deps: CliDeps;
  event: SpoolEvent;
  lane?: string;
};

/**
 * Dispatch a single spool event by running an agent turn.
 */
export async function dispatchSpoolEvent(
  params: DispatchSpoolEventParams,
): Promise<SpoolDispatchResult> {
  const { cfg, deps, event } = params;

  // Check expiration - move to dead-letter for audit trail
  if (isEventExpired(event)) {
    await moveToDeadLetter(event.id, event, "expired", "event expired");
    return {
      status: "expired",
      eventId: event.id,
      error: "event expired",
    };
  }

  // Check retry limit (use config default if event doesn't specify maxRetries)
  const configMaxRetries = cfg.spool?.maxRetries;
  if (hasExceededRetries(event, configMaxRetries)) {
    await moveToDeadLetter(event.id, event, "max_retries", "exceeded maximum retry attempts");
    return {
      status: "error",
      eventId: event.id,
      error: "exceeded maximum retry attempts",
    };
  }

  try {
    const result = await runSpoolIsolatedAgentTurn({
      cfg,
      deps,
      event,
      lane: params.lane ?? "spool",
    });

    if (result.status === "ok" || result.status === "skipped") {
      // Success - remove the event
      await deleteSpoolEvent(event.id);
      return {
        status: result.status,
        eventId: event.id,
        summary: result.summary,
      };
    }

    // Error - increment retry count and update event
    const updatedEvent: SpoolEvent = {
      ...event,
      retryCount: (event.retryCount ?? 0) + 1,
    };

    if (hasExceededRetries(updatedEvent, configMaxRetries)) {
      await moveToDeadLetter(event.id, updatedEvent, "max_retries", result.error);
      return {
        status: "error",
        eventId: event.id,
        error: result.error ?? "agent turn failed",
      };
    }

    // Update event with incremented retry count for next attempt
    await writeSpoolEvent(updatedEvent);
    return {
      status: "error",
      eventId: event.id,
      error: result.error ?? "agent turn failed (will retry)",
    };
  } catch (err) {
    // Unexpected error - increment retry and move to dead letter if exceeded
    const updatedEvent: SpoolEvent = {
      ...event,
      retryCount: (event.retryCount ?? 0) + 1,
    };

    if (hasExceededRetries(updatedEvent, configMaxRetries)) {
      await moveToDeadLetter(event.id, updatedEvent, "error", String(err));
    } else {
      await writeSpoolEvent(updatedEvent);
    }

    return {
      status: "error",
      eventId: event.id,
      error: String(err),
    };
  }
}

export type DispatchSpoolEventFileParams = {
  cfg: OpenClawConfig;
  deps: CliDeps;
  filePath: string;
  lane?: string;
};

/**
 * Dispatch a spool event from a file path.
 * Handles invalid files by moving them to dead-letter.
 */
export async function dispatchSpoolEventFile(
  params: DispatchSpoolEventFileParams,
): Promise<SpoolDispatchResult> {
  const { cfg, deps, filePath } = params;

  // Extract event ID from filename (use path.basename for cross-platform support)
  const filename = path.basename(filePath);
  const eventId = filename.replace(/\.json$/, "");

  // Skip temp files (written as <id>.json.tmp.<uuid> by writer.ts)
  if (filename.includes(".json.tmp.")) {
    return {
      status: "skipped",
      eventId,
      error: "temp file",
    };
  }

  const result = await readSpoolEventFile(filePath);

  if (!result.success) {
    // Skip vanished files (already processed or manually removed) instead of
    // dead-lettering them - avoids false failures in racey watcher scenarios
    if (result.error === "file not found") {
      return {
        status: "skipped",
        eventId,
        error: "file vanished",
      };
    }
    // Invalid event - move to dead-letter
    await moveToDeadLetter(eventId, null, "invalid", result.error);
    return {
      status: "error",
      eventId,
      error: result.error,
    };
  }

  // Validate that the event ID in the file matches the filename
  // to prevent orphaned files and duplicate processing
  if (result.event.id !== eventId) {
    const error = `event ID mismatch: file "${eventId}.json" contains id "${result.event.id}"`;
    await moveToDeadLetter(eventId, result.event, "invalid", error);
    return {
      status: "error",
      eventId,
      error,
    };
  }

  return dispatchSpoolEvent({
    cfg,
    deps,
    event: result.event,
    lane: params.lane,
  });
}
