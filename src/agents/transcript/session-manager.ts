import { randomUUID } from "node:crypto";
import {
  appendSqliteSessionTranscriptEvent,
  listSqliteSessionTranscripts,
  loadSqliteSessionTranscriptEvents,
  replaceSqliteSessionTranscriptEvents,
} from "../../config/sessions/transcript-store.sqlite.js";
import { DEFAULT_AGENT_ID } from "../../routing/session-key.js";
import { CURRENT_SESSION_VERSION } from "./session-transcript-format.js";
import type {
  SessionContext,
  SessionEntry,
  SessionHeader,
  SessionInfo,
  SessionListProgress,
  SessionManager,
  SessionTranscriptScope,
  SessionTreeNode,
  TranscriptEntry,
} from "./session-transcript-types.js";
import { TranscriptState } from "./transcript-state.js";

function createSessionHeader(params: {
  id?: string;
  cwd: string;
  parentSession?: string;
}): SessionHeader {
  return {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: params.id ?? randomUUID(),
    timestamp: new Date().toISOString(),
    cwd: params.cwd,
    parentSession: params.parentSession,
  };
}

type SqliteTranscriptRecord = {
  agentId: string;
  sessionId: string;
  updatedAt: number;
};

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

function formatTranscriptParentReference(
  scope: SessionTranscriptScope | undefined,
): string | undefined {
  return scope ? `agent-db:${scope.agentId}:transcript_events:${scope.sessionId}` : undefined;
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

function appendTranscriptEntryToSqlite(scope: SessionTranscriptScope, entry: SessionEntry): void {
  appendSqliteSessionTranscriptEvent({
    agentId: scope.agentId,
    sessionId: scope.sessionId,
    event: entry,
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

function isMessageWithContent(
  message: unknown,
): message is { role: string; content: unknown; timestamp?: unknown } {
  return Boolean(
    message &&
    typeof message === "object" &&
    typeof (message as { role?: unknown }).role === "string" &&
    "content" in message,
  );
}

function extractTextContent(message: { content: unknown }): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  if (!Array.isArray(message.content)) {
    return "";
  }
  return message.content
    .filter((block): block is { type: "text"; text: string } =>
      Boolean(
        block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
      ),
    )
    .map((block) => block.text)
    .join(" ");
}

function buildSessionInfoFromState(
  scope: SessionTranscriptScope,
  state: TranscriptState,
  modifiedFallback: Date,
): SessionInfo | null {
  const header = state.getHeader();
  if (!header) {
    return null;
  }
  try {
    let messageCount = 0;
    let firstMessage = "";
    const allMessages: string[] = [];
    let lastActivityTime: number | undefined;
    for (const entry of state.getEntries()) {
      if (entry.type === "session_info") {
        continue;
      }
      if (entry.type !== "message") {
        continue;
      }
      messageCount += 1;
      const message = entry.message;
      if (
        !isMessageWithContent(message) ||
        (message.role !== "user" && message.role !== "assistant")
      ) {
        continue;
      }
      const textContent = extractTextContent(message);
      if (textContent) {
        allMessages.push(textContent);
        if (!firstMessage && message.role === "user") {
          firstMessage = textContent;
        }
      }
      if (typeof message.timestamp === "number") {
        lastActivityTime = Math.max(lastActivityTime ?? 0, message.timestamp);
      } else {
        const entryTimestamp = Date.parse(entry.timestamp);
        if (Number.isFinite(entryTimestamp)) {
          lastActivityTime = Math.max(lastActivityTime ?? 0, entryTimestamp);
        }
      }
    }
    const headerTime = Date.parse(header.timestamp);
    return {
      id: header.id,
      transcriptScope: { ...scope },
      cwd: header.cwd,
      name: state.getSessionName(),
      parentSession: header.parentSession,
      created: Number.isFinite(headerTime) ? new Date(headerTime) : modifiedFallback,
      modified:
        typeof lastActivityTime === "number" && lastActivityTime > 0
          ? new Date(lastActivityTime)
          : Number.isFinite(headerTime)
            ? new Date(headerTime)
            : modifiedFallback,
      messageCount,
      firstMessage: firstMessage || "(no messages)",
      allMessagesText: allMessages.join(" "),
    };
  } catch {
    return null;
  }
}

function listSqliteTranscriptRecords(): SqliteTranscriptRecord[] {
  const seen = new Set<string>();
  return [
    ...listSqliteSessionTranscripts(),
    ...listSqliteSessionTranscripts({ agentId: DEFAULT_AGENT_ID }),
  ]
    .filter((entry) => {
      const key = `${entry.agentId}\0${entry.sessionId}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .map((entry) => ({
      agentId: entry.agentId,
      sessionId: entry.sessionId,
      updatedAt: entry.updatedAt,
    }));
}

function loadTranscriptStateForRecord(record: SqliteTranscriptRecord): TranscriptState {
  return createTranscriptStateFromEvents(
    loadSqliteSessionTranscriptEvents({
      agentId: record.agentId,
      sessionId: record.sessionId,
    }).map((entry) => entry.event),
  );
}

export class TranscriptSessionManager implements SessionManager {
  private state: TranscriptState;
  private persist: boolean;
  private sqliteScope: SessionTranscriptScope | undefined;

  private constructor(params: {
    state: TranscriptState;
    persist: boolean;
    sqliteScope?: SessionTranscriptScope;
  }) {
    this.state = params.state;
    this.persist = params.persist;
    this.sqliteScope = params.sqliteScope;
  }

  static openForSession(params: {
    agentId: string;
    sessionId: string;
    cwd?: string;
  }): TranscriptSessionManager {
    const loaded = loadTranscriptStateForSession(params);
    return new TranscriptSessionManager({
      persist: true,
      state: loaded.state,
      sqliteScope: loaded.scope,
    });
  }

  static create(cwd: string): TranscriptSessionManager {
    const header = createSessionHeader({ cwd });
    const sqliteScope = createTranscriptScope({
      agentId: DEFAULT_AGENT_ID,
      sessionId: header.id,
    });
    const state = new TranscriptState({ header, entries: [] });
    persistFullTranscriptStateToSqlite(sqliteScope, state);
    return new TranscriptSessionManager({
      persist: true,
      state,
      sqliteScope,
    });
  }

  static inMemory(cwd = process.cwd()): TranscriptSessionManager {
    const header = createSessionHeader({ cwd });
    return new TranscriptSessionManager({
      persist: false,
      state: new TranscriptState({ header, entries: [] }),
      sqliteScope: undefined,
    });
  }

  static continueRecent(cwd: string): TranscriptSessionManager {
    const newestSqlite = listSqliteTranscriptRecords().find((entry) => {
      const state = loadTranscriptStateForRecord(entry);
      return state.getCwd() === cwd;
    });
    if (newestSqlite) {
      return TranscriptSessionManager.openForSession({
        agentId: newestSqlite.agentId,
        sessionId: newestSqlite.sessionId,
        cwd,
      });
    }
    return TranscriptSessionManager.create(cwd);
  }

  static forkFromSession(params: {
    agentId: string;
    sessionId: string;
    targetCwd: string;
  }): TranscriptSessionManager {
    const sourceScope = createTranscriptScope({
      agentId: params.agentId,
      sessionId: params.sessionId,
    });
    const sourceState = createTranscriptStateFromEvents(
      loadSqliteSessionTranscriptEvents(sourceScope).map((entry) => entry.event),
    );
    const header = createSessionHeader({
      cwd: params.targetCwd,
      parentSession: formatTranscriptParentReference(sourceScope),
    });
    const state = new TranscriptState({ header, entries: sourceState.getEntries() });
    const sqliteScope = createTranscriptScope({
      agentId: sourceScope.agentId,
      sessionId: header.id,
    });
    persistFullTranscriptStateToSqlite(sqliteScope, state);
    return TranscriptSessionManager.openForSession({
      agentId: sqliteScope.agentId,
      sessionId: sqliteScope.sessionId,
      cwd: params.targetCwd,
    });
  }

  static async list(cwd: string, onProgress?: SessionListProgress): Promise<SessionInfo[]> {
    return (await TranscriptSessionManager.listAll(onProgress)).filter(
      (session) => session.cwd === cwd,
    );
  }

  static async listAll(onProgress?: SessionListProgress): Promise<SessionInfo[]> {
    const records = listSqliteTranscriptRecords();
    const sessions: SessionInfo[] = [];
    let loaded = 0;
    for (const record of records) {
      const state = loadTranscriptStateForRecord(record);
      loaded += 1;
      onProgress?.(loaded, records.length);
      const info = buildSessionInfoFromState(
        { agentId: record.agentId, sessionId: record.sessionId },
        state,
        new Date(record.updatedAt),
      );
      if (info) {
        sessions.push(info);
      }
    }
    return sessions.toSorted((a, b) => b.modified.getTime() - a.modified.getTime());
  }

  newSession(options?: {
    id?: string;
    parentSession?: string;
  }): SessionTranscriptScope | undefined {
    const header = createSessionHeader({
      id: options?.id,
      cwd: this.getCwd(),
      parentSession: options?.parentSession,
    });
    this.state = new TranscriptState({ header, entries: [] });
    if (this.persist) {
      const agentId = this.sqliteScope?.agentId ?? DEFAULT_AGENT_ID;
      this.sqliteScope = createTranscriptScope({
        agentId,
        sessionId: header.id,
      });
      persistFullTranscriptStateToSqlite(this.sqliteScope, this.state);
    }
    return this.getTranscriptScope();
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
  }

  resetLeaf(): void {
    this.state.resetLeaf();
  }

  removeTailEntries(
    shouldRemove: Parameters<SessionManager["removeTailEntries"]>[0],
    options?: Parameters<SessionManager["removeTailEntries"]>[1],
  ): number {
    const removed = this.state.removeTailEntries(shouldRemove, options);
    if (removed > 0 && this.persist && this.sqliteScope) {
      persistFullTranscriptStateToSqlite(this.sqliteScope, this.state);
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
    );
  }

  createBranchedSession(leafId: string): SessionTranscriptScope | undefined {
    const branch = this.getBranch(leafId);
    if (branch.length === 0) {
      throw new Error(`Entry ${leafId} not found`);
    }
    const header = createSessionHeader({
      cwd: this.getCwd(),
      parentSession: formatTranscriptParentReference(this.sqliteScope),
    });
    if (!this.persist) {
      return undefined;
    }
    const branchScope = createTranscriptScope({
      agentId: this.sqliteScope?.agentId ?? DEFAULT_AGENT_ID,
      sessionId: header.id,
    });
    const state = new TranscriptState({
      header,
      entries: branch.filter((e) => e.type !== "label"),
    });
    persistFullTranscriptStateToSqlite(branchScope, state);
    return { ...branchScope };
  }

  private persistAppendedEntry(entry: SessionEntry): string {
    if (!this.persist || !this.sqliteScope) {
      return entry.id;
    }
    if (this.state.migrated) {
      persistFullTranscriptStateToSqlite(this.sqliteScope, this.state);
    } else {
      appendTranscriptEntryToSqlite(this.sqliteScope, entry);
    }
    return entry.id;
  }
}

export function openTranscriptSessionManagerForSession(params: {
  agentId: string;
  sessionId: string;
  cwd?: string;
}): SessionManager {
  return TranscriptSessionManager.openForSession(params);
}

export const SessionManagerValue = {
  create: (cwd: string) => TranscriptSessionManager.create(cwd),
  openForSession: (params: { agentId: string; sessionId: string; cwd?: string }) =>
    TranscriptSessionManager.openForSession(params),
  continueRecent: (cwd: string) => TranscriptSessionManager.continueRecent(cwd),
  inMemory: (cwd?: string) => TranscriptSessionManager.inMemory(cwd),
  forkFromSession: (params: { agentId: string; sessionId: string; targetCwd: string }) =>
    TranscriptSessionManager.forkFromSession(params),
  list: (cwd: string, onProgress?: SessionListProgress) =>
    TranscriptSessionManager.list(cwd, onProgress),
  listAll: (onProgress?: SessionListProgress) => TranscriptSessionManager.listAll(onProgress),
};
