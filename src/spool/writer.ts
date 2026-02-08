/**
 * Spool event writer - creates event files in the spool directory.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import type { SpoolEvent, SpoolEventCreate } from "./types.js";
import { resolveSpoolEventsDir, resolveSpoolEventPath } from "./paths.js";

/**
 * Ensure the spool events directory exists.
 */
export async function ensureSpoolEventsDir(
  env: Record<string, string | undefined> = process.env,
): Promise<string> {
  const dir = resolveSpoolEventsDir(env);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Create a full SpoolEvent from a partial creation request.
 */
export function buildSpoolEvent(create: SpoolEventCreate): SpoolEvent {
  const now = Date.now();
  return {
    ...create,
    id: randomUUID(),
    createdAt: new Date(now).toISOString(),
    createdAtMs: now,
    retryCount: 0,
  };
}

/**
 * Write a spool event to the events directory.
 * Returns the event ID.
 */
export async function writeSpoolEvent(
  event: SpoolEvent,
  env: Record<string, string | undefined> = process.env,
): Promise<string> {
  await ensureSpoolEventsDir(env);
  const eventPath = resolveSpoolEventPath(event.id, env);
  const content = JSON.stringify(event, null, 2);
  // Write atomically using a temp file
  const tempPath = `${eventPath}.tmp.${randomUUID()}`;
  await fs.writeFile(tempPath, content, "utf8");
  // On POSIX, fs.rename atomically replaces existing files.
  // On Windows, fs.rename fails if destination exists - must unlink first.
  // Only use unlink on Windows to preserve POSIX atomicity.
  // Note: Windows has a brief race window where the file doesn't exist between
  // unlink and rename. The watcher handles this gracefully by treating transient
  // ENOENT as "file vanished" (skipped), and the write completes normally.
  if (process.platform === "win32") {
    try {
      await fs.unlink(eventPath);
    } catch (err) {
      // Ignore ENOENT (file doesn't exist) - expected for new events
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
  }
  await fs.rename(tempPath, eventPath);
  return event.id;
}

/**
 * Create and write a new spool event from a creation request.
 * Returns the created event.
 */
export async function createSpoolEvent(
  create: SpoolEventCreate,
  env: Record<string, string | undefined> = process.env,
): Promise<SpoolEvent> {
  const event = buildSpoolEvent(create);
  await writeSpoolEvent(event, env);
  return event;
}

/**
 * Create a spool event from a simple message.
 * This is the most common use case - just send a message to the agent.
 */
export async function createSpoolAgentTurn(
  message: string,
  options?: {
    agentId?: string;
    sessionKey?: string;
    model?: string;
    thinking?: string;
    priority?: "low" | "normal" | "high" | "critical";
    maxRetries?: number;
    expiresAt?: string;
    delivery?: {
      enabled?: boolean;
      channel?: string;
      to?: string;
    };
  },
  env: Record<string, string | undefined> = process.env,
): Promise<SpoolEvent> {
  return createSpoolEvent(
    {
      version: 1,
      priority: options?.priority,
      maxRetries: options?.maxRetries,
      expiresAt: options?.expiresAt,
      payload: {
        kind: "agentTurn",
        message,
        agentId: options?.agentId,
        sessionKey: options?.sessionKey,
        model: options?.model,
        thinking: options?.thinking,
        delivery: options?.delivery,
      },
    },
    env,
  );
}
