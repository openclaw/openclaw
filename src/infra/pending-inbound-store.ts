import fs from "node:fs/promises";
import path from "node:path";
import { readJsonFile, writeJsonAtomic } from "./json-files.js";

const STORE_FILENAME = "pending-inbound.json";

/**
 * An inbound message captured during gateway drain.
 * Stored to disk so it survives restart and can be replayed.
 */
export type PendingInboundEntry = {
  channel: string;
  id: string;
  payload: unknown;
  capturedAt: number;
};

type PendingInboundFile = {
  version: 1;
  entries: Record<string, PendingInboundEntry>;
};

function storeKey(entry: Pick<PendingInboundEntry, "channel" | "id">): string {
  return `${entry.channel}:${entry.id}`;
}

function resolveStorePath(stateDir: string): string {
  return path.join(stateDir, STORE_FILENAME);
}

/**
 * Append (or overwrite by dedup key) a pending inbound entry.
 * Uses atomic write (tmp + rename) following the update-offset-store pattern.
 */
export async function writePendingInbound(
  stateDir: string,
  entry: PendingInboundEntry,
): Promise<void> {
  const filePath = resolveStorePath(stateDir);
  const existing = await readPendingInboundFile(filePath);
  const key = storeKey(entry);
  existing.entries[key] = entry;
  await writeJsonAtomic(filePath, existing, {
    mode: 0o600,
    trailingNewline: true,
    ensureDirMode: 0o700,
  });
}

/**
 * Read all pending inbound entries. Returns [] if the file doesn't exist.
 */
export async function readPendingInbound(stateDir: string): Promise<PendingInboundEntry[]> {
  const filePath = resolveStorePath(stateDir);
  const data = await readPendingInboundFile(filePath);
  return Object.values(data.entries);
}

/**
 * Remove the pending inbound file entirely.
 */
export async function clearPendingInbound(stateDir: string): Promise<void> {
  const filePath = resolveStorePath(stateDir);
  try {
    await fs.unlink(filePath);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      return;
    }
    throw err;
  }
}

async function readPendingInboundFile(filePath: string): Promise<PendingInboundFile> {
  const data = await readJsonFile<PendingInboundFile>(filePath);
  if (data && data.version === 1 && typeof data.entries === "object" && data.entries !== null) {
    return data;
  }
  return { version: 1, entries: {} };
}
