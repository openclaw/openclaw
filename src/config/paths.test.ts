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
  it("prefers SMART_AGENT_NEO_OAUTH_DIR over SMART_AGENT_NEO_STATE_DIR", () => {
    const env = {
      SMART_AGENT_NEO_OAUTH_DIR: "/custom/oauth",
      SMART_AGENT_NEO_STATE_DIR: "/custom/state",
    } as NodeJS.ProcessEnv;

    expect(resolveOAuthDir(env, "/custom/state")).toBe(path.resolve("/custom/oauth"));
    expect(resolveOAuthPath(env, "/custom/state")).toBe(
      path.join(path.resolve("/custom/oauth"), "oauth.json"),
    );
  });

  it("derives oauth path from SMART_AGENT_NEO_STATE_DIR when unset", () => {
    const env = {
      SMART_AGENT_NEO_STATE_DIR: "/custom/state",
    } as NodeJS.ProcessEnv;

    expect(resolveOAuthDir(env, "/custom/state")).toBe(path.join("/custom/state", "credentials"));
    expect(resolveOAuthPath(env, "/custom/state")).toBe(
      path.join("/custom/state", "credentials", "oauth.json"),
    );
  });
});

describe("state + config path candidates", () => {
  it("uses SMART_AGENT_NEO_STATE_DIR when set", () => {
    const env = {
      SMART_AGENT_NEO_STATE_DIR: "/new/state",
    } as NodeJS.ProcessEnv;

    expect(resolveStateDir(env, () => "/home/test")).toBe(path.resolve("/new/state"));
  });

  it("uses SMART_AGENT_NEO_HOME for default state/config locations", () => {
    const env = {
      SMART_AGENT_NEO_HOME: "/srv/smart-agent-neo-home",
    } as NodeJS.ProcessEnv;

    const resolvedHome = path.resolve("/srv/smart-agent-neo-home");
    expect(resolveStateDir(env)).toBe(path.join(resolvedHome, ".smart-agent-neo"));

    const candidates = resolveDefaultConfigCandidates(env);
    expect(candidates[0]).toBe(path.join(resolvedHome, ".smart-agent-neo", "smart-agent-neo.json"));
  });

  it("prefers SMART_AGENT_NEO_HOME over HOME for default state/config locations", () => {
    const env = {
      SMART_AGENT_NEO_HOME: "/srv/smart-agent-neo-home",
      HOME: "/home/other",
    } as NodeJS.ProcessEnv;

    const resolvedHome = path.resolve("/srv/smart-agent-neo-home");
    expect(resolveStateDir(env)).toBe(path.join(resolvedHome, ".smart-agent-neo"));

    const candidates = resolveDefaultConfigCandidates(env);
    expect(candidates[0]).toBe(path.join(resolvedHome, ".smart-agent-neo", "smart-agent-neo.json"));
  });

  it("orders default config candidates in a stable order", () => {
    const home = "/home/test";
    const resolvedHome = path.resolve(home);
    const candidates = resolveDefaultConfigCandidates({} as NodeJS.ProcessEnv, () => home);
    const expected = [
      path.join(resolvedHome, ".smart-agent-neo", "smart-agent-neo.json"),
      path.join(resolvedHome, ".smart-agent-neo", "neobot.json"),
      path.join(resolvedHome, ".smart-agent-neo", "moldbot.json"),
      path.join(resolvedHome, ".smart-agent-neo", "neobot.json"),
      path.join(resolvedHome, ".neobot", "smart-agent-neo.json"),
      path.join(resolvedHome, ".neobot", "neobot.json"),
      path.join(resolvedHome, ".neobot", "moldbot.json"),
      path.join(resolvedHome, ".neobot", "neobot.json"),
      path.join(resolvedHome, ".moldbot", "smart-agent-neo.json"),
      path.join(resolvedHome, ".moldbot", "neobot.json"),
      path.join(resolvedHome, ".moldbot", "moldbot.json"),
      path.join(resolvedHome, ".moldbot", "neobot.json"),
      path.join(resolvedHome, ".neobot", "smart-agent-neo.json"),
      path.join(resolvedHome, ".neobot", "neobot.json"),
      path.join(resolvedHome, ".neobot", "moldbot.json"),
      path.join(resolvedHome, ".neobot", "neobot.json"),
    ];
    expect(candidates).toEqual(expected);
  });

  it("prefers ~/.smart-agent-neo when it exists and legacy dir is missing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "smart-agent-neo-state-"));
    try {
      const newDir = path.join(root, ".smart-agent-neo");
      await fs.mkdir(newDir, { recursive: true });
      const resolved = resolveStateDir({} as NodeJS.ProcessEnv, () => root);
      expect(resolved).toBe(newDir);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("CONFIG_PATH prefers existing config when present", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "smart-agent-neo-config-"));
    try {
      const legacyDir = path.join(root, ".smart-agent-neo");
      await fs.mkdir(legacyDir, { recursive: true });
      const legacyPath = path.join(legacyDir, "smart-agent-neo.json");
      await fs.writeFile(legacyPath, "{}", "utf-8");

      const resolved = resolveConfigPathCandidate({} as NodeJS.ProcessEnv, () => root);
      expect(resolved).toBe(legacyPath);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("respects state dir overrides when config is missing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "smart-agent-neo-config-override-"));
    try {
      const legacyDir = path.join(root, ".smart-agent-neo");
      await fs.mkdir(legacyDir, { recursive: true });
      const legacyConfig = path.join(legacyDir, "smart-agent-neo.json");
      await fs.writeFile(legacyConfig, "{}", "utf-8");

      const overrideDir = path.join(root, "override");
      const env = { SMART_AGENT_NEO_STATE_DIR: overrideDir } as NodeJS.ProcessEnv;
      const resolved = resolveConfigPath(env, overrideDir, () => root);
      expect(resolved).toBe(path.join(overrideDir, "smart-agent-neo.json"));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
