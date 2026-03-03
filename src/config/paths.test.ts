import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveDefaultConfigCandidates,
  resolveConfigPathCandidate,
  resolveConfigPath,
  resolveOAuthDir,
  resolveOAuthPath,
  resolveStateDir,
} from "./paths.js";

describe("oauth paths", () => {
  it("prefers BOT_OAUTH_DIR over BOT_STATE_DIR", () => {
    const env = {
      BOT_OAUTH_DIR: "/custom/oauth",
      BOT_STATE_DIR: "/custom/state",
    } as NodeJS.ProcessEnv;

    expect(resolveOAuthDir(env, "/custom/state")).toBe(path.resolve("/custom/oauth"));
    expect(resolveOAuthPath(env, "/custom/state")).toBe(
      path.join(path.resolve("/custom/oauth"), "oauth.json"),
    );
  });

  it("derives oauth path from BOT_STATE_DIR when unset", () => {
    const env = {
      BOT_STATE_DIR: "/custom/state",
    } as NodeJS.ProcessEnv;

    expect(resolveOAuthDir(env, "/custom/state")).toBe(path.join("/custom/state", "credentials"));
    expect(resolveOAuthPath(env, "/custom/state")).toBe(
      path.join("/custom/state", "credentials", "oauth.json"),
    );
  });
});

describe("state + config path candidates", () => {
  async function withTempRoot(prefix: string, run: (root: string) => Promise<void>): Promise<void> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    try {
      await run(root);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }

  function expectBotHomeDefaults(env: NodeJS.ProcessEnv): void {
    const configuredHome = env.BOT_HOME;
    if (!configuredHome) {
      throw new Error("BOT_HOME must be set for this assertion helper");
    }
    const resolvedHome = path.resolve(configuredHome);
    expect(resolveStateDir(env)).toBe(path.join(resolvedHome, ".bot"));

    const candidates = resolveDefaultConfigCandidates(env);
    expect(candidates[0]).toBe(path.join(resolvedHome, ".bot", "bot.json"));
  }

  it("uses BOT_STATE_DIR when set", () => {
    const env = {
      BOT_STATE_DIR: "/new/state",
    } as NodeJS.ProcessEnv;

    expect(resolveStateDir(env, () => "/home/test")).toBe(path.resolve("/new/state"));
  });

  it("uses BOT_HOME for default state/config locations", () => {
    const env = {
      BOT_HOME: "/srv/bot-home",
    } as NodeJS.ProcessEnv;
    expectBotHomeDefaults(env);
  });

  it("prefers BOT_HOME over HOME for default state/config locations", () => {
    const env = {
      BOT_HOME: "/srv/bot-home",
      HOME: "/home/other",
    } as NodeJS.ProcessEnv;
    expectBotHomeDefaults(env);
  });

  it("orders default config candidates in a stable order", () => {
    const home = "/home/test";
    const resolvedHome = path.resolve(home);
    const candidates = resolveDefaultConfigCandidates({} as NodeJS.ProcessEnv, () => home);
    const expected = [
      path.join(resolvedHome, ".bot", "bot.json"),
      path.join(resolvedHome, ".bot", "clawdbot.json"),
      path.join(resolvedHome, ".bot", "moldbot.json"),
      path.join(resolvedHome, ".bot", "moltbot.json"),
      path.join(resolvedHome, ".clawdbot", "bot.json"),
      path.join(resolvedHome, ".clawdbot", "clawdbot.json"),
      path.join(resolvedHome, ".clawdbot", "moldbot.json"),
      path.join(resolvedHome, ".clawdbot", "moltbot.json"),
      path.join(resolvedHome, ".moldbot", "bot.json"),
      path.join(resolvedHome, ".moldbot", "clawdbot.json"),
      path.join(resolvedHome, ".moldbot", "moldbot.json"),
      path.join(resolvedHome, ".moldbot", "moltbot.json"),
      path.join(resolvedHome, ".moltbot", "bot.json"),
      path.join(resolvedHome, ".moltbot", "clawdbot.json"),
      path.join(resolvedHome, ".moltbot", "moldbot.json"),
      path.join(resolvedHome, ".moltbot", "moltbot.json"),
    ];
    expect(candidates).toEqual(expected);
  });

  it("prefers ~/.bot when it exists and legacy dir is missing", async () => {
    await withTempRoot("bot-state-", async (root) => {
      const newDir = path.join(root, ".bot");
      await fs.mkdir(newDir, { recursive: true });
      const resolved = resolveStateDir({} as NodeJS.ProcessEnv, () => root);
      expect(resolved).toBe(newDir);
    });
  });

  it("falls back to existing legacy state dir when ~/.bot is missing", async () => {
    await withTempRoot("bot-state-legacy-", async (root) => {
      const legacyDir = path.join(root, ".clawdbot");
      await fs.mkdir(legacyDir, { recursive: true });
      const resolved = resolveStateDir({} as NodeJS.ProcessEnv, () => root);
      expect(resolved).toBe(legacyDir);
    });
  });

  it("CONFIG_PATH prefers existing config when present", async () => {
    await withTempRoot("bot-config-", async (root) => {
      const legacyDir = path.join(root, ".bot");
      await fs.mkdir(legacyDir, { recursive: true });
      const legacyPath = path.join(legacyDir, "bot.json");
      await fs.writeFile(legacyPath, "{}", "utf-8");

      const resolved = resolveConfigPathCandidate({} as NodeJS.ProcessEnv, () => root);
      expect(resolved).toBe(legacyPath);
    });
  });

  it("respects state dir overrides when config is missing", async () => {
    await withTempRoot("bot-config-override-", async (root) => {
      const legacyDir = path.join(root, ".bot");
      await fs.mkdir(legacyDir, { recursive: true });
      const legacyConfig = path.join(legacyDir, "bot.json");
      await fs.writeFile(legacyConfig, "{}", "utf-8");

      const overrideDir = path.join(root, "override");
      const env = { BOT_STATE_DIR: overrideDir } as NodeJS.ProcessEnv;
      const resolved = resolveConfigPath(env, overrideDir, () => root);
      expect(resolved).toBe(path.join(overrideDir, "bot.json"));
    });
  });
});
