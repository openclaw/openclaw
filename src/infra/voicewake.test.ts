// Covers voice wake trigger defaults, sanitization, and persistence.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import {
  defaultVoiceWakeTriggers,
  loadVoiceWakeConfig,
  setVoiceWakeTriggers,
} from "./voicewake.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    await closeStateDatabaseForTest();
    cleanup();
  });
});

describe("voicewake config", () => {
  it("returns defaults when missing", async () => {
    const baseDir = tempDirs.make("openclaw-voicewake-");
    await expect(loadVoiceWakeConfig(baseDir)).resolves.toEqual({
      triggers: defaultVoiceWakeTriggers(),
      updatedAtMs: 0,
    });
  });

  it("sanitizes and persists triggers", async () => {
    const baseDir = tempDirs.make("openclaw-voicewake-");
    const saved = await setVoiceWakeTriggers(["  hi  ", "", "  there "], baseDir);
    expect(saved.triggers).toEqual(["hi", "there"]);
    expect(saved.updatedAtMs).toBeGreaterThan(0);

    await expect(loadVoiceWakeConfig(baseDir)).resolves.toEqual(saved);
    const replacement = await setVoiceWakeTriggers(["wake"], baseDir);
    expect(replacement.triggers).toEqual(["wake"]);
    await expect(loadVoiceWakeConfig(baseDir)).resolves.toEqual(replacement);
  });

  it("does not read retired JSON trigger files at runtime", async () => {
    const baseDir = tempDirs.make("openclaw-voicewake-");
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

  it("does not recreate the retired JSON trigger file", async () => {
    const baseDir = tempDirs.make("openclaw-voicewake-");
    await setVoiceWakeTriggers(["wake"], baseDir);
    await expect(fs.readFile(path.join(baseDir, "settings", "voicewake.json"))).rejects.toThrow(
      /ENOENT/u,
    );
  });
});
