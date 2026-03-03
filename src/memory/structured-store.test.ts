import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeAllStructuredStores, getStructuredStore } from "./structured-store.js";

// Use a temp directory for tests so we don't touch the real state dir.
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "structured-store-test-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", tmpDir);
});

afterEach(() => {
  closeAllStructuredStores();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("StructuredStore", () => {
  it("should store and query entries", () => {
    const store = getStructuredStore("test-agent");
    store.store("users", "alice", { name: "Alice", age: 30 });
    store.store("users", "bob", { name: "Bob", age: 25 });

    const entries = store.query("users");
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.key).toSorted()).toEqual(["alice", "bob"]);
    expect(entries.find((e) => e.key === "alice")?.value).toEqual({ name: "Alice", age: 30 });
  });

  it("should upsert existing keys", () => {
    const store = getStructuredStore("test-agent");
    store.store("users", "alice", { name: "Alice", age: 30 });
    store.store("users", "alice", { name: "Alice", age: 31 });

    const entries = store.query("users");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.value).toEqual({ name: "Alice", age: 31 });
  });

  it("should filter by key-value pairs", () => {
    const store = getStructuredStore("test-agent");
    store.store("users", "alice", { name: "Alice", role: "admin" });
    store.store("users", "bob", { name: "Bob", role: "user" });
    store.store("users", "carol", { name: "Carol", role: "admin" });

    const admins = store.query("users", { role: "admin" });
    expect(admins).toHaveLength(2);
    expect(admins.map((e) => e.key).toSorted()).toEqual(["alice", "carol"]);
  });

  it("should respect limit parameter", () => {
    const store = getStructuredStore("test-agent");
    for (let i = 0; i < 10; i++) {
      store.store("items", `item-${i}`, { index: i });
    }

    const limited = store.query("items", undefined, 3);
    expect(limited).toHaveLength(3);
  });

  it("should remove entries", () => {
    const store = getStructuredStore("test-agent");
    store.store("users", "alice", { name: "Alice" });
    store.store("users", "bob", { name: "Bob" });

    const deleted = store.remove("users", "alice");
    expect(deleted).toBe(true);

    const entries = store.query("users");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.key).toBe("bob");
  });

  it("should return false when removing non-existent key", () => {
    const store = getStructuredStore("test-agent");
    const deleted = store.remove("users", "ghost");
    expect(deleted).toBe(false);
  });

  it("should list keys in a collection", () => {
    const store = getStructuredStore("test-agent");
    store.store("users", "alice", { name: "Alice" });
    store.store("users", "bob", { name: "Bob" });

    const keys = store.list("users");
    expect(keys).toEqual(["alice", "bob"]);
  });

  it("should list collections with counts", () => {
    const store = getStructuredStore("test-agent");
    store.store("users", "alice", { name: "Alice" });
    store.store("users", "bob", { name: "Bob" });
    store.store("settings", "theme", { dark: true });

    const collections = store.collections();
    expect(collections).toHaveLength(2);
    const sorted = collections.toSorted((a, b) => a.collection.localeCompare(b.collection));
    expect(sorted[0]).toEqual({ collection: "settings", count: 1 });
    expect(sorted[1]).toEqual({ collection: "users", count: 2 });
  });

  it("should enforce max value size", () => {
    const store = getStructuredStore("test-agent");
    const bigValue = "x".repeat(64 * 1024 + 1);
    expect(() => store.store("data", "big", bigValue)).toThrow(/exceeds maximum size/);
  });

  it("should enforce max collection entries", () => {
    const store = getStructuredStore("test-agent");
    // Store up to the limit
    for (let i = 0; i < 10_000; i++) {
      store.store("full", `key-${i}`, { i });
    }
    // One more should fail
    expect(() => store.store("full", "overflow", { overflow: true })).toThrow(
      /reached the maximum/,
    );
  });

  it("should allow upsert when collection is at max", () => {
    const store = getStructuredStore("test-agent");
    for (let i = 0; i < 10_000; i++) {
      store.store("full", `key-${i}`, { i });
    }
    // Updating an existing key should succeed
    expect(() => store.store("full", "key-0", { i: 999 })).not.toThrow();
  });

  it("should isolate stores by agentId", () => {
    const storeA = getStructuredStore("agent-a");
    const storeB = getStructuredStore("agent-b");

    storeA.store("notes", "x", { from: "a" });
    storeB.store("notes", "x", { from: "b" });

    const entriesA = storeA.query("notes");
    const entriesB = storeB.query("notes");

    expect(entriesA).toHaveLength(1);
    expect(entriesA[0]?.value).toEqual({ from: "a" });
    expect(entriesB).toHaveLength(1);
    expect(entriesB[0]?.value).toEqual({ from: "b" });
  });

  it("should return singleton for same agentId", () => {
    const store1 = getStructuredStore("same-agent");
    const store2 = getStructuredStore("same-agent");
    expect(store1).toBe(store2);
  });

  it("should return empty results for non-existent collection", () => {
    const store = getStructuredStore("test-agent");
    expect(store.query("nope")).toEqual([]);
    expect(store.list("nope")).toEqual([]);
  });

  it("should include updatedAt timestamp", () => {
    const store = getStructuredStore("test-agent");
    store.store("meta", "key1", { v: 1 });
    const entries = store.query("meta");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.updatedAt).toBeTruthy();
    // ISO string format
    expect(() => new Date(entries[0].updatedAt)).not.toThrow();
  });
});
