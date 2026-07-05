// Covers voice wake trigger defaults, sanitization, and persistence.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../test-utils/temp-dir.js";
import {
  defaultVoiceWakeTriggers,
  loadVoiceWakeConfig,
  setVoiceWakeTriggers,
} from "./voicewake.js";

describe("voicewake config", () => {
  it("returns defaults when missing", async () => {
    await withTempDir("openclaw-voicewake-", async (baseDir) => {
      await expect(loadVoiceWakeConfig(baseDir)).resolves.toEqual({
        triggers: defaultVoiceWakeTriggers(),
        updatedAtMs: 0,
      });
    });
  });

  it("sanitizes and persists triggers", async () => {
    await withTempDir("openclaw-voicewake-", async (baseDir) => {
      const saved = await setVoiceWakeTriggers(["  hi  ", "", "  there "], baseDir);
      expect(saved.triggers).toEqual(["hi", "there"]);
      expect(saved.updatedAtMs).toBeGreaterThan(0);

      await expect(loadVoiceWakeConfig(baseDir)).resolves.toEqual({
        triggers: ["hi", "there"],
        updatedAtMs: saved.updatedAtMs,
      });
    });
  });

<<<<<<< HEAD
  it("does not read retired JSON trigger files at runtime", async () => {
    await withTempDir("openclaw-voicewake-", async (baseDir) => {
=======
  it("falls back to defaults for empty or malformed persisted values", async () => {
    await withTempDir("openclaw-voicewake-", async (baseDir) => {
      const emptySaved = await setVoiceWakeTriggers(["", "   "], baseDir);
      expect(emptySaved.triggers).toEqual(defaultVoiceWakeTriggers());

>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
      await fs.mkdir(path.join(baseDir, "settings"), { recursive: true });
      await fs.writeFile(
        path.join(baseDir, "settings", "voicewake.json"),
        JSON.stringify({
          triggers: ["  wake ", "", 42, null],
          updatedAtMs: -1,
        }),
        "utf8",
      );

      await expect(loadVoiceWakeConfig(baseDir)).resolves.toEqual({
<<<<<<< HEAD
        triggers: defaultVoiceWakeTriggers(),
=======
        triggers: ["wake"],
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
        updatedAtMs: 0,
      });
    });
  });
<<<<<<< HEAD

  it("does not recreate the retired JSON trigger file", async () => {
    await withTempDir("openclaw-voicewake-", async (baseDir) => {
      await setVoiceWakeTriggers(["wake"], baseDir);
      await expect(fs.readFile(path.join(baseDir, "settings", "voicewake.json"))).rejects.toThrow(
        /ENOENT/u,
      );
    });
  });
=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
});
