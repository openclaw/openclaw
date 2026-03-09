import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readConfigFileSnapshotForWrite } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.js";
import { withEnvAsync } from "../test-utils/env.js";
import { persistPluginConfigWrite } from "./config-write.js";

async function makeTempModularConfig(params?: { pluginsRaw?: string }): Promise<{
  rootDir: string;
  configPath: string;
  pluginsPath: string;
}> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-plugin-config-write-"));
  const configDir = path.join(rootDir, "config");
  await fs.mkdir(configDir, { recursive: true });
  const configPath = path.join(rootDir, "openclaw.json");
  const pluginsPath = path.join(configDir, "plugins.json5");
  await fs.writeFile(
    path.join(configDir, "env.json5"),
    JSON.stringify({ OPENAI_API_KEY: "${OPENAI_API_KEY}" }, null, 2),
    "utf-8",
  );
  await fs.writeFile(
    configPath,
    `{
  env: { $include: "./config/env.json5" },
  plugins: { $include: "./config/plugins.json5" }
}
`,
    "utf-8",
  );
  await fs.writeFile(
    pluginsPath,
    params?.pluginsRaw ??
      `{}
`,
    "utf-8",
  );
  return { rootDir, configPath, pluginsPath };
}

async function readJsonFile(filePath: string): Promise<unknown> {
  const raw = await fs.readFile(filePath, "utf-8");
  return JSON.parse(raw);
}

async function withConfigPath<T>(configPath: string, run: () => Promise<T>): Promise<T> {
  return await withEnvAsync(
    {
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_DISABLE_CONFIG_CACHE: "1",
      OPENAI_API_KEY: "sk-test",
    },
    run,
  );
}

describe("persistPluginConfigWrite", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("preserves root $include directives and writes plugin changes into the included file", async () => {
    const paths = await makeTempModularConfig();
    tempRoots.push(paths.rootDir);
    const nextConfig: OpenClawConfig = {
      plugins: {
        entries: {
          telegram: { enabled: true },
        },
      },
    };

    await withConfigPath(paths.configPath, async () => {
      const current = (await readConfigFileSnapshotForWrite()).snapshot.config;
      await persistPluginConfigWrite({
        ...current,
        ...nextConfig,
      });
    });

    const rootRaw = await fs.readFile(paths.configPath, "utf-8");
    expect(rootRaw).toContain('$include: "./config/plugins.json5"');
    expect(rootRaw).toContain('$include: "./config/env.json5"');
    expect(rootRaw).not.toContain('"telegram"');

    await expect(readJsonFile(paths.pluginsPath)).resolves.toEqual(nextConfig.plugins);
  });

  it("fails validation before mutating either config file", async () => {
    const paths = await makeTempModularConfig();
    tempRoots.push(paths.rootDir);
    const beforeRoot = await fs.readFile(paths.configPath, "utf-8");
    const beforePlugins = await fs.readFile(paths.pluginsPath, "utf-8");

    await withConfigPath(paths.configPath, async () => {
      const current = (await readConfigFileSnapshotForWrite()).snapshot.config;
      await expect(
        persistPluginConfigWrite({
          ...current,
          plugins: {
            enabled: "yes" as unknown as boolean,
          },
        }),
      ).rejects.toThrow(/plugins/i);
    });

    await expect(fs.readFile(paths.configPath, "utf-8")).resolves.toBe(beforeRoot);
    await expect(fs.readFile(paths.pluginsPath, "utf-8")).resolves.toBe(beforePlugins);
  });

  it("preserves the plugins include while updating other changed root keys", async () => {
    const paths = await makeTempModularConfig();
    tempRoots.push(paths.rootDir);

    await withConfigPath(paths.configPath, async () => {
      const current = (await readConfigFileSnapshotForWrite()).snapshot.config;
      await persistPluginConfigWrite({
        ...current,
        gateway: {
          port: 19001,
        },
        plugins: {
          entries: {
            telegram: { enabled: true },
          },
        },
      });
    });

    const rootRaw = await fs.readFile(paths.configPath, "utf-8");
    expect(rootRaw).toContain('"$include": "./config/plugins.json5"');
    expect(rootRaw).toContain('"$include": "./config/env.json5"');
    expect(rootRaw).toContain('"gateway"');
    expect(rootRaw).not.toContain('"telegram"');
    await expect(readJsonFile(paths.pluginsPath)).resolves.toEqual({
      entries: {
        telegram: { enabled: true },
      },
    });
  });
});
