import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { withTempDir } from "../test-utils/temp-dir.js";
import { createDedupeCache } from "./dedupe.js";
import { readSessionStoreJson5 } from "./state-migrations.fs.js";
import { loadVoiceWakeRoutingConfig } from "./voicewake-routing.js";
import { defaultVoiceWakeTriggers, setVoiceWakeTriggers } from "./voicewake.js";

it.each([true, false])("reads JSON5, preserving bytes (valid UTF-8: %s)", async (valid) => {
  await withTempDir("openclaw-session-store-", async (dir) => {
    const storePath = path.join(dir, "sessions.json");
    const bytes = Buffer.from("// JSON5 comment\n{main:{sessionId:'s1', updatedAt:123},}");
    if (!valid) {
      bytes[bytes.indexOf("s1")] = 0xff;
    }
    await fs.writeFile(storePath, bytes);
    expect(readSessionStoreJson5(storePath)).toEqual({
      ok: valid,
      store: valid ? { main: { sessionId: "s1", updatedAt: 123 } } : {},
    });
    expect(await fs.readFile(storePath)).toEqual(bytes);
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

it("supports non-mutating existence checks via peek()", () => {
  const cache = createDedupeCache({ ttlMs: 1000, maxSize: 10 });
  expect(cache.peek("a", 100)).toBe(false);
  expect(cache.check("a", 100)).toBe(false);
  expect(cache.peek("a", 200)).toBe(true);
  expect(cache.peek("a", 1201)).toBe(false);
});
