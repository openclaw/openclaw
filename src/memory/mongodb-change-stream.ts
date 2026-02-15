import type { ChangeStream, ChangeStreamDocument, Collection, Document } from "mongodb";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("memory:mongodb:changestream");

/**
 * Callback invoked when relevant changes are detected in the chunks collection.
 * The watcher debounces and batches events, so this is called at most once
 * per debounce window.
 */
export type ChangeStreamCallback = (event: {
  operationType: string;
  paths: string[];
  timestamp: Date;
}) => void;

/**
 * MongoDBChangeStreamWatcher watches for changes to the chunks collection
 * and invokes a callback when relevant inserts/updates/deletes are detected.
 *
 * Requires a replica set (same as transactions). Degrades gracefully on
 * standalone topologies by simply not opening a stream.
 */
export class MongoDBChangeStreamWatcher {
  private stream: ChangeStream<Document, ChangeStreamDocument> | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private pendingPaths: Set<string> = new Set();
  private pendingOpType: string = "unknown";
  private closed = false;
  /**
   * F21: Last resume token for reconnection after restart.
   * NOTE (v1): Token is held in-memory only — not persisted to the meta collection.
   * On process restart the token is lost and events since shutdown are missed.
   * The manager can call `lastResumeToken` on shutdown to persist externally.
   */
  private _lastResumeToken: unknown = null;

  constructor(
    private readonly collection: Collection,
    private readonly callback: ChangeStreamCallback,
    private readonly debounceMs: number = 1000,
  ) {}

  /** F21: Get the last resume token for external persistence across restarts */
  get lastResumeToken(): unknown {
    return this._lastResumeToken;
  }

  /**
   * F21: Open the change stream. Accepts an optional resumeAfter token
   * to resume from a previously persisted position.
   * Returns false if change streams are not supported (standalone MongoDB).
   */
  async start(resumeAfter?: unknown): Promise<boolean> {
    if (this.closed) {
      return false;
    }

    try {
      // Filter to relevant operation types only
      const watchOpts: Record<string, unknown> = {
        fullDocument: "updateLookup",
      };
      if (resumeAfter) {
        watchOpts.resumeAfter = resumeAfter;
      }

      this.stream = this.collection.watch(
        [
          {
            $match: {
              operationType: { $in: ["insert", "update", "replace", "delete"] },
            },
          },
        ],
        watchOpts,
      );

      this.stream.on("change", (change: ChangeStreamDocument) => {
        this.handleChange(change);
      });

      this.stream.on("error", (err: Error) => {
        const msg = err.message ?? String(err);
        if (isChangeStreamNotSupported(msg)) {
          log.info("change streams not supported (standalone topology), closing watcher");
          void this.close();
        } else {
          log.warn(`change stream error: ${msg}`);
        }
      });

      log.info("change stream started");
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isChangeStreamNotSupported(msg)) {
        log.info("change streams not supported (standalone topology)");
        return false;
      }
      log.warn(`failed to start change stream: ${msg}`);
      return false;
    }
  }

  private handleChange(change: ChangeStreamDocument): void {
    // F21: Persist resume token for reconnection
    if (change._id) {
      this._lastResumeToken = change._id;
    }

    const opType = change.operationType;

    // Extract path from the document (available for insert/update/replace)
    let changedPath: string | undefined;
    if ("fullDocument" in change && change.fullDocument) {
      changedPath = change.fullDocument.path as string | undefined;
    }
    if (!changedPath && "documentKey" in change && change.documentKey) {
      // For deletes, try to extract path from _id if it's a composite key
      const docId = String(change.documentKey._id);
      const pathEnd = docId.indexOf(":");
      if (pathEnd > 0) {
        changedPath = docId.slice(0, pathEnd);
      }
    }

    if (changedPath) {
      this.pendingPaths.add(changedPath);
    }
    this.pendingOpType = opType;

    // Debounce: batch changes within the debounce window
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.flush();
    }, this.debounceMs);
  }

  private flush(): void {
    if (this.pendingPaths.size === 0 && this.pendingOpType === "unknown") {
      return;
    }

    const paths = Array.from(this.pendingPaths);
    const opType = this.pendingOpType;
    this.pendingPaths.clear();
    this.pendingOpType = "unknown";
    this.debounceTimer = null;

    try {
      this.callback({
        operationType: opType,
        paths,
        timestamp: new Date(),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`change stream callback error: ${msg}`);
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (this.stream) {
      try {
        await this.stream.close();
      } catch {
        // Ignore close errors
      }
      this.stream = null;
    }

    log.info("change stream closed");
  }

  get isActive(): boolean {
    return this.stream !== null && !this.closed;
  }
}

function isChangeStreamNotSupported(msg: string): boolean {
  return (
    msg.includes("not allowed on a replica set") ||
    msg.includes("The $changeStream stage is only supported") ||
    msg.includes("not replicated") ||
    msg.includes("not a replica set")
  );
}
