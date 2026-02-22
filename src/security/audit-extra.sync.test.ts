import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  collectAttackSurfaceSummaryFindings,
  collectSecretsInConfigFindings,
} from "./audit-extra.sync.js";
import { safeEqualSecret } from "./secret-equal.js";

describe("collectAttackSurfaceSummaryFindings", () => {
  it("distinguishes external webhooks from internal hooks when only internal hooks are enabled", () => {
    const cfg: OpenClawConfig = {
      hooks: { internal: { enabled: true } },
    };

    const [finding] = collectAttackSurfaceSummaryFindings(cfg);
    expect(finding.checkId).toBe("summary.attack_surface");
    expect(finding.detail).toContain("hooks.webhooks: disabled");
    expect(finding.detail).toContain("hooks.internal: enabled");
  });

  it("reports both hook systems as enabled when both are configured", () => {
    const cfg: OpenClawConfig = {
      hooks: { enabled: true, internal: { enabled: true } },
    };

    const [finding] = collectAttackSurfaceSummaryFindings(cfg);
    expect(finding.detail).toContain("hooks.webhooks: enabled");
    expect(finding.detail).toContain("hooks.internal: enabled");
  });

  it("reports both hook systems as disabled when neither is configured", () => {
    const cfg: OpenClawConfig = {};

    const [finding] = collectAttackSurfaceSummaryFindings(cfg);
    expect(finding.detail).toContain("hooks.webhooks: disabled");
    expect(finding.detail).toContain("hooks.internal: disabled");
  });
});

