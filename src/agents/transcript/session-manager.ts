import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  SessionContext,
  SessionEntry,
  SessionHeader,
  SessionInfo,
  SessionListProgress,
  SessionManager,
  SessionTreeNode,
} from "./session-transcript-contract.js";
import { CURRENT_SESSION_VERSION } from "./session-transcript-format.js";
import {
  persistTranscriptStateMutationSync,
  readTranscriptFileStateSync,
  TranscriptFileState,
  writeTranscriptFileAtomicSync,
} from "./transcript-file-state.js";

function transcriptHasSessionHeader(raw: string): boolean {
  for (const line of raw.trim().split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as { type?: unknown; id?: unknown };
      return parsed.type === "session" && typeof parsed.id === "string";
    } catch {
      continue;
    }
  }
  return false;
}

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

function encodeSessionCwd(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

function resolveDefaultSessionDir(cwd: string): string {
  return path.join(os.homedir(), ".openclaw", "sessions", encodeSessionCwd(cwd));
}

function ensureDirSync(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function loadTranscriptState(params: {
  sessionFile: string;
  sessionId?: string;
  cwd?: string;
}): TranscriptFileState {
  if (fs.existsSync(params.sessionFile)) {
    const raw = fs.readFileSync(params.sessionFile, "utf-8");
    if (transcriptHasSessionHeader(raw)) {
      const state = readTranscriptFileStateSync(params.sessionFile);
      if (state.migrated) {
        writeTranscriptFileAtomicSync(params.sessionFile, [
          ...(state.header ? [state.header] : []),
          ...state.entries,
        ]);
        return new TranscriptFileState({
          header: state.header,
          entries: state.entries,
        });
      }
      return state;
    }
  }

  const header = createSessionHeader({
    id: params.sessionId,
    cwd: params.cwd ?? process.cwd(),
  });
  const state = new TranscriptFileState({ header, entries: [] });
  writeTranscriptFileAtomicSync(params.sessionFile, [header]);
  return state;
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

async function buildSessionInfo(filePath: string): Promise<SessionInfo | null> {
  try {
    const state = readTranscriptFileStateSync(filePath);
    const header = state.getHeader();
    if (!header) {
      return null;
    }
    const stats = await fsPromises.stat(filePath);
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
      created: Number.isFinite(headerTime) ? new Date(headerTime) : stats.mtime,
      modified:
        typeof lastActivityTime === "number" && lastActivityTime > 0
          ? new Date(lastActivityTime)
          : Number.isFinite(headerTime)
            ? new Date(headerTime)
            : stats.mtime,
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
  try {
    const entries = await fsPromises.readdir(dir);
    const files = entries
      .filter((entry) => entry.endsWith(".jsonl"))
      .map((entry) => path.join(dir, entry));
    const total = progressTotal ?? files.length;
    const sessions: SessionInfo[] = [];
    let loaded = 0;
    for (const file of files) {
      const info = await buildSessionInfo(file);
      loaded += 1;
      onProgress?.(progressOffset + loaded, total);
      if (info) {
        sessions.push(info);
      }
    }
    return sessions.toSorted((a, b) => b.modified.getTime() - a.modified.getTime());
  } catch {
    return [];
  }
}

export class TranscriptSessionManager implements SessionManager {
  private state: TranscriptFileState;
  private sessionFile: string | undefined;
  private sessionDir: string;
  private persist: boolean;

  private constructor(params: {
    sessionDir: string;
    state: TranscriptFileState;
    sessionFile?: string;
    persist: boolean;
  }) {
    this.sessionFile = params.sessionFile ? path.resolve(params.sessionFile) : undefined;
    this.sessionDir = path.resolve(params.sessionDir);
    this.state = params.state;
    this.persist = params.persist;
  }

  static open(params: {
    sessionFile: string;
    sessionId?: string;
    cwd?: string;
    sessionDir?: string;
  }): TranscriptSessionManager {
    const sessionFile = path.resolve(params.sessionFile);
    return new TranscriptSessionManager({
      sessionDir: params.sessionDir ? path.resolve(params.sessionDir) : path.dirname(sessionFile),
      sessionFile,
      persist: true,
      state: loadTranscriptState({
        sessionFile,
        sessionId: params.sessionId,
        cwd: params.cwd,
      }),
    });
  }

  static create(cwd: string, sessionDir?: string): TranscriptSessionManager {
    const dir = path.resolve(sessionDir ?? resolveDefaultSessionDir(cwd));
    ensureDirSync(dir);
    const header = createSessionHeader({ cwd });
    const sessionFile = path.join(dir, createSessionFileName(header));
    writeTranscriptFileAtomicSync(sessionFile, [header]);
    return new TranscriptSessionManager({
      sessionDir: dir,
      sessionFile,
      persist: true,
      state: new TranscriptFileState({ header, entries: [] }),
    });
  }

  static inMemory(cwd = process.cwd()): TranscriptSessionManager {
    const header = createSessionHeader({ cwd });
    return new TranscriptSessionManager({
      sessionDir: "",
      persist: false,
      state: new TranscriptFileState({ header, entries: [] }),
    });
  }

  static continueRecent(cwd: string, sessionDir?: string): TranscriptSessionManager {
    const dir = path.resolve(sessionDir ?? resolveDefaultSessionDir(cwd));
    ensureDirSync(dir);
    const newest = fs
      .readdirSync(dir)
      .filter((entry) => entry.endsWith(".jsonl"))
      .map((entry) => path.join(dir, entry))
      .filter((file) => fs.existsSync(file))
      .toSorted((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
    return newest
      ? TranscriptSessionManager.open({ sessionFile: newest, cwd })
      : TranscriptSessionManager.create(cwd, dir);
  }

  static forkFrom(
    sourcePath: string,
    targetCwd: string,
    sessionDir?: string,
  ): TranscriptSessionManager {
    const sourceFile = path.resolve(sourcePath);
    const sourceState = readTranscriptFileStateSync(sourceFile);
    const dir = path.resolve(sessionDir ?? resolveDefaultSessionDir(targetCwd));
    ensureDirSync(dir);
    const header = createSessionHeader({
      cwd: targetCwd,
      parentSession: sourceFile,
    });
    const sessionFile = path.join(dir, createSessionFileName(header));
    writeTranscriptFileAtomicSync(sessionFile, [header, ...sourceState.getEntries()]);
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
    const root = path.join(os.homedir(), ".openclaw", "sessions");
    try {
      const dirs = (await fsPromises.readdir(root, { withFileTypes: true })).filter((entry) =>
        entry.isDirectory(),
      );
      const totalFiles = (
        await Promise.all(
          dirs.map(async (entry) => {
            try {
              return (await fsPromises.readdir(path.join(root, entry.name))).filter((file) =>
                file.endsWith(".jsonl"),
              ).length;
            } catch {
              return 0;
            }
          }),
        )
      ).reduce((sum, count) => sum + count, 0);
      const sessions: SessionInfo[] = [];
      let offset = 0;
      for (const dir of dirs) {
        const dirPath = path.join(root, dir.name);
        const listed = await listSessionsFromDir(dirPath, onProgress, offset, totalFiles);
        offset += listed.length;
        sessions.push(...listed);
      }
      return sessions.toSorted((a, b) => b.modified.getTime() - a.modified.getTime());
    } catch {
      return [];
    }
  }

  setSessionFile(sessionFile: string): void {
    this.sessionFile = path.resolve(sessionFile);
    this.sessionDir = path.dirname(this.sessionFile);
    this.persist = true;
    this.state = loadTranscriptState({
      sessionFile: this.sessionFile,
      cwd: this.getCwd(),
    });
  }

  newSession(options?: { id?: string; parentSession?: string }): string | undefined {
    const header = createSessionHeader({
      id: options?.id,
      cwd: this.getCwd(),
      parentSession: options?.parentSession,
    });
    this.state = new TranscriptFileState({ header, entries: [] });
    if (this.persist) {
      this.sessionFile =
        this.sessionFile ?? path.join(this.sessionDir, createSessionFileName(header));
      writeTranscriptFileAtomicSync(this.sessionFile, [header]);
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
    writeTranscriptFileAtomicSync(sessionFile, [
      header,
      ...branch.filter((e) => e.type !== "label"),
    ]);
    return sessionFile;
  }

  private persistAppendedEntry(entry: SessionEntry): string {
    if (!this.persist || !this.sessionFile) {
      return entry.id;
    }
    persistTranscriptStateMutationSync({
      sessionFile: this.sessionFile,
      state: this.state,
      appendedEntries: [entry],
    });
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
