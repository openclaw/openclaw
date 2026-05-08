import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  createSqliteSessionTranscriptLocator,
  isSqliteSessionTranscriptLocator,
  parseSqliteSessionTranscriptLocator,
} from "../../config/sessions/paths.js";
import {
  appendSqliteSessionTranscriptEvent,
  listSqliteSessionTranscripts,
  loadSqliteSessionTranscriptEvents,
  replaceSqliteSessionTranscriptEvents,
  resolveSqliteSessionTranscriptScopeForPath,
} from "../../config/sessions/transcript-store.sqlite.js";
import { DEFAULT_AGENT_ID } from "../../routing/session-key.js";
import type {
  FileEntry,
  SessionContext,
  SessionEntry,
  SessionHeader,
  SessionInfo,
  SessionListProgress,
  SessionManager,
  SessionTreeNode,
} from "./session-transcript-contract.js";
import { CURRENT_SESSION_VERSION } from "./session-transcript-format.js";
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

type TranscriptSqliteScope = {
  agentId: string;
  sessionId: string;
  transcriptPath: string;
};

type SqliteTranscriptRecord = {
  agentId: string;
  sessionId: string;
  path: string;
  updatedAt: number;
};

function normalizeTranscriptLocator(sessionFile: string): string {
  const trimmed = sessionFile.trim();
  return isSqliteSessionTranscriptLocator(trimmed) ? trimmed : path.resolve(trimmed);
}

function createTranscriptLocator(header: SessionHeader, agentId = DEFAULT_AGENT_ID): string {
  return createSqliteSessionTranscriptLocator({
    agentId,
    sessionId: header.id,
  });
}

function resolveAgentIdFromTranscriptLocator(transcriptLocator: string): string {
  const locator = parseSqliteSessionTranscriptLocator(transcriptLocator);
  if (locator) {
    return locator.agentId;
  }
  return DEFAULT_AGENT_ID;
}

function createTranscriptStateFromEvents(events: unknown[]): TranscriptState {
  const fileEntries = events.filter((event): event is FileEntry =>
    Boolean(event && typeof event === "object"),
  );
  const header =
    fileEntries.find((entry): entry is SessionHeader => entry.type === "session") ?? null;
  const entries = fileEntries.filter((entry): entry is SessionEntry => entry.type !== "session");
  return new TranscriptState({ header, entries });
}

function persistFullTranscriptStateToSqlite(
  scope: TranscriptSqliteScope,
  state: TranscriptState,
): void {
  replaceSqliteSessionTranscriptEvents({
    agentId: scope.agentId,
    sessionId: scope.sessionId,
    transcriptPath: scope.transcriptPath,
    events: [...(state.header ? [state.header] : []), ...state.entries],
  });
}

function appendTranscriptEntryToSqlite(scope: TranscriptSqliteScope, entry: SessionEntry): void {
  appendSqliteSessionTranscriptEvent({
    agentId: scope.agentId,
    sessionId: scope.sessionId,
    transcriptPath: scope.transcriptPath,
    event: entry,
  });
}

