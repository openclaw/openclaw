import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { NormalizedUsage } from "../agents/usage.js";
import { ensureTranscriptFile } from "./session-utils.fs.js";

/**
 * Content block type for CLI messages (matches SDK format).
 */
export type CliContentBlock =
  | { type: "text"; text: string }
  | { type: "input_text"; text: string }
  | { type: "output_text"; text: string };

/**
 * Message type for CLI session manager with usage support.
 */
export type CliMessage = {
  role: "user" | "assistant";
  content: string | CliContentBlock[];
  provider?: string;
  model?: string;
  /** Token usage for assistant messages. */
  usage?: NormalizedUsage;
  stopReason?: string;
};

/**
 * Entry in a CLI session transcript (matches SDK SessionEntry format).
 */
export type CliSessionEntry = {
  type: "message" | "custom" | "session";
  id: string;
  parentId?: string;
  timestamp: string;
  message?: {
    role: string;
    content: CliContentBlock[];
    timestamp: number;
    stopReason?: string;
    usage?: {
      input: number;
      output: number;
      cacheRead?: number;
      cacheWrite?: number;
      totalTokens: number;
    };
    provider?: string;
    model?: string;
  };
  customType?: string;
  data?: unknown;
};

/**
 * Parameters for creating a new CLI session manager.
 */
export type CliSessionManagerParams = {
  sessionId: string;
  sessionFile?: string;
  storePath?: string;
  provider?: string;
  model?: string;
};

/**
 * In-process lock for session transcript writes.
 * Ensures atomic user+assistant message pairs within the same Node process.
 */
const sessionWriteLocks = new Map<string, Promise<void>>();

async function withSessionLock<T>(sessionId: string, fn: () => T | Promise<T>): Promise<T> {
  const pending = sessionWriteLocks.get(sessionId);
  if (pending) {
    await pending.catch(() => {});
  }

  let resolve: () => void;
  const lock = new Promise<void>((r) => {
    resolve = r;
  });
  sessionWriteLocks.set(sessionId, lock);

  try {
    return await fn();
  } finally {
    resolve!();
    if (sessionWriteLocks.get(sessionId) === lock) {
      sessionWriteLocks.delete(sessionId);
    }
  }
}

/**
 * CLI Session Manager - manages session transcripts for CLI backends.
 *
 * API aligned with SDK's SessionManager where appropriate:
 * - Static factories (open/create) instead of public constructor
 * - Accessor methods (getSessionId, getSessionFile, etc.)
 * - appendMessage returns entry ID (string)
 * - Write lock for concurrency safety
 *
 * Key difference from SDK: CLI doesn't need branching/navigation (linear transcript only).
 */
export class CliSessionManager {
  private readonly sessionId: string;
  private readonly sessionFile: string | undefined;
  private readonly storePath: string | undefined;
  private readonly provider: string | undefined;
  private readonly model: string | undefined;
  private readonly entries: CliSessionEntry[] = [];
  private leafId: string | null = null;
  private cliBackendSessionId: string | undefined;

  private constructor(params: CliSessionManagerParams) {
    this.sessionId = params.sessionId;
    this.sessionFile = params.sessionFile;
    this.storePath = params.storePath;
    this.provider = params.provider;
    this.model = params.model;
  }

  /**
   * Creates a new CLI session manager (SDK-style factory).
   * Creates the transcript file if it doesn't exist.
   */
  static create(params: CliSessionManagerParams): CliSessionManager {
    const manager = new CliSessionManager(params);
    const transcriptPath = manager.resolveTranscriptPath();
    if (transcriptPath) {
      ensureTranscriptFile({ transcriptPath, sessionId: params.sessionId });
    }
    return manager;
  }

  /**
   * Opens an existing session from a transcript file (SDK-style factory).
   * Creates the transcript file if it doesn't exist.
   */
  static open(sessionFile: string, params?: Partial<CliSessionManagerParams>): CliSessionManager {
    const sessionId = params?.sessionId ?? crypto.randomUUID();
    const manager = new CliSessionManager({
      sessionId,
      sessionFile,
      storePath: params?.storePath,
      provider: params?.provider,
      model: params?.model,
    });

    // Ensure transcript file exists
    ensureTranscriptFile({ transcriptPath: sessionFile, sessionId });

    // Load existing entries from transcript
    manager.loadEntries(sessionFile);

    return manager;
  }

  // --- Accessors (matching SDK surface) ---

  getSessionId(): string {
    return this.sessionId;
  }

  getSessionFile(): string | undefined {
    return this.sessionFile ?? this.resolveTranscriptPath() ?? undefined;
  }

  getLeafId(): string | null {
    return this.leafId;
  }

  getLeafEntry(): CliSessionEntry | undefined {
    if (!this.leafId) return undefined;
    return this.entries.find((e) => e.id === this.leafId);
  }

