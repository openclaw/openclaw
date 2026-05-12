import { randomUUID } from "node:crypto";
import {
  appendSqliteSessionTranscriptMessage,
  appendSqliteSessionTranscriptEvent,
  loadSqliteSessionTranscriptEvents,
  replaceSqliteSessionTranscriptEvents,
} from "../../config/sessions/transcript-store.sqlite.js";
import { CURRENT_SESSION_VERSION } from "./session-transcript-format.js";
import type {
  SessionContext,
  SessionEntry,
  SessionHeader,
  SessionManager,
  SessionTranscriptScope,
  SessionTreeNode,
  TranscriptEntry,
} from "./session-transcript-types.js";
import { TranscriptState } from "./transcript-state.js";

function createSessionHeader(params: { id?: string; cwd: string }): SessionHeader {
  return {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: params.id ?? randomUUID(),
    timestamp: new Date().toISOString(),
    cwd: params.cwd,
  };
}

function normalizeTranscriptScopeId(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`SQLite transcript ${label} is required`);
  }
  return trimmed;
}

function createTranscriptScope(params: {
  agentId: string;
  sessionId: string;
}): SessionTranscriptScope {
  const agentId = normalizeTranscriptScopeId(params.agentId, "agent id");
  const sessionId = normalizeTranscriptScopeId(params.sessionId, "session id");
  return {
    agentId,
    sessionId,
  };
}

function createTranscriptStateFromEvents(events: unknown[]): TranscriptState {
  const transcriptEntries = events.filter((event): event is TranscriptEntry =>
    Boolean(event && typeof event === "object"),
  );
  const header =
    transcriptEntries.find((entry): entry is SessionHeader => entry.type === "session") ?? null;
  const entries = transcriptEntries.filter(
    (entry): entry is SessionEntry => entry.type !== "session",
  );
  return new TranscriptState({ header, entries });
}

function persistFullTranscriptStateToSqlite(
  scope: SessionTranscriptScope,
  state: TranscriptState,
): void {
  replaceSqliteSessionTranscriptEvents({
    agentId: scope.agentId,
    sessionId: scope.sessionId,
    events: [...(state.header ? [state.header] : []), ...state.entries],
  });
}

function appendTranscriptEntryToSqlite(
  scope: SessionTranscriptScope,
  entry: SessionEntry,
  options?: { parentMode?: "database-tail" },
): void {
  appendSqliteSessionTranscriptEvent({
    agentId: scope.agentId,
    sessionId: scope.sessionId,
    event: entry,
    ...(options?.parentMode ? { parentMode: options.parentMode } : {}),
  });
}

function loadTranscriptStateForSession(params: {
  agentId: string;
  sessionId: string;
  cwd?: string;
}): {
  state: TranscriptState;
  scope: SessionTranscriptScope;
} {
  const scope = createTranscriptScope({
    agentId: params.agentId,
    sessionId: params.sessionId,
  });
  const sqliteEvents = loadSqliteSessionTranscriptEvents(scope).map((entry) => entry.event);
  if (sqliteEvents.length > 0) {
    return { state: createTranscriptStateFromEvents(sqliteEvents), scope };
  }

  const header = createSessionHeader({
    id: scope.sessionId,
    cwd: params.cwd ?? process.cwd(),
  });
  const state = new TranscriptState({ header, entries: [] });
  persistFullTranscriptStateToSqlite(scope, state);
  return { state, scope };
}

class TranscriptSessionManager implements SessionManager {
  private state: TranscriptState;
  private persist: boolean;
  private sqliteScope: SessionTranscriptScope | undefined;
  private explicitBranchSelection = false;

  constructor(params: {
    state: TranscriptState;
    persist: boolean;
    sqliteScope?: SessionTranscriptScope;
  }) {
    this.state = params.state;
    this.persist = params.persist;
    this.sqliteScope = params.sqliteScope;
  }

  static inMemory(cwd = process.cwd()): TranscriptSessionManager {
    const header = createSessionHeader({ cwd });
    return new TranscriptSessionManager({
      persist: false,
      state: new TranscriptState({ header, entries: [] }),
      sqliteScope: undefined,
    });
  }

  isPersisted(): boolean {
    return this.persist;
  }

  getCwd(): string {
    return this.state.getCwd();
  }

  getSessionId(): string {
    return this.state.getHeader()?.id ?? "";
  }

  getTranscriptScope(): SessionTranscriptScope | undefined {
    return this.sqliteScope ? { ...this.sqliteScope } : undefined;
  }

  appendMessage(message: Parameters<SessionManager["appendMessage"]>[0]): string {
    if (this.persist && this.sqliteScope && !this.explicitBranchSelection) {
      const result = appendSqliteSessionTranscriptMessage({
        agentId: this.sqliteScope.agentId,
        sessionId: this.sqliteScope.sessionId,
        sessionVersion: this.state.getHeader()?.version ?? CURRENT_SESSION_VERSION,
        cwd: this.state.getCwd(),
        message,
      });
      this.reloadPersistedState();
      return result.messageId;
    }
    return this.persistAppendedEntry(this.state.appendMessage(message));
  }

