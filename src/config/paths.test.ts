import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  resolveDefaultConfigCandidates,
  resolveConfigPathCandidate,
  resolveConfigPath,
  resolveOAuthDir,
  resolveOAuthPath,
  resolveStateDir,
  applyGatewayRuntimePortEnvOverride,
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
  async function withTempRoot(prefix: string, run: (root: string) => Promise<void>): Promise<void> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    try {
      await run(root);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }

  function expectOpenClawHomeDefaults(env: NodeJS.ProcessEnv): void {
    const configuredHome = env.OPENCLAW_HOME;
    if (!configuredHome) {
      throw new Error("OPENCLAW_HOME must be set for this assertion helper");
    }
    const resolvedHome = path.resolve(configuredHome);
    expect(resolveStateDir(env)).toBe(path.join(resolvedHome, ".openclaw"));

    const candidates = resolveDefaultConfigCandidates(env);
    expect(candidates[0]).toBe(path.join(resolvedHome, ".openclaw", "openclaw.json"));
  }

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
    expectOpenClawHomeDefaults(env);
  });

  it("prefers OPENCLAW_HOME over HOME for default state/config locations", () => {
    const env = {
      OPENCLAW_HOME: "/srv/openclaw-home",
      HOME: "/home/other",
    } as NodeJS.ProcessEnv;
    expectOpenClawHomeDefaults(env);
  });

  it("orders default config candidates in a stable order", () => {
    const home = "/home/test";
    const resolvedHome = path.resolve(home);
    const candidates = resolveDefaultConfigCandidates({} as NodeJS.ProcessEnv, () => home);
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

  it("prefers ~/.openclaw when it exists and legacy dir is missing", async () => {
    await withTempRoot("openclaw-state-", async (root) => {
      const newDir = path.join(root, ".openclaw");
      await fs.mkdir(newDir, { recursive: true });
      const resolved = resolveStateDir({} as NodeJS.ProcessEnv, () => root);
      expect(resolved).toBe(newDir);
    });
  });

  it("falls back to existing legacy state dir when ~/.openclaw is missing", async () => {
    await withTempRoot("openclaw-state-legacy-", async (root) => {
      const legacyDir = path.join(root, ".clawdbot");
      await fs.mkdir(legacyDir, { recursive: true });
      const resolved = resolveStateDir({} as NodeJS.ProcessEnv, () => root);
      expect(resolved).toBe(legacyDir);
    });
  });

  it("CONFIG_PATH prefers existing config when present", async () => {
    await withTempRoot("openclaw-config-", async (root) => {
      const legacyDir = path.join(root, ".openclaw");
      await fs.mkdir(legacyDir, { recursive: true });
      const legacyPath = path.join(legacyDir, "openclaw.json");
      await fs.writeFile(legacyPath, "{}", "utf-8");

      const resolved = resolveConfigPathCandidate({} as NodeJS.ProcessEnv, () => root);
      expect(resolved).toBe(legacyPath);
    });
  });

  it("respects state dir overrides when config is missing", async () => {
    await withTempRoot("openclaw-config-override-", async (root) => {
      const legacyDir = path.join(root, ".openclaw");
      await fs.mkdir(legacyDir, { recursive: true });
      const legacyConfig = path.join(legacyDir, "openclaw.json");
      await fs.writeFile(legacyConfig, "{}", "utf-8");

      const overrideDir = path.join(root, "override");
      const env = { OPENCLAW_STATE_DIR: overrideDir } as NodeJS.ProcessEnv;
      const resolved = resolveConfigPath(env, overrideDir, () => root);
      expect(resolved).toBe(path.join(overrideDir, "openclaw.json"));
    });
  });
});

describe("applyGatewayRuntimePortEnvOverride", () => {
  let fixtureRoot = "";

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-port-override-"));
  });

  afterAll(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  it("sets env var when lock file has valid port and PID is alive", async () => {
    const configDir = path.join(fixtureRoot, "case-valid");
    await fs.mkdir(configDir, { recursive: true });
    const configPath = path.join(configDir, "openclaw.json");
    await fs.writeFile(configPath, "{}", "utf8");

    // Mock isPidAlive to return true
    const isPidAliveSpy = vi
      .spyOn(await import("../shared/pid-alive.js"), "isPidAlive")
      .mockReturnValue(true);

    // Create a mock lock file with port
    const { resolveGatewayLockDir } = await import("./paths.js");
    const { createHash } = await import("node:crypto");
    const lockDir = resolveGatewayLockDir();
    await fs.mkdir(lockDir, { recursive: true });
    const hash = createHash("sha256").update(configPath).digest("hex").slice(0, 8);
    const lockPath = path.join(lockDir, `gateway.${hash}.lock`);
    const payload = {
      pid: 12345,
      createdAt: new Date().toISOString(),
      configPath,
      port: 48789,
    };
    await fs.writeFile(lockPath, JSON.stringify(payload), "utf8");

    const env: NodeJS.ProcessEnv = {
      OPENCLAW_STATE_DIR: configDir,
      OPENCLAW_CONFIG_PATH: configPath,
    };

    await applyGatewayRuntimePortEnvOverride(env);

    expect(env.OPENCLAW_GATEWAY_PORT).toBe("48789");

    isPidAliveSpy.mockRestore();
    await fs.rm(lockPath, { force: true });
  });

  it("does not set env var when PID is not alive", async () => {
    const configDir = path.join(fixtureRoot, "case-dead-pid");
    await fs.mkdir(configDir, { recursive: true });
    const configPath = path.join(configDir, "openclaw.json");
    await fs.writeFile(configPath, "{}", "utf8");

    // Mock isPidAlive to return false
    const isPidAliveSpy = vi
      .spyOn(await import("../shared/pid-alive.js"), "isPidAlive")
      .mockReturnValue(false);

    // Create a mock lock file with port
    const { resolveGatewayLockDir } = await import("./paths.js");
    const { createHash } = await import("node:crypto");
    const lockDir = resolveGatewayLockDir();
    await fs.mkdir(lockDir, { recursive: true });
    const hash = createHash("sha256").update(configPath).digest("hex").slice(0, 8);
    const lockPath = path.join(lockDir, `gateway.${hash}.lock`);
    const payload = {
      pid: 12345,
      createdAt: new Date().toISOString(),
      configPath,
      port: 48789,
    };
    await fs.writeFile(lockPath, JSON.stringify(payload), "utf8");

    const env: NodeJS.ProcessEnv = {
      OPENCLAW_STATE_DIR: configDir,
      OPENCLAW_CONFIG_PATH: configPath,
    };

    await applyGatewayRuntimePortEnvOverride(env);

    expect(env.OPENCLAW_GATEWAY_PORT).toBeUndefined();

    isPidAliveSpy.mockRestore();
    await fs.rm(lockPath, { force: true });
  });

  it("skips when env var is already set", async () => {
    const configDir = path.join(fixtureRoot, "case-env-set");
    await fs.mkdir(configDir, { recursive: true });
    const configPath = path.join(configDir, "openclaw.json");
    await fs.writeFile(configPath, "{}", "utf8");

    const env: NodeJS.ProcessEnv = {
      OPENCLAW_STATE_DIR: configDir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_GATEWAY_PORT: "99999",
    };

    await applyGatewayRuntimePortEnvOverride(env);

    // Should remain unchanged
    expect(env.OPENCLAW_GATEWAY_PORT).toBe("99999");
  });
});