describe("collectSecretsInConfigFindings — credential detection", () => {
  it("detects plaintext API key in model provider config", () => {
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          anthropic: { baseUrl: "https://api.anthropic.com", apiKey: "sk-ant-real-key" },
        },
      },
    };
    const findings = collectSecretsInConfigFindings(cfg);
    const f = findings.find((f) => f.checkId === "credentials.plaintext_api_keys");
    expect(f).toBeDefined();
    expect(f?.detail).toContain("models.providers.anthropic.apiKey");
  });

  it("skips API key using env var reference", () => {
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          anthropic: { baseUrl: "https://api.anthropic.com", apiKey: "${ANTHROPIC_API_KEY}" },
        },
      },
    };
    const findings = collectSecretsInConfigFindings(cfg);
    expect(findings.find((f) => f.checkId === "credentials.plaintext_api_keys")).toBeUndefined();
  });

  it("skips API key using secret provider reference", () => {
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          anthropic: { baseUrl: "https://api.anthropic.com", apiKey: "${bw:anthropic/password}" },
        },
      },
    };
    const findings = collectSecretsInConfigFindings(cfg);
    expect(findings.find((f) => f.checkId === "credentials.plaintext_api_keys")).toBeUndefined();
  });

  it("detects plaintext Telegram bot token", () => {
    const cfg: OpenClawConfig = {
      channels: { telegram: { botToken: "7123456789:AAHxxxxx" } },
    } as OpenClawConfig;
    const findings = collectSecretsInConfigFindings(cfg);
    const f = findings.find((f) => f.checkId === "credentials.plaintext_channel_tokens");
    expect(f).toBeDefined();
    expect(f?.detail).toContain("channels.telegram.botToken");
  });

  it("detects plaintext Discord token", () => {
    const cfg: OpenClawConfig = {
      channels: { discord: { token: "MTIzNDU2Nzg5.xxxxx" } },
    } as OpenClawConfig;
    const findings = collectSecretsInConfigFindings(cfg);
    const f = findings.find((f) => f.checkId === "credentials.plaintext_channel_tokens");
    expect(f).toBeDefined();
    expect(f?.detail).toContain("channels.discord.token");
  });

  it("detects plaintext Slack tokens", () => {
    const cfg: OpenClawConfig = {
      channels: { slack: { botToken: "xoxb-xxx", appToken: "xapp-xxx" } },
    } as OpenClawConfig;
    const findings = collectSecretsInConfigFindings(cfg);
    const f = findings.find((f) => f.checkId === "credentials.plaintext_channel_tokens");
    expect(f).toBeDefined();
    expect(f?.detail).toContain("channels.slack.botToken");
    expect(f?.detail).toContain("channels.slack.appToken");
  });

  it("skips channel tokens using env var references", () => {
    const cfg: OpenClawConfig = {
      channels: { telegram: { botToken: "${TELEGRAM_BOT_TOKEN}" } },
    } as OpenClawConfig;
    const findings = collectSecretsInConfigFindings(cfg);
    expect(
      findings.find((f) => f.checkId === "credentials.plaintext_channel_tokens"),
    ).toBeUndefined();
  });

  it("detects plaintext TTS API key", () => {
    const cfg: OpenClawConfig = {
      tts: { elevenlabs: { apiKey: "el_xxxxx" } },
    } as OpenClawConfig;
    const findings = collectSecretsInConfigFindings(cfg);
    const f = findings.find((f) => f.checkId === "credentials.plaintext_tts_keys");
    expect(f).toBeDefined();
    expect(f?.detail).toContain("tts.elevenlabs.apiKey");
  });

  it("detects plaintext webhook secrets", () => {
    const cfg: OpenClawConfig = {
      gateway: { controlUi: { webhookToken: "raw-token-123" } },
    } as OpenClawConfig;
    const findings = collectSecretsInConfigFindings(cfg);
    const f = findings.find((f) => f.checkId === "credentials.plaintext_webhook_secrets");
    expect(f).toBeDefined();
    expect(f?.detail).toContain("gateway.controlUi.webhookToken");
  });

  it("reports no_secret_provider when plaintext exists and no provider configured", () => {
    const cfg: OpenClawConfig = {
      models: {
        providers: { anthropic: { baseUrl: "https://api.anthropic.com", apiKey: "sk-ant-key" } },
      },
    };
    const findings = collectSecretsInConfigFindings(cfg);
    const f = findings.find((f) => f.checkId === "credentials.no_secret_provider");
    expect(f).toBeDefined();
    expect(f?.severity).toBe("info");
  });

  it("does not report no_secret_provider when all secrets use env refs", () => {
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          anthropic: { baseUrl: "https://api.anthropic.com", apiKey: "${ANTHROPIC_API_KEY}" },
        },
      },
    };
    const findings = collectSecretsInConfigFindings(cfg);
    expect(findings.find((f) => f.checkId === "credentials.no_secret_provider")).toBeUndefined();
  });

  it("produces no credential findings for empty config", () => {
    const cfg: OpenClawConfig = {};
    const findings = collectSecretsInConfigFindings(cfg);
    const credFindings = findings.filter((f) => f.checkId.startsWith("credentials."));
    expect(credFindings).toHaveLength(0);
  });

  it("detects multiple plaintext keys across providers", () => {
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          anthropic: { baseUrl: "https://api.anthropic.com", apiKey: "sk-ant-xxx" },
          openai: { baseUrl: "https://api.openai.com", apiKey: "sk-xxx" },
        },
      },
    };
    const findings = collectSecretsInConfigFindings(cfg);
    const f = findings.find((f) => f.checkId === "credentials.plaintext_api_keys");
    expect(f).toBeDefined();
    expect(f?.title).toContain("2 API key(s)");
  });
});

describe("safeEqualSecret", () => {
  it("matches identical secrets", () => {
    expect(safeEqualSecret("secret-token", "secret-token")).toBe(true);
  });

  it("rejects mismatched secrets", () => {
    expect(safeEqualSecret("secret-token", "secret-tokEn")).toBe(false);
  });

  it("rejects different-length secrets", () => {
    expect(safeEqualSecret("short", "much-longer")).toBe(false);
  });

  it("rejects missing values", () => {
    expect(safeEqualSecret(undefined, "secret")).toBe(false);
    expect(safeEqualSecret("secret", undefined)).toBe(false);
    expect(safeEqualSecret(null, "secret")).toBe(false);
  });
});
