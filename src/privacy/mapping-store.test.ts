import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PrivacyMappingStore } from "./mapping-store.js";
import type { PrivacyMapping } from "./types.js";

function createTempStore(): { store: PrivacyMappingStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "privacy-test-"));
  const storePath = join(dir, "test-mappings.enc");
  const store = new PrivacyMappingStore({ storePath, salt: "test-salt" });
  return { store, dir };
}

function makeMappingData(id: string, sessionId: string, createdAt?: number): PrivacyMapping {
  return {
    id,
    sessionId,
    original: `original-${id}`,
    replacement: `replacement-${id}`,
    type: "email",
    riskLevel: "medium",
    createdAt: createdAt ?? Date.now(),
  };
}

describe("PrivacyMappingStore", () => {
  const cleanups: string[] = [];

  afterEach(() => {
    for (const dir of cleanups) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    cleanups.length = 0;
  });

  describe("save and load", () => {
    it("round-trips mappings through encrypted storage", () => {
      const { store, dir } = createTempStore();
      cleanups.push(dir);

      const mappings = [makeMappingData("1", "session-a"), makeMappingData("2", "session-a")];

      store.save(mappings);
      const loaded = store.load();

      expect(loaded).toHaveLength(2);
      expect(loaded[0].original).toBe("original-1");
      expect(loaded[1].original).toBe("original-2");
    });

    it("returns empty array when file does not exist", () => {
      const { store, dir } = createTempStore();
      cleanups.push(dir);
      expect(store.load()).toEqual([]);
    });
  });

  describe("append", () => {
    it("appends new mappings without duplicates", () => {
      const { store, dir } = createTempStore();
      cleanups.push(dir);

      store.save([makeMappingData("1", "s1")]);
      store.append([makeMappingData("1", "s1"), makeMappingData("2", "s1")]);

      const loaded = store.load();
      expect(loaded).toHaveLength(2);
    });
  });

  describe("loadSession", () => {
    it("filters mappings by session ID", () => {
      const { store, dir } = createTempStore();
      cleanups.push(dir);

      store.save([
        makeMappingData("1", "session-a"),
        makeMappingData("2", "session-b"),
        makeMappingData("3", "session-a"),
      ]);

      const sessionA = store.loadSession("session-a");
      expect(sessionA).toHaveLength(2);
      expect(sessionA.every((m) => m.sessionId === "session-a")).toBe(true);
    });
  });

  describe("cleanup", () => {
    it("removes expired mappings", () => {
      const { store, dir } = createTempStore();
      cleanups.push(dir);

      const oldTime = Date.now() - 100_000;
      store.save([makeMappingData("old", "s1", oldTime), makeMappingData("new", "s1", Date.now())]);

      const removed = store.cleanup(50_000);
      expect(removed).toBe(1);

      const remaining = store.load();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe("new");
    });
  });

  describe("clearSession", () => {
    it("removes all mappings for a session", () => {
      const { store, dir } = createTempStore();
      cleanups.push(dir);

      store.save([makeMappingData("1", "session-a"), makeMappingData("2", "session-b")]);

      store.clearSession("session-a");
      const remaining = store.load();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].sessionId).toBe("session-b");
    });
  });

  describe("destroy", () => {
    it("deletes the store file", () => {
      const { store, dir } = createTempStore();
      cleanups.push(dir);

      store.save([makeMappingData("1", "s1")]);
      store.destroy();
      expect(store.load()).toEqual([]);
    });
  });

  describe("encryption", () => {
    it("cannot decrypt with wrong salt", () => {
      const dir = mkdtempSync(join(tmpdir(), "privacy-test-"));
      cleanups.push(dir);

      const storePath = join(dir, "enc-test.enc");
      const store1 = new PrivacyMappingStore({ storePath, salt: "salt-1" });
      store1.save([makeMappingData("1", "s1")]);

      const store2 = new PrivacyMappingStore({ storePath, salt: "salt-2" });
      // Wrong salt should return empty (graceful failure).
      expect(store2.load()).toEqual([]);
    });

    it("stores master key next to a custom storePath", () => {
      const dir = mkdtempSync(join(tmpdir(), "privacy-test-"));
      cleanups.push(dir);

      const storePath = join(dir, "nested", "enc-test.enc");
      const store = new PrivacyMappingStore({ storePath, salt: "salt-1" });
      store.save([makeMappingData("1", "s1")]);

      expect(existsSync(join(dir, "nested", "master.key"))).toBe(true);
    });
  });
});
