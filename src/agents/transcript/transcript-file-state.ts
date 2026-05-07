import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  appendSqliteSessionTranscriptEvent,
  loadSqliteSessionTranscriptEvents,
  replaceSqliteSessionTranscriptEvents,
  resolveSqliteSessionTranscriptScopeForPath,
} from "../../config/sessions/transcript-store.sqlite.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../../routing/session-key.js";
import type {
  FileEntry,
  SessionContext,
  SessionEntry,
  SessionHeader,
  SessionTreeNode,
} from "./session-transcript-contract.js";
import {
  buildSessionContext,
  CURRENT_SESSION_VERSION,
  migrateSessionEntries,
} from "./session-transcript-format.js";

type BranchSummaryEntry = Extract<SessionEntry, { type: "branch_summary" }>;
type CompactionEntry = Extract<SessionEntry, { type: "compaction" }>;
type CustomEntry = Extract<SessionEntry, { type: "custom" }>;
type CustomMessageEntry = Extract<SessionEntry, { type: "custom_message" }>;
type LabelEntry = Extract<SessionEntry, { type: "label" }>;
type ModelChangeEntry = Extract<SessionEntry, { type: "model_change" }>;
type SessionInfoEntry = Extract<SessionEntry, { type: "session_info" }>;
type SessionMessageEntry = Extract<SessionEntry, { type: "message" }>;
type ThinkingLevelChangeEntry = Extract<SessionEntry, { type: "thinking_level_change" }>;

function isSessionEntry(entry: FileEntry): entry is SessionEntry {
  return entry.type !== "session";
}

function sessionHeaderVersion(header: SessionHeader | null): number {
  return typeof header?.version === "number" ? header.version : 1;
}

function generateEntryId(byId: { has(id: string): boolean }): string {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const id = randomUUID().slice(0, 8);
    if (!byId.has(id)) {
      return id;
    }
  }
  return randomUUID();
}

function resolveAgentIdFromTranscriptPath(sessionFile: string): string {
  const resolved = path.resolve(sessionFile);
  const sessionsDir = path.dirname(resolved);
  const agentDir = path.dirname(sessionsDir);
  const agentsDir = path.dirname(agentDir);
  if (path.basename(sessionsDir) === "sessions" && path.basename(agentsDir) === "agents") {
    return normalizeAgentId(path.basename(agentDir));
  }
  return DEFAULT_AGENT_ID;
}

function transcriptStateFromFileEntries(fileEntries: FileEntry[]): TranscriptFileState {
  const headerBeforeMigration =
    fileEntries.find((entry): entry is SessionHeader => entry.type === "session") ?? null;
  const migrated = sessionHeaderVersion(headerBeforeMigration) < CURRENT_SESSION_VERSION;
  migrateSessionEntries(fileEntries);
  const header =
    fileEntries.find((entry): entry is SessionHeader => entry.type === "session") ?? null;
  const entries = fileEntries.filter(isSessionEntry);
  return new TranscriptFileState({ header, entries, migrated });
}

function transcriptStateFromSqlite(sessionFile: string): TranscriptFileState | undefined {
  const scope = resolveSqliteSessionTranscriptScopeForPath({ transcriptPath: sessionFile });
  if (!scope) {
    return undefined;
  }
  const events = loadSqliteSessionTranscriptEvents(scope).map((entry) => entry.event);
  if (events.length === 0) {
    return undefined;
  }
  return transcriptStateFromFileEntries(
    events.filter((event): event is FileEntry => Boolean(event && typeof event === "object")),
  );
}

function resolveTranscriptWriteScope(
  sessionFile: string,
  entries: Array<SessionHeader | SessionEntry>,
): { agentId: string; sessionId: string; transcriptPath: string } | undefined {
  const header = entries.find((entry): entry is SessionHeader => entry.type === "session");
  const existing = resolveSqliteSessionTranscriptScopeForPath({ transcriptPath: sessionFile });
  const sessionId = header?.id ?? existing?.sessionId;
  if (!sessionId) {
    return undefined;
  }
  return {
    agentId: existing?.agentId ?? resolveAgentIdFromTranscriptPath(sessionFile),
    sessionId,
    transcriptPath: path.resolve(sessionFile),
  };
}

export class TranscriptFileState {
  readonly header: SessionHeader | null;
  readonly entries: SessionEntry[];
  readonly migrated: boolean;
  private readonly byId = new Map<string, SessionEntry>();
  private readonly labelsById = new Map<string, string>();
  private readonly labelTimestampsById = new Map<string, string>();
  private leafId: string | null = null;

  constructor(params: {
    header: SessionHeader | null;
    entries: SessionEntry[];
    migrated?: boolean;
  }) {
    this.header = params.header;
    this.entries = [...params.entries];
    this.migrated = params.migrated === true;
    this.rebuildIndex();
  }

