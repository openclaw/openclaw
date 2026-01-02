import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "clawdis-config-"));
  const previousHome = process.env.HOME;
  process.env.HOME = base;
  try {
    return await fn(base);
  } finally {
    process.env.HOME = previousHome;
    await fs.rm(base, { recursive: true, force: true });
  }
}

/**
 * Helper to test env var overrides. Saves/restores env vars and resets modules.
 */
async function withEnvOverride<T>(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
    if (overrides[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = overrides[key];
    }
  }
  vi.resetModules();
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
    vi.resetModules();
  }
}

describe("config identity defaults", () => {
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.HOME;
  });

  afterEach(() => {
    process.env.HOME = previousHome;
  });

  it("derives mentionPatterns when identity is set", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".clawdis");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "clawdis.json"),
        JSON.stringify(
          {
            identity: { name: "Samantha", theme: "helpful sloth", emoji: "🦥" },
            messages: {},
            routing: {},
          },
          null,
          2,
        ),
        "utf-8",
      );

      vi.resetModules();
      const { loadConfig } = await import("./config.js");
      const cfg = loadConfig();

      expect(cfg.messages?.responsePrefix).toBeUndefined();
      expect(cfg.routing?.groupChat?.mentionPatterns).toEqual([
        "\\b@?Samantha\\b",
      ]);
    });
  });

  it("does not override explicit values", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".clawdis");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "clawdis.json"),
        JSON.stringify(
          {
            identity: {
              name: "Samantha Sloth",
              theme: "space lobster",
              emoji: "🦞",
            },
            messages: {
              responsePrefix: "✅",
            },
            routing: {
              groupChat: { mentionPatterns: ["@clawd"] },
            },
          },
          null,
          2,
        ),
        "utf-8",
      );

      vi.resetModules();
      const { loadConfig } = await import("./config.js");
      const cfg = loadConfig();

      expect(cfg.messages?.responsePrefix).toBe("✅");
      expect(cfg.routing?.groupChat?.mentionPatterns).toEqual(["@clawd"]);
    });
  });

  it("respects empty responsePrefix to disable identity defaults", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".clawdis");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "clawdis.json"),
        JSON.stringify(
          {
            identity: { name: "Samantha", theme: "helpful sloth", emoji: "🦥" },
            messages: { responsePrefix: "" },
            routing: {},
          },
          null,
          2,
        ),
        "utf-8",
      );

      vi.resetModules();
      const { loadConfig } = await import("./config.js");
      const cfg = loadConfig();

      expect(cfg.messages?.responsePrefix).toBe("");
    });
  });

  it("does not synthesize agent/session when absent", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".clawdis");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "clawdis.json"),
        JSON.stringify(
          {
            identity: { name: "Samantha", theme: "helpful sloth", emoji: "🦥" },
            messages: {},
            routing: {},
          },
          null,
          2,
        ),
        "utf-8",
      );

      vi.resetModules();
      const { loadConfig } = await import("./config.js");
      const cfg = loadConfig();

      expect(cfg.messages?.responsePrefix).toBeUndefined();
      expect(cfg.routing?.groupChat?.mentionPatterns).toEqual([
        "\\b@?Samantha\\b",
      ]);
      expect(cfg.agent).toBeUndefined();
      expect(cfg.session).toBeUndefined();
    });
  });

  it("does not derive responsePrefix from identity emoji", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".clawdis");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "clawdis.json"),
        JSON.stringify(
          {
            identity: { name: "Clawd", theme: "space lobster", emoji: "🦞" },
            messages: {},
            routing: {},
          },
          null,
          2,
        ),
        "utf-8",
      );

      vi.resetModules();
      const { loadConfig } = await import("./config.js");
      const cfg = loadConfig();

      expect(cfg.messages?.responsePrefix).toBeUndefined();
    });
  });
});

