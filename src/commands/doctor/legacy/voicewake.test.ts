import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadVoiceWakeRoutingConfig } from "../../../infra/voicewake-routing.js";
import { defaultVoiceWakeTriggers, loadVoiceWakeConfig } from "../../../infra/voicewake.js";
import { withTempDir } from "../../../test-utils/temp-dir.js";
import {
  importLegacyVoiceWakeRoutingConfigFileToSqlite,
  legacyVoiceWakeRoutingConfigFileExists,
} from "./voicewake-routing.js";
import {
  importLegacyVoiceWakeConfigFileToSqlite,
  legacyVoiceWakeConfigFileExists,
} from "./voicewake.js";

async function writeSettingsJson(baseDir: string, fileName: string, value: unknown): Promise<void> {
  await fs.mkdir(path.join(baseDir, "settings"), { recursive: true });
  await fs.writeFile(path.join(baseDir, "settings", fileName), JSON.stringify(value), "utf-8");
}

describe("legacy voicewake migration", () => {
  it("imports legacy trigger config into SQLite and removes the source", async () => {
    await withTempDir("openclaw-doctor-voicewake-", async (baseDir) => {
      await writeSettingsJson(baseDir, "voicewake.json", {
        triggers: ["  wake ", "", 42, null],
        updatedAtMs: -1,
      });

      await expect(loadVoiceWakeConfig(baseDir)).resolves.toEqual({
        triggers: defaultVoiceWakeTriggers(),
        updatedAtMs: 0,
      });
      await expect(legacyVoiceWakeConfigFileExists(baseDir)).resolves.toBe(true);
      await expect(importLegacyVoiceWakeConfigFileToSqlite(baseDir)).resolves.toEqual({
        imported: true,
        triggers: 1,
      });
      await expect(loadVoiceWakeConfig(baseDir)).resolves.toEqual({
        triggers: ["wake"],
        updatedAtMs: 0,
      });
      await expect(legacyVoiceWakeConfigFileExists(baseDir)).resolves.toBe(false);
    });
  });

  it("imports legacy routing config into SQLite and removes the source", async () => {
    await withTempDir("openclaw-doctor-voicewake-routing-", async (baseDir) => {
      await writeSettingsJson(baseDir, "voicewake-routing.json", {
        defaultTarget: { mode: "current" },
        routes: [{ trigger: "  Hello   Bot  ", target: { agentId: "main" } }],
      });

      await expect(legacyVoiceWakeRoutingConfigFileExists(baseDir)).resolves.toBe(true);
      await expect(importLegacyVoiceWakeRoutingConfigFileToSqlite(baseDir)).resolves.toEqual({
        imported: true,
        routes: 1,
      });
      const loaded = await loadVoiceWakeRoutingConfig(baseDir);
      expect(loaded.routes).toEqual([{ trigger: "hello bot", target: { agentId: "main" } }]);
      await expect(legacyVoiceWakeRoutingConfigFileExists(baseDir)).resolves.toBe(false);
    });
  });

  it("skips missing legacy files", async () => {
    await withTempDir("openclaw-doctor-voicewake-", async (baseDir) => {
      await expect(importLegacyVoiceWakeConfigFileToSqlite(baseDir)).resolves.toEqual({
        imported: false,
        triggers: 0,
      });
      await expect(importLegacyVoiceWakeRoutingConfigFileToSqlite(baseDir)).resolves.toEqual({
        imported: false,
        routes: 0,
      });
    });
  });
});
