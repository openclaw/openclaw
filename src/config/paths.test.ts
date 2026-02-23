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

    const resolvedHome = path.resolve("/srv/bot-home");
    expect(resolveStateDir(env)).toBe(path.join(resolvedHome, ".bot"));

    const candidates = resolveDefaultConfigCandidates(env);
    expect(candidates[0]).toBe(path.join(resolvedHome, ".bot", "bot.json"));
  });

  it("prefers BOT_HOME over HOME for default state/config locations", () => {
    const env = {
      BOT_HOME: "/srv/bot-home",
      HOME: "/home/other",
    } as NodeJS.ProcessEnv;

    const resolvedHome = path.resolve("/srv/bot-home");
    expect(resolveStateDir(env)).toBe(path.join(resolvedHome, ".bot"));

    const candidates = resolveDefaultConfigCandidates(env);
    expect(candidates[0]).toBe(path.join(resolvedHome, ".bot", "bot.json"));
  });

  it("returns single canonical config candidate", () => {
    const home = "/home/test";
    const resolvedHome = path.resolve(home);
    const candidates = resolveDefaultConfigCandidates({} as NodeJS.ProcessEnv, () => home);
    const expected = [path.join(resolvedHome, ".bot", "bot.json")];
    expect(candidates).toEqual(expected);
  });

  it("prefers ~/.bot when it exists", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "bot-state-"));
    try {
      const botDir = path.join(root, ".bot");
      await fs.mkdir(botDir, { recursive: true });
      const resolved = resolveStateDir({} as NodeJS.ProcessEnv, () => root);
      expect(resolved).toBe(botDir);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("CONFIG_PATH prefers existing config when present", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "bot-config-"));
    try {
      const botDir = path.join(root, ".bot");
      await fs.mkdir(botDir, { recursive: true });
      const configPath = path.join(botDir, "bot.json");
      await fs.writeFile(configPath, "{}", "utf-8");

      const resolved = resolveConfigPathCandidate({} as NodeJS.ProcessEnv, () => root);
      expect(resolved).toBe(configPath);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("respects state dir overrides when config is missing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "bot-config-override-"));
    try {
      const botDir = path.join(root, ".bot");
      await fs.mkdir(botDir, { recursive: true });
      const botConfig = path.join(botDir, "bot.json");
      await fs.writeFile(botConfig, "{}", "utf-8");

      const overrideDir = path.join(root, "override");
      const env = { BOT_STATE_DIR: overrideDir } as NodeJS.ProcessEnv;
      const resolved = resolveConfigPath(env, overrideDir, () => root);
      expect(resolved).toBe(path.join(overrideDir, "bot.json"));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
