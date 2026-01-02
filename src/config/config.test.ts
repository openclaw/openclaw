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

describe("deep research env overrides", () => {
  let previousEnv: {
    enabled?: string;
    dryRun?: string;
    cliPath?: string;
    outputLanguage?: string;
  };

  beforeEach(() => {
    previousEnv = {
      enabled: process.env.DEEP_RESEARCH_ENABLED,
      dryRun: process.env.DEEP_RESEARCH_DRY_RUN,
      cliPath: process.env.DEEP_RESEARCH_CLI_PATH,
      outputLanguage: process.env.DEEP_RESEARCH_OUTPUT_LANGUAGE,
    };
    delete process.env.DEEP_RESEARCH_ENABLED;
    delete process.env.DEEP_RESEARCH_DRY_RUN;
    delete process.env.DEEP_RESEARCH_CLI_PATH;
    delete process.env.DEEP_RESEARCH_OUTPUT_LANGUAGE;
  });

  afterEach(() => {
    process.env.DEEP_RESEARCH_ENABLED = previousEnv.enabled;
    process.env.DEEP_RESEARCH_DRY_RUN = previousEnv.dryRun;
    process.env.DEEP_RESEARCH_CLI_PATH = previousEnv.cliPath;
    process.env.DEEP_RESEARCH_OUTPUT_LANGUAGE = previousEnv.outputLanguage;
  });

  it("applies env overrides when config is missing", async () => {
    await withTempHome(async () => {
      process.env.DEEP_RESEARCH_ENABLED = "false";
      process.env.DEEP_RESEARCH_DRY_RUN = "false";
      process.env.DEEP_RESEARCH_CLI_PATH = "/tmp/deep-research-cli.sh";
      process.env.DEEP_RESEARCH_OUTPUT_LANGUAGE = "ru";

      vi.resetModules();
      const { readConfigFileSnapshot } = await import("./config.js");
      const snap = await readConfigFileSnapshot();

      expect(snap.config.deepResearch?.enabled).toBe(false);
      expect(snap.config.deepResearch?.dryRun).toBe(false);
      expect(snap.config.deepResearch?.cliPath).toBe(
        "/tmp/deep-research-cli.sh",
      );
      expect(snap.config.deepResearch?.outputLanguage).toBe("ru");
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
