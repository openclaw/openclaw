// Covers voice wake trigger defaults, sanitization, and persistence.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import {
  defaultVoiceWakeTriggers,
  loadVoiceWakeConfig,
  setVoiceWakeTriggers,
} from "./voicewake.js";

async function withVoiceWakeState(run: (baseDir: string) => Promise<void>): Promise<void> {
  const lifetime = createFixtureLifetime();
  onTestFinished(() => lifetime.cleanup());
  const baseDir = lifetime.createTempDir("openclaw-voicewake-");
  try {
    await lifetime.run(async () => {
      try {
        await run(baseDir);
      } finally {
        await lifetime.verifyCleanup(closeStateDatabaseForTest);
      }
    });
  } finally {
    await lifetime.cleanup();
  }
}

describe("voicewake config", () => {
  it("returns defaults when missing", async () => {
    await withVoiceWakeState(async (baseDir) => {
      await expect(loadVoiceWakeConfig(baseDir)).resolves.toEqual({
        triggers: defaultVoiceWakeTriggers(),
        updatedAtMs: 0,
      });
    });
  });

  it("sanitizes and persists triggers", async () => {
    await withVoiceWakeState(async (baseDir) => {
      const saved = await setVoiceWakeTriggers(["  hi  ", "", "  there "], baseDir);
      expect(saved.triggers).toEqual(["hi", "there"]);
      expect(saved.updatedAtMs).toBeGreaterThan(0);

      await expect(loadVoiceWakeConfig(baseDir)).resolves.toEqual({
        triggers: ["hi", "there"],
        updatedAtMs: saved.updatedAtMs,
      });
    });
  });

  it("does not read retired JSON trigger files at runtime", async () => {
    await withVoiceWakeState(async (baseDir) => {
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
        triggers: defaultVoiceWakeTriggers(),
        updatedAtMs: 0,
      });
    });
  });

  it("does not recreate the retired JSON trigger file", async () => {
    await withVoiceWakeState(async (baseDir) => {
      await setVoiceWakeTriggers(["wake"], baseDir);
      await expect(fs.readFile(path.join(baseDir, "settings", "voicewake.json"))).rejects.toThrow(
        /ENOENT/u,
      );
    });
  });
});
