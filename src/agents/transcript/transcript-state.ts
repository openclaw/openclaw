import { randomUUID } from "node:crypto";
import {
  appendSqliteSessionTranscriptEvent,
  loadSqliteSessionTranscriptEvents,
  replaceSqliteSessionTranscriptEvents,
  resolveSqliteSessionTranscriptScope,
} from "../../config/sessions/transcript-store.sqlite.js";
import {
  buildSessionContext,
  CURRENT_SESSION_VERSION,
  migrateSessionEntries,
} from "./session-transcript-format.js";
import type {
  FileEntry,
  SessionContext,
  SessionEntry,
  SessionHeader,
  SessionTreeNode,
} from "./session-transcript-types.js";

type BranchSummaryEntry = Extract<SessionEntry, { type: "branch_summary" }>;
type CompactionEntry = Extract<SessionEntry, { type: "compaction" }>;
type CustomEntry = Extract<SessionEntry, { type: "custom" }>;
type CustomMessageEntry = Extract<SessionEntry, { type: "custom_message" }>;
type LabelEntry = Extract<SessionEntry, { type: "label" }>;
type ModelChangeEntry = Extract<SessionEntry, { type: "model_change" }>;
type SessionInfoEntry = Extract<SessionEntry, { type: "session_info" }>;
type SessionMessageEntry = Extract<SessionEntry, { type: "message" }>;
type ThinkingLevelChangeEntry = Extract<SessionEntry, { type: "thinking_level_change" }>;

type TranscriptStateScope = {
  agentId: string;
  sessionId: string;
};

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

function transcriptStateFromEntries(fileEntries: FileEntry[]): TranscriptState {
  const headerBeforeMigration =
    fileEntries.find((entry): entry is SessionHeader => entry.type === "session") ?? null;
  const migrated = sessionHeaderVersion(headerBeforeMigration) < CURRENT_SESSION_VERSION;
  migrateSessionEntries(fileEntries);
  const header =
    fileEntries.find((entry): entry is SessionHeader => entry.type === "session") ?? null;
  const entries = fileEntries.filter(isSessionEntry);
  return new TranscriptState({ header, entries, migrated });
}

function transcriptStateFromSqliteScope(scope: TranscriptStateScope): TranscriptState | undefined {
  const events = loadSqliteSessionTranscriptEvents(scope).map((entry) => entry.event);
  if (events.length === 0) {
    return undefined;
  }
  return transcriptStateFromEntries(
    events.filter((event): event is FileEntry => Boolean(event && typeof event === "object")),
  );
}

function resolveTranscriptWriteScopeForSession(
  scope: TranscriptStateScope,
  entries: Array<SessionHeader | SessionEntry>,
): TranscriptStateScope | undefined {
  const resolved = resolveSqliteSessionTranscriptScope(scope);
  if (!resolved) {
    return undefined;
  }
  const header = entries.find((entry): entry is SessionHeader => entry.type === "session");
  const sessionId = header?.id ?? resolved.sessionId;
  if (!sessionId) {
    return undefined;
  }
  return {
    agentId: resolved.agentId,
    sessionId,
  };
}

export class TranscriptState {
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

  removeTailEntries(
    shouldRemove: (entry: SessionEntry) => boolean,
    options: { maxEntries?: number; minEntries?: number } = {},
  ): number {
    const minEntries = options.minEntries ?? 0;
    const maxEntries = options.maxEntries ?? Number.POSITIVE_INFINITY;
    let removed = 0;
    while (this.entries.length > minEntries && removed < maxEntries) {
      const last = this.entries.at(-1);
      if (!last || !shouldRemove(last)) {
        break;
      }
      this.entries.pop();
      removed += 1;
    }
    if (removed > 0) {
      this.rebuildIndex();
    }
    return removed;
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

export async function readTranscriptStateForSession(
  scope: TranscriptStateScope,
): Promise<TranscriptState> {
  const resolved = resolveSqliteSessionTranscriptScope(scope);
  const sqliteState = resolved ? transcriptStateFromSqliteScope(resolved) : undefined;
  if (sqliteState) {
    return sqliteState;
  }
  throw new Error(
    `Transcript is not in the SQLite state database for agent ${scope.agentId} session ${scope.sessionId}. Run "openclaw doctor --fix" if legacy files still need import.`,
  );
}

export function readTranscriptStateForSessionSync(scope: TranscriptStateScope): TranscriptState {
  const resolved = resolveSqliteSessionTranscriptScope(scope);
  const sqliteState = resolved ? transcriptStateFromSqliteScope(resolved) : undefined;
  if (sqliteState) {
    return sqliteState;
  }
  throw new Error(
    `Transcript is not in the SQLite state database for agent ${scope.agentId} session ${scope.sessionId}. Run "openclaw doctor --fix" if legacy files still need import.`,
  );
}

export async function replaceTranscriptStateEventsForSession(
  scope: TranscriptStateScope,
  entries: Array<SessionHeader | SessionEntry>,
): Promise<void> {
  const writeScope = resolveTranscriptWriteScopeForSession(scope, entries);
  if (!writeScope) {
    throw new Error(
      `Cannot write SQLite transcript without a session header for agent ${scope.agentId} session ${scope.sessionId}`,
    );
  }
  replaceSqliteSessionTranscriptEvents({
    ...writeScope,
    events: entries,
  });
}

export function replaceTranscriptStateEventsForSessionSync(
  scope: TranscriptStateScope,
  entries: Array<SessionHeader | SessionEntry>,
): void {
  const writeScope = resolveTranscriptWriteScopeForSession(scope, entries);
  if (!writeScope) {
    throw new Error(
      `Cannot write SQLite transcript without a session header for agent ${scope.agentId} session ${scope.sessionId}`,
    );
  }
  replaceSqliteSessionTranscriptEvents({
    ...writeScope,
    events: entries,
  });
}

export async function persistTranscriptStateMutationForSession(params: {
  agentId: string;
  sessionId: string;
  state: TranscriptState;
  appendedEntries: SessionEntry[];
}): Promise<void> {
  if (params.appendedEntries.length === 0 && !params.state.migrated) {
    return;
  }
  const allEntries = [
    ...(params.state.header ? [params.state.header] : []),
    ...params.state.entries,
  ];
  if (params.state.migrated) {
    await replaceTranscriptStateEventsForSession(params, allEntries);
    return;
  }
  const scope = resolveTranscriptWriteScopeForSession(params, allEntries);
  if (!scope) {
    throw new Error(
      `Cannot append SQLite transcript without a session header for agent ${params.agentId} session ${params.sessionId}`,
    );
  }
  for (const entry of params.appendedEntries) {
    appendSqliteSessionTranscriptEvent({ ...scope, event: entry });
  }
}

export function persistTranscriptStateMutationForSessionSync(params: {
  agentId: string;
  sessionId: string;
  state: TranscriptState;
  appendedEntries: SessionEntry[];
}): void {
  if (params.appendedEntries.length === 0 && !params.state.migrated) {
    return;
  }
  const allEntries = [
    ...(params.state.header ? [params.state.header] : []),
    ...params.state.entries,
  ];
  if (params.state.migrated) {
    replaceTranscriptStateEventsForSessionSync(params, allEntries);
    return;
  }
  const scope = resolveTranscriptWriteScopeForSession(params, allEntries);
  if (!scope) {
    throw new Error(
      `Cannot append SQLite transcript without a session header for agent ${params.agentId} session ${params.sessionId}`,
    );
  }
  for (const entry of params.appendedEntries) {
    appendSqliteSessionTranscriptEvent({ ...scope, event: entry });
  }
}
