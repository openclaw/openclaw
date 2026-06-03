import { appendFileSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { writeSiblingTempFile } from "../../infra/fs-safe-advanced.js";

type WriteJsonlFileOptions = {
  encoding?: BufferEncoding;
  flag?: string;
  mode?: number;
};

export function serializeJsonlEntry(entry: unknown): string {
  return `${serializeJsonlLine(entry)}\n`;
}

export function serializeJsonlLine(entry: unknown): string {
  return JSON.stringify(entry);
}

export function serializeJsonlEntries(entries: readonly unknown[]): string {
  return serializeJsonlLines(entries.map(serializeJsonlLine));
}

export function serializeJsonlLines(lines: readonly string[]): string {
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

export function writeJsonlEntriesSync(filePath: string, entries: readonly unknown[]): void {
  writeFileSync(filePath, serializeJsonlEntries(entries), "utf-8");
}

export function appendJsonlEntrySync(filePath: string, entry: unknown): void {
  appendFileSync(filePath, serializeJsonlEntry(entry), "utf-8");
}

export function appendJsonlEntriesSync(filePath: string, entries: readonly unknown[]): void {
  if (entries.length === 0) {
    return;
  }
  appendFileSync(filePath, serializeJsonlEntries(entries), "utf-8");
}

export async function writeJsonlEntry(
  filePath: string,
  entry: unknown,
  options?: WriteJsonlFileOptions,
): Promise<void> {
  await fs.writeFile(filePath, serializeJsonlEntry(entry), {
    encoding: options?.encoding ?? "utf-8",
    ...(options?.flag ? { flag: options.flag } : {}),
    ...(options?.mode !== undefined ? { mode: options.mode } : {}),
  });
}

export async function writeJsonlLines(
  filePath: string,
  lines: readonly string[],
  options?: WriteJsonlFileOptions,
): Promise<void> {
  await fs.writeFile(filePath, serializeJsonlLines(lines), {
    encoding: options?.encoding ?? "utf-8",
    ...(options?.flag ? { flag: options.flag } : {}),
    ...(options?.mode !== undefined ? { mode: options.mode } : {}),
  });
}

export async function appendJsonlEntry(filePath: string, entry: unknown): Promise<void> {
  await fs.appendFile(filePath, serializeJsonlEntry(entry), "utf-8");
}

// Atomic counterpart to writeJsonlLines: write the serialized lines to a sibling
// temp file (fsync'd) and rename it over filePath. An interrupted whole-file
// rewrite (crash, power loss, or ENOSPC mid-write) can then never truncate or
// partially overwrite the existing file — on failure the original is left intact
// and the temp is removed, so the caller can retry. Output bytes are identical
// to writeJsonlLines (same serializeJsonlLines string); only the delivery
// (temp+rename instead of in-place O_TRUNC) differs. Used by the one-time
// linear->parent-linked transcript migration, which rewrites the live
// conversation-history JSONL in place.
export async function writeJsonlLinesAtomic(
  filePath: string,
  lines: readonly string[],
  options?: Pick<WriteJsonlFileOptions, "encoding" | "mode">,
): Promise<void> {
  await writeSiblingTempFile({
    dir: path.dirname(filePath),
    chmodDir: false,
    syncTempFile: true,
    syncParentDir: true,
    ...(options?.mode !== undefined ? { mode: options.mode } : {}),
    writeTemp: async (tempPath) => {
      await fs.writeFile(tempPath, serializeJsonlLines(lines), {
        encoding: options?.encoding ?? "utf-8",
        flag: "wx",
        ...(options?.mode !== undefined ? { mode: options.mode } : {}),
      });
    },
    resolveFinalPath: () => filePath,
  });
}