  private rebuildIndex(): void {
    this.byId.clear();
    this.labelsById.clear();
    this.labelTimestampsById.clear();
    this.leafId = null;
    for (const entry of this.entries) {
      this.byId.set(entry.id, entry);
      this.leafId = entry.id;
      if (entry.type === "label") {
        if (entry.label) {
          this.labelsById.set(entry.targetId, entry.label);
          this.labelTimestampsById.set(entry.targetId, entry.timestamp);
        } else {
          this.labelsById.delete(entry.targetId);
          this.labelTimestampsById.delete(entry.targetId);
        }
      }
    }
  }

  getCwd(): string {
    return this.header?.cwd ?? process.cwd();
  }

  getHeader(): SessionHeader | null {
    return this.header;
  }

  getEntries(): SessionEntry[] {
    return [...this.entries];
  }

  getLeafId(): string | null {
    return this.leafId;
  }

  getLeafEntry(): SessionEntry | undefined {
    return this.leafId ? this.byId.get(this.leafId) : undefined;
  }

  getEntry(id: string): SessionEntry | undefined {
    return this.byId.get(id);
  }

  getChildren(parentId: string): SessionEntry[] {
    return this.entries.filter((entry) => entry.parentId === parentId);
  }

  getLabel(id: string): string | undefined {
    return this.labelsById.get(id);
  }

  getTree(): SessionTreeNode[] {
    const nodeById = new Map<string, SessionTreeNode>();
    const roots: SessionTreeNode[] = [];
    for (const entry of this.entries) {
      nodeById.set(entry.id, {
        entry,
        children: [],
        label: this.labelsById.get(entry.id),
        labelTimestamp: this.labelTimestampsById.get(entry.id),
      });
    }

    for (const entry of this.entries) {
      const node = nodeById.get(entry.id);
      if (!node) {
        continue;
      }
      if (entry.parentId === null || entry.parentId === entry.id) {
        roots.push(node);
        continue;
      }
      const parent = nodeById.get(entry.parentId);
      if (parent) {
        parent.children.push(node);
      } else {
        roots.push(node);
      }
    }

    const stack = [...roots];
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node) {
        continue;
      }
      node.children.sort((a, b) => Date.parse(a.entry.timestamp) - Date.parse(b.entry.timestamp));
      stack.push(...node.children);
    }
    return roots;
  }

  getSessionName(): string | undefined {
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const entry = this.entries[index];
      if (entry.type === "session_info") {
        return entry.name?.trim() || undefined;
      }
    }
    return undefined;
  }

  getBranch(fromId?: string): SessionEntry[] {
    const branch: SessionEntry[] = [];
    let current = (fromId ?? this.leafId) ? this.byId.get((fromId ?? this.leafId)!) : undefined;
    while (current) {
      branch.push(current);
      current = current.parentId ? this.byId.get(current.parentId) : undefined;
    }
    branch.reverse();
    return branch;
  }

  buildSessionContext(): SessionContext {
    return buildSessionContext(this.entries, this.leafId, this.byId);
  }

  branch(branchFromId: string): void {
    if (!this.byId.has(branchFromId)) {
      throw new Error(`Entry ${branchFromId} not found`);
    }
    this.leafId = branchFromId;
  }

  resetLeaf(): void {
    this.leafId = null;
  }

  appendMessage(message: SessionMessageEntry["message"]): SessionMessageEntry {
    return this.appendEntry({
      type: "message",
      id: generateEntryId(this.byId),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      message,
    });
  }

  appendThinkingLevelChange(thinkingLevel: string): ThinkingLevelChangeEntry {
    return this.appendEntry({
      type: "thinking_level_change",
      id: generateEntryId(this.byId),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      thinkingLevel,
    });
  }

  appendModelChange(provider: string, modelId: string): ModelChangeEntry {
    return this.appendEntry({
      type: "model_change",
      id: generateEntryId(this.byId),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      provider,
      modelId,
    });
  }

  appendCompaction(
    summary: string,
    firstKeptEntryId: string,
    tokensBefore: number,
    details?: unknown,
    fromHook?: boolean,
  ): CompactionEntry {
    return this.appendEntry({
      type: "compaction",
      id: generateEntryId(this.byId),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      summary,
      firstKeptEntryId,
      tokensBefore,
      details,
      fromHook,
    });
  }

  appendCustomEntry(customType: string, data?: unknown): CustomEntry {
    return this.appendEntry({
      type: "custom",
      customType,
      data,
      id: generateEntryId(this.byId),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
    });
  }

  appendSessionInfo(name: string): SessionInfoEntry {
    return this.appendEntry({
      type: "session_info",
      id: generateEntryId(this.byId),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      name: name.trim(),
    });
  }

  appendCustomMessageEntry(
    customType: string,
    content: CustomMessageEntry["content"],
    display: boolean,
    details?: unknown,
  ): CustomMessageEntry {
    return this.appendEntry({
      type: "custom_message",
      customType,
      content,
      display,
      details,
      id: generateEntryId(this.byId),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
    });
  }

  appendLabelChange(targetId: string, label: string | undefined): LabelEntry {
    if (!this.byId.has(targetId)) {
      throw new Error(`Entry ${targetId} not found`);
    }
    return this.appendEntry({
      type: "label",
      id: generateEntryId(this.byId),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      targetId,
      label,
    });
  }

  branchWithSummary(
    branchFromId: string | null,
    summary: string,
    details?: unknown,
    fromHook?: boolean,
  ): BranchSummaryEntry {
    if (branchFromId !== null && !this.byId.has(branchFromId)) {
      throw new Error(`Entry ${branchFromId} not found`);
    }
    this.leafId = branchFromId;
    return this.appendEntry({
      type: "branch_summary",
      id: generateEntryId(this.byId),
      parentId: branchFromId,
      timestamp: new Date().toISOString(),
      fromId: branchFromId ?? "root",
      summary,
      details,
      fromHook,
    });
  }

  private appendEntry<T extends SessionEntry>(entry: T): T {
    this.entries.push(entry);
    this.byId.set(entry.id, entry);
    this.leafId = entry.id;
    if (entry.type === "label") {
      if (entry.label) {
        this.labelsById.set(entry.targetId, entry.label);
        this.labelTimestampsById.set(entry.targetId, entry.timestamp);
      } else {
        this.labelsById.delete(entry.targetId);
        this.labelTimestampsById.delete(entry.targetId);
      }
    }
    return entry;
  }
}

