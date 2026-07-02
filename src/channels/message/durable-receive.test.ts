// Durable receive tests cover persisted inbound channel receive state and replay behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type {
  PluginStateEntry,
  PluginStateKeyedStore,
} from "../../plugin-state/plugin-state-store.types.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  createDurableInboundReceiveJournal,
  createDurableInboundReceiveJournalFromQueue,
  replayPendingDurableInboundReceives,
} from "./durable-receive.js";
import { createChannelIngressQueue } from "./ingress-queue.js";

type TestPayload = { body: string };
type TestMetadata = { source: string };
type TestCompletedMetadata = { delivered: boolean };

function assertNoUndefinedFields(value: unknown): void {
  if (value === undefined) {
    throw new Error("undefined field");
  }
  if (!value || typeof value !== "object") {
    return;
  }
  for (const entry of Array.isArray(value) ? value : Object.values(value)) {
    assertNoUndefinedFields(entry);
  }
}

function createMemoryStore<T>(): PluginStateKeyedStore<T> {
  const values = new Map<string, PluginStateEntry<T>>();
  return {
    async register(key, value) {
      assertNoUndefinedFields(value);
      values.set(key, { key, value, createdAt: Date.now() });
    },
    async registerIfAbsent(key, value) {
      if (values.has(key)) {
        return false;
      }
      assertNoUndefinedFields(value);
      values.set(key, { key, value, createdAt: Date.now() });
      return true;
    },
    async update(key, updateValue) {
      const next = updateValue(values.get(key)?.value);
      if (next === undefined) {
        return false;
      }
      assertNoUndefinedFields(next);
      values.set(key, { key, value: next, createdAt: Date.now() });
      return true;
    },
    async lookup(key) {
      return values.get(key)?.value;
    },
    async consume(key) {
      const value = values.get(key)?.value;
      values.delete(key);
      return value;
    },
    async delete(key) {
      return values.delete(key);
    },
    async entries() {
      return Array.from(values.values());
    },
    async clear() {
      values.clear();
    },
  };
}

