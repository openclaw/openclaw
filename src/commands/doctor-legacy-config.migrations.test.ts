import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeCompatibilityConfigValues } from "./doctor-legacy-config.js";

describe("normalizeCompatibilityConfigValues", () => {
  let previousOauthDir: string | undefined;
  let tempOauthDir: string | undefined;

  const writeCreds = (dir: string) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "creds.json"), JSON.stringify({ me: {} }));
  };

  const expectNoWhatsAppConfigForLegacyAuth = (setup?: () => void) => {
    setup?.();
    const res = normalizeCompatibilityConfigValues({
      messages: { ackReaction: "👀", ackReactionScope: "group-mentions" },
    });
    expect(res.config.channels?.whatsapp).toBeUndefined();
    expect(res.changes).toEqual([]);
  };

  beforeEach(() => {
    previousOauthDir = process.env.OPENCLAW_OAUTH_DIR;
    tempOauthDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-oauth-"));
    process.env.OPENCLAW_OAUTH_DIR = tempOauthDir;
  });

  afterEach(() => {
    if (previousOauthDir === undefined) {
      delete process.env.OPENCLAW_OAUTH_DIR;
    } else {
      process.env.OPENCLAW_OAUTH_DIR = previousOauthDir;
    }
    if (tempOauthDir) {
      fs.rmSync(tempOauthDir, { recursive: true, force: true });
      tempOauthDir = undefined;
    }
  });

  it("does not add whatsapp config when missing and no auth exists", () => {
    const res = normalizeCompatibilityConfigValues({
      messages: { ackReaction: "👀" },
    });

    expect(res.config.channels?.whatsapp).toBeUndefined();
    expect(res.changes).toEqual([]);
  });

  it("copies legacy ack reaction when whatsapp config exists", () => {
    const res = normalizeCompatibilityConfigValues({
      messages: { ackReaction: "👀", ackReactionScope: "group-mentions" },
      channels: { whatsapp: {} },
    });

    expect(res.config.channels?.whatsapp?.ackReaction).toEqual({
      emoji: "👀",
      direct: false,
      group: "mentions",
    });
    expect(res.changes).toEqual([
      "Copied messages.ackReaction → channels.whatsapp.ackReaction (scope: group-mentions).",
    ]);
  });

  it("does not add whatsapp config when only auth exists (issue #900)", () => {
    expectNoWhatsAppConfigForLegacyAuth(() => {
      const credsDir = path.join(tempOauthDir ?? "", "whatsapp", "default");
      writeCreds(credsDir);
    });
  });

  it("does not add whatsapp config when only legacy auth exists (issue #900)", () => {
    expectNoWhatsAppConfigForLegacyAuth(() => {
      const credsPath = path.join(tempOauthDir ?? "", "creds.json");
      fs.writeFileSync(credsPath, JSON.stringify({ me: {} }));
    });
  });

  it("does not add whatsapp config when only non-default auth exists (issue #900)", () => {
    expectNoWhatsAppConfigForLegacyAuth(() => {
      const credsDir = path.join(tempOauthDir ?? "", "whatsapp", "work");
      writeCreds(credsDir);
    });
  });

  it("copies legacy ack reaction when authDir override exists", () => {
    const customDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-wa-auth-"));
    try {
      writeCreds(customDir);

      const res = normalizeCompatibilityConfigValues({
        messages: { ackReaction: "👀", ackReactionScope: "group-mentions" },
        channels: { whatsapp: { accounts: { work: { authDir: customDir } } } },
      });

      expect(res.config.channels?.whatsapp?.ackReaction).toEqual({
        emoji: "👀",
        direct: false,
        group: "mentions",
      });
    } finally {
      fs.rmSync(customDir, { recursive: true, force: true });
    }
  });

  it("migrates Slack dm.policy/dm.allowFrom to dmPolicy/allowFrom aliases", () => {
    const res = normalizeCompatibilityConfigValues({
      channels: {
        slack: {
          dm: { enabled: true, policy: "open", allowFrom: ["*"] },
        },
      },
    });

    expect(res.config.channels?.slack?.dmPolicy).toBe("open");
    expect(res.config.channels?.slack?.allowFrom).toEqual(["*"]);
    expect(res.config.channels?.slack?.dm).toEqual({ enabled: true });
    expect(res.changes).toEqual([
      "Moved channels.slack.dm.policy → channels.slack.dmPolicy.",
      "Moved channels.slack.dm.allowFrom → channels.slack.allowFrom.",
    ]);
  });

  it("migrates Discord account dm.policy/dm.allowFrom to dmPolicy/allowFrom aliases", () => {
    const res = normalizeCompatibilityConfigValues({
      channels: {
        discord: {
          accounts: {
            work: {
              dm: { policy: "allowlist", allowFrom: ["123"], groupEnabled: true },
            },
          },
        },
      },
    });

    expect(res.config.channels?.discord?.accounts?.work?.dmPolicy).toBe("allowlist");
    expect(res.config.channels?.discord?.accounts?.work?.allowFrom).toEqual(["123"]);
    expect(res.config.channels?.discord?.accounts?.work?.dm).toEqual({ groupEnabled: true });
    expect(res.changes).toEqual([
      "Moved channels.discord.accounts.work.dm.policy → channels.discord.accounts.work.dmPolicy.",
      "Moved channels.discord.accounts.work.dm.allowFrom → channels.discord.accounts.work.allowFrom.",
    ]);
  });

  it("migrates Discord streaming boolean alias to streaming enum", () => {
    const res = normalizeCompatibilityConfigValues({
      channels: {
        discord: {
          streaming: true,
          accounts: {
            work: {
              streaming: false,
            },
          },
        },
      },
    });

    expect(res.config.channels?.discord?.streaming).toBe("partial");
    expect(res.config.channels?.discord?.streamMode).toBeUndefined();
    expect(res.config.channels?.discord?.accounts?.work?.streaming).toBe("off");
    expect(res.config.channels?.discord?.accounts?.work?.streamMode).toBeUndefined();
    expect(res.changes).toContain(
      "Normalized channels.discord.streaming boolean → enum (partial).",
    );
    expect(res.changes).toContain(
      "Normalized channels.discord.accounts.work.streaming boolean → enum (off).",
    );
  });

  it("migrates Discord legacy streamMode into streaming enum", () => {
    const res = normalizeCompatibilityConfigValues({
      channels: {
        discord: {
          streaming: false,
          streamMode: "block",
        },
      },
    });

    expect(res.config.channels?.discord?.streaming).toBe("block");
    expect(res.config.channels?.discord?.streamMode).toBeUndefined();
    expect(res.changes).toEqual([
      "Moved channels.discord.streamMode → channels.discord.streaming (block).",
      "Normalized channels.discord.streaming boolean → enum (block).",
    ]);
  });

  it("migrates Telegram streamMode into streaming enum", () => {
    const res = normalizeCompatibilityConfigValues({
      channels: {
        telegram: {
          streamMode: "block",
        },
      },
    });

    expect(res.config.channels?.telegram?.streaming).toBe("block");
    expect(res.config.channels?.telegram?.streamMode).toBeUndefined();
    expect(res.changes).toEqual([
      "Moved channels.telegram.streamMode → channels.telegram.streaming (block).",
    ]);
  });

  it("migrates Slack legacy streaming keys to unified config", () => {
    const res = normalizeCompatibilityConfigValues({
      channels: {
        slack: {
          streaming: false,
          streamMode: "status_final",
        },
      },
    });

    expect(res.config.channels?.slack?.streaming).toBe("progress");
    expect(res.config.channels?.slack?.nativeStreaming).toBe(false);
    expect(res.config.channels?.slack?.streamMode).toBeUndefined();
    expect(res.changes).toEqual([
      "Moved channels.slack.streamMode → channels.slack.streaming (progress).",
      "Moved channels.slack.streaming (boolean) → channels.slack.nativeStreaming (false).",
    ]);
  });

  it("moves missing default account from single-account top-level config when named accounts already exist", () => {
    const res = normalizeCompatibilityConfigValues({
      channels: {
        telegram: {
          enabled: true,
          botToken: "legacy-token",
          dmPolicy: "allowlist",
          allowFrom: ["123"],
          groupPolicy: "allowlist",
          streaming: "partial",
          accounts: {
            alerts: {
              enabled: true,
              botToken: "alerts-token",
            },
          },
        },
      },
    });

    expect(res.config.channels?.telegram?.accounts?.default).toEqual({
      botToken: "legacy-token",
      dmPolicy: "allowlist",
      allowFrom: ["123"],
      groupPolicy: "allowlist",
      streaming: "partial",
    });
    expect(res.config.channels?.telegram?.botToken).toBeUndefined();
    expect(res.config.channels?.telegram?.dmPolicy).toBeUndefined();
    expect(res.config.channels?.telegram?.allowFrom).toBeUndefined();
    expect(res.config.channels?.telegram?.groupPolicy).toBeUndefined();
    expect(res.config.channels?.telegram?.streaming).toBeUndefined();
    expect(res.config.channels?.telegram?.accounts?.alerts?.botToken).toBe("alerts-token");
    expect(res.changes).toContain(
      "Moved channels.telegram single-account top-level values into channels.telegram.accounts.default.",
    );
  });

  it("migrates browser ssrfPolicy allowPrivateNetwork to dangerouslyAllowPrivateNetwork", () => {
    const res = normalizeCompatibilityConfigValues({
      browser: {
        ssrfPolicy: {
          allowPrivateNetwork: true,
          allowedHostnames: ["localhost"],
        },
      },
    });

    expect(res.config.browser?.ssrfPolicy?.allowPrivateNetwork).toBeUndefined();
    expect(res.config.browser?.ssrfPolicy?.dangerouslyAllowPrivateNetwork).toBe(true);
    expect(res.config.browser?.ssrfPolicy?.allowedHostnames).toEqual(["localhost"]);
    expect(res.changes).toContain(
      "Moved browser.ssrfPolicy.allowPrivateNetwork → browser.ssrfPolicy.dangerouslyAllowPrivateNetwork (true).",
    );
  });

  it("normalizes conflicting browser SSRF alias keys without changing effective behavior", () => {
    const res = normalizeCompatibilityConfigValues({
      browser: {
        ssrfPolicy: {
          allowPrivateNetwork: true,
          dangerouslyAllowPrivateNetwork: false,
        },
      },
    });

    expect(res.config.browser?.ssrfPolicy?.allowPrivateNetwork).toBeUndefined();
    expect(res.config.browser?.ssrfPolicy?.dangerouslyAllowPrivateNetwork).toBe(true);
    expect(res.changes).toContain(
      "Moved browser.ssrfPolicy.allowPrivateNetwork → browser.ssrfPolicy.dangerouslyAllowPrivateNetwork (true).",
    );
  });

  it("migrates nano-banana skill config to native image generation config", () => {
    const res = normalizeCompatibilityConfigValues({
      skills: {
        entries: {
          "nano-banana-pro": {
            enabled: true,
            apiKey: { source: "env", provider: "default", id: "GEMINI_API_KEY" },
          },
        },
      },
    });

    expect(res.config.agents?.defaults?.imageGenerationModel).toEqual({
      primary: "google/gemini-3-pro-image-preview",
    });
    expect(res.config.models?.providers?.google?.apiKey).toEqual({
      source: "env",
      provider: "default",
      id: "GEMINI_API_KEY",
    });
    expect(res.config.skills?.entries).toBeUndefined();
    expect(res.changes).toEqual([
      "Moved skills.entries.nano-banana-pro → agents.defaults.imageGenerationModel.primary (google/gemini-3-pro-image-preview).",
      "Moved skills.entries.nano-banana-pro.apiKey → models.providers.google.apiKey.",
      "Removed legacy skills.entries.nano-banana-pro.",
    ]);
  });

  it("prefers legacy nano-banana env.GEMINI_API_KEY over skill apiKey during migration", () => {
    const res = normalizeCompatibilityConfigValues({
      skills: {
        entries: {
          "nano-banana-pro": {
            apiKey: "ignored-skill-api-key",
            env: {
              GEMINI_API_KEY: "env-gemini-key",
            },
          },
        },
      },
    });

    expect(res.config.models?.providers?.google?.apiKey).toBe("env-gemini-key");
    expect(res.changes).toContain(
      "Moved skills.entries.nano-banana-pro.env.GEMINI_API_KEY → models.providers.google.apiKey.",
    );
  });

  it("preserves explicit native config while removing legacy nano-banana skill config", () => {
    const res = normalizeCompatibilityConfigValues({
      agents: {
        defaults: {
          imageGenerationModel: {
            primary: "fal/fal-ai/flux/dev",
          },
        },
      },
      models: {
        providers: {
          google: {
            apiKey: "existing-google-key",
          },
        },
      },
      skills: {
        entries: {
          "nano-banana-pro": {
            apiKey: "legacy-gemini-key",
          },
          peekaboo: { enabled: true },
        },
      },
    });

    expect(res.config.agents?.defaults?.imageGenerationModel).toEqual({
      primary: "fal/fal-ai/flux/dev",
    });
    expect(res.config.models?.providers?.google?.apiKey).toBe("existing-google-key");
    expect(res.config.skills?.entries).toEqual({
      peekaboo: { enabled: true },
    });
    expect(res.changes).toEqual(["Removed legacy skills.entries.nano-banana-pro."]);
  });

  it("removes nano-banana from skills.allowBundled during migration", () => {
    const res = normalizeCompatibilityConfigValues({
      skills: {
        allowBundled: ["peekaboo", "nano-banana-pro"],
      },
    });

    expect(res.config.skills?.allowBundled).toEqual(["peekaboo"]);
    expect(res.changes).toEqual(["Removed nano-banana-pro from skills.allowBundled."]);
  });
});