function loadTranscriptState(params: { sessionFile: string; sessionId?: string; cwd?: string }): {
  state: TranscriptState;
  scope: TranscriptSqliteScope;
} {
  const sessionFile = params.sessionFile.trim();
  const transcriptPath = isSqliteSessionTranscriptLocator(sessionFile)
    ? sessionFile
    : path.resolve(sessionFile);
  const existingScope = resolveSqliteSessionTranscriptScopeForPath({ transcriptPath });
  if (!isSqliteSessionTranscriptLocator(transcriptPath) && !existingScope) {
    throw new Error(
      `Legacy transcript has not been imported into SQLite: ${transcriptPath}. Run "openclaw doctor --fix" to build the session database.`,
    );
  }
  const sessionId = existingScope?.sessionId ?? params.sessionId;
  if (!sessionId) {
    throw new Error(`SQLite transcript scope is missing session id for: ${transcriptPath}`);
  }
  const scope = {
    agentId: existingScope?.agentId ?? resolveAgentIdFromTranscriptLocator(transcriptPath),
    sessionId,
    transcriptPath,
  };
  const sqliteEvents = loadSqliteSessionTranscriptEvents(scope).map((entry) => entry.event);
  if (sqliteEvents.length > 0) {
    return { state: createTranscriptStateFromEvents(sqliteEvents), scope };
  }

  const header = createSessionHeader({
    id: params.sessionId ?? scope.sessionId,
    cwd: params.cwd ?? process.cwd(),
  });
  const state = new TranscriptState({ header, entries: [] });
  const headerScope = { ...scope, sessionId: header.id };
  persistFullTranscriptStateToSqlite(headerScope, state);
  return { state, scope: headerScope };
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
  filePath: string,
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
      path: filePath,
      id: header.id,
      cwd: header.cwd,
      name: state.getSessionName(),
      parentSessionPath: header.parentSession,
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
      path:
        entry.path ??
        createSqliteSessionTranscriptLocator({
          agentId: entry.agentId,
          sessionId: entry.sessionId,
        }),
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
  private sessionFile: string | undefined;
  private persist: boolean;
  private sqliteScope: TranscriptSqliteScope | undefined;

  private constructor(params: {
    state: TranscriptState;
    sessionFile?: string;
    persist: boolean;
    sqliteScope?: TranscriptSqliteScope;
  }) {
    this.sessionFile = params.sessionFile
      ? normalizeTranscriptLocator(params.sessionFile)
      : undefined;
    this.state = params.state;
    this.persist = params.persist;
    this.sqliteScope = params.sqliteScope;
  }

  static open(params: {
    sessionFile: string;
    sessionId?: string;
    cwd?: string;
  }): TranscriptSessionManager {
    const sessionFile = normalizeTranscriptLocator(params.sessionFile);
    const loaded = loadTranscriptState({
      sessionFile,
      sessionId: params.sessionId,
      cwd: params.cwd,
    });
    return new TranscriptSessionManager({
      sessionFile,
      persist: true,
      state: loaded.state,
      sqliteScope: loaded.scope,
    });
  }

  static create(cwd: string): TranscriptSessionManager {
    const header = createSessionHeader({ cwd });
    const sessionFile = createTranscriptLocator(header);
    const sqliteScope = {
      agentId: resolveAgentIdFromTranscriptLocator(sessionFile),
      sessionId: header.id,
      transcriptPath: normalizeTranscriptLocator(sessionFile),
    };
    const state = new TranscriptState({ header, entries: [] });
    persistFullTranscriptStateToSqlite(sqliteScope, state);
    return new TranscriptSessionManager({
      sessionFile,
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
      return TranscriptSessionManager.open({ sessionFile: newestSqlite.path, cwd });
    }
    return TranscriptSessionManager.create(cwd);
  }

  static forkFrom(sourcePath: string, targetCwd: string): TranscriptSessionManager {
    const sourceFile = normalizeTranscriptLocator(sourcePath);
    const sourceScope = resolveSqliteSessionTranscriptScopeForPath({ transcriptPath: sourceFile });
    if (!sourceScope) {
      throw new Error(
        `Legacy transcript has not been imported into SQLite: ${sourceFile}. Run "openclaw doctor --fix" to build the session database.`,
      );
    }
    const sourceState = createTranscriptStateFromEvents(
      loadSqliteSessionTranscriptEvents(sourceScope).map((entry) => entry.event),
    );
    const header = createSessionHeader({
      cwd: targetCwd,
      parentSession: sourceFile,
    });
    const sessionFile = createTranscriptLocator(header, sourceScope.agentId);
    const state = new TranscriptState({ header, entries: sourceState.getEntries() });
    const sqliteScope = {
      agentId: sourceScope.agentId,
      sessionId: header.id,
      transcriptPath: normalizeTranscriptLocator(sessionFile),
    };
    persistFullTranscriptStateToSqlite(sqliteScope, state);
    return TranscriptSessionManager.open({ sessionFile, cwd: targetCwd });
  }

  static async list(cwd: string, onProgress?: SessionListProgress): Promise<SessionInfo[]> {
    return (await TranscriptSessionManager.listAll(onProgress)).filter(
      (session) => session.cwd === cwd,
    );
  }

  static async listAll(onProgress?: SessionListProgress): Promise<SessionInfo[]> {
    const files = listSqliteTranscriptRecords();
    const sessions: SessionInfo[] = [];
    let loaded = 0;
    for (const file of files) {
      const state = loadTranscriptStateForRecord(file);
      loaded += 1;
      onProgress?.(loaded, files.length);
      const info = buildSessionInfoFromState(file.path, state, new Date(file.updatedAt));
      if (info) {
        sessions.push(info);
      }
    }
    return sessions.toSorted((a, b) => b.modified.getTime() - a.modified.getTime());
  }

  setSessionFile(sessionFile: string): void {
    this.sessionFile = normalizeTranscriptLocator(sessionFile);
    this.persist = true;
    const loaded = loadTranscriptState({
      sessionFile: this.sessionFile,
      cwd: this.getCwd(),
    });
    this.state = loaded.state;
    this.sqliteScope = loaded.scope;
  }

  newSession(options?: { id?: string; parentSession?: string }): string | undefined {
    const header = createSessionHeader({
      id: options?.id,
      cwd: this.getCwd(),
      parentSession: options?.parentSession,
    });
    this.state = new TranscriptState({ header, entries: [] });
    if (this.persist) {
      this.sessionFile = createTranscriptLocator(header, this.sqliteScope?.agentId);
      this.sqliteScope = {
        agentId: resolveAgentIdFromTranscriptLocator(this.sessionFile),
        sessionId: header.id,
        transcriptPath: normalizeTranscriptLocator(this.sessionFile),
      };
      persistFullTranscriptStateToSqlite(this.sqliteScope, this.state);
    }
    return this.sessionFile;
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

  getSessionFile(): string | undefined {
    return this.sessionFile;
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
    if (removed > 0 && this.persist && this.sessionFile && this.sqliteScope) {
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

  createBranchedSession(leafId: string): string | undefined {
    const branch = this.getBranch(leafId);
    if (branch.length === 0) {
      throw new Error(`Entry ${leafId} not found`);
    }
    const header = createSessionHeader({
      cwd: this.getCwd(),
      parentSession: this.sessionFile,
    });
    const sessionFile = createSqliteSessionTranscriptLocator({
      agentId: this.sqliteScope?.agentId ?? DEFAULT_AGENT_ID,
      sessionId: header.id,
    });
    if (!this.persist) {
      return undefined;
    }
    const state = new TranscriptState({
      header,
      entries: branch.filter((e) => e.type !== "label"),
    });
    persistFullTranscriptStateToSqlite(
      {
        agentId: resolveAgentIdFromTranscriptLocator(sessionFile),
        sessionId: header.id,
        transcriptPath: normalizeTranscriptLocator(sessionFile),
      },
      state,
    );
    return sessionFile;
  }

  private persistAppendedEntry(entry: SessionEntry): string {
    if (!this.persist || !this.sessionFile || !this.sqliteScope) {
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

export function openTranscriptSessionManager(params: {
  sessionFile: string;
  sessionId?: string;
  cwd?: string;
}): SessionManager {
  return TranscriptSessionManager.open(params);
}

export const SessionManagerValue = {
  create: (cwd: string) => TranscriptSessionManager.create(cwd),
  open: (sessionFile: string, cwdOverride?: string) => {
    return TranscriptSessionManager.open({
      sessionFile,
      cwd: cwdOverride,
    });
  },
  continueRecent: (cwd: string) => TranscriptSessionManager.continueRecent(cwd),
  inMemory: (cwd?: string) => TranscriptSessionManager.inMemory(cwd),
  forkFrom: (sourcePath: string, targetCwd: string) =>
    TranscriptSessionManager.forkFrom(sourcePath, targetCwd),
  list: (cwd: string, onProgress?: SessionListProgress) =>
    TranscriptSessionManager.list(cwd, onProgress),
  listAll: (onProgress?: SessionListProgress) => TranscriptSessionManager.listAll(onProgress),
};
