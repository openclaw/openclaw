/**
 * One-shot migration: delivery-queue JSON files → SQLite.
 *
 * Scans ~/.openclaw/delivery-queue/*.json (pending) and
 * ~/.openclaw/delivery-queue/failed/*.json (failed),
 * inserts them into the delivery_queue table, then deletes the source files.
 */
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { resolveStateDir } from "../../config/paths.js";
import { getStateDb } from "../state-db/connection.js";
import { enqueueDeliveryToDb, moveToFailedInDb } from "./delivery-queue-sqlite.js";
import type { QueuedDelivery } from "./delivery-queue.js";

type MigrationResult = {
  pendingCount: number;
  failedCount: number;
  migrated: boolean;
  error?: string;
};

export function migrateDeliveryQueueToSqlite(
  env?: NodeJS.ProcessEnv,
  db?: DatabaseSync,
): MigrationResult {
  const stateDir = resolveStateDir(env);
  const queueDir = path.join(stateDir, "delivery-queue");
  const failedDir = path.join(queueDir, "failed");
  const _db = db ?? getStateDb(env);

  // Skip if no queue directory
  if (!fs.existsSync(queueDir)) {
    return { pendingCount: 0, failedCount: 0, migrated: true };
  }

  let pendingCount = 0;
  let failedCount = 0;

  // Migrate pending entries
  try {
    const files = fs.readdirSync(queueDir).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      const filePath = path.join(queueDir, file);
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) {
          continue;
        }
        const raw = fs.readFileSync(filePath, "utf-8");
        const entry = JSON.parse(raw) as QueuedDelivery;
        enqueueDeliveryToDb(entry, _db);
        fs.unlinkSync(filePath);
        pendingCount++;
      } catch {
        // Skip malformed entries
      }
    }
  } catch {
    // queueDir read failed — skip
  }

  // Migrate failed entries
  try {
    if (fs.existsSync(failedDir)) {
      const files = fs.readdirSync(failedDir).filter((f) => f.endsWith(".json"));
      for (const file of files) {
        const filePath = path.join(failedDir, file);
        try {
          const raw = fs.readFileSync(filePath, "utf-8");
          const entry = JSON.parse(raw) as QueuedDelivery;
          enqueueDeliveryToDb(entry, _db);
          moveToFailedInDb(entry.id, _db);
          fs.unlinkSync(filePath);
          failedCount++;
        } catch {
          // Skip malformed entries
        }
      }
    }
  } catch {
    // failedDir read failed — skip
  }

  // Clean up empty directories
  try {
    if (fs.existsSync(failedDir)) {
      const remaining = fs.readdirSync(failedDir);
      if (remaining.length === 0) {
        fs.rmdirSync(failedDir);
      }
    }
    const remaining = fs.readdirSync(queueDir);
    // Only remove if empty (no .delivered markers or other files)
    if (remaining.length === 0) {
      fs.rmdirSync(queueDir);
    }
  } catch {
    // Best-effort cleanup
  }

  return { pendingCount, failedCount, migrated: true };
}
