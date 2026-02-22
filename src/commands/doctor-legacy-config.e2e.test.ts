import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeLegacyConfigValues } from "./doctor-legacy-config.js";

describe("normalizeLegacyConfigValues", () => {
  let previousOauthDir: string | undefined;
  let tempOauthDir: string | undefined;

  const writeCreds = (dir: string) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "creds.json"), JSON.stringify({ me: {} }));
  };

  const expectNoWhatsAppConfigForLegacyAuth = (setup?: () => void) => {
    setup?.();
    const res = normalizeLegacyConfigValues({
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
    const res = normalizeLegacyConfigValues({
      messages: { ackReaction: "👀" },
    });

    expect(res.config.channels?.whatsapp).toBeUndefined();
    expect(res.changes).toEqual([]);
  });

  it("copies legacy ack reaction when whatsapp config exists", () => {
    const res = normalizeLegacyConfigValues({
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

      const res = normalizeLegacyConfigValues({
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
    const res = normalizeLegacyConfigValues({
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
    const res = normalizeLegacyConfigValues({
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
    const res = normalizeLegacyConfigValues({
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
    expect(res.changes).toEqual([
      "Normalized channels.discord.streaming boolean → enum (partial).",
      "Normalized channels.discord.accounts.work.streaming boolean → enum (off).",
    ]);
  });

  it("migrates Discord legacy streamMode into streaming enum", () => {
    const res = normalizeLegacyConfigValues({
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
    const res = normalizeLegacyConfigValues({
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
    const res = normalizeLegacyConfigValues({
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
});
