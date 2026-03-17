import fs from "node:fs/promises";
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

async function loadIndex(stateDir?: string): Promise<DeliveryIndex> {
  try {
    const raw = await fs.readFile(resolveIndexPath(stateDir), "utf8");
    const parsed = JSON.parse(raw) as DeliveryIndex;
    if (parsed.version !== 1 || typeof parsed.entries !== "object") {
      return { version: 1, entries: {} };
    }
    return parsed;
  } catch {
    return { version: 1, entries: {} };
  }
}

async function saveIndex(index: DeliveryIndex, stateDir?: string): Promise<void> {
  const indexPath = resolveIndexPath(stateDir);
  const tmp = `${indexPath}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(index), "utf8");
  await fs.rename(tmp, indexPath);
}

export async function addToIndex(entry: DeliveryIndexEntry, stateDir?: string): Promise<void> {
  const index = await loadIndex(stateDir);
  const updated = {
    ...index,
    entries: { ...index.entries, [entry.id]: entry },
  };
  await saveIndex(updated, stateDir);
}

export async function removeFromIndex(id: string, stateDir?: string): Promise<void> {
  const index = await loadIndex(stateDir);
  const { [id]: _, ...rest } = index.entries;
  await saveIndex({ ...index, entries: rest }, stateDir);
}

export async function queryIndex(
  filter?: { channel?: string; accountId?: string },
  stateDir?: string,
): Promise<DeliveryIndexEntry[]> {
  const index = await loadIndex(stateDir);
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

export async function getIndexSize(stateDir?: string): Promise<number> {
  const index = await loadIndex(stateDir);
  return Object.keys(index.entries).length;
}

export async function rebuildIndex(stateDir?: string): Promise<number> {
  const base = stateDir ?? resolveStateDir();
  const queueDir = path.join(base, QUEUE_DIRNAME);
  const index: DeliveryIndex = { version: 1, entries: {} };
  let count = 0;
  try {
    const files = await fs.readdir(queueDir);
    for (const file of files) {
      if (!file.endsWith(".json") || file === INDEX_FILENAME) {
        continue;
      }
      try {
        const raw = await fs.readFile(path.join(queueDir, file), "utf8");
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
  await saveIndex(index, stateDir);
  return count;
}
