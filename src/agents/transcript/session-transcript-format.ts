import { randomUUID } from "node:crypto";
import type { AgentMessage } from "../agent-core-contract.js";
import type {
  BranchSummaryEntry,
  CompactionEntry,
  CustomMessageEntry,
  FileEntry,
  SessionContext,
  SessionEntry,
  SessionHeader,
} from "./session-transcript-types.js";

export const CURRENT_SESSION_VERSION = 3;

function generateSessionEntryId(ids: Set<string>): string {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const id = randomUUID().slice(0, 8);
    if (!ids.has(id)) {
      ids.add(id);
      return id;
    }
  }
  const id = randomUUID();
  ids.add(id);
  return id;
}

function migrateV1ToV2(entries: FileEntry[]): void {
  const ids = new Set<string>();
  let previousId: string | null = null;
  for (const entry of entries) {
    if (entry.type === "session") {
      entry.version = 2;
      continue;
    }
    entry.id = generateSessionEntryId(ids);
    entry.parentId = previousId;
    previousId = entry.id;

    if (entry.type === "compaction") {
      const legacy = entry as CompactionEntry & { firstKeptEntryIndex?: number };
      if (typeof legacy.firstKeptEntryIndex === "number") {
        const targetEntry = entries[legacy.firstKeptEntryIndex];
        if (targetEntry?.type !== "session") {
          legacy.firstKeptEntryId = targetEntry.id;
        }
        delete legacy.firstKeptEntryIndex;
      }
    }
  }
}

function migrateV2ToV3(entries: FileEntry[]): void {
  for (const entry of entries) {
    if (entry.type === "session") {
      entry.version = 3;
      continue;
    }
    if (
      entry.type === "message" &&
      entry.message &&
      (entry.message as { role?: string }).role === "hookMessage"
    ) {
      (entry.message as { role?: string }).role = "custom";
    }
  }
}

export function parseSessionEntries(content: string): FileEntry[] {
  const entries: FileEntry[] = [];
  for (const line of content.trim().split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      entries.push(JSON.parse(line) as FileEntry);
    } catch {
      // Keep compatibility with PI's tolerant JSONL reader.
    }
  }
  return entries;
}

export function migrateSessionEntries(entries: FileEntry[]): void {
  const header = entries.find((entry): entry is SessionHeader => entry.type === "session");
  const version = header?.version ?? 1;
  if (version >= CURRENT_SESSION_VERSION) {
    return;
  }
  if (version < 2) {
    migrateV1ToV2(entries);
  }
  if (version < 3) {
    migrateV2ToV3(entries);
  }
}

function toTranscriptMessageTimestamp(timestamp: string): number {
  return new Date(timestamp).getTime();
}

function createCustomAgentMessage(entry: CustomMessageEntry): AgentMessage {
  return {
    role: "custom",
    customType: entry.customType,
    content: entry.content,
    display: entry.display,
    details: entry.details,
    timestamp: toTranscriptMessageTimestamp(entry.timestamp),
  } as AgentMessage;
}

function createBranchSummaryAgentMessage(entry: BranchSummaryEntry): AgentMessage {
  return {
    role: "branchSummary",
    summary: entry.summary,
    fromId: entry.fromId,
    timestamp: toTranscriptMessageTimestamp(entry.timestamp),
  } as AgentMessage;
}

function createCompactionSummaryAgentMessage(entry: CompactionEntry): AgentMessage {
  return {
    role: "compactionSummary",
    summary: entry.summary,
    tokensBefore: entry.tokensBefore,
    timestamp: toTranscriptMessageTimestamp(entry.timestamp),
  } as AgentMessage;
}

function buildEntryIndex(entries: SessionEntry[]): Map<string, SessionEntry> {
  const index = new Map<string, SessionEntry>();
  for (const entry of entries) {
    index.set(entry.id, entry);
  }
  return index;
}

function resolveSessionContextPath(
  entries: SessionEntry[],
  leafId: string | null | undefined,
  byId: Map<string, SessionEntry>,
): SessionEntry[] {
  if (leafId === null) {
    return [];
  }
  let leaf = leafId ? byId.get(leafId) : undefined;
  leaf ??= entries.at(-1);
  if (!leaf) {
    return [];
  }

  const path: SessionEntry[] = [];
  const seen = new Set<string>();
  let current: SessionEntry | undefined = leaf;
  while (current) {
    if (seen.has(current.id)) {
      break;
    }
    seen.add(current.id);
    path.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path;
}

function appendSessionContextMessage(messages: AgentMessage[], entry: SessionEntry): void {
  if (entry.type === "message") {
    messages.push(entry.message);
    return;
  }
  if (entry.type === "custom_message") {
    messages.push(createCustomAgentMessage(entry));
    return;
  }
  if (entry.type === "branch_summary" && entry.summary) {
    messages.push(createBranchSummaryAgentMessage(entry));
  }
}

export function buildSessionContext(
  entries: SessionEntry[],
  leafId?: string | null,
  byId?: Map<string, SessionEntry>,
): SessionContext {
  const entryIndex = byId ?? buildEntryIndex(entries);
  const path = resolveSessionContextPath(entries, leafId, entryIndex);
  let thinkingLevel = "off";
  let model: SessionContext["model"] = null;
  let compaction: CompactionEntry | null = null;

  for (const entry of path) {
    if (entry.type === "thinking_level_change") {
      thinkingLevel = entry.thinkingLevel;
      continue;
    }
    if (entry.type === "model_change") {
      model = { provider: entry.provider, modelId: entry.modelId };
      continue;
    }
    if (entry.type === "message" && entry.message.role === "assistant") {
      model = { provider: entry.message.provider, modelId: entry.message.model };
      continue;
    }
    if (entry.type === "compaction") {
      compaction = entry;
    }
  }

  const messages: AgentMessage[] = [];
  if (!compaction) {
    for (const entry of path) {
      appendSessionContextMessage(messages, entry);
    }
    return { messages, thinkingLevel, model };
  }

  messages.push(createCompactionSummaryAgentMessage(compaction));
  const compactionIndex = path.findIndex(
    (entry) => entry.type === "compaction" && entry.id === compaction.id,
  );
  let foundFirstKept = false;
  for (let index = 0; index < compactionIndex; index += 1) {
    const entry = path[index];
    if (entry.id === compaction.firstKeptEntryId) {
      foundFirstKept = true;
    }
    if (foundFirstKept) {
      appendSessionContextMessage(messages, entry);
    }
  }
  for (let index = compactionIndex + 1; index < path.length; index += 1) {
    appendSessionContextMessage(messages, path[index]);
  }
  return { messages, thinkingLevel, model };
}
