import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempHome } from "./home-env.test-harness.js";
import {
  getRuntimeConfigSourceSnapshot,
  loadConfig,
  resetConfigRuntimeState,
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

  it("reloads when OPENCLAW_CONFIG_PATH changes after the module was imported", async () => {
    await withTempHome("openclaw-config-runtime-load-path-", async (home) => {
      const originalConfigPath = process.env.OPENCLAW_CONFIG_PATH;
      const primaryConfigPath = path.join(home, ".openclaw", "primary.json");
      const alternateConfigPath = path.join(home, ".openclaw", "alternate.json");

      await fs.mkdir(path.dirname(primaryConfigPath), { recursive: true });
      await fs.writeFile(
        primaryConfigPath,
        `${JSON.stringify({ gateway: { port: 18789 } }, null, 2)}\n`,
        "utf8",
      );
      await fs.writeFile(
        alternateConfigPath,
        `${JSON.stringify({ gateway: { port: 19003 } }, null, 2)}\n`,
        "utf8",
      );

      try {
        process.env.OPENCLAW_CONFIG_PATH = primaryConfigPath;
        expect(loadConfig().gateway?.port).toBe(18789);

        process.env.OPENCLAW_CONFIG_PATH = alternateConfigPath;
        expect(loadConfig().gateway?.port).toBe(19003);
      } finally {
        if (originalConfigPath === undefined) {
          delete process.env.OPENCLAW_CONFIG_PATH;
        } else {
          process.env.OPENCLAW_CONFIG_PATH = originalConfigPath;
        }
        resetRuntimeConfigState();
      }
    });
  });
});
