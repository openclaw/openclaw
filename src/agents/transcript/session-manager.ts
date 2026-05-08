import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { isSqliteSessionTranscriptLocator } from "../../config/sessions/paths.js";
import {
  appendSqliteSessionTranscriptEvent,
  listSqliteSessionTranscriptFiles,
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

function createSessionFileName(header: SessionHeader): string {
  return `${header.timestamp.replace(/[:.]/g, "-")}_${header.id}.jsonl`;
}

type TranscriptSqliteScope = {
  agentId: string;
  sessionId: string;
  transcriptPath: string;
};

function encodeSessionCwd(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

function resolveDefaultSessionDir(cwd: string): string {
  return path.join(os.homedir(), ".openclaw", "sessions", encodeSessionCwd(cwd));
}

function normalizeSessionFileIdentifier(sessionFile: string): string {
  const trimmed = sessionFile.trim();
  return isSqliteSessionTranscriptLocator(trimmed) ? trimmed : path.resolve(trimmed);
}

function resolveSessionDirForIdentifier(sessionFile: string, sessionDir?: string): string {
  if (sessionDir) {
    return path.resolve(sessionDir);
  }
  return isSqliteSessionTranscriptLocator(sessionFile) ? "" : path.dirname(sessionFile);
}

function resolveAgentIdFromSessionPath(sessionFile: string): string {
  void sessionFile;
  return DEFAULT_AGENT_ID;
}

function resolveFallbackSessionIdFromPath(sessionFile: string): string {
  const basename = path.basename(sessionFile);
  const stem = basename.endsWith(".jsonl") ? basename.slice(0, -".jsonl".length) : basename;
  const timestampIdMatch = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T.*_([^_]+)$/.exec(stem);
  return timestampIdMatch?.[1] ?? stem;
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
  const scope = {
    agentId: existingScope?.agentId ?? resolveAgentIdFromSessionPath(transcriptPath),
    sessionId:
      existingScope?.sessionId ??
      params.sessionId ??
      resolveFallbackSessionIdFromPath(transcriptPath),
    transcriptPath,
  };
  const sqliteEvents = loadSqliteSessionTranscriptEvents(scope).map((entry) => entry.event);
  if (sqliteEvents.length > 0) {
    return { state: createTranscriptStateFromEvents(sqliteEvents), scope };
  }

  const header = createSessionHeader({
    id: params.sessionId,
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

async function listSessionsFromDir(
  dir: string,
  onProgress?: SessionListProgress,
  progressOffset = 0,
  progressTotal?: number,
): Promise<SessionInfo[]> {
  const resolvedDir = path.resolve(dir);
  const sqliteFiles = listSqliteSessionTranscriptFiles().filter(
    (entry) => path.dirname(path.resolve(entry.path)) === resolvedDir,
  );
  const sessions: SessionInfo[] = [];
  let loaded = 0;
  const total = progressTotal ?? sqliteFiles.length;
  for (const file of sqliteFiles) {
    const state = createTranscriptStateFromEvents(
      loadSqliteSessionTranscriptEvents({
        agentId: file.agentId,
        sessionId: file.sessionId,
      }).map((entry) => entry.event),
    );
    loaded += 1;
    onProgress?.(progressOffset + loaded, total);
    const info = buildSessionInfoFromState(file.path, state, new Date(file.updatedAt));
    if (info) {
      sessions.push(info);
    }
  }
  return sessions.toSorted((a, b) => b.modified.getTime() - a.modified.getTime());
}

export class TranscriptSessionManager implements SessionManager {
  private state: TranscriptState;
  private sessionFile: string | undefined;
  private sessionDir: string;
  private persist: boolean;
  private sqliteScope: TranscriptSqliteScope | undefined;

  private constructor(params: {
    sessionDir: string;
    state: TranscriptState;
    sessionFile?: string;
    persist: boolean;
    sqliteScope?: TranscriptSqliteScope;
  }) {
    this.sessionFile = params.sessionFile
      ? normalizeSessionFileIdentifier(params.sessionFile)
      : undefined;
    this.sessionDir = params.sessionDir ? path.resolve(params.sessionDir) : "";
    this.state = params.state;
    this.persist = params.persist;
    this.sqliteScope = params.sqliteScope;
  }

  static open(params: {
    sessionFile: string;
    sessionId?: string;
    cwd?: string;
    sessionDir?: string;
  }): TranscriptSessionManager {
    const sessionFile = normalizeSessionFileIdentifier(params.sessionFile);
    const loaded = loadTranscriptState({
      sessionFile,
      sessionId: params.sessionId,
      cwd: params.cwd,
    });
    return new TranscriptSessionManager({
      sessionDir: resolveSessionDirForIdentifier(sessionFile, params.sessionDir),
      sessionFile,
      persist: true,
      state: loaded.state,
      sqliteScope: loaded.scope,
    });
  }

  static create(cwd: string, sessionDir?: string): TranscriptSessionManager {
    const dir = path.resolve(sessionDir ?? resolveDefaultSessionDir(cwd));
    const header = createSessionHeader({ cwd });
    const sessionFile = path.join(dir, createSessionFileName(header));
    const sqliteScope = {
      agentId: resolveAgentIdFromSessionPath(sessionFile),
      sessionId: header.id,
      transcriptPath: path.resolve(sessionFile),
    };
    const state = new TranscriptState({ header, entries: [] });
    persistFullTranscriptStateToSqlite(sqliteScope, state);
    return new TranscriptSessionManager({
      sessionDir: dir,
      sessionFile,
      persist: true,
      state,
      sqliteScope,
    });
  }

  static inMemory(cwd = process.cwd()): TranscriptSessionManager {
    const header = createSessionHeader({ cwd });
    return new TranscriptSessionManager({
      sessionDir: "",
      persist: false,
      state: new TranscriptState({ header, entries: [] }),
      sqliteScope: undefined,
    });
  }

  static continueRecent(cwd: string, sessionDir?: string): TranscriptSessionManager {
    const dir = path.resolve(sessionDir ?? resolveDefaultSessionDir(cwd));
    const newestSqlite = listSqliteSessionTranscriptFiles()
      .filter((entry) => path.dirname(path.resolve(entry.path)) === dir)
      .toSorted((a, b) => b.updatedAt - a.updatedAt)[0];
    if (newestSqlite) {
      return TranscriptSessionManager.open({ sessionFile: newestSqlite.path, cwd });
    }
    return TranscriptSessionManager.create(cwd, dir);
  }

  static forkFrom(
    sourcePath: string,
    targetCwd: string,
    sessionDir?: string,
  ): TranscriptSessionManager {
    const sourceFile = path.resolve(sourcePath);
    const sourceScope = resolveSqliteSessionTranscriptScopeForPath({ transcriptPath: sourceFile });
    if (!sourceScope) {
      throw new Error(
        `Legacy transcript has not been imported into SQLite: ${sourceFile}. Run "openclaw doctor --fix" to build the session database.`,
      );
    }
    const sourceState = createTranscriptStateFromEvents(
      loadSqliteSessionTranscriptEvents(sourceScope).map((entry) => entry.event),
    );
    const dir = path.resolve(sessionDir ?? resolveDefaultSessionDir(targetCwd));
    const header = createSessionHeader({
      cwd: targetCwd,
      parentSession: sourceFile,
    });
    const sessionFile = path.join(dir, createSessionFileName(header));
    const state = new TranscriptState({ header, entries: sourceState.getEntries() });
    const sqliteScope = {
      agentId: resolveAgentIdFromSessionPath(sessionFile),
      sessionId: header.id,
      transcriptPath: path.resolve(sessionFile),
    };
    persistFullTranscriptStateToSqlite(sqliteScope, state);
    return TranscriptSessionManager.open({ sessionFile, cwd: targetCwd });
  }

  static async list(
    cwd: string,
    sessionDir?: string,
    onProgress?: SessionListProgress,
  ): Promise<SessionInfo[]> {
    return await listSessionsFromDir(
      path.resolve(sessionDir ?? resolveDefaultSessionDir(cwd)),
      onProgress,
    );
  }

  static async listAll(onProgress?: SessionListProgress): Promise<SessionInfo[]> {
    const files = listSqliteSessionTranscriptFiles();
    const sessions: SessionInfo[] = [];
    let loaded = 0;
    for (const file of files) {
      const state = createTranscriptStateFromEvents(
        loadSqliteSessionTranscriptEvents({
          agentId: file.agentId,
          sessionId: file.sessionId,
        }).map((entry) => entry.event),
      );
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
    this.sessionFile = normalizeSessionFileIdentifier(sessionFile);
    this.sessionDir = resolveSessionDirForIdentifier(this.sessionFile);
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
      this.sessionFile =
        this.sessionFile ?? path.join(this.sessionDir, createSessionFileName(header));
      this.sqliteScope = {
        agentId: resolveAgentIdFromSessionPath(this.sessionFile),
        sessionId: header.id,
        transcriptPath: normalizeSessionFileIdentifier(this.sessionFile),
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

  getSessionDir(): string {
    return this.sessionDir;
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
    const timestamp = header.timestamp.replace(/[:.]/g, "-");
    const sessionFile = path.join(this.sessionDir, `${timestamp}_${header.id}.jsonl`);
    if (!this.persist) {
      return undefined;
    }
    const state = new TranscriptState({
      header,
      entries: branch.filter((e) => e.type !== "label"),
    });
    persistFullTranscriptStateToSqlite(
      {
        agentId: resolveAgentIdFromSessionPath(sessionFile),
        sessionId: header.id,
        transcriptPath: path.resolve(sessionFile),
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
  create: (cwd: string, sessionDir?: string) => TranscriptSessionManager.create(cwd, sessionDir),
  open: (sessionFile: string, sessionDir?: string, cwdOverride?: string) => {
    return TranscriptSessionManager.open({
      sessionFile,
      cwd: cwdOverride,
      sessionDir,
    });
  },
  continueRecent: (cwd: string, sessionDir?: string) =>
    TranscriptSessionManager.continueRecent(cwd, sessionDir),
  inMemory: (cwd?: string) => TranscriptSessionManager.inMemory(cwd),
  forkFrom: (sourcePath: string, targetCwd: string, sessionDir?: string) =>
    TranscriptSessionManager.forkFrom(sourcePath, targetCwd, sessionDir),
  list: (cwd: string, sessionDir?: string, onProgress?: SessionListProgress) =>
    TranscriptSessionManager.list(cwd, sessionDir, onProgress),
  listAll: (onProgress?: SessionListProgress) => TranscriptSessionManager.listAll(onProgress),
};