  getEntries(): CliSessionEntry[] {
    return [...this.entries];
  }

  isPersisted(): boolean {
    return Boolean(this.sessionFile || this.storePath);
  }

  // --- CLI-specific extensions ---

  setCliBackendSessionId(cliSessionId: string): void {
    this.cliBackendSessionId = cliSessionId;
  }

  getCliBackendSessionId(): string | undefined {
    return this.cliBackendSessionId;
  }

  // --- Append Methods (matching SDK pattern, returns entry ID) ---

  /**
   * Appends a message to the session transcript.
   * Returns the entry ID (string) like SDK SessionManager.
   */
  appendMessage(message: CliMessage): string {
    const transcriptPath = this.resolveTranscriptPath();
    if (!transcriptPath) {
      throw new Error("Cannot append message: no transcript path available");
    }

    const now = Date.now();
    const entryId = crypto.randomUUID().slice(0, 8);
    const content = this.normalizeContent(message.content);

    const messageBody: CliSessionEntry["message"] = {
      role: message.role,
      content,
      timestamp: now,
    };

    if (message.role === "assistant") {
      messageBody.stopReason = message.stopReason ?? "cli_backend";
      const u = message.usage;
      messageBody.usage = {
        input: u?.input ?? 0,
        output: u?.output ?? 0,
        cacheRead: u?.cacheRead,
        cacheWrite: u?.cacheWrite,
        totalTokens: u?.total ?? (u?.input ?? 0) + (u?.output ?? 0),
      };
      if (message.provider ?? this.provider) {
        messageBody.provider = message.provider ?? this.provider;
      }
      if (message.model ?? this.model) {
        messageBody.model = message.model ?? this.model;
      }
    }

    const entry: CliSessionEntry = {
      type: "message",
      id: entryId,
      parentId: this.leafId ?? undefined,
      timestamp: new Date(now).toISOString(),
      message: messageBody,
    };

    // Append to transcript file
    try {
      fs.appendFileSync(transcriptPath, `${JSON.stringify(entry)}\n`, "utf-8");
    } catch (err) {
      throw new Error(
        `Failed to write to transcript: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Update in-memory state
    this.entries.push(entry);
    this.leafId = entryId;

    return entryId;
  }

  /**
   * Appends a message asynchronously with session-level locking.
   * Returns the entry ID (string) like SDK SessionManager.
   */
  async appendMessageAsync(message: CliMessage): Promise<string> {
    return withSessionLock(this.sessionId, () => this.appendMessage(message));
  }

  /**
   * Appends a custom entry to the session transcript.
   * Returns the entry ID (string) like SDK SessionManager.
   */
  appendCustomEntry(customType: string, data?: unknown): string {
    const transcriptPath = this.resolveTranscriptPath();
    if (!transcriptPath) {
      throw new Error("Cannot append custom entry: no transcript path available");
    }

    const entryId = crypto.randomUUID().slice(0, 8);
    const entry: CliSessionEntry = {
      type: "custom",
      id: entryId,
      parentId: this.leafId ?? undefined,
      timestamp: new Date().toISOString(),
      customType,
      data,
    };

    try {
      fs.appendFileSync(transcriptPath, `${JSON.stringify(entry)}\n`, "utf-8");
    } catch (err) {
      throw new Error(
        `Failed to write custom entry: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    this.entries.push(entry);
    this.leafId = entryId;

    return entryId;
  }

  /**
   * Archives the session transcript with a reason suffix.
   * Returns the path to the archived file.
   */
  archive(reason: string): string {
    const transcriptPath = this.resolveTranscriptPath();
    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      throw new Error("Cannot archive: transcript file not found");
    }

    const ts = new Date().toISOString().replaceAll(":", "-");
    const archived = `${transcriptPath}.${reason}.${ts}`;
    fs.renameSync(transcriptPath, archived);
    return archived;
  }

  // --- Private helpers ---

  private resolveTranscriptPath(): string | null {
    if (this.sessionFile) return this.sessionFile;
    if (this.storePath) {
      return path.join(path.dirname(this.storePath), `${this.sessionId}.jsonl`);
    }
    return null;
  }

  private normalizeContent(content: string | CliContentBlock[]): CliContentBlock[] {
    if (typeof content === "string") {
      return [{ type: "text", text: content }];
    }
    return content;
  }

  private loadEntries(filePath: string): void {
    if (!fs.existsSync(filePath)) return;

    try {
      const data = fs.readFileSync(filePath, "utf-8");
      const lines = data.split(/\r?\n/);

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as CliSessionEntry;
          if (parsed.type === "message" || parsed.type === "custom") {
            this.entries.push(parsed);
            this.leafId = parsed.id;
          }
        } catch {
          // Skip malformed lines
        }
      }
    } catch {
      // File read error - start fresh
    }
  }
}