  appendThinkingLevelChange(thinkingLevel: string): string {
    return this.persistAppendedEntry(this.state.appendThinkingLevelChange(thinkingLevel));
  }

  appendModelChange(provider: string, modelId: string): string {
    return this.persistAppendedEntry(this.state.appendModelChange(provider, modelId));
  }

  appendCompaction(
    summary: string,
    firstKeptEntryId: string,
    tokensBefore: number,
    details?: unknown,
    fromHook?: boolean,
  ): string {
    return this.persistAppendedEntry(
      this.state.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromHook),
    );
  }

  appendCustomEntry(customType: string, data?: unknown): string {
    return this.persistAppendedEntry(this.state.appendCustomEntry(customType, data));
  }

  appendSessionInfo(name: string): string {
    return this.persistAppendedEntry(this.state.appendSessionInfo(name));
  }

  getSessionName(): string | undefined {
    return this.state.getSessionName();
  }

  appendCustomMessageEntry(
    customType: string,
    content: Parameters<SessionManager["appendCustomMessageEntry"]>[1],
    display: boolean,
    details?: unknown,
  ): string {
    return this.persistAppendedEntry(
      this.state.appendCustomMessageEntry(customType, content, display, details),
    );
  }

  getLeafId(): string | null {
    return this.state.getLeafId();
  }

  getLeafEntry(): SessionEntry | undefined {
    return this.state.getLeafEntry();
  }

  getEntry(id: string): SessionEntry | undefined {
    return this.state.getEntry(id);
  }

  getChildren(parentId: string): SessionEntry[] {
    return this.state.getChildren(parentId);
  }

  getLabel(id: string): string | undefined {
    return this.state.getLabel(id);
  }

  appendLabelChange(targetId: string, label: string | undefined): string {
    return this.persistAppendedEntry(this.state.appendLabelChange(targetId, label));
  }

  getBranch(fromId?: string): SessionEntry[] {
    return this.state.getBranch(fromId);
  }

  buildSessionContext(): SessionContext {
    return this.state.buildSessionContext();
  }

  getHeader(): SessionHeader | null {
    return this.state.getHeader();
  }

  getEntries(): SessionEntry[] {
    return this.state.getEntries();
  }

  getTree(): SessionTreeNode[] {
    return this.state.getTree();
  }

  branch(branchFromId: string): void {
    this.state.branch(branchFromId);
    this.explicitBranchSelection = true;
  }

  resetLeaf(): void {
    this.state.resetLeaf();
    this.explicitBranchSelection = true;
  }

  removeTailEntries(
    shouldRemove: Parameters<SessionManager["removeTailEntries"]>[0],
    options?: Parameters<SessionManager["removeTailEntries"]>[1],
  ): number {
    const removed = this.state.removeTailEntries(shouldRemove, options);
    if (removed > 0 && this.persist && this.sqliteScope) {
      persistFullTranscriptStateToSqlite(this.sqliteScope, this.state);
      this.explicitBranchSelection = false;
    }
    return removed;
  }

  branchWithSummary(
    branchFromId: string | null,
    summary: string,
    details?: unknown,
    fromHook?: boolean,
  ): string {
    return this.persistAppendedEntry(
      this.state.branchWithSummary(branchFromId, summary, details, fromHook),
      { preserveParent: true },
    );
  }

  private persistAppendedEntry(
    entry: SessionEntry,
    options?: { preserveParent?: boolean },
  ): string {
    if (!this.persist || !this.sqliteScope) {
      return entry.id;
    }
    appendTranscriptEntryToSqlite(
      this.sqliteScope,
      entry,
      options?.preserveParent || this.explicitBranchSelection
        ? undefined
        : { parentMode: "database-tail" },
    );
    if (!options?.preserveParent && !this.explicitBranchSelection) {
      this.reloadPersistedState();
    }
    return entry.id;
  }

  private reloadPersistedState(): void {
    if (!this.sqliteScope) {
      return;
    }
    this.state = createTranscriptStateFromEvents(
      loadSqliteSessionTranscriptEvents(this.sqliteScope).map((entry) => entry.event),
    );
  }
}

export function openTranscriptSessionManagerForSession(params: {
  agentId: string;
  sessionId: string;
  cwd?: string;
}): SessionManager {
  const loaded = loadTranscriptStateForSession(params);
  return new TranscriptSessionManager({
    persist: true,
    state: loaded.state,
    sqliteScope: loaded.scope,
  });
}

export const SessionManagerValue = {
  inMemory: (cwd?: string) => TranscriptSessionManager.inMemory(cwd),
};