describe("config discord", () => {
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.HOME;
  });

  afterEach(() => {
    process.env.HOME = previousHome;
  });

  it("loads discord guild map + dm group settings", async () => {
    await withTempHome(async (home) => {
      const configDir = path.join(home, ".clawdis");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "clawdis.json"),
        JSON.stringify(
          {
            discord: {
              enabled: true,
              dm: {
                enabled: true,
                allowFrom: ["steipete"],
                groupEnabled: true,
                groupChannels: ["clawd-dm"],
              },
              guilds: {
                "123": {
                  slug: "friends-of-clawd",
                  requireMention: false,
                  users: ["steipete"],
                  channels: {
                    general: { allow: true },
                  },
                },
              },
            },
          },
          null,
          2,
        ),
        "utf-8",
      );

      vi.resetModules();
      const { loadConfig } = await import("./config.js");
      const cfg = loadConfig();

      expect(cfg.discord?.enabled).toBe(true);
      expect(cfg.discord?.dm?.groupEnabled).toBe(true);
      expect(cfg.discord?.dm?.groupChannels).toEqual(["clawd-dm"]);
      expect(cfg.discord?.guilds?.["123"]?.slug).toBe("friends-of-clawd");
      expect(cfg.discord?.guilds?.["123"]?.channels?.general?.allow).toBe(true);
    });
  });
});

describe("Nix integration (U3, U5, U9)", () => {
  describe("U3: isNixMode env var detection", () => {
    it("isNixMode is false when CLAWDIS_NIX_MODE is not set", async () => {
      await withEnvOverride({ CLAWDIS_NIX_MODE: undefined }, async () => {
        const { isNixMode } = await import("./config.js");
        expect(isNixMode).toBe(false);
      });
    });

    it("isNixMode is false when CLAWDIS_NIX_MODE is empty", async () => {
      await withEnvOverride({ CLAWDIS_NIX_MODE: "" }, async () => {
        const { isNixMode } = await import("./config.js");
        expect(isNixMode).toBe(false);
      });
    });

    it("isNixMode is false when CLAWDIS_NIX_MODE is not '1'", async () => {
      await withEnvOverride({ CLAWDIS_NIX_MODE: "true" }, async () => {
        const { isNixMode } = await import("./config.js");
        expect(isNixMode).toBe(false);
      });
    });

    it("isNixMode is true when CLAWDIS_NIX_MODE=1", async () => {
      await withEnvOverride({ CLAWDIS_NIX_MODE: "1" }, async () => {
        const { isNixMode } = await import("./config.js");
        expect(isNixMode).toBe(true);
      });
    });
  });

  describe("U5: CONFIG_PATH and STATE_DIR env var overrides", () => {
    it("STATE_DIR_CLAWDIS defaults to ~/.clawdis when env not set", async () => {
      await withEnvOverride({ CLAWDIS_STATE_DIR: undefined }, async () => {
        const { STATE_DIR_CLAWDIS } = await import("./config.js");
        expect(STATE_DIR_CLAWDIS).toMatch(/\.clawdis$/);
      });
    });

    it("STATE_DIR_CLAWDIS respects CLAWDIS_STATE_DIR override", async () => {
      await withEnvOverride(
        { CLAWDIS_STATE_DIR: "/custom/state/dir" },
        async () => {
          const { STATE_DIR_CLAWDIS } = await import("./config.js");
          expect(STATE_DIR_CLAWDIS).toBe("/custom/state/dir");
        },
      );
    });

    it("CONFIG_PATH_CLAWDIS defaults to ~/.clawdis/clawdis.json when env not set", async () => {
      await withEnvOverride(
        { CLAWDIS_CONFIG_PATH: undefined, CLAWDIS_STATE_DIR: undefined },
        async () => {
          const { CONFIG_PATH_CLAWDIS } = await import("./config.js");
          expect(CONFIG_PATH_CLAWDIS).toMatch(/\.clawdis\/clawdis\.json$/);
        },
      );
    });

    it("CONFIG_PATH_CLAWDIS respects CLAWDIS_CONFIG_PATH override", async () => {
      await withEnvOverride(
        { CLAWDIS_CONFIG_PATH: "/nix/store/abc/clawdis.json" },
        async () => {
          const { CONFIG_PATH_CLAWDIS } = await import("./config.js");
          expect(CONFIG_PATH_CLAWDIS).toBe("/nix/store/abc/clawdis.json");
        },
      );
    });

    it("CONFIG_PATH_CLAWDIS uses STATE_DIR_CLAWDIS when only state dir is overridden", async () => {
      await withEnvOverride(
        {
          CLAWDIS_CONFIG_PATH: undefined,
          CLAWDIS_STATE_DIR: "/custom/state",
        },
        async () => {
          const { CONFIG_PATH_CLAWDIS } = await import("./config.js");
          expect(CONFIG_PATH_CLAWDIS).toBe("/custom/state/clawdis.json");
        },
      );
    });
  });

  describe("U9: telegram.tokenFile schema validation", () => {
    it("accepts config with only botToken", async () => {
      await withTempHome(async (home) => {
        const configDir = path.join(home, ".clawdis");
        await fs.mkdir(configDir, { recursive: true });
        await fs.writeFile(
          path.join(configDir, "clawdis.json"),
          JSON.stringify({
            telegram: { botToken: "123:ABC" },
          }),
          "utf-8",
        );

        vi.resetModules();
        const { loadConfig } = await import("./config.js");
        const cfg = loadConfig();
        expect(cfg.telegram?.botToken).toBe("123:ABC");
        expect(cfg.telegram?.tokenFile).toBeUndefined();
      });
    });

    it("accepts config with only tokenFile", async () => {
      await withTempHome(async (home) => {
        const configDir = path.join(home, ".clawdis");
        await fs.mkdir(configDir, { recursive: true });
        await fs.writeFile(
          path.join(configDir, "clawdis.json"),
          JSON.stringify({
            telegram: { tokenFile: "/run/agenix/telegram-token" },
          }),
          "utf-8",
        );

        vi.resetModules();
        const { loadConfig } = await import("./config.js");
        const cfg = loadConfig();
        expect(cfg.telegram?.tokenFile).toBe("/run/agenix/telegram-token");
        expect(cfg.telegram?.botToken).toBeUndefined();
      });
    });

    it("accepts config with both botToken and tokenFile", async () => {
      await withTempHome(async (home) => {
        const configDir = path.join(home, ".clawdis");
        await fs.mkdir(configDir, { recursive: true });
        await fs.writeFile(
          path.join(configDir, "clawdis.json"),
          JSON.stringify({
            telegram: {
              botToken: "fallback:token",
              tokenFile: "/run/agenix/telegram-token",
            },
          }),
          "utf-8",
        );

        vi.resetModules();
        const { loadConfig } = await import("./config.js");
        const cfg = loadConfig();
        expect(cfg.telegram?.botToken).toBe("fallback:token");
        expect(cfg.telegram?.tokenFile).toBe("/run/agenix/telegram-token");
      });
    });
  });
});

