import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { CURRENT_SESSION_VERSION } from "@mariozechner/pi-coding-agent";
import {
  acquireSessionWriteLock,
  type SessionWriteLockAcquireTimeoutConfig,
  resolveSessionWriteLockAcquireTimeoutMs,
} from "../../agents/session-write-lock.js";

const TRANSCRIPT_APPEND_SCAN_CHUNK_BYTES = 64 * 1024;
const SESSION_MANAGER_APPEND_MAX_BYTES = 8 * 1024 * 1024;

type TranscriptLeafInfo = {
  leafId?: string;
  hasParentLinkedEntries: boolean;
  nonSessionEntryCount: number;
};

async function yieldTranscriptAppendScan(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function lineParentLinkedEntryId(line: string): string | undefined {
  if (!line.trim()) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(line) as { type?: unknown; id?: unknown; parentId?: unknown };
    return parsed.type !== "session" && typeof parsed.id === "string" && "parentId" in parsed
      ? parsed.id
      : undefined;
  } catch {
    return undefined;
  }
}

function normalizeEntryId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function generateEntryId(existingIds: Set<string>): string {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const id = randomUUID().slice(0, 8);
    if (!existingIds.has(id)) {
      existingIds.add(id);
      return id;
    }
  }
  const id = randomUUID();
  existingIds.add(id);
  return id;
}

async function readTranscriptLeafInfo(transcriptPath: string): Promise<TranscriptLeafInfo> {
  const handle = await fs.open(transcriptPath, "r");
  try {
    const decoder = new StringDecoder("utf8");
    const buffer = Buffer.allocUnsafe(TRANSCRIPT_APPEND_SCAN_CHUNK_BYTES);
    let carry = "";
    let leafId: string | undefined;
    let hasParentLinkedEntries = false;
    let nonSessionEntryCount = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead <= 0) {
        break;
      }
      const text = carry + decoder.write(buffer.subarray(0, bytesRead));
      const lines = text.split(/\r?\n/);
      carry = lines.pop() ?? "";
      for (const line of lines) {
        if (lineHasNonSessionEntry(line)) {
          nonSessionEntryCount += 1;
        }
        const id = lineParentLinkedEntryId(line);
        if (id) {
          leafId = id;
          hasParentLinkedEntries = true;
        }
      }
      await yieldTranscriptAppendScan();
    }
    const tail = carry + decoder.end();
    if (lineHasNonSessionEntry(tail)) {
      nonSessionEntryCount += 1;
    }
    const id = lineParentLinkedEntryId(tail);
    if (id) {
      leafId = id;
      hasParentLinkedEntries = true;
    }
    return {
      ...(leafId ? { leafId } : {}),
      hasParentLinkedEntries,
      nonSessionEntryCount,
    };
  } finally {
    await handle.close();
  }
}

function lineHasNonSessionEntry(line: string): boolean {
  if (!line.trim()) {
    return false;
  }
  try {
    const parsed = JSON.parse(line) as { type?: unknown };
    return parsed.type !== "session";
  } catch {
    return false;
  }
}

async function migrateLinearTranscriptToParentLinked(transcriptPath: string): Promise<{
  leafId?: string;
}> {
  const raw = await fs.readFile(transcriptPath, "utf-8");
  // First pass: collect all existing IDs already in the file so we preserve them.
  // This ensures idempotency - running migration multiple times produces the same result.
  const seenIds = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        if (record.type !== "session") {
          const id = normalizeEntryId(record.id);
          if (id !== undefined) {
            seenIds.add(id);
          }
        }
      }
    } catch {
      // Skip malformed lines
    }
  }

  const existingIds = new Set<string>(seenIds);
  const output: string[] = [];
  let previousId: string | null = null;
  let leafId: string | undefined;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      output.push(line);
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      output.push(line);
      continue;
    }
    const record = parsed as Record<string, unknown>;
    if (record.type === "session") {
      output.push(JSON.stringify({ ...record, version: CURRENT_SESSION_VERSION }));
      continue;
    }
    // Preserve existing valid IDs that are already in the file.
    // Only generate new IDs for entries without valid existing IDs.
    const id = normalizeEntryId(record.id) ?? generateEntryId(existingIds);
    existingIds.add(id);
    if (!Object.hasOwn(record, "id") || normalizeEntryId(record.id) === undefined) {
      record.id = id;
    }
    if (!Object.hasOwn(record, "parentId")) {
      record.parentId = previousId;
    }
    previousId = id;
    leafId = id;
    output.push(JSON.stringify(record));
  }
  await fs.writeFile(transcriptPath, `${output.join("\n")}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
  const result: { leafId?: string } = {};
  if (leafId) {
    result.leafId = leafId;
  }
  return result;
}

async function ensureTranscriptHeader(
  transcriptPath: string,
  params: { sessionId?: string; cwd?: string } = {},
): Promise<void> {
  const stat = await fs.stat(transcriptPath).catch(() => null);
  if (stat?.isFile() && stat.size > 0) {
    return;
  }
  await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
  const header = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: params.sessionId ?? randomUUID(),
    timestamp: new Date().toISOString(),
    cwd: params.cwd ?? process.cwd(),
  };
  await fs.writeFile(transcriptPath, `${JSON.stringify(header)}\n`, {
    encoding: "utf-8",
    mode: 0o600,
    flag: stat?.isFile() ? "w" : "wx",
  });
}

export async function appendSessionTranscriptMessage(params: {
  transcriptPath: string;
  message: unknown;
  now?: number;
  sessionId?: string;
  cwd?: string;
  useRawWhenLinear?: boolean;
  config?: SessionWriteLockAcquireTimeoutConfig;
}): Promise<{ messageId: string }> {
  const lock = await acquireSessionWriteLock({
    sessionFile: params.transcriptPath,
    timeoutMs: resolveSessionWriteLockAcquireTimeoutMs(params.config),
    allowReentrant: true,
  });
  try {
    const now = params.now ?? Date.now();
    const messageId = randomUUID();
    await ensureTranscriptHeader(params.transcriptPath, {
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      ...(params.cwd ? { cwd: params.cwd } : {}),
    });
    const stat = await fs.stat(params.transcriptPath).catch(() => null);
    let leafInfo: TranscriptLeafInfo = await readTranscriptLeafInfo(params.transcriptPath).catch(
      () => ({
        hasParentLinkedEntries: false,
        nonSessionEntryCount: 0,
      }),
    );
    const hasLinearEntries = !leafInfo.hasParentLinkedEntries && leafInfo.nonSessionEntryCount > 0;
    const allowRawWhenLinear = params.useRawWhenLinear !== false;
    const shouldRawAppend =
      allowRawWhenLinear &&
      hasLinearEntries &&
      (stat?.size ?? 0) > SESSION_MANAGER_APPEND_MAX_BYTES;
    if (hasLinearEntries && !shouldRawAppend) {
      const migrated = await migrateLinearTranscriptToParentLinked(params.transcriptPath);
      leafInfo = {
        ...(migrated.leafId ? { leafId: migrated.leafId } : {}),
        hasParentLinkedEntries: Boolean(migrated.leafId),
        nonSessionEntryCount: leafInfo.nonSessionEntryCount,
      };
    }
    const entry = {
      type: "message",
      id: messageId,
      ...(shouldRawAppend ? {} : { parentId: leafInfo.leafId ?? null }),
      timestamp: new Date(now).toISOString(),
      message: params.message,
    };
    await fs.appendFile(params.transcriptPath, `${JSON.stringify(entry)}\n`, "utf-8");
    return { messageId };
  } finally {
    await lock.release();
  }
}
