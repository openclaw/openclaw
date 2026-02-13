import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_AGENT_MAX_CONCURRENT, DEFAULT_SUBAGENT_MAX_CONCURRENT } from "./agent-limits.js";
import { loadConfig } from "./config.js";

type HomeEnvSnapshot = {
  home: string | undefined;
  userProfile: string | undefined;
  homeDrive: string | undefined;
  homePath: string | undefined;
  stateDir: string | undefined;
};

function snapshotHomeEnv(): HomeEnvSnapshot {
  return {
    home: process.env.HOME,
    userProfile: process.env.USERPROFILE,
    homeDrive: process.env.HOMEDRIVE,
    homePath: process.env.HOMEPATH,
    stateDir: process.env.OPENCLAW_STATE_DIR,
  };
}

function restoreHomeEnv(snapshot: HomeEnvSnapshot) {
  const restoreKey = (key: string, value: string | undefined) => {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  };
  restoreKey("HOME", snapshot.home);
  restoreKey("USERPROFILE", snapshot.userProfile);
  restoreKey("HOMEDRIVE", snapshot.homeDrive);
  restoreKey("HOMEPATH", snapshot.homePath);
  restoreKey("OPENCLAW_STATE_DIR", snapshot.stateDir);
}

describe("config identity defaults", () => {
  let fixtureRoot = "";
  let fixtureCount = 0;

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-config-identity-"));
  });

  afterAll(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  const writeAndLoadConfig = async (home: string, config: Record<string, unknown>) => {
    const configDir = path.join(home, ".openclaw");
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, "openclaw.json"),
      JSON.stringify(config, null, 2),
      "utf-8",
    );
    return loadConfig();
  };

  const withTempHome = async <T>(fn: (home: string) => Promise<T>): Promise<T> => {
    const home = path.join(fixtureRoot, `home-${fixtureCount++}`);
    await fs.mkdir(path.join(home, ".openclaw"), { recursive: true });

    const snapshot = snapshotHomeEnv();
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.OPENCLAW_STATE_DIR = path.join(home, ".openclaw");

    if (process.platform === "win32") {
      const match = home.match(/^([A-Za-z]:)(.*)$/);
      if (match) {
        process.env.HOMEDRIVE = match[1];
        process.env.HOMEPATH = match[2] || "\\";
      }
    }

    try {
      return await fn(home);
    } finally {
      restoreHomeEnv(snapshot);
    }
  };

  it("does not derive mention defaults and only sets ackReactionScope when identity is present", async () => {
    await withTempHome(async (home) => {
      const cfg = await writeAndLoadConfig(home, {
        agents: {
          list: [
            {
              id: "main",
              identity: {
                name: "Samantha",
                theme: "helpful sloth",
                emoji: "🦥",
              },
            },
          ],
        },
        messages: {},
      });

      expect(cfg.messages?.responsePrefix).toBeUndefined();
      expect(cfg.messages?.groupChat?.mentionPatterns).toBeUndefined();
      expect(cfg.messages?.ackReaction).toBeUndefined();
      expect(cfg.messages?.ackReactionScope).toBe("group-mentions");
    });
  });

  it("keeps ackReaction unset and does not synthesize agent/session defaults when identity is missing", async () => {
    await withTempHome(async (home) => {
      const cfg = await writeAndLoadConfig(home, { messages: {} });

      expect(cfg.messages?.ackReaction).toBeUndefined();
      expect(cfg.messages?.ackReactionScope).toBe("group-mentions");
      expect(cfg.messages?.responsePrefix).toBeUndefined();
      expect(cfg.messages?.groupChat?.mentionPatterns).toBeUndefined();
      expect(cfg.agents?.list).toBeUndefined();
      expect(cfg.agents?.defaults?.maxConcurrent).toBe(DEFAULT_AGENT_MAX_CONCURRENT);
      expect(cfg.agents?.defaults?.subagents?.maxConcurrent).toBe(DEFAULT_SUBAGENT_MAX_CONCURRENT);
      expect(cfg.session).toBeUndefined();
    });
  });

  it("does not override explicit values", async () => {
    await withTempHome(async (home) => {
      const cfg = await writeAndLoadConfig(home, {
        agents: {
          list: [
            {
              id: "main",
              identity: {
                name: "Samantha Sloth",
                theme: "space lobster",
                emoji: "🦞",
              },
              groupChat: { mentionPatterns: ["@openclaw"] },
            },
          ],
        },
        messages: {
          responsePrefix: "✅",
        },
      });

      expect(cfg.messages?.responsePrefix).toBe("✅");
      expect(cfg.agents?.list?.[0]?.groupChat?.mentionPatterns).toEqual(["@openclaw"]);
    });
  });

  it("supports provider textChunkLimit config", async () => {
    await withTempHome(async (home) => {
      const cfg = await writeAndLoadConfig(home, {
        messages: {
          messagePrefix: "[openclaw]",
          responsePrefix: "🦞",
        },
        channels: {
          whatsapp: { allowFrom: ["+15555550123"], textChunkLimit: 4444 },
          telegram: { enabled: true, textChunkLimit: 3333 },
          discord: {
            enabled: true,
            textChunkLimit: 1999,
            maxLinesPerMessage: 17,
          },
          signal: { enabled: true, textChunkLimit: 2222 },
          imessage: { enabled: true, textChunkLimit: 1111 },
        },
      });

      expect(cfg.channels?.whatsapp?.textChunkLimit).toBe(4444);
      expect(cfg.channels?.telegram?.textChunkLimit).toBe(3333);
      expect(cfg.channels?.discord?.textChunkLimit).toBe(1999);
      expect(cfg.channels?.discord?.maxLinesPerMessage).toBe(17);
      expect(cfg.channels?.signal?.textChunkLimit).toBe(2222);
      expect(cfg.channels?.imessage?.textChunkLimit).toBe(1111);

      const legacy = (cfg.messages as unknown as Record<string, unknown>).textChunkLimit;
      expect(legacy).toBeUndefined();
    });
  });

  it("accepts blank model provider apiKey values", async () => {
    await withTempHome(async (home) => {
      const cfg = await writeAndLoadConfig(home, {
        models: {
          mode: "merge",
          providers: {
            minimax: {
              baseUrl: "https://api.minimax.io/anthropic",
              apiKey: "",
              api: "anthropic-messages",
              models: [
                {
                  id: "MiniMax-M2.1",
                  name: "MiniMax M2.1",
                  reasoning: false,
                  input: ["text"],
                  cost: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                  },
                  contextWindow: 200000,
                  maxTokens: 8192,
                },
              ],
            },
          },
        },
      });

      expect(cfg.models?.providers?.minimax?.baseUrl).toBe("https://api.minimax.io/anthropic");
    });
  });

  it("respects empty responsePrefix to disable identity defaults", async () => {
    await withTempHome(async (home) => {
      const cfg = await writeAndLoadConfig(home, {
        agents: {
          list: [
            {
              id: "main",
              identity: {
                name: "Samantha",
                theme: "helpful sloth",
                emoji: "🦥",
              },
            },
          ],
        },
        messages: { responsePrefix: "" },
      });

      expect(cfg.messages?.responsePrefix).toBe("");
    });
  });

  it("does not derive responsePrefix from identity emoji", async () => {
    await withTempHome(async (home) => {
      const cfg = await writeAndLoadConfig(home, {
        agents: {
          list: [
            {
              id: "main",
              identity: {
                name: "OpenClaw",
                theme: "space lobster",
                emoji: "🦞",
              },
            },
          ],
        },
        messages: {},
      });

      expect(cfg.messages?.responsePrefix).toBeUndefined();
    });
  });
});