describe("talk api key fallback", () => {
  let previousEnv: string | undefined;

  beforeEach(() => {
    previousEnv = process.env.ELEVENLABS_API_KEY;
    delete process.env.ELEVENLABS_API_KEY;
  });

  afterEach(() => {
    process.env.ELEVENLABS_API_KEY = previousEnv;
  });

  it("injects talk.apiKey from profile when config is missing", async () => {
    await withTempHome(async (home) => {
      await fs.writeFile(
        path.join(home, ".profile"),
        "export ELEVENLABS_API_KEY=profile-key\n",
        "utf-8",
      );

      vi.resetModules();
      const { readConfigFileSnapshot } = await import("./config.js");
      const snap = await readConfigFileSnapshot();

      expect(snap.config?.talk?.apiKey).toBe("profile-key");
      expect(snap.exists).toBe(false);
    });
  });

  it("prefers ELEVENLABS_API_KEY env over profile", async () => {
    await withTempHome(async (home) => {
      await fs.writeFile(
        path.join(home, ".profile"),
        "export ELEVENLABS_API_KEY=profile-key\n",
        "utf-8",
      );
      process.env.ELEVENLABS_API_KEY = "env-key";

      vi.resetModules();
      const { readConfigFileSnapshot } = await import("./config.js");
      const snap = await readConfigFileSnapshot();

      expect(snap.config?.talk?.apiKey).toBe("env-key");
    });
  });
});

