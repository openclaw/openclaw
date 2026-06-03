// JSONL helpers centralize newline-safe transcript serialization and writes.
import { appendFileSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { writeSiblingTempFile } from "../../infra/fs-safe-advanced.js";

type WriteJsonlFileOptions = {
  encoding?: BufferEncoding;
  flag?: string;
  mode?: number;
};

/** Serializes one JSONL entry and appends the newline terminator. */
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
  // Transcript readers expect every persisted entry batch to end with a newline.
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

export function writeJsonlEntriesSync(filePath: string, entries: readonly unknown[]): string {
  const content = serializeJsonlEntries(entries);
  writeFileSync(filePath, content, "utf-8");
  return content;
}

export function appendJsonlEntrySync(
  filePath: string,
  entry: unknown,
  options?: { prefixNewline?: boolean },
): string {
  return appendSerializedJsonlEntrySync(filePath, serializeJsonlEntry(entry), options);
}

export function appendSerializedJsonlEntrySync(
  filePath: string,
  serializedEntry: string,
  options?: { prefixNewline?: boolean },
): string {
  const content = options?.prefixNewline ? `\n${serializedEntry}` : serializedEntry;
  appendFileSync(filePath, content, "utf-8");
  return content;
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
): Promise<string> {
  const content = serializeJsonlLines(lines);
  await fs.writeFile(filePath, content, {
    encoding: options?.encoding ?? "utf-8",
    ...(options?.flag ? { flag: options.flag } : {}),
    ...(options?.mode !== undefined ? { mode: options.mode } : {}),
  });
  return content;
}

export async function appendJsonlEntry(filePath: string, entry: unknown): Promise<void> {
  await appendSerializedJsonlEntry(filePath, serializeJsonlEntry(entry));
}

export async function appendSerializedJsonlEntry(
  filePath: string,
  serializedEntry: string,
): Promise<void> {
  const handle = await fs.open(filePath, "a+", 0o600);
  try {
    const stat = await handle.stat();
    let prefixNewline = false;
    if (stat.size > 0) {
      const lastByte = Buffer.allocUnsafe(1);
      const { bytesRead } = await handle.read(lastByte, 0, 1, stat.size - 1);
      prefixNewline = bytesRead === 1 && lastByte[0] !== 0x0a;
    }
    await handle.appendFile(`${prefixNewline ? "\n" : ""}${serializedEntry}`, "utf-8");
  } finally {
    await handle.close();
  }
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
