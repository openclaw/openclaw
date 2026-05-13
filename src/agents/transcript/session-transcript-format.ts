import type { AgentMessage } from "../agent-core-contract.js";
import type {
  BranchSummaryEntry,
  CompactionEntry,
  CustomMessageEntry,
  SessionContext,
  SessionEntry,
} from "./session-transcript-types.js";

export const CURRENT_SESSION_VERSION = 1;

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
