import fs from "node:fs/promises";
import path from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { onSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import {
  OpenMemoryClient,
  type AddMemoryResult,
  type OpenMemoryConfig,
} from "./openmemory-client.js";
import { buildSessionEntry, listSessionFilesForAgent } from "./session-files.js";

const log = createSubsystemLogger("openmemory-sync");

const SESSION_DELTA_READ_CHUNK_BYTES = 64 * 1024;
const DEFAULT_DELTA_BYTES = 100_000;
const DEFAULT_DELTA_MESSAGES = 50;
const DEFAULT_SYNC_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 90;
const DEFAULT_RETENTION_CLEANUP_MS = 24 * 60 * 60 * 1000;

type SessionDeltaState = {
  lastSize: number;
  pendingBytes: number;
  pendingMessages: number;
};

type SessionSyncState = {
  hash: string;
  mtimeMs: number;
  lastSyncedAt: number;
};

export type OpenMemorySyncManagerConfig = OpenMemoryConfig & {
  agentId: string;
  deltaBytes?: number;
  deltaMessages?: number;
  syncIntervalMs?: number;
  retentionDays?: number;
  retentionCleanupIntervalMs?: number;
};

export class OpenMemorySyncManager extends OpenMemoryClient {
  private readonly agentId: string;
  private readonly deltaBytes: number;
  private readonly deltaMessages: number;
  private readonly syncIntervalMs: number;
  private readonly retentionDays: number;
  private readonly retentionCleanupIntervalMs: number;

  private readonly sessionDeltas = new Map<string, SessionDeltaState>();
  private readonly sessionSyncState = new Map<string, SessionSyncState>();
  private readonly pendingSync = new Set<string>();

  private unsubscribeSessionEvents: (() => void) | null = null;
  private syncTimer: NodeJS.Timeout | null = null;
  private retentionTimer: NodeJS.Timeout | null = null;
  private running = false;
  private syncing = false;

  constructor(config: OpenMemorySyncManagerConfig) {
    super(config);
    this.agentId = config.agentId;
    this.deltaBytes = config.deltaBytes ?? DEFAULT_DELTA_BYTES;
    this.deltaMessages = config.deltaMessages ?? DEFAULT_DELTA_MESSAGES;
    this.syncIntervalMs = config.syncIntervalMs ?? DEFAULT_SYNC_INTERVAL_MS;
    this.retentionDays = config.retentionDays ?? DEFAULT_RETENTION_DAYS;
    this.retentionCleanupIntervalMs =
      config.retentionCleanupIntervalMs ?? DEFAULT_RETENTION_CLEANUP_MS;
  }

  static async create(config: OpenMemorySyncManagerConfig): Promise<OpenMemorySyncManager | null> {
    const base = await OpenMemoryClient.create(config);
    if (!base) {
      return null;
    }
    await base.close?.();
    return new OpenMemorySyncManager(config);
  }

  startListening(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.unsubscribeSessionEvents = onSessionTranscriptUpdate((update) => {
      void this.handleSessionUpdate(update.sessionFile);
    });

    this.syncTimer = setInterval(() => {
      void this.syncPending({ reason: "interval" });
    }, this.syncIntervalMs);

    this.retentionTimer = setInterval(() => {
      void this.cleanupRetention();
    }, this.retentionCleanupIntervalMs);

    log.info("OpenMemory session sync listener started", {
      agentId: this.agentId,
      deltaBytes: this.deltaBytes,
      deltaMessages: this.deltaMessages,
      syncIntervalMs: this.syncIntervalMs,
      retentionDays: this.retentionDays,
    });
  }

  stopListening(): void {
    this.running = false;
    this.unsubscribeSessionEvents?.();
    this.unsubscribeSessionEvents = null;
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    if (this.retentionTimer) {
      clearInterval(this.retentionTimer);
      this.retentionTimer = null;
    }
  }

  async close(): Promise<void> {
    this.stopListening();
    await super.close();
  }

  async syncAllSessions(): Promise<void> {
    const files = await listSessionFilesForAgent(this.agentId);
    for (const absPath of files) {
      this.pendingSync.add(absPath);
    }
    await this.syncPending({ reason: "full-sync" });
  }

  async syncPending(params?: { reason?: string }): Promise<void> {
    if (this.syncing) {
      return;
    }
    if (this.pendingSync.size === 0) {
      return;
    }

    this.syncing = true;
    try {
      const pending = Array.from(this.pendingSync);
      this.pendingSync.clear();

      for (const absPath of pending) {
        await this.syncSessionFile(absPath, params?.reason ?? "session-delta");
      }
    } finally {
      this.syncing = false;
    }
  }

  private async handleSessionUpdate(sessionFile: string): Promise<void> {
    const delta = await this.updateSessionDelta(sessionFile);
    if (!delta) {
      return;
    }

    const bytesHit =
      this.deltaBytes <= 0 ? delta.pendingBytes > 0 : delta.pendingBytes >= this.deltaBytes;
    const messagesHit =
      this.deltaMessages <= 0
        ? delta.pendingMessages > 0
        : delta.pendingMessages >= this.deltaMessages;

    if (!bytesHit && !messagesHit) {
      return;
    }

    this.pendingSync.add(sessionFile);
    delta.pendingBytes =
      this.deltaBytes > 0 ? Math.max(0, delta.pendingBytes - this.deltaBytes) : 0;
    delta.pendingMessages =
      this.deltaMessages > 0 ? Math.max(0, delta.pendingMessages - this.deltaMessages) : 0;

    await this.syncPending({ reason: "session-delta" });
  }

  private async updateSessionDelta(sessionFile: string): Promise<SessionDeltaState | null> {
    let stat: { size: number };
    try {
      stat = await fs.stat(sessionFile);
    } catch {
      return null;
    }

    const size = stat.size;
    let state = this.sessionDeltas.get(sessionFile);
    if (!state) {
      state = { lastSize: 0, pendingBytes: 0, pendingMessages: 0 };
      this.sessionDeltas.set(sessionFile, state);
    }

    const deltaBytes = Math.max(0, size - state.lastSize);
    if (deltaBytes === 0 && size === state.lastSize) {
      return state;
    }

    if (size < state.lastSize) {
      state.lastSize = size;
      state.pendingBytes += size;
      if (this.deltaMessages > 0) {
        state.pendingMessages += await this.countNewlines(sessionFile, 0, size);
      }
      return state;
    }

    state.pendingBytes += deltaBytes;
    if (this.deltaMessages > 0) {
      state.pendingMessages += await this.countNewlines(sessionFile, state.lastSize, size);
    }
    state.lastSize = size;
    return state;
  }

  private async syncSessionFile(absPath: string, reason: string): Promise<AddMemoryResult | null> {
    const entry = await buildSessionEntry(absPath);
    if (!entry || !entry.content.trim()) {
      return null;
    }

    const previous = this.sessionSyncState.get(absPath);
    if (previous && previous.hash === entry.hash && previous.mtimeMs === entry.mtimeMs) {
      this.resetSessionDelta(absPath, entry.size);
      return null;
    }

    const sessionId = this.extractSessionId(absPath);
    const tags = ["session", "episodic", `sessionId:${sessionId}`];
    const metadata = {
      source: "sessions",
      sessionId,
      path: entry.path,
      hash: entry.hash,
      mtimeMs: entry.mtimeMs,
      messageCount: entry.lineMap.length,
      syncedAt: Date.now(),
      reason,
    };

    const result = await this.add({
      content: entry.content,
      tags,
      metadata,
    });

    this.sessionSyncState.set(absPath, {
      hash: entry.hash,
      mtimeMs: entry.mtimeMs,
      lastSyncedAt: Date.now(),
    });
    this.resetSessionDelta(absPath, entry.size);

    return result;
  }

  private resetSessionDelta(absPath: string, size: number): void {
    const state = this.sessionDeltas.get(absPath);
    if (!state) {
      return;
    }
    state.lastSize = size;
    state.pendingBytes = 0;
    state.pendingMessages = 0;
  }

  private extractSessionId(absPath: string): string {
    const base = path.basename(absPath, ".jsonl");
    const [head] = base.split("-");
    return head || base;
  }

  private async countNewlines(absPath: string, start: number, end: number): Promise<number> {
    if (end <= start) {
      return 0;
    }
    const handle = await fs.open(absPath, "r");
    try {
      let offset = start;
      let count = 0;
      const buffer = Buffer.alloc(SESSION_DELTA_READ_CHUNK_BYTES);

      while (offset < end) {
        const toRead = Math.min(buffer.length, end - offset);
        const { bytesRead } = await handle.read(buffer, 0, toRead, offset);
        if (bytesRead <= 0) {
          break;
        }
        for (let i = 0; i < bytesRead; i += 1) {
          if (buffer[i] === 10) {
            count += 1;
          }
        }
        offset += bytesRead;
      }

      return count;
    } finally {
      await handle.close();
    }
  }

  private async cleanupRetention(): Promise<void> {
    const retentionCutoff = Date.now() - this.retentionDays * 24 * 60 * 60 * 1000;

    try {
      const queryResponse = await fetch(`${this.getUrl()}/memory/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: "session transcript",
          k: 200,
          user_id: this.getUserId(),
          filters: {
            source: "sessions",
            endTime: Math.floor(retentionCutoff / 1000),
          },
        }),
      });

      if (!queryResponse.ok) {
        return;
      }

      const data = (await queryResponse.json()) as {
        matches?: Array<{ id: string; metadata?: { source?: string; mtimeMs?: number } }>;
      };

      const staleIds = (data.matches ?? [])
        .filter((item) => item.metadata?.source === "sessions")
        .map((item) => item.id)
        .filter(Boolean);

      if (staleIds.length === 0) {
        return;
      }

      for (const id of staleIds) {
        await fetch(
          `${this.getUrl()}/memory/delete/${id}?user_id=${encodeURIComponent(this.getUserId())}`,
          {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
          },
        ).catch(() => undefined);
      }

      log.info("OpenMemory retention cleanup completed", {
        deleted: staleIds.length,
        retentionDays: this.retentionDays,
      });
    } catch (err) {
      log.debug(`OpenMemory retention cleanup skipped: ${String(err)}`);
    }
  }
}
