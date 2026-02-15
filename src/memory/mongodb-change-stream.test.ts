import type { Collection } from "mongodb";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MongoDBChangeStreamWatcher, type ChangeStreamCallback } from "./mongodb-change-stream.js";

// ---------------------------------------------------------------------------
// Mock change stream
// ---------------------------------------------------------------------------

type EventHandler = (event: unknown) => void;

function createMockStream() {
  const handlers = new Map<string, EventHandler[]>();
  return {
    on: vi.fn((event: string, handler: EventHandler) => {
      if (!handlers.has(event)) {
        handlers.set(event, []);
      }
      handlers.get(event)!.push(handler);
    }),
    close: vi.fn(async () => {}),
    emit(event: string, data: unknown) {
      for (const handler of handlers.get(event) ?? []) {
        handler(data);
      }
    },
  };
}

function createMockCollection(stream: ReturnType<typeof createMockStream>): Collection {
  return {
    watch: vi.fn(() => stream),
  } as unknown as Collection;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MongoDBChangeStreamWatcher", () => {
  let mockStream: ReturnType<typeof createMockStream>;
  let mockCol: Collection;
  let callback: ChangeStreamCallback;
  let callbackArgs: Array<{ operationType: string; paths: string[]; timestamp: Date }>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockStream = createMockStream();
    mockCol = createMockCollection(mockStream);
    callbackArgs = [];
    callback = (event) => callbackArgs.push(event);
  });

  afterEach(async () => {
    vi.useRealTimers();
  });

  it("starts watching the collection", async () => {
    const watcher = new MongoDBChangeStreamWatcher(mockCol, callback, 100);
    const started = await watcher.start();

    expect(started).toBe(true);
    expect(mockCol.watch).toHaveBeenCalledTimes(1);
    expect(watcher.isActive).toBe(true);

    await watcher.close();
  });

  it("debounces change events", async () => {
    const watcher = new MongoDBChangeStreamWatcher(mockCol, callback, 100);
    await watcher.start();

    // Emit 3 rapid changes
    mockStream.emit("change", {
      operationType: "update",
      fullDocument: { path: "memory/a.md" },
      documentKey: { _id: "memory/a.md:1:5" },
    });
    mockStream.emit("change", {
      operationType: "update",
      fullDocument: { path: "memory/b.md" },
      documentKey: { _id: "memory/b.md:1:3" },
    });
    mockStream.emit("change", {
      operationType: "insert",
      fullDocument: { path: "memory/c.md" },
      documentKey: { _id: "memory/c.md:1:2" },
    });

    // No callback yet (debouncing)
    expect(callbackArgs.length).toBe(0);

    // Advance past debounce window
    vi.advanceTimersByTime(150);

    // Single batched callback
    expect(callbackArgs.length).toBe(1);
    expect(callbackArgs[0].paths).toContain("memory/a.md");
    expect(callbackArgs[0].paths).toContain("memory/b.md");
    expect(callbackArgs[0].paths).toContain("memory/c.md");
    expect(callbackArgs[0].operationType).toBe("insert");

    await watcher.close();
  });

  it("extracts path from delete events using _id composite key", async () => {
    const watcher = new MongoDBChangeStreamWatcher(mockCol, callback, 50);
    await watcher.start();

    // Delete event has no fullDocument
    mockStream.emit("change", {
      operationType: "delete",
      documentKey: { _id: "sessions/old.jsonl:1:10" },
    });

    vi.advanceTimersByTime(100);

    expect(callbackArgs.length).toBe(1);
    expect(callbackArgs[0].paths).toContain("sessions/old.jsonl");
    expect(callbackArgs[0].operationType).toBe("delete");

    await watcher.close();
  });

  it("closes cleanly", async () => {
    const watcher = new MongoDBChangeStreamWatcher(mockCol, callback, 100);
    await watcher.start();
    expect(watcher.isActive).toBe(true);

    await watcher.close();
    expect(watcher.isActive).toBe(false);
    expect(mockStream.close).toHaveBeenCalled();
  });

  it("is idempotent on close", async () => {
    const watcher = new MongoDBChangeStreamWatcher(mockCol, callback, 100);
    await watcher.start();

    await watcher.close();
    await watcher.close(); // second close should not throw
    expect(mockStream.close).toHaveBeenCalledTimes(1);
  });

  it("returns false on start when change streams not supported", async () => {
    const col = {
      watch: vi.fn(() => {
        throw new Error("The $changeStream stage is only supported on replica sets");
      }),
    } as unknown as Collection;

    const watcher = new MongoDBChangeStreamWatcher(col, callback);
    const started = await watcher.start();

    expect(started).toBe(false);
    expect(watcher.isActive).toBe(false);
  });

  it("does not start after close", async () => {
    const watcher = new MongoDBChangeStreamWatcher(mockCol, callback, 100);
    await watcher.close();

    const started = await watcher.start();
    expect(started).toBe(false);
  });

  it("handles callback errors gracefully", async () => {
    const failingCallback: ChangeStreamCallback = () => {
      throw new Error("callback failed");
    };
    const watcher = new MongoDBChangeStreamWatcher(mockCol, failingCallback, 50);
    await watcher.start();

    mockStream.emit("change", {
      operationType: "insert",
      fullDocument: { path: "memory/test.md" },
      documentKey: { _id: "memory/test.md:1:1" },
    });

    // Should not throw
    vi.advanceTimersByTime(100);

    await watcher.close();
  });
});
