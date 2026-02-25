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
  it("prefers ACTIVI_OAUTH_DIR over ACTIVI_STATE_DIR", () => {
    const env = {
      ACTIVI_OAUTH_DIR: "/custom/oauth",
      ACTIVI_STATE_DIR: "/custom/state",
    } as NodeJS.ProcessEnv;

    expect(resolveOAuthDir(env, "/custom/state")).toBe(path.resolve("/custom/oauth"));
    expect(resolveOAuthPath(env, "/custom/state")).toBe(
      path.join(path.resolve("/custom/oauth"), "oauth.json"),
    );
  });

  it("derives oauth path from ACTIVI_STATE_DIR when unset", () => {
    const env = {
      ACTIVI_STATE_DIR: "/custom/state",
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

  function expectActiviHomeDefaults(env: NodeJS.ProcessEnv): void {
    const configuredHome = env.ACTIVI_HOME;
    if (!configuredHome) {
      throw new Error("ACTIVI_HOME must be set for this assertion helper");
    }
    const resolvedHome = path.resolve(configuredHome);
    expect(resolveStateDir(env)).toBe(path.join(resolvedHome, ".activi"));

    const candidates = resolveDefaultConfigCandidates(env);
    expect(candidates[0]).toBe(path.join(resolvedHome, ".activi", "activi.json"));
  }

  it("uses ACTIVI_STATE_DIR when set", () => {
    const env = {
      ACTIVI_STATE_DIR: "/new/state",
    } as NodeJS.ProcessEnv;

    expect(resolveStateDir(env, () => "/home/test")).toBe(path.resolve("/new/state"));
  });

  it("uses ACTIVI_HOME for default state/config locations", () => {
    const env = {
      ACTIVI_HOME: "/srv/activi-home",
    } as NodeJS.ProcessEnv;
    expectActiviHomeDefaults(env);
  });

  it("prefers ACTIVI_HOME over HOME for default state/config locations", () => {
    const env = {
      ACTIVI_HOME: "/srv/activi-home",
      HOME: "/home/other",
    } as NodeJS.ProcessEnv;
    expectActiviHomeDefaults(env);
  });

  it("orders default config candidates in a stable order", () => {
    const home = "/home/test";
    const resolvedHome = path.resolve(home);
    const candidates = resolveDefaultConfigCandidates({} as NodeJS.ProcessEnv, () => home);
    const expected = [
      path.join(resolvedHome, ".activi", "activi.json"),
      path.join(resolvedHome, ".activi", "openclaw.json"),
      path.join(resolvedHome, ".activi", "moldbot.json"),
      path.join(resolvedHome, ".activi", "moltbot.json"),
      path.join(resolvedHome, ".activi", "activi.json"),
      path.join(resolvedHome, ".activi", "openclaw.json"),
      path.join(resolvedHome, ".activi", "moldbot.json"),
      path.join(resolvedHome, ".activi", "moltbot.json"),
      path.join(resolvedHome, ".moldbot", "activi.json"),
      path.join(resolvedHome, ".moldbot", "openclaw.json"),
      path.join(resolvedHome, ".moldbot", "moldbot.json"),
      path.join(resolvedHome, ".moldbot", "moltbot.json"),
      path.join(resolvedHome, ".moltbot", "activi.json"),
      path.join(resolvedHome, ".moltbot", "openclaw.json"),
      path.join(resolvedHome, ".moltbot", "moldbot.json"),
      path.join(resolvedHome, ".moltbot", "moltbot.json"),
    ];
    expect(candidates).toEqual(expected);
  });

  it("prefers ~/.activi when it exists and legacy dir is missing", async () => {
    await withTempRoot("activi-state-", async (root) => {
      const newDir = path.join(root, ".activi");
      await fs.mkdir(newDir, { recursive: true });
      const resolved = resolveStateDir({} as NodeJS.ProcessEnv, () => root);
      expect(resolved).toBe(newDir);
    });
  });

  it("falls back to existing legacy state dir when ~/.activi is missing", async () => {
    await withTempRoot("activi-state-legacy-", async (root) => {
      const legacyDir = path.join(root, ".activi");
      await fs.mkdir(legacyDir, { recursive: true });
      const resolved = resolveStateDir({} as NodeJS.ProcessEnv, () => root);
      expect(resolved).toBe(legacyDir);
    });
  });

  it("CONFIG_PATH prefers existing config when present", async () => {
    await withTempRoot("activi-config-", async (root) => {
      const legacyDir = path.join(root, ".activi");
      await fs.mkdir(legacyDir, { recursive: true });
      const legacyPath = path.join(legacyDir, "activi.json");
      await fs.writeFile(legacyPath, "{}", "utf-8");

      const resolved = resolveConfigPathCandidate({} as NodeJS.ProcessEnv, () => root);
      expect(resolved).toBe(legacyPath);
    });
  });

  it("respects state dir overrides when config is missing", async () => {
    await withTempRoot("activi-config-override-", async (root) => {
      const legacyDir = path.join(root, ".activi");
      await fs.mkdir(legacyDir, { recursive: true });
      const legacyConfig = path.join(legacyDir, "activi.json");
      await fs.writeFile(legacyConfig, "{}", "utf-8");

      const overrideDir = path.join(root, "override");
      const env = { ACTIVI_STATE_DIR: overrideDir } as NodeJS.ProcessEnv;
      const resolved = resolveConfigPath(env, overrideDir, () => root);
      expect(resolved).toBe(path.join(overrideDir, "activi.json"));
    });
  });
});
