import fs from "node:fs/promises";
import path from "node:path";

export const DEFAULT_MEMORY_WARN_CHARS = 15_000;
export const DEFAULT_MEMORY_PRUNE_KEEP_CHARS = 10_000;

export type MemoryPruneResult = {
  pruned: boolean;
  dryRun: boolean;
  filePath: string;
  originalChars: number;
  keptChars: number;
  archivedChars: number;
  archiveFilePath?: string;
};

export type MemoryPruneOptions = {
  filePath: string;
  dryRun?: boolean;
  keepChars?: number;
  warnChars?: number;
};

/**
 * Split content at the nearest `## ` or `# ` heading boundary before `keepChars`.
 * Falls back to the nearest newline boundary. Returns `[kept, archived]`.
 */
export function splitAtHeadingBoundary(content: string, keepChars: number): [string, string] {
  if (keepChars >= content.length) {
    return [content, ""];
  }
  if (keepChars <= 0) {
    return ["", content];
  }

  const region = content.slice(0, keepChars);

  let splitIndex = -1;
  for (let i = region.length - 1; i >= 0; i--) {
    if (region[i] === "\n") {
      const after = region.slice(i + 1);
      if (after.startsWith("## ") || after.startsWith("# ")) {
        splitIndex = i + 1;
        break;
      }
    }
  }

  if (splitIndex === -1) {
    const lastNewline = region.lastIndexOf("\n");
    splitIndex = lastNewline >= 0 ? lastNewline + 1 : keepChars;
  }

  return [content.slice(0, splitIndex), content.slice(splitIndex)];
}

/**
 * Prune MEMORY.md when it exceeds the warn threshold.
 * Keeps the first portion and archives the rest.
 */
export async function pruneMemoryFile(opts: MemoryPruneOptions): Promise<MemoryPruneResult> {
  const { filePath, dryRun = false } = opts;
  const keepChars = opts.keepChars ?? DEFAULT_MEMORY_PRUNE_KEEP_CHARS;
  const warnChars = opts.warnChars ?? DEFAULT_MEMORY_WARN_CHARS;

  let content: string;
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {
        pruned: false,
        dryRun,
        filePath,
        originalChars: 0,
        keptChars: 0,
        archivedChars: 0,
      };
    }
    throw err;
  }

  const originalChars = content.length;

  if (originalChars <= warnChars) {
    return {
      pruned: false,
      dryRun,
      filePath,
      originalChars,
      keptChars: originalChars,
      archivedChars: 0,
    };
  }

  const [kept, archived] = splitAtHeadingBoundary(content, keepChars);

  if (archived.length === 0) {
    return {
      pruned: false,
      dryRun,
      filePath,
      originalChars,
      keptChars: originalChars,
      archivedChars: 0,
    };
  }

  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const memoryDir = path.dirname(filePath);
  const archiveDir = path.join(memoryDir, "memory");
  const archiveFilePath = path.join(archiveDir, `${dateStr}-archived.md`);

  if (dryRun) {
    return {
      pruned: true,
      dryRun: true,
      filePath,
      originalChars,
      keptChars: kept.length,
      archivedChars: archived.length,
      archiveFilePath,
    };
  }

  await fs.mkdir(archiveDir, { recursive: true }).catch(() => {});

  const archiveHeader = `\n## Archived from MEMORY.md on ${dateStr}\n\n`;
  await fs.appendFile(archiveFilePath, archiveHeader + archived, "utf-8");

  const tmpPath = filePath + ".tmp";
  await fs.writeFile(tmpPath, kept, "utf-8");
  await fs.rename(tmpPath, filePath);

  return {
    pruned: true,
    dryRun: false,
    filePath,
    originalChars,
    keptChars: kept.length,
    archivedChars: archived.length,
    archiveFilePath,
  };
}
