import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withTempHome } from "./home-env.test-harness.js";
import {
  getRuntimeConfigSourceSnapshot,
  loadConfig,
  resetConfigRuntimeState,
  setRuntimeConfigSnapshot,
  setRuntimeConfigSnapshotRefreshHandler,
  writeConfigFile,
} from "./io.js";
import type { OpenClawConfig } from "./types.js";

function resetRuntimeConfigState(): void {
  setRuntimeConfigSnapshotRefreshHandler(null);
  resetConfigRuntimeState();
}

async function writeConfig(home: string, config: OpenClawConfig): Promise<string> {
  const configPath = path.join(home, ".openclaw", "openclaw.json");
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return configPath;
}

describe("loadConfig runtime snapshot pinning", () => {
  afterEach(() => {
    delete process.env.OPENCLAW_CONFIG_CACHE_MS;
    delete process.env.OPENCLAW_DISABLE_CONFIG_CACHE;
  });

  it("prefers runtime snapshot over OPENCLAW_CONFIG_CACHE_MS parse cache", async () => {
    await withTempHome("openclaw-config-runtime-load-cache-", async (home) => {
      const configPath = await writeConfig(home, { gateway: { port: 18789 } });
      try {
        process.env.OPENCLAW_CONFIG_CACHE_MS = "60000";
        resetRuntimeConfigState();
        setRuntimeConfigSnapshot({ gateway: { port: 42424 } });
        await fs.writeFile(configPath, "{ not valid json", "utf8");
        expect(loadConfig().gateway?.port).toBe(42424);
      } finally {
        resetRuntimeConfigState();
      }
    });
  });

  it("pins the first successful load in memory until the snapshot is cleared", async () => {
    await withTempHome("openclaw-config-runtime-load-pin-", async (home) => {
      await writeConfig(home, { gateway: { port: 18789 } });

      try {
        expect(loadConfig().gateway?.port).toBe(18789);
        expect(getRuntimeConfigSourceSnapshot()).toBeNull();

        await writeConfig(home, { gateway: { port: 19001 } });

        expect(loadConfig().gateway?.port).toBe(18789);

        resetRuntimeConfigState();
        expect(loadConfig().gateway?.port).toBe(19001);
      } finally {
        resetRuntimeConfigState();
      }
    });
  });

  it("refreshes a plain runtime snapshot after writes without falling back to disk reads", async () => {
    await withTempHome("openclaw-config-runtime-load-write-", async (home) => {
      await writeConfig(home, { gateway: { port: 18789 } });

      try {
        expect(loadConfig().gateway?.port).toBe(18789);

        await writeConfigFile({
          ...loadConfig(),
          gateway: { port: 19002 },
        });

        expect(loadConfig().gateway?.port).toBe(19002);

        await writeConfig(home, { gateway: { port: 19999 } });
        expect(loadConfig().gateway?.port).toBe(19002);
      } finally {
        resetRuntimeConfigState();
      }
    });
  });
});
