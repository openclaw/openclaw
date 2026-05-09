import type { AgentMessage } from "../agent-core-contract.js";
import type { ImageContent, TextContent } from "../pi-ai-contract.js";

export type SessionHeader = {
  type: "session";
  version?: number;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
};

export type SessionEntryBase = {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
};

export type SessionMessageEntry = SessionEntryBase & {
  type: "message";
  message: AgentMessage;
};

export type ThinkingLevelChangeEntry = SessionEntryBase & {
  type: "thinking_level_change";
  thinkingLevel: string;
};

export type ModelChangeEntry = SessionEntryBase & {
  type: "model_change";
  provider: string;
  modelId: string;
};

export type CompactionEntry<T = unknown> = SessionEntryBase & {
  type: "compaction";
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details?: T;
  fromHook?: boolean;
};

export type BranchSummaryEntry<T = unknown> = SessionEntryBase & {
  type: "branch_summary";
  fromId: string;
  summary: string;
  details?: T;
  fromHook?: boolean;
};

export type CustomEntry<T = unknown> = SessionEntryBase & {
  type: "custom";
  customType: string;
  data?: T;
};

export type LabelEntry = SessionEntryBase & {
  type: "label";
  targetId: string;
  label: string | undefined;
};

export type SessionInfoEntry = SessionEntryBase & {
  type: "session_info";
  name?: string;
};

export type CustomMessageEntry<T = unknown> = SessionEntryBase & {
  type: "custom_message";
  customType: string;
  content: string | (TextContent | ImageContent)[];
  details?: T;
  display: boolean;
};

export type SessionEntry =
  | SessionMessageEntry
  | ThinkingLevelChangeEntry
  | ModelChangeEntry
  | CompactionEntry
  | BranchSummaryEntry
  | CustomEntry
  | CustomMessageEntry
  | LabelEntry
  | SessionInfoEntry;

export type FileEntry = SessionHeader | SessionEntry;

export type SessionTreeNode = {
  entry: SessionEntry;
  children: SessionTreeNode[];
  label?: string;
  labelTimestamp?: string;
};

export type SessionContext = {
  messages: AgentMessage[];
  thinkingLevel: string;
  model: { provider: string; modelId: string } | null;
};

export type SessionInfo = {
  id: string;
  transcriptScope: SessionTranscriptScope;
  cwd: string;
  name?: string;
  parentSession?: string;
  created: Date;
  modified: Date;
  messageCount: number;
  firstMessage: string;
  allMessagesText: string;
};

export type SessionTranscriptScope = {
  agentId: string;
  sessionId: string;
};

export type SessionListProgress = (loaded: number, total: number) => void;

type PersistableSessionMessage = Exclude<
  AgentMessage,
  { role: "branchSummary" | "compactionSummary" }
>;

export type SessionManager = {
  newSession(options?: { id?: string; parentSession?: string }): SessionTranscriptScope | undefined;
  isPersisted(): boolean;
  getCwd(): string;
  getSessionId(): string;
  getTranscriptScope(): SessionTranscriptScope | undefined;
  appendMessage(message: PersistableSessionMessage): string;
  appendThinkingLevelChange(thinkingLevel: string): string;
  appendModelChange(provider: string, modelId: string): string;
  appendCompaction(
    summary: string,
    firstKeptEntryId: string,
    tokensBefore: number,
    details?: unknown,
    fromHook?: boolean,
  ): string;
  appendCustomEntry(customType: string, data?: unknown): string;
  appendSessionInfo(name: string): string;
  getSessionName(): string | undefined;
  appendCustomMessageEntry(
    customType: string,
    content: string | (TextContent | ImageContent)[],
    display: boolean,
    details?: unknown,
  ): string;
  getLeafId(): string | null;
  getLeafEntry(): SessionEntry | undefined;
  getEntry(id: string): SessionEntry | undefined;
  getChildren(parentId: string): SessionEntry[];
  getLabel(id: string): string | undefined;
  appendLabelChange(targetId: string, label: string | undefined): string;
  getBranch(fromId?: string): SessionEntry[];
  buildSessionContext(): SessionContext;
  getHeader(): SessionHeader | null;
  getEntries(): SessionEntry[];
  getTree(): SessionTreeNode[];
  branch(branchFromId: string): void;
  resetLeaf(): void;
  removeTailEntries(
    shouldRemove: (entry: SessionEntry) => boolean,
    options?: { maxEntries?: number; minEntries?: number },
  ): number;
  branchWithSummary(
    branchFromId: string | null,
    summary: string,
    details?: unknown,
    fromHook?: boolean,
  ): string;
  createBranchedSession(leafId: string): SessionTranscriptScope | undefined;
};
