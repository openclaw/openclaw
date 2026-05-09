import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadOpenRouterModelCapabilities } from "../../../agents/pi-embedded-runner/openrouter-model-capabilities.js";
import { getOpenRouterModelCapabilities } from "../../../agents/pi-embedded-runner/openrouter-model-capabilities.js";
import { closeOpenClawStateDatabaseForTest } from "../../../state/openclaw-state-db.js";
import { withStateDirEnv } from "../../../test-helpers/state-dir-env.js";
import {
  importLegacyOpenRouterModelCapabilitiesCacheToSqlite,
  legacyOpenRouterModelCapabilitiesCacheExists,
} from "./openrouter-model-capabilities.js";

async function writeLegacyOpenRouterCache(stateDir: string): Promise<string> {
  const cachePath = path.join(stateDir, "cache", "openrouter-models.json");
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(
    cachePath,
    `${JSON.stringify(
      {
        models: {
          "acme/legacy-json": {
            name: "Legacy JSON",
            input: ["text"],
            reasoning: false,
            contextWindow: 111_000,
            maxTokens: 22_000,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
            },
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return cachePath;
}

describe("legacy OpenRouter model capabilities migration", () => {
  it("imports legacy JSON cache into SQLite and removes the source", async () => {
    await withStateDirEnv("openclaw-doctor-openrouter-capabilities-", async ({ stateDir }) => {
      const cachePath = await writeLegacyOpenRouterCache(stateDir);

      expect(legacyOpenRouterModelCapabilitiesCacheExists()).toBe(true);
      expect(importLegacyOpenRouterModelCapabilitiesCacheToSqlite()).toEqual({
        imported: true,
        models: 1,
      });

      await expect(fs.stat(cachePath)).rejects.toMatchObject({ code: "ENOENT" });
      await loadOpenRouterModelCapabilities("acme/legacy-json");
      expect(getOpenRouterModelCapabilities("acme/legacy-json")).toMatchObject({
        name: "Legacy JSON",
        contextWindow: 111_000,
        maxTokens: 22_000,
      });
    });
    closeOpenClawStateDatabaseForTest();
  });

  it("skips when the legacy JSON cache is missing", async () => {
    await withStateDirEnv("openclaw-doctor-openrouter-capabilities-", async () => {
      expect(importLegacyOpenRouterModelCapabilitiesCacheToSqlite()).toEqual({
        imported: false,
        models: 0,
      });
      expect(legacyOpenRouterModelCapabilitiesCacheExists()).toBe(false);
    });
    closeOpenClawStateDatabaseForTest();
  });
});
