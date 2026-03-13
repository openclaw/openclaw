import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../test-utils/temp-dir.js";
import { createDedupeCache } from "./dedupe.js";
import {
  emitDiagnosticEvent,
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
} from "./diagnostic-events.js";
import { readSessionStoreJson5 } from "./state-migrations.fs.js";

describe("infra store", () => {
  describe("state migrations fs", () => {
    it("treats array session stores as invalid", async () => {
      await withTempDir("openclaw-session-store-", async (dir) => {
        const storePath = path.join(dir, "sessions.json");
        await fs.writeFile(storePath, "[]", "utf-8");

        const result = readSessionStoreJson5(storePath);
        expect(result.ok).toBe(false);
        expect(result.store).toEqual({});
      });
    });

    it("parses JSON5 object session stores", async () => {
      await withTempDir("openclaw-session-store-", async (dir) => {
        const storePath = path.join(dir, "sessions.json");
        await fs.writeFile(
          storePath,
          "{\n  // comment allowed in JSON5\n  main: { sessionId: 's1', updatedAt: 123 },\n}\n",
          "utf-8",
        );

        const result = readSessionStoreJson5(storePath);
        expect(result.ok).toBe(true);
        expect(result.store.main?.sessionId).toBe("s1");
        expect(result.store.main?.updatedAt).toBe(123);
      });
    });
  });

  describe("diagnostic-events", () => {
    it("emits monotonic seq", async () => {
      resetDiagnosticEventsForTest();
      const seqs: number[] = [];
      const stop = onDiagnosticEvent((evt) => seqs.push(evt.seq));

      emitDiagnosticEvent({
        type: "model.usage",
        usage: { total: 1 },
      });
      emitDiagnosticEvent({
        type: "model.usage",
        usage: { total: 2 },
      });

      stop();

      expect(seqs).toEqual([1, 2]);
    });

    it("emits message-flow events", async () => {
      resetDiagnosticEventsForTest();
      const types: string[] = [];
      const stop = onDiagnosticEvent((evt) => types.push(evt.type));

      emitDiagnosticEvent({
        type: "webhook.received",
        channel: "telegram",
        updateType: "telegram-post",
      });
      emitDiagnosticEvent({
        type: "message.queued",
        channel: "telegram",
        source: "telegram",
        queueDepth: 1,
      });
      emitDiagnosticEvent({
        type: "session.state",
        state: "processing",
        reason: "run_started",
      });

      stop();

      expect(types).toEqual(["webhook.received", "message.queued", "session.state"]);
    });
  });

  describe("createDedupeCache", () => {
    it("marks duplicates within TTL", () => {
      const cache = createDedupeCache({ ttlMs: 1000, maxSize: 10 });
      expect(cache.check("a", 100)).toBe(false);
      expect(cache.check("a", 500)).toBe(true);
    });

    it("expires entries after TTL", () => {
      const cache = createDedupeCache({ ttlMs: 1000, maxSize: 10 });
      expect(cache.check("a", 100)).toBe(false);
      expect(cache.check("a", 1501)).toBe(false);
    });

    it("evicts oldest entries when over max size", () => {
      const cache = createDedupeCache({ ttlMs: 10_000, maxSize: 2 });
      expect(cache.check("a", 100)).toBe(false);
      expect(cache.check("b", 200)).toBe(false);
      expect(cache.check("c", 300)).toBe(false);
      expect(cache.check("a", 400)).toBe(false);
    });

    it("prunes expired entries even when refreshed keys are older in insertion order", () => {
      const cache = createDedupeCache({ ttlMs: 100, maxSize: 10 });
      expect(cache.check("a", 0)).toBe(false);
      expect(cache.check("b", 50)).toBe(false);
      expect(cache.check("a", 120)).toBe(false);
      expect(cache.check("c", 200)).toBe(false);
      expect(cache.size()).toBe(2);
    });

    it("supports non-mutating existence checks via peek()", () => {
      const cache = createDedupeCache({ ttlMs: 1000, maxSize: 10 });
      expect(cache.peek("a", 100)).toBe(false);
      expect(cache.check("a", 100)).toBe(false);
      expect(cache.peek("a", 200)).toBe(true);
      expect(cache.peek("a", 1201)).toBe(false);
    });
  });
});