async function withTempState<T>(fn: (stateDir: string) => Promise<T>): Promise<T> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-durable-receive-"));
  try {
    return await fn(stateDir);
  } finally {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

describe("createDurableInboundReceiveJournal", () => {
  it("accepts pending records once and reports duplicate pending deliveries", async () => {
    const journal = createDurableInboundReceiveJournal<
      TestPayload,
      TestMetadata,
      TestCompletedMetadata
    >({
      pendingStore: createMemoryStore(),
      completedStore: createMemoryStore(),
      now: () => 10,
    });

    await expect(
      journal.accept("message-1", { body: "hello" }, { metadata: { source: "live" } }),
    ).resolves.toMatchObject({
      kind: "accepted",
      duplicate: false,
      record: {
        id: "message-1",
        payload: { body: "hello" },
        metadata: { source: "live" },
        receivedAt: 10,
      },
    });

    await expect(
      journal.accept("message-1", { body: "changed" }, { metadata: { source: "redeliver" } }),
    ).resolves.toMatchObject({
      kind: "pending",
      duplicate: true,
      record: {
        payload: { body: "hello" },
        metadata: { source: "live" },
      },
    });
  });

  it("keeps completed ids so later duplicates do not re-enter pending", async () => {
    const journal = createDurableInboundReceiveJournal<
      TestPayload,
      TestMetadata,
      TestCompletedMetadata
    >({
      pendingStore: createMemoryStore(),
      completedStore: createMemoryStore(),
      now: () => 20,
    });

    await journal.accept("message-1", { body: "hello" });
    await journal.complete("message-1", { metadata: { delivered: true }, completedAt: 30 });

    await expect(journal.pending()).resolves.toEqual([]);
    await expect(journal.accept("message-1", { body: "again" })).resolves.toMatchObject({
      kind: "completed",
      duplicate: true,
      record: {
        id: "message-1",
        completedAt: 30,
        metadata: { delivered: true },
      },
    });
  });

  it("does not recreate pending state when completion wins a missing-pending race", async () => {
    let completedLookups = 0;
    const pendingStore: PluginStateKeyedStore<
      import("./durable-receive.js").DurableInboundReceivePendingRecord<TestPayload, TestMetadata>
    > = {
      async register() {
        throw new Error("pending register should not run");
      },
      async registerIfAbsent() {
        return false;
      },
      async update() {
        return false;
      },
      async lookup() {
        return undefined;
      },
      async consume() {
        return undefined;
      },
      async delete() {
        return false;
      },
      async entries() {
        return [];
      },
      async clear() {},
    };
    const completedStore: PluginStateKeyedStore<
      import("./durable-receive.js").DurableInboundReceiveCompletedRecord<TestCompletedMetadata>
    > = {
      async register() {},
      async registerIfAbsent() {
        return false;
      },
      async update() {
        return false;
      },
      async lookup() {
        completedLookups += 1;
        return completedLookups === 2
          ? { id: "message-1", completedAt: 40, metadata: { delivered: true } }
          : undefined;
      },
      async consume() {
        return undefined;
      },
      async delete() {
        return false;
      },
      async entries() {
        return [];
      },
      async clear() {},
    };
    const journal = createDurableInboundReceiveJournal<
      TestPayload,
      TestMetadata,
      TestCompletedMetadata
    >({
      pendingStore,
      completedStore,
    });

    await expect(journal.accept("message-1", { body: "again" })).resolves.toMatchObject({
      kind: "completed",
      duplicate: true,
      record: { completedAt: 40 },
    });
  });

  it("removes newly inserted pending state when completion wins the insert race", async () => {
    let completedLookups = 0;
    const pendingStore =
      createMemoryStore<
        import("./durable-receive.js").DurableInboundReceivePendingRecord<TestPayload, TestMetadata>
      >();
    const completedStore: PluginStateKeyedStore<
      import("./durable-receive.js").DurableInboundReceiveCompletedRecord<TestCompletedMetadata>
    > = {
      async register() {},
      async registerIfAbsent() {
        return false;
      },
      async update() {
        return false;
      },
      async lookup() {
        completedLookups += 1;
        return completedLookups === 2
          ? { id: "message-1", completedAt: 50, metadata: { delivered: true } }
          : undefined;
      },
      async consume() {
        return undefined;
      },
      async delete() {
        return false;
      },
      async entries() {
        return [];
      },
      async clear() {},
    };
    const journal = createDurableInboundReceiveJournal<
      TestPayload,
      TestMetadata,
      TestCompletedMetadata
    >({
      pendingStore,
      completedStore,
    });

    await expect(journal.accept("message-1", { body: "again" })).resolves.toMatchObject({
      kind: "completed",
      duplicate: true,
      record: { completedAt: 50 },
    });
    await expect(pendingStore.lookup("message-1")).resolves.toBeUndefined();
  });

  it("filters stale pending records when completion left both stores populated", async () => {
    const pendingStore =
      createMemoryStore<
        import("./durable-receive.js").DurableInboundReceivePendingRecord<TestPayload, TestMetadata>
      >();
    const completedStore =
      createMemoryStore<
        import("./durable-receive.js").DurableInboundReceiveCompletedRecord<TestCompletedMetadata>
      >();
    await pendingStore.register("message-1", {
      id: "message-1",
      payload: { body: "hello" },
      receivedAt: 1,
      updatedAt: 1,
      attempts: 0,
    });
    await completedStore.register("message-1", {
      id: "message-1",
      completedAt: 2,
      metadata: { delivered: true },
    });
    const journal = createDurableInboundReceiveJournal<
      TestPayload,
      TestMetadata,
      TestCompletedMetadata
    >({
      pendingStore,
      completedStore,
    });

    await expect(journal.pending()).resolves.toEqual([]);
    await expect(pendingStore.lookup("message-1")).resolves.toBeUndefined();
  });

  it("releases retryable records while preserving original receive order", async () => {
    let clock = 100;
    const journal = createDurableInboundReceiveJournal<
      TestPayload,
      TestMetadata,
      TestCompletedMetadata
    >({
      pendingStore: createMemoryStore(),
      completedStore: createMemoryStore(),
      now: () => clock,
    });

    await journal.accept("b", { body: "second" }, { receivedAt: 2 });
    await journal.accept("a", { body: "first" }, { receivedAt: 1 });

    clock = 200;
    await expect(journal.release("a", { lastError: "transient" })).resolves.toBe(true);

    await expect(journal.pending()).resolves.toMatchObject([
      {
        id: "a",
        attempts: 1,
        receivedAt: 1,
        lastAttemptAt: 200,
        lastError: "transient",
      },
      {
        id: "b",
        attempts: 0,
        receivedAt: 2,
      },
    ]);
  });

  it("fail() dead-letters a pending record so it is not replayed or re-accepted", async () => {
    const journal = createDurableInboundReceiveJournal<
      TestPayload,
      TestMetadata,
      TestCompletedMetadata
    >({
      pendingStore: createMemoryStore(),
      completedStore: createMemoryStore(),
      now: () => 10,
    });

    await journal.accept("poison", { body: "boom" });
    await expect(journal.fail("poison", { reason: "max_replay_attempts" })).resolves.toBe(true);
    await expect(journal.pending()).resolves.toEqual([]);
    const redelivered = await journal.accept("poison", { body: "boom again" });
    expect(redelivered.kind).not.toBe("accepted");
    expect(redelivered.duplicate).toBe(true);
  });

  it("fail() on the queue-backed journal dead-letters and blocks re-accept", async () => {
    await withTempState(async (stateDir) => {
      const queue = createChannelIngressQueue<TestPayload, TestMetadata, TestCompletedMetadata>({
        channelId: "test",
        accountId: "account",
        stateDir,
        now: () => 10,
      });
      const journal = createDurableInboundReceiveJournalFromQueue({ queue });

      await journal.accept("poison", { body: "boom" });
      await expect(journal.fail("poison", { reason: "max_replay_attempts" })).resolves.toBe(true);
      await expect(journal.pending()).resolves.toEqual([]);
      const redelivered = await journal.accept("poison", { body: "boom again" });
      expect(redelivered.kind).not.toBe("accepted");
      expect(redelivered.duplicate).toBe(true);
    });
  });

  it("bounded replay processes fresh records, counts the attempt, and dead-letters at the cap", async () => {
    const journal = createDurableInboundReceiveJournal<
      TestPayload,
      TestMetadata,
      TestCompletedMetadata
    >({
      pendingStore: createMemoryStore(),
      completedStore: createMemoryStore(),
      now: () => 10,
    });
    await journal.accept("fresh", { body: "ok" }, { receivedAt: 1 });
    await journal.accept("poison", { body: "boom" }, { receivedAt: 2 });
    await journal.release("poison");
    await journal.release("poison");

    const processed: string[] = [];
    const deadLettered: string[] = [];
    await replayPendingDurableInboundReceives({
      journal,
      maxAttempts: 2,
      onDeadLetter: (record) => {
        deadLettered.push(record.id);
      },
      process: async (record) => {
        processed.push(record.id);
        await journal.complete(record.id);
      },
    });

    expect(processed).toEqual(["fresh"]);
    expect(deadLettered).toEqual(["poison"]);
    await expect(journal.pending()).resolves.toEqual([]);
    const redelivered = await journal.accept("poison", { body: "boom again" });
    expect(redelivered.kind).not.toBe("accepted");
  });

  it("bounded replay attempt counting survives a replay that never finishes", async () => {
    const journal = createDurableInboundReceiveJournal<
      TestPayload,
      TestMetadata,
      TestCompletedMetadata
    >({
      pendingStore: createMemoryStore(),
      completedStore: createMemoryStore(),
      now: () => 10,
    });
    await journal.accept("stall", { body: "hangs" });

    // Simulate a stalled run: process neither completes nor releases; the
    // attempt must still be recorded so restarts converge on the cap.
    await replayPendingDurableInboundReceives({
      journal,
      maxAttempts: 2,
      process: async () => {},
    });
    await expect(journal.pending()).resolves.toMatchObject([{ id: "stall", attempts: 1 }]);

    await replayPendingDurableInboundReceives({
      journal,
      maxAttempts: 2,
      process: async () => {},
    });
    await expect(journal.pending()).resolves.toMatchObject([{ id: "stall", attempts: 2 }]);

    const deadLettered: string[] = [];
    await replayPendingDurableInboundReceives({
      journal,
      maxAttempts: 2,
      onDeadLetter: (record) => {
        deadLettered.push(record.id);
      },
      process: async () => {
        throw new Error("should not process past the cap");
      },
    });
    expect(deadLettered).toEqual(["stall"]);
    await expect(journal.pending()).resolves.toEqual([]);
  });

  it("bounded replay isolates a throwing record and still replays the rest", async () => {
    const journal = createDurableInboundReceiveJournal<
      TestPayload,
      TestMetadata,
      TestCompletedMetadata
    >({
      pendingStore: createMemoryStore(),
      completedStore: createMemoryStore(),
      now: () => 10,
    });
    await journal.accept("poison", { body: "boom" }, { receivedAt: 1 });
    await journal.accept("fresh", { body: "ok" }, { receivedAt: 2 });

    const processed: string[] = [];
    await expect(
      replayPendingDurableInboundReceives({
        journal,
        maxAttempts: 3,
        process: async (record) => {
          if (record.id === "poison") {
            throw new Error("poison record");
          }
          processed.push(record.id);
          await journal.complete(record.id);
        },
      }),
    ).rejects.toThrow("durable inbound replay failed for some records");

    // The newer record behind the poison one was still delivered, and the
    // poison record kept its bumped attempt so it converges on the cap.
    expect(processed).toEqual(["fresh"]);
    await expect(journal.pending()).resolves.toMatchObject([{ id: "poison", attempts: 1 }]);
  });

  it("bounded replay skips a record whose row vanished before the attempt was recorded", async () => {
    const journal = createDurableInboundReceiveJournal<
      TestPayload,
      TestMetadata,
      TestCompletedMetadata
    >({
      pendingStore: createMemoryStore(),
      completedStore: createMemoryStore(),
      now: () => 10,
    });
    await journal.accept("gone", { body: "completed elsewhere" });

    // Simulate a concurrent live delivery completing the record between the
    // pending() snapshot and the per-record release.
    const racingJournal: typeof journal = {
      ...journal,
      release: async () => false,
    };

    const processed: string[] = [];
    await replayPendingDurableInboundReceives({
      journal: racingJournal,
      maxAttempts: 3,
      process: async (record) => {
        processed.push(record.id);
      },
    });
    expect(processed).toEqual([]);
  });

  it("can use the shared channel ingress queue as durable storage", async () => {
    await withTempState(async (stateDir) => {
      const queue = createChannelIngressQueue<TestPayload, TestMetadata, TestCompletedMetadata>({
        channelId: "test",
        accountId: "account",
        stateDir,
        now: () => 10,
      });
      const journal = createDurableInboundReceiveJournalFromQueue({
        queue,
        retention: { completedMaxEntries: 1 },
      });

      await expect(
        journal.accept("message-1", { body: "hello" }, { metadata: { source: "live" } }),
      ).resolves.toMatchObject({
        kind: "accepted",
        duplicate: false,
        record: {
          id: "message-1",
          payload: { body: "hello" },
          metadata: { source: "live" },
          receivedAt: 10,
        },
      });

      await expect(journal.pending()).resolves.toMatchObject([
        {
          id: "message-1",
          payload: { body: "hello" },
          metadata: { source: "live" },
        },
      ]);

      await expect(journal.release("message-1", { lastError: "retry" })).resolves.toBe(true);
      await expect(journal.pending()).resolves.toMatchObject([
        {
          id: "message-1",
          attempts: 1,
          lastError: "retry",
        },
      ]);

      await journal.complete("message-1", {
        metadata: { delivered: true },
        completedAt: 20,
      });
      await expect(journal.accept("message-1", { body: "again" })).resolves.toMatchObject({
        kind: "completed",
        duplicate: true,
        record: {
          id: "message-1",
          completedAt: 20,
          metadata: { delivered: true },
        },
      });

      await journal.accept("message-2", { body: "new" });
      await journal.complete("message-2", { completedAt: 21 });
      await expect(journal.accept("message-1", { body: "past retention" })).resolves.toMatchObject({
        kind: "accepted",
        duplicate: false,
      });
    });
  });
});
