import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

const QUEUE_DIRNAME = "webhook-queue";
const MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

export interface WebhookQueueEntry {
  channelId: string;
  deduplicationId: string;
  enqueuedAt: number;
  payload: unknown;
}

function resolveQueueDir(stateDir?: string): string {
  const base = stateDir ?? resolveStateDir();
  return path.join(base, QUEUE_DIRNAME);
}

function entryFilename(channelId: string, deduplicationId: string): string {
  return `${channelId}_${deduplicationId}.json`;
}

async function ensureQueueDir(queueDir: string): Promise<void> {
  await fs.promises.mkdir(queueDir, { recursive: true, mode: 0o700 });
}

/**
 * Persist an inbound webhook payload to disk before acknowledging receipt.
 * Write failure must NOT block normal processing — callers should catch errors.
 */
export async function enqueueWebhook(
  channelId: string,
  deduplicationId: string,
  payload: unknown,
  stateDir?: string,
): Promise<void> {
  const queueDir = resolveQueueDir(stateDir);
  await ensureQueueDir(queueDir);
  const entry: WebhookQueueEntry = {
    channelId,
    deduplicationId,
    enqueuedAt: Date.now(),
    payload,
  };
  const filePath = path.join(queueDir, entryFilename(channelId, deduplicationId));
  const tmp = `${filePath}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(entry), { encoding: "utf-8", mode: 0o600 });
  await fs.promises.rename(tmp, filePath);
}

/** Remove a processed webhook entry from the queue. */
export async function dequeueWebhook(
  channelId: string,
  deduplicationId: string,
  stateDir?: string,
): Promise<void> {
  const filePath = path.join(resolveQueueDir(stateDir), entryFilename(channelId, deduplicationId));
  try {
    await fs.promises.unlink(filePath);
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: string }).code === "ENOENT"
    ) {
      return; // Already removed — no-op.
    }
    throw err;
  }
}

/**
 * Load all pending webhook entries, sorted by enqueue time, deduplicated by
 * deduplicationId. Entries older than 1 hour are deleted (cleanup).
 */
export async function replayPendingWebhooks(
  channelId?: string,
  stateDir?: string,
): Promise<WebhookQueueEntry[]> {
  const queueDir = resolveQueueDir(stateDir);
  let files: string[];
  try {
    files = await fs.promises.readdir(queueDir);
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: string }).code !== "ENOENT"
    ) {
      console.warn("[webhook-queue] failed to read queue directory:", err);
    }
    return [];
  }

  const now = Date.now();
  const entries: WebhookQueueEntry[] = [];

  for (const file of files) {
    // Clean up orphaned temp files from interrupted writes.
    if (file.endsWith(".tmp")) {
      await fs.promises.unlink(path.join(queueDir, file)).catch(() => {});
      continue;
    }
    if (!file.endsWith(".json")) {
      continue;
    }
    const filePath = path.join(queueDir, file);
    try {
      const raw = await fs.promises.readFile(filePath, "utf-8");
      const entry = JSON.parse(raw) as WebhookQueueEntry;

      // Validate required fields to avoid sort/dedup errors from malformed entries.
      if (typeof entry.deduplicationId !== "string" || typeof entry.enqueuedAt !== "number") {
        continue;
      }

      // Cleanup: delete entries older than 1 hour.
      if (now - entry.enqueuedAt > MAX_AGE_MS) {
        await fs.promises.unlink(filePath).catch(() => {});
        continue;
      }

      // Filter by channel if specified.
      if (channelId && entry.channelId !== channelId) {
        continue;
      }

      entries.push(entry);
    } catch {
      // Skip malformed or inaccessible entries.
    }
  }

  // Sort oldest first; break timestamp ties deterministically by deduplicationId.
  entries.sort(
    (a, b) => a.enqueuedAt - b.enqueuedAt || a.deduplicationId.localeCompare(b.deduplicationId),
  );

  // Deduplicate by deduplicationId (keep earliest).
  const seen = new Set<string>();
  return entries.filter((e) => {
    if (seen.has(e.deduplicationId)) {
      return false;
    }
    seen.add(e.deduplicationId);
    return true;
  });
}
