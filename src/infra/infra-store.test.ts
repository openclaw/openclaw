import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getChannelActivity,
  recordChannelActivity,
  resetChannelActivityForTest,
} from "./channel-activity.js";
import { createDedupeCache } from "./dedupe.js";
import {
  emitDiagnosticEvent,
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
} from "./diagnostic-events.js";
import { readSessionStoreJson5 } from "./state-migrations.fs.js";
import {
  defaultVoiceWakeTriggers,
  loadVoiceWakeConfig,
  setVoiceWakeTriggers,
} from "./voicewake.js";

describe("infra store", () => {
  describe("state migrations fs", () => {
    it("treats array session stores as invalid", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-store-"));
      const storePath = path.join(dir, "sessions.json");
      await fs.writeFile(storePath, "[]", "utf-8");

      const result = readSessionStoreJson5(storePath);
      expect(result.ok).toBe(false);
      expect(result.store).toEqual({});
    });
  });

  describe("voicewake store", () => {
    it("returns defaults when missing", async () => {
      const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-voicewake-"));
      const cfg = await loadVoiceWakeConfig(baseDir);
      expect(cfg.triggers).toEqual(defaultVoiceWakeTriggers());
      expect(cfg.updatedAtMs).toBe(0);
    });

    it("sanitizes and persists triggers", async () => {
      const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-voicewake-"));
      const saved = await setVoiceWakeTriggers(["  hi  ", "", "  there "], baseDir);
      expect(saved.triggers).toEqual(["hi", "there"]);
      expect(saved.updatedAtMs).toBeGreaterThan(0);

      const loaded = await loadVoiceWakeConfig(baseDir);
      expect(loaded.triggers).toEqual(["hi", "there"]);
      expect(loaded.updatedAtMs).toBeGreaterThan(0);
    });

    it("falls back to defaults when triggers empty", async () => {
      const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-voicewake-"));
      const saved = await setVoiceWakeTriggers(["", "   "], baseDir);
      expect(saved.triggers).toEqual(defaultVoiceWakeTriggers());
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

  describe("channel activity", () => {
    beforeEach(() => {
      resetChannelActivityForTest();
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-08T00:00:00Z"));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("records inbound/outbound separately", () => {
      recordChannelActivity({ channel: "telegram", direction: "inbound" });
      vi.advanceTimersByTime(1000);
      recordChannelActivity({ channel: "telegram", direction: "outbound" });
      const res = getChannelActivity({ channel: "telegram" });
      expect(res.inboundAt).toBe(1767830400000);
      expect(res.outboundAt).toBe(1767830401000);
    });

    it("isolates accounts", () => {
      recordChannelActivity({
        channel: "whatsapp",
        accountId: "a",
        direction: "inbound",
        at: 1,
      });
      recordChannelActivity({
        channel: "whatsapp",
        accountId: "b",
        direction: "inbound",
        at: 2,
      });
      expect(getChannelActivity({ channel: "whatsapp", accountId: "a" })).toEqual({
        inboundAt: 1,
        outboundAt: null,
      });
      expect(getChannelActivity({ channel: "whatsapp", accountId: "b" })).toEqual({
        inboundAt: 2,
        outboundAt: null,
      });
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
  });
});
