import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { maybeMigratePluginsAllowForExtensions } from "./migrate-plugins-allow-extensions.js";

async function makeTempStateDir(pluginIds: string[]): Promise<{
  stateDir: string;
  cleanup: () => Promise<void>;
}> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-migrate-plugins-allow-"));
  for (const pluginId of pluginIds) {
    await fs.mkdir(path.join(stateDir, "extensions", pluginId, "dist"), { recursive: true });
    await fs.writeFile(path.join(stateDir, "extensions", pluginId, "package.json"), "{}");
  }
  return {
    stateDir,
    cleanup: async () => {
      await fs.rm(stateDir, { recursive: true, force: true });
    },
  };
}

describe("maybeMigratePluginsAllowForExtensions", () => {
  it("does nothing when no extension directories exist", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-migrate-plugins-allow-"));
    try {
      const cfg = {};
      const result = await maybeMigratePluginsAllowForExtensions({ cfg, stateDir });
      expect(result.changes).toEqual([]);
      expect(result.config).toEqual(cfg);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("seeds plugins.allow from discovered extensions when allowlist is unset", async () => {
    const { stateDir, cleanup } = await makeTempStateDir(["brave", "slack"]);
    try {
      const cfg = {};
      const result = await maybeMigratePluginsAllowForExtensions({ cfg, stateDir });
      expect(result.changes).toEqual([
        'Set plugins.allow to ["brave", "slack"] because extension artifacts exist but no allowlist was configured.',
      ]);
      expect(result.config.plugins?.allow).toEqual(["brave", "slack"]);
    } finally {
      await cleanup();
    }
  });

  it("preserves an existing plugins.allow", async () => {
    const { stateDir, cleanup } = await makeTempStateDir(["brave"]);
    try {
      const cfg = { plugins: { allow: ["existing"] } };
      const result = await maybeMigratePluginsAllowForExtensions({ cfg, stateDir });
      expect(result.changes).toEqual([]);
      expect(result.config.plugins?.allow).toEqual(["existing"]);
    } finally {
      await cleanup();
    }
  });

  it("does not overwrite an explicit empty plugins.allow", async () => {
    const { stateDir, cleanup } = await makeTempStateDir(["brave"]);
    try {
      const cfg = { plugins: { allow: [] } };
      const result = await maybeMigratePluginsAllowForExtensions({ cfg, stateDir });
      expect(result.changes).toEqual([]);
      expect(result.config.plugins?.allow).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it("excludes denied plugins and explicitly disabled entries", async () => {
    const { stateDir, cleanup } = await makeTempStateDir(["brave", "slack", "trello"]);
    try {
      const cfg = {
        plugins: {
          deny: ["slack"],
          entries: {
            trello: { enabled: false },
          },
        },
      };
      const result = await maybeMigratePluginsAllowForExtensions({ cfg, stateDir });
      expect(result.changes).toEqual([
        'Set plugins.allow to ["brave"] because extension artifacts exist but no allowlist was configured.',
      ]);
      expect(result.config.plugins?.allow).toEqual(["brave"]);
    } finally {
      await cleanup();
    }
  });

  it("ignores generated install debris", async () => {
    const { stateDir, cleanup } = await makeTempStateDir(["brave"]);
    try {
      await fs.mkdir(path.join(stateDir, "extensions", "node_modules"), { recursive: true });
      await fs.mkdir(path.join(stateDir, "extensions", "brave.bak"), { recursive: true });
      const cfg = {};
      const result = await maybeMigratePluginsAllowForExtensions({ cfg, stateDir });
      expect(result.config.plugins?.allow).toEqual(["brave"]);
    } finally {
      await cleanup();
    }
  });
});
