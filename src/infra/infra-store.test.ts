import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../test-utils/temp-dir.js";
import { createDedupeCache } from "./dedupe.js";
import { readSessionStoreJson5 } from "./state-migrations.fs.js";
import { loadVoiceWakeRoutingConfig, resolveVoiceWakeRouteByTrigger } from "./voicewake-routing.js";
import { defaultVoiceWakeTriggers, setVoiceWakeTriggers } from "./voicewake.js";

describe("infra store", () => {
  it("refuses malformed UTF-8 without exposing replacement characters as session entries", async () => {
    await withTempDir("openclaw-session-store-", async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const bytes = Buffer.from('{main:{sessionId:"damaged"}}');
      bytes[bytes.indexOf("damaged")] = 0xff;
      await fs.writeFile(storePath, bytes);
      expect(readSessionStoreJson5(storePath)).toEqual({ store: {}, ok: false });
      expect(await fs.readFile(storePath)).toEqual(bytes);
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

      expect(readSessionStoreJson5(storePath)).toMatchObject({
        ok: true,
        store: { main: { sessionId: "s1", updatedAt: 123 } },
      });
    });
  });

  it("returns voicewake routing defaults when its store is missing", async () => {
    await withTempDir("openclaw-voicewake-routing-", async (baseDir) => {
      expect(await loadVoiceWakeRoutingConfig(baseDir)).toStrictEqual({
        version: 1,
        defaultTarget: { mode: "current" },
        routes: [],
        updatedAtMs: 0,
      });
    });
  });

  it("falls back to defaults when triggers empty", async () => {
    await withTempDir("openclaw-voicewake-", async (baseDir) => {
      const saved = await setVoiceWakeTriggers(["", "   "], baseDir);
      expect(saved.triggers).toEqual(defaultVoiceWakeTriggers());
    });
  });

  it("resolves routes by normalized trigger", () => {
    expect(
      resolveVoiceWakeRouteByTrigger({
        trigger: "  HELLO   BOT ",
        config: {
          version: 1,
          defaultTarget: { mode: "current" },
          routes: [{ trigger: "hello bot", target: { sessionKey: "agent:main:main" } }],
          updatedAtMs: 0,
        },
      }),
    ).toEqual({ sessionKey: "agent:main:main" });
  });

  it("prunes expired entries even when refreshed keys are older in insertion order", () => {
    const cache = createDedupeCache({ ttlMs: 100, maxSize: 10 });
    expect(cache.check("a", 0)).toBe(false);
    expect(cache.check("b", 50)).toBe(false);
    expect(cache.check("a", 120)).toBe(false);
    expect(cache.check("c", 200)).toBe(false);
    expect(cache.size()).toBe(2);
  });

  it("bounds non-finite ttl and max size options", () => {
    const cache = createDedupeCache({ ttlMs: Number.NaN, maxSize: Number.NaN });

    expect(cache.check("a", 100)).toBe(false);
    expect(cache.peek("a", 100)).toBe(false);
    expect(cache.size()).toBe(0);
  });

  it("supports non-mutating existence checks via peek()", () => {
    const cache = createDedupeCache({ ttlMs: 1000, maxSize: 10 });
    expect(cache.peek("a", 100)).toBe(false);
    expect(cache.check("a", 100)).toBe(false);
    expect(cache.peek("a", 200)).toBe(true);
    expect(cache.peek("a", 1201)).toBe(false);
  });
});
