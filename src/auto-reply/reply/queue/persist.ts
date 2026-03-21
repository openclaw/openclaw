import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../../../config/paths.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import type { FollowupRun } from "./types.js";

const log = createSubsystemLogger("queue-persist");

const PENDING_MESSAGES_FILENAME = "pending-messages.json";

export type PersistedQueueEntry = {
  key: string;
  items: FollowupRun[];
};

export type PersistedQueueFile = {
  version: 1;
  persistedAt: number;
  entries: PersistedQueueEntry[];
};

function resolvePendingMessagesPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), PENDING_MESSAGES_FILENAME);
}

/**
 * Persist all non-empty followup queues to disk before shutdown.
 * Called from the gateway close handler so queued messages survive restart.
 */
export async function persistFollowupQueues(
  queues: Map<string, { items: FollowupRun[] }>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const entries: PersistedQueueEntry[] = [];
  for (const [key, queue] of queues) {
    if (queue.items.length > 0) {
      entries.push({
        key,
        // Serialize only the data needed for replay; strip non-serializable fields
        items: queue.items.map((item) => ({
          ...item,
          run: {
            ...item.run,
            // Config object is too large and non-portable across restarts;
            // it will be re-resolved from the live config on replay.
            config: undefined as never,
            skillsSnapshot: undefined,
          },
        })),
      });
    }
  }

  if (entries.length === 0) {
    return null;
  }

  const filePath = resolvePendingMessagesPath(env);
  const data: PersistedQueueFile = {
    version: 1,
    persistedAt: Date.now(),
    entries,
  };

  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
    log.info(
      `persisted ${entries.reduce((sum, e) => sum + e.items.length, 0)} pending message(s) across ${entries.length} queue(s)`,
    );
    return filePath;
  } catch (err) {
    log.error(`failed to persist pending messages: ${String(err)}`);
    return null;
  }
}

/**
 * Read and consume persisted pending messages from disk.
 * Returns the entries and deletes the file. Returns null if no file exists
 * or the file is invalid.
 */
export async function consumePersistedQueues(
  env: NodeJS.ProcessEnv = process.env,
): Promise<PersistedQueueEntry[] | null> {
  const filePath = resolvePendingMessagesPath(env);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }

  // Delete immediately to avoid double-replay on crash during processing
  await fs.unlink(filePath).catch(() => {});

  let parsed: PersistedQueueFile;
  try {
    parsed = JSON.parse(raw) as PersistedQueueFile;
  } catch {
    log.warn("pending-messages.json was corrupt; discarding");
    return null;
  }

  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.entries)) {
    log.warn("pending-messages.json has unexpected format; discarding");
    return null;
  }

  // Discard entries older than 5 minutes (messages may be stale)
  const MAX_AGE_MS = 5 * 60 * 1000;
  if (Date.now() - parsed.persistedAt > MAX_AGE_MS) {
    log.info(
      `pending-messages.json is ${Math.round((Date.now() - parsed.persistedAt) / 1000)}s old; discarding as stale`,
    );
    return null;
  }

  const totalItems = parsed.entries.reduce((sum, e) => sum + e.items.length, 0);
  log.info(
    `consumed ${totalItems} pending message(s) across ${parsed.entries.length} queue(s) from disk`,
  );
  return parsed.entries;
}
