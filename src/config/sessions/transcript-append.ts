import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  acquireSessionWriteLock,
  type SessionWriteLockAcquireTimeoutConfig,
  resolveSessionWriteLockAcquireTimeoutMs,
} from "../../agents/session-write-lock.js";

const TRANSCRIPT_APPEND_SCAN_CHUNK_BYTES = 64 * 1024;
const SESSION_MANAGER_APPEND_MAX_BYTES = 8 * 1024 * 1024;

let piCodingAgentModulePromise: Promise<typeof import("@mariozechner/pi-coding-agent")> | null =
  null;
const transcriptAppendQueues = new Map<string, Promise<void>>();

async function loadCurrentSessionVersion(): Promise<number> {
  piCodingAgentModulePromise ??= import("@mariozechner/pi-coding-agent");
  return (await piCodingAgentModulePromise).CURRENT_SESSION_VERSION;
}

type TranscriptLeafInfo = {
  leafId?: string;
  leafConversationalId?: string;
  hasParentLinkedEntries: boolean;
  nonSessionEntryCount: number;
};

async function yieldTranscriptAppendScan(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

type ParentLinkedEntryInfo = {
  id: string;
  /**
   * The `role` field of the embedded message, when present. Used to discriminate
   * tool-result intermediates from conversational messages so that incoming user
   * messages can attach to the most-recent assistant/user turn rather than to a
   * tool-result intermediate. See appendSessionTranscriptMessageLocked.
   */
  role?: string;
};

function lineParentLinkedEntryInfo(line: string): ParentLinkedEntryInfo | undefined {
  if (!line.trim()) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(line) as {
      type?: unknown;
      id?: unknown;
      parentId?: unknown;
      message?: { role?: unknown } | null;
    };
    if (parsed.type === "session" || typeof parsed.id !== "string" || !("parentId" in parsed)) {
      return undefined;
    }
    const role = parsed.message && typeof parsed.message === "object"
      ? (parsed.message as { role?: unknown }).role
      : undefined;
    return {
      id: parsed.id,
      ...(typeof role === "string" ? { role } : {}),
    };
  } catch {
    return undefined;
  }
}

function lineParentLinkedEntryId(line: string): string | undefined {
  return lineParentLinkedEntryInfo(line)?.id;
}

/**
 * Roles whose entries represent intermediate tool exchange records rather than
 * conversational turns. When choosing the parent for an incoming `user` message
 * we walk past these to find the most-recent assistant/user message instead.
 */
const TOOL_INTERMEDIATE_ROLES: ReadonlySet<string> = new Set(["toolResult", "tool_result"]);

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
    let leafConversationalId: string | undefined;
    let hasParentLinkedEntries = false;
    let nonSessionEntryCount = 0;
    const consumeLine = (line: string): void => {
      if (lineHasNonSessionEntry(line)) {
        nonSessionEntryCount += 1;
      }
      const info = lineParentLinkedEntryInfo(line);
      if (info) {
        leafId = info.id;
        hasParentLinkedEntries = true;
        if (!info.role || !TOOL_INTERMEDIATE_ROLES.has(info.role)) {
          leafConversationalId = info.id;
        }
      }
    };
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead <= 0) {
        break;
      }
      const text = carry + decoder.write(buffer.subarray(0, bytesRead));
      const lines = text.split(/\r?\n/);
      carry = lines.pop() ?? "";
      for (const line of lines) {
        consumeLine(line);
      }
      await yieldTranscriptAppendScan();
    }
    const tail = carry + decoder.end();
    consumeLine(tail);
    return {
      ...(leafId ? { leafId } : {}),
      ...(leafConversationalId ? { leafConversationalId } : {}),
      hasParentLinkedEntries,
      nonSessionEntryCount,
    };
  } finally {
    await handle.close();
  }
}

function extractIncomingMessageRole(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const role = (message as { role?: unknown }).role;
  return typeof role === "string" ? role : undefined;
}

/**
 * Choose the parentId for a freshly-appended entry. For incoming `user` messages
 * we prefer the most-recent conversational entry (assistant/user) over any
 * trailing tool-result intermediate, so an inbound user message after a turn
 * that ended with `assistant{toolCall} → toolResult → assistant{text}` does not
 * become a sibling of the toolResult and orphan the assistant text on the next
 * normalisation pass.
 *
 * If the incoming role is not `user`, or the leaf is already conversational, we
 * fall through to the historical behaviour (use the trailing entry).
 */
function resolveParentIdForIncomingMessage(
  leafInfo: TranscriptLeafInfo,
  incomingMessage: unknown,
): string | null {
  const incomingRole = extractIncomingMessageRole(incomingMessage);
  if (incomingRole === "user" && leafInfo.leafConversationalId) {
    return leafInfo.leafConversationalId;
  }
  return leafInfo.leafId ?? null;
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
  const currentSessionVersion = await loadCurrentSessionVersion();
  const existingIds = new Set<string>();
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
      output.push(JSON.stringify({ ...record, version: currentSessionVersion }));
      continue;
    }
    const id = normalizeEntryId(record.id) ?? generateEntryId(existingIds);
    existingIds.add(id);
    record.id = id;
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
  const currentSessionVersion = await loadCurrentSessionVersion();
  await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
  const header = {
    type: "session",
    version: currentSessionVersion,
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

async function resolveTranscriptAppendQueueKey(transcriptPath: string): Promise<string> {
  const resolvedTranscriptPath = path.resolve(transcriptPath);
  const transcriptDir = path.dirname(resolvedTranscriptPath);
  await fs.mkdir(transcriptDir, { recursive: true });
  try {
    return path.join(await fs.realpath(transcriptDir), path.basename(resolvedTranscriptPath));
  } catch {
    return resolvedTranscriptPath;
  }
}

async function withTranscriptAppendQueue<T>(
  transcriptPath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const queueKey = await resolveTranscriptAppendQueueKey(transcriptPath);
  const previous = transcriptAppendQueues.get(queueKey) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => current);
  transcriptAppendQueues.set(queueKey, tail);
  await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    releaseCurrent();
    if (transcriptAppendQueues.get(queueKey) === tail) {
      transcriptAppendQueues.delete(queueKey);
    }
  }
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
  return await withTranscriptAppendQueue(params.transcriptPath, () =>
    appendSessionTranscriptMessageLocked(params),
  );
}

async function appendSessionTranscriptMessageLocked(params: {
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
      ...(shouldRawAppend
        ? {}
        : { parentId: resolveParentIdForIncomingMessage(leafInfo, params.message) }),
      timestamp: new Date(now).toISOString(),
      message: params.message,
    };
    await fs.appendFile(params.transcriptPath, `${JSON.stringify(entry)}\n`, "utf-8");
    return { messageId };
  } finally {
    await lock.release();
  }
}
