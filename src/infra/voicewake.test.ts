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

  it("falls back to defaults for empty or malformed persisted values", async () => {
    await withTempDir("openclaw-voicewake-", async (baseDir) => {
      const emptySaved = await setVoiceWakeTriggers(["", "   "], baseDir);
      expect(emptySaved.triggers).toEqual(defaultVoiceWakeTriggers());
    });
  });
});
