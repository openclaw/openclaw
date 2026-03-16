import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";

const QUEUE_DIRNAME = "delivery-queue";
const INDEX_FILENAME = "index.json";

type DeliveryIndexEntry = {
  id: string;
  channel: string;
  accountId?: string;
  enqueuedAt: number;
  lanePriority: string;
};

type DeliveryIndex = {
  version: number;
  entries: Record<string, DeliveryIndexEntry>;
};

function resolveIndexPath(stateDir?: string): string {
  const base = stateDir ?? resolveStateDir();
  return path.join(base, QUEUE_DIRNAME, INDEX_FILENAME);
}

function loadIndexSync(stateDir?: string): DeliveryIndex {
  try {
    const raw = fs.readFileSync(resolveIndexPath(stateDir), "utf8");
    const parsed = JSON.parse(raw) as DeliveryIndex;
    if (parsed.version !== 1 || typeof parsed.entries !== "object") {
      return { version: 1, entries: {} };
    }
    return parsed;
  } catch {
    return { version: 1, entries: {} };
  }
}

function saveIndexSync(index: DeliveryIndex, stateDir?: string): void {
  const indexPath = resolveIndexPath(stateDir);
  const tmp = `${indexPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(index), "utf8");
  fs.renameSync(tmp, indexPath);
}

export function addToIndex(entry: DeliveryIndexEntry, stateDir?: string): void {
  const index = loadIndexSync(stateDir);
  index.entries[entry.id] = entry;
  saveIndexSync(index, stateDir);
}

export function removeFromIndex(id: string, stateDir?: string): void {
  const index = loadIndexSync(stateDir);
  delete index.entries[id];
  saveIndexSync(index, stateDir);
}

export function queryIndex(
  filter?: { channel?: string; accountId?: string },
  stateDir?: string,
): DeliveryIndexEntry[] {
  const index = loadIndexSync(stateDir);
  let entries = Object.values(index.entries);
  if (filter?.channel) {
    entries = entries.filter((e) => e.channel === filter.channel);
  }
  if (filter?.accountId !== undefined) {
    entries = entries.filter(
      (e) => e.accountId === filter.accountId || (!e.accountId && filter.accountId === "default"),
    );
  }
  return entries.toSorted((a, b) => a.enqueuedAt - b.enqueuedAt);
}

export function getIndexSize(stateDir?: string): number {
  const index = loadIndexSync(stateDir);
  return Object.keys(index.entries).length;
}

export function rebuildIndex(stateDir?: string): number {
  const base = stateDir ?? resolveStateDir();
  const queueDir = path.join(base, QUEUE_DIRNAME);
  const index: DeliveryIndex = { version: 1, entries: {} };
  let count = 0;
  try {
    const files = fs.readdirSync(queueDir);
    for (const file of files) {
      if (!file.endsWith(".json") || file === INDEX_FILENAME) {
        continue;
      }
      try {
        const raw = fs.readFileSync(path.join(queueDir, file), "utf8");
        const entry = JSON.parse(raw) as {
          id: string;
          channel: string;
          accountId?: string;
          enqueuedAt: number;
          lanePriority?: string;
        };
        if (entry.id && entry.channel) {
          index.entries[entry.id] = {
            id: entry.id,
            channel: entry.channel,
            accountId: entry.accountId,
            enqueuedAt: entry.enqueuedAt,
            lanePriority: entry.lanePriority ?? "user-visible",
          };
          count++;
        }
      } catch {
        // Skip malformed
      }
    }
  } catch {
    // Queue dir doesn't exist yet
  }
  saveIndexSync(index, stateDir);
  return count;
}
