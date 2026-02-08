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
  it("prefers OPENCLAW_OAUTH_DIR over OPENCLAW_STATE_DIR", () => {
    const env = {
      OPENCLAW_OAUTH_DIR: "/custom/oauth",
      OPENCLAW_STATE_DIR: "/custom/state",
    } as NodeJS.ProcessEnv;

    expect(resolveOAuthDir(env, "/custom/state")).toBe(path.resolve("/custom/oauth"));
    expect(resolveOAuthPath(env, "/custom/state")).toBe(
      path.join(path.resolve("/custom/oauth"), "oauth.json"),
    );
  });

  it("derives oauth path from OPENCLAW_STATE_DIR when unset", () => {
    const env = {
      OPENCLAW_STATE_DIR: "/custom/state",
    } as NodeJS.ProcessEnv;

    expect(resolveOAuthDir(env, "/custom/state")).toBe(path.join("/custom/state", "credentials"));
    expect(resolveOAuthPath(env, "/custom/state")).toBe(
      path.join("/custom/state", "credentials", "oauth.json"),
    );
  });
});

describe("state + config path candidates", () => {
  it("uses OPENCLAW_STATE_DIR when set", () => {
    const env = {
      OPENCLAW_STATE_DIR: "/new/state",
    } as NodeJS.ProcessEnv;

    expect(resolveStateDir(env, () => "/home/test")).toBe(path.resolve("/new/state"));
  });

  it("uses OPENCLAW_HOME for default state/config locations", () => {
    const env = {
      OPENCLAW_HOME: "/srv/openclaw-home",
    } as NodeJS.ProcessEnv;

    const resolvedHome = path.resolve("/srv/openclaw-home");
    expect(resolveStateDir(env)).toBe(path.join(resolvedHome, ".openclaw"));

    const candidates = resolveDefaultConfigCandidates(env);
    expect(candidates[0]).toBe(path.join(resolvedHome, ".openclaw", "openclaw.json"));
  });

  it("prefers OPENCLAW_HOME over HOME for default state/config locations", () => {
    const env = {
      OPENCLAW_HOME: "/srv/openclaw-home",
      HOME: "/home/other",
    } as NodeJS.ProcessEnv;

    const resolvedHome = path.resolve("/srv/openclaw-home");
    expect(resolveStateDir(env)).toBe(path.join(resolvedHome, ".openclaw"));

    const candidates = resolveDefaultConfigCandidates(env);
    expect(candidates[0]).toBe(path.join(resolvedHome, ".openclaw", "openclaw.json"));
  });

  it("orders default config candidates in a stable order", () => {
    const home = "/home/test";
    const resolvedHome = path.resolve(home);
    const candidates = resolveDefaultConfigCandidates({} as NodeJS.ProcessEnv, () => home, {
      skipLegacyIfNewExists: false,
    });
    const expected = [
      path.join(resolvedHome, ".openclaw", "openclaw.json"),
      path.join(resolvedHome, ".openclaw", "clawdbot.json"),
      path.join(resolvedHome, ".openclaw", "moldbot.json"),
      path.join(resolvedHome, ".openclaw", "moltbot.json"),
      path.join(resolvedHome, ".clawdbot", "openclaw.json"),
      path.join(resolvedHome, ".clawdbot", "clawdbot.json"),
      path.join(resolvedHome, ".clawdbot", "moldbot.json"),
      path.join(resolvedHome, ".clawdbot", "moltbot.json"),
      path.join(resolvedHome, ".moldbot", "openclaw.json"),
      path.join(resolvedHome, ".moldbot", "clawdbot.json"),
      path.join(resolvedHome, ".moldbot", "moldbot.json"),
      path.join(resolvedHome, ".moldbot", "moltbot.json"),
      path.join(resolvedHome, ".moltbot", "openclaw.json"),
      path.join(resolvedHome, ".moltbot", "clawdbot.json"),
      path.join(resolvedHome, ".moltbot", "moldbot.json"),
      path.join(resolvedHome, ".moltbot", "moltbot.json"),
    ];
    expect(candidates).toEqual(expected);
  });

  it("skips legacy filenames when openclaw.json exists in the same dir", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skip-legacy-"));
    try {
      const openclawDir = path.join(root, ".openclaw");
      await fs.mkdir(openclawDir, { recursive: true });
      await fs.writeFile(path.join(openclawDir, "openclaw.json"), "{}", "utf-8");

      const candidates = resolveDefaultConfigCandidates({} as NodeJS.ProcessEnv, () => root);
      // .openclaw dir has openclaw.json → no legacy filenames for that dir
      expect(candidates).toContain(path.join(openclawDir, "openclaw.json"));
      expect(candidates).not.toContain(path.join(openclawDir, "clawdbot.json"));
      expect(candidates).not.toContain(path.join(openclawDir, "moltbot.json"));
      expect(candidates).not.toContain(path.join(openclawDir, "moldbot.json"));

      // Legacy dirs don't have openclaw.json → legacy filenames still present
      const clawdbotDir = path.join(root, ".clawdbot");
      expect(candidates).toContain(path.join(clawdbotDir, "clawdbot.json"));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("includes legacy filenames when openclaw.json does not exist", () => {
    const home = "/nonexistent/home";
    const candidates = resolveDefaultConfigCandidates({} as NodeJS.ProcessEnv, () => home);
    // Since the dirs don't exist on disk, fs.existsSync returns false → legacy included
    expect(candidates).toContain(path.join(home, ".openclaw", "clawdbot.json"));
    expect(candidates).toContain(path.join(home, ".clawdbot", "clawdbot.json"));
  });

  it("skips legacy filenames in OPENCLAW_STATE_DIR when openclaw.json exists there", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-statedir-legacy-"));
    try {
      await fs.writeFile(path.join(root, "openclaw.json"), "{}", "utf-8");
      await fs.writeFile(path.join(root, "clawdbot.json"), "{}", "utf-8");

      const env = { OPENCLAW_STATE_DIR: root } as unknown as NodeJS.ProcessEnv;
      const candidates = resolveDefaultConfigCandidates(env, () => "/fake-home");

      // Custom state dir has openclaw.json → no legacy filenames
      expect(candidates).toContain(path.join(root, "openclaw.json"));
      expect(candidates).not.toContain(path.join(root, "clawdbot.json"));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("handles symlink scenario: .clawdbot -> .openclaw", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-symlink-"));
    try {
      const openclawDir = path.join(root, ".openclaw");
      const clawdbotDir = path.join(root, ".clawdbot");
      await fs.mkdir(openclawDir, { recursive: true });
      await fs.writeFile(path.join(openclawDir, "openclaw.json"), "{}", "utf-8");
      // Stale legacy config in the same dir (would be visible via symlink)
      await fs.writeFile(path.join(openclawDir, "clawdbot.json"), "{}", "utf-8");
      // Create symlink like migration does
      await fs.symlink(openclawDir, clawdbotDir);

      const candidates = resolveDefaultConfigCandidates({} as NodeJS.ProcessEnv, () => root);

      // Both .openclaw and .clawdbot (via symlink) see openclaw.json → no legacy filenames
      expect(candidates).toContain(path.join(openclawDir, "openclaw.json"));
      expect(candidates).not.toContain(path.join(openclawDir, "clawdbot.json"));
      expect(candidates).toContain(path.join(clawdbotDir, "openclaw.json"));
      expect(candidates).not.toContain(path.join(clawdbotDir, "clawdbot.json"));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("prefers ~/.openclaw when it exists and legacy dir is missing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-state-"));
    try {
      const newDir = path.join(root, ".openclaw");
      await fs.mkdir(newDir, { recursive: true });
      const resolved = resolveStateDir({} as NodeJS.ProcessEnv, () => root);
      expect(resolved).toBe(newDir);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("CONFIG_PATH prefers existing config when present", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-config-"));
    try {
      const legacyDir = path.join(root, ".openclaw");
      await fs.mkdir(legacyDir, { recursive: true });
      const legacyPath = path.join(legacyDir, "openclaw.json");
      await fs.writeFile(legacyPath, "{}", "utf-8");

      const resolved = resolveConfigPathCandidate({} as NodeJS.ProcessEnv, () => root);
      expect(resolved).toBe(legacyPath);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("respects state dir overrides when config is missing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-config-override-"));
    try {
      const legacyDir = path.join(root, ".openclaw");
      await fs.mkdir(legacyDir, { recursive: true });
      const legacyConfig = path.join(legacyDir, "openclaw.json");
      await fs.writeFile(legacyConfig, "{}", "utf-8");

      const overrideDir = path.join(root, "override");
      const env = { OPENCLAW_STATE_DIR: overrideDir } as NodeJS.ProcessEnv;
      const resolved = resolveConfigPath(env, overrideDir, () => root);
      expect(resolved).toBe(path.join(overrideDir, "openclaw.json"));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("resolveConfigPath respects CLAWDBOT_CONFIG_PATH as legacy fallback", () => {
    const env = { CLAWDBOT_CONFIG_PATH: "/tmp/legacy/clawdbot.json" } as NodeJS.ProcessEnv;
    const resolved = resolveConfigPath(env);
    expect(resolved).toBe("/tmp/legacy/clawdbot.json");
  });

  it("resolveConfigPath prefers OPENCLAW_CONFIG_PATH over CLAWDBOT_CONFIG_PATH", () => {
    const env = {
      OPENCLAW_CONFIG_PATH: "/tmp/new/openclaw.json",
      CLAWDBOT_CONFIG_PATH: "/tmp/legacy/clawdbot.json",
    } as NodeJS.ProcessEnv;
    const resolved = resolveConfigPath(env);
    expect(resolved).toBe("/tmp/new/openclaw.json");
  });
});