export async function readTranscriptFileState(sessionFile: string): Promise<TranscriptFileState> {
  const sqliteState = transcriptStateFromSqlite(sessionFile);
  if (sqliteState) {
    return sqliteState;
  }
  throw new Error(
    `Transcript is not in SQLite: ${sessionFile}. Run "openclaw doctor --fix" to import legacy JSONL transcripts.`,
  );
}

export function readTranscriptFileStateSync(sessionFile: string): TranscriptFileState {
  const sqliteState = transcriptStateFromSqlite(sessionFile);
  if (sqliteState) {
    return sqliteState;
  }
  throw new Error(
    `Transcript is not in SQLite: ${sessionFile}. Run "openclaw doctor --fix" to import legacy JSONL transcripts.`,
  );
}

export async function writeTranscriptFileAtomic(
  filePath: string,
  entries: Array<SessionHeader | SessionEntry>,
): Promise<void> {
  const scope = resolveTranscriptWriteScope(filePath, entries);
  if (!scope) {
    throw new Error(`Cannot write SQLite transcript without a session header: ${filePath}`);
  }
  replaceSqliteSessionTranscriptEvents({
    ...scope,
    events: entries,
  });
}

export function writeTranscriptFileAtomicSync(
  filePath: string,
  entries: Array<SessionHeader | SessionEntry>,
): void {
  const scope = resolveTranscriptWriteScope(filePath, entries);
  if (!scope) {
    throw new Error(`Cannot write SQLite transcript without a session header: ${filePath}`);
  }
  replaceSqliteSessionTranscriptEvents({
    ...scope,
    events: entries,
  });
}

export async function persistTranscriptStateMutation(params: {
  sessionFile: string;
  state: TranscriptFileState;
  appendedEntries: SessionEntry[];
}): Promise<void> {
  if (params.appendedEntries.length === 0 && !params.state.migrated) {
    return;
  }
  if (params.state.migrated) {
    await writeTranscriptFileAtomic(params.sessionFile, [
      ...(params.state.header ? [params.state.header] : []),
      ...params.state.entries,
    ]);
    return;
  }
  const scope = resolveTranscriptWriteScope(params.sessionFile, [
    ...(params.state.header ? [params.state.header] : []),
    ...params.state.entries,
  ]);
  if (!scope) {
    throw new Error(
      `Cannot append SQLite transcript without a session header: ${params.sessionFile}`,
    );
  }
  for (const entry of params.appendedEntries) {
    appendSqliteSessionTranscriptEvent({ ...scope, event: entry });
  }
}

export function persistTranscriptStateMutationSync(params: {
  sessionFile: string;
  state: TranscriptFileState;
  appendedEntries: SessionEntry[];
}): void {
  if (params.appendedEntries.length === 0 && !params.state.migrated) {
    return;
  }
  if (params.state.migrated) {
    writeTranscriptFileAtomicSync(params.sessionFile, [
      ...(params.state.header ? [params.state.header] : []),
      ...params.state.entries,
    ]);
    return;
  }
  const scope = resolveTranscriptWriteScope(params.sessionFile, [
    ...(params.state.header ? [params.state.header] : []),
    ...params.state.entries,
  ]);
  if (!scope) {
    throw new Error(
      `Cannot append SQLite transcript without a session header: ${params.sessionFile}`,
    );
  }
  for (const entry of params.appendedEntries) {
    appendSqliteSessionTranscriptEvent({ ...scope, event: entry });
  }
}