describe("talk.voiceAliases", () => {
  it("accepts a string map of voice aliases", async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({
      talk: {
        voiceAliases: {
          Clawd: "EXAVITQu4vr4xnSDxMaL",
          Roger: "CwhRBWXzGAHq8TQ4Fs17",
        },
      },
    });
    expect(res.ok).toBe(true);
  });

  it("rejects non-string voice alias values", async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({
      talk: {
        voiceAliases: {
          Clawd: 123,
        },
      },
    });
    expect(res.ok).toBe(false);
  });
});

describe("legacy config detection", () => {
  it("rejects routing.allowFrom", async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({
      routing: { allowFrom: ["+15555550123"] },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.path).toBe("routing.allowFrom");
    }
  });

  it("rejects routing.groupChat.requireMention", async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({
      routing: { groupChat: { requireMention: false } },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.path).toBe("routing.groupChat.requireMention");
    }
  });

  it("migrates routing.allowFrom to whatsapp.allowFrom", async () => {
    vi.resetModules();
    const { migrateLegacyConfig } = await import("./config.js");
    const res = migrateLegacyConfig({
      routing: { allowFrom: ["+15555550123"] },
    });
    expect(res.changes).toContain(
      "Moved routing.allowFrom → whatsapp.allowFrom.",
    );
    expect(res.config?.whatsapp?.allowFrom).toEqual(["+15555550123"]);
    expect(res.config?.routing?.allowFrom).toBeUndefined();
  });

  it("migrates routing.groupChat.requireMention to whatsapp/telegram/imessage groups", async () => {
    vi.resetModules();
    const { migrateLegacyConfig } = await import("./config.js");
    const res = migrateLegacyConfig({
      routing: { groupChat: { requireMention: false } },
    });
    expect(res.changes).toContain(
      'Moved routing.groupChat.requireMention → whatsapp.groups."*".requireMention.',
    );
    expect(res.changes).toContain(
      'Moved routing.groupChat.requireMention → telegram.groups."*".requireMention.',
    );
    expect(res.changes).toContain(
      'Moved routing.groupChat.requireMention → imessage.groups."*".requireMention.',
    );
    expect(res.config?.whatsapp?.groups?.["*"]?.requireMention).toBe(false);
    expect(res.config?.telegram?.groups?.["*"]?.requireMention).toBe(false);
    expect(res.config?.imessage?.groups?.["*"]?.requireMention).toBe(false);
    expect(res.config?.routing?.groupChat?.requireMention).toBeUndefined();
  });

  it("rejects telegram.requireMention", async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({
      telegram: { requireMention: true },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.path).toBe("telegram.requireMention");
    }
  });

  it("migrates telegram.requireMention to telegram.groups.*.requireMention", async () => {
    vi.resetModules();
    const { migrateLegacyConfig } = await import("./config.js");
    const res = migrateLegacyConfig({
      telegram: { requireMention: false },
    });
    expect(res.changes).toContain(
      'Moved telegram.requireMention → telegram.groups."*".requireMention.',
    );
    expect(res.config?.telegram?.groups?.["*"]?.requireMention).toBe(false);
    expect(res.config?.telegram?.requireMention).toBeUndefined();
  });

  it("surfaces legacy issues in snapshot", async () => {
    await withTempHome(async (home) => {
      const configPath = path.join(home, ".clawdis", "clawdis.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        JSON.stringify({ routing: { allowFrom: ["+15555550123"] } }),
        "utf-8",
      );

      vi.resetModules();
      const { readConfigFileSnapshot } = await import("./config.js");
      const snap = await readConfigFileSnapshot();

      expect(snap.valid).toBe(false);
      expect(snap.legacyIssues.length).toBe(1);
      expect(snap.legacyIssues[0]?.path).toBe("routing.allowFrom");
    });
  });
});
