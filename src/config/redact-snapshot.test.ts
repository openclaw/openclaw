import { describe, expect, it } from "vitest";
import type { ConfigUiHints } from "./schema.js";
import type { ConfigFileSnapshot } from "./types.openclaw.js";
import {
  REDACTED_SENTINEL,
  redactConfigSnapshot,
  restoreRedactedValues,
} from "./redact-snapshot.js";

function makeSnapshot(config: Record<string, unknown>, raw?: string): ConfigFileSnapshot {
  return {
    path: "/home/user/.openclaw/config.json5",
    exists: true,
    raw: raw ?? JSON.stringify(config),
    parsed: config,
    valid: true,
    config: config as ConfigFileSnapshot["config"],
    hash: "abc123",
    issues: [],
    warnings: [],
    legacyIssues: [],
  };
}

describe("redactConfigSnapshot", () => {
  it("redacts top-level token fields", () => {
    const snapshot = makeSnapshot({
      gateway: { auth: { token: "my-super-secret-gateway-token-value" } },
    });
    const result = redactConfigSnapshot(snapshot);
    expect(result.config).toEqual({
      gateway: { auth: { token: REDACTED_SENTINEL } },
    });
  });

  it("redacts botToken in channel configs", () => {
    const snapshot = makeSnapshot({
      channels: {
        telegram: { botToken: "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef" },
        slack: { botToken: "fake-slack-bot-token-placeholder-value" },
      },
    });
    const result = redactConfigSnapshot(snapshot);
    const channels = result.config.channels as Record<string, Record<string, string>>;
    expect(channels.telegram.botToken).toBe(REDACTED_SENTINEL);
    expect(channels.slack.botToken).toBe(REDACTED_SENTINEL);
  });

  it("redacts apiKey in model providers", () => {
    const snapshot = makeSnapshot({
      models: {
        providers: {
          openai: { apiKey: "sk-proj-abcdef1234567890ghij", baseUrl: "https://api.openai.com" },
        },
      },
    });
    const result = redactConfigSnapshot(snapshot);
    const models = result.config.models as Record<string, Record<string, Record<string, string>>>;
    expect(models.providers.openai.apiKey).toBe(REDACTED_SENTINEL);
    expect(models.providers.openai.baseUrl).toBe("https://api.openai.com");
  });

  it("redacts password fields", () => {
    const snapshot = makeSnapshot({
      gateway: { auth: { password: "super-secret-password-value-here" } },
    });
    const result = redactConfigSnapshot(snapshot);
    const gw = result.config.gateway as Record<string, Record<string, string>>;
    expect(gw.auth.password).toBe(REDACTED_SENTINEL);
  });

  it("redacts appSecret fields", () => {
    const snapshot = makeSnapshot({
      channels: {
        feishu: { appSecret: "feishu-app-secret-value-here-1234" },
      },
    });
    const result = redactConfigSnapshot(snapshot);
    const channels = result.config.channels as Record<string, Record<string, string>>;
    expect(channels.feishu.appSecret).toBe(REDACTED_SENTINEL);
  });

  it("redacts signingSecret fields", () => {
    const snapshot = makeSnapshot({
      channels: {
        slack: { signingSecret: "slack-signing-secret-value-1234" },
      },
    });
    const result = redactConfigSnapshot(snapshot);
    const channels = result.config.channels as Record<string, Record<string, string>>;
    expect(channels.slack.signingSecret).toBe(REDACTED_SENTINEL);
  });

  it("redacts short secrets with same sentinel", () => {
    const snapshot = makeSnapshot({
      gateway: { auth: { token: "short" } },
    });
    const result = redactConfigSnapshot(snapshot);
    const gw = result.config.gateway as Record<string, Record<string, string>>;
    expect(gw.auth.token).toBe(REDACTED_SENTINEL);
  });

  it("preserves non-sensitive fields", () => {
    const snapshot = makeSnapshot({
      ui: { seamColor: "#0088cc" },
      gateway: { port: 18789 },
      models: { providers: { openai: { baseUrl: "https://api.openai.com" } } },
    });
    const result = redactConfigSnapshot(snapshot);
    expect(result.config).toEqual(snapshot.config);
  });

  it("preserves hash unchanged", () => {
    const snapshot = makeSnapshot({ gateway: { auth: { token: "secret-token-value-here" } } });
    const result = redactConfigSnapshot(snapshot);
    expect(result.hash).toBe("abc123");
  });

  it("redacts secrets in raw field via text-based redaction", () => {
    const config = { token: "abcdef1234567890ghij" };
    const raw = '{ "token": "abcdef1234567890ghij" }';
    const snapshot = makeSnapshot(config, raw);
    const result = redactConfigSnapshot(snapshot);
    expect(result.raw).not.toContain("abcdef1234567890ghij");
    expect(result.raw).toContain(REDACTED_SENTINEL);
  });

  it("redacts parsed object as well", () => {
    const config = {
      channels: { discord: { token: "MTIzNDU2Nzg5MDEyMzQ1Njc4.GaBcDe.FgH" } },
    };
    const snapshot = makeSnapshot(config);
    const result = redactConfigSnapshot(snapshot);
    const parsed = result.parsed as Record<string, Record<string, Record<string, string>>>;
    expect(parsed.channels.discord.token).toBe(REDACTED_SENTINEL);
  });

  it("handles null raw gracefully", () => {
    const snapshot: ConfigFileSnapshot = {
      path: "/test",
      exists: false,
      raw: null,
      parsed: null,
      valid: false,
      config: {} as ConfigFileSnapshot["config"],
      issues: [],
      warnings: [],
      legacyIssues: [],
    };
    const result = redactConfigSnapshot(snapshot);
    expect(result.raw).toBeNull();
    expect(result.parsed).toBeNull();
  });

  it("handles deeply nested tokens in accounts", () => {
    const snapshot = makeSnapshot({
      channels: {
        slack: {
          accounts: {
            workspace1: { botToken: "fake-workspace1-token-abcdefghij" },
            workspace2: { appToken: "fake-workspace2-token-abcdefghij" },
          },
        },
      },
    });
    const result = redactConfigSnapshot(snapshot);
    const channels = result.config.channels as Record<
      string,
      Record<string, Record<string, Record<string, string>>>
    >;
    expect(channels.slack.accounts.workspace1.botToken).toBe(REDACTED_SENTINEL);
    expect(channels.slack.accounts.workspace2.appToken).toBe(REDACTED_SENTINEL);
  });

  it("handles webhookSecret field", () => {
    const snapshot = makeSnapshot({
      channels: {
        telegram: { webhookSecret: "telegram-webhook-secret-value-1234" },
      },
    });
    const result = redactConfigSnapshot(snapshot);
    const channels = result.config.channels as Record<string, Record<string, string>>;
    expect(channels.telegram.webhookSecret).toBe(REDACTED_SENTINEL);
  });

  it("redacts env vars that look like secrets", () => {
    const snapshot = makeSnapshot({
      env: {
        vars: {
          OPENAI_API_KEY: "sk-proj-1234567890abcdefghij",
          NODE_ENV: "production",
        },
      },
    });
    const result = redactConfigSnapshot(snapshot);
    const env = result.config.env as Record<string, Record<string, string>>;
    // NODE_ENV is not sensitive, should be preserved
    expect(env.vars.NODE_ENV).toBe("production");
  });

  it("does NOT redact numeric 'tokens' fields (token regex fix)", () => {
    const snapshot = makeSnapshot({
      memory: { tokens: 8192 },
    });
    const result = redactConfigSnapshot(snapshot);
    const memory = result.config.memory as Record<string, number>;
    expect(memory.tokens).toBe(8192);
  });

  it("does NOT redact 'softThresholdTokens' (token regex fix)", () => {
    const snapshot = makeSnapshot({
      compaction: { softThresholdTokens: 50000 },
    });
    const result = redactConfigSnapshot(snapshot);
    const compaction = result.config.compaction as Record<string, number>;
    expect(compaction.softThresholdTokens).toBe(50000);
  });

  it("does NOT redact string 'tokens' field either", () => {
    const snapshot = makeSnapshot({
      memory: { tokens: "should-not-be-redacted" },
    });
    const result = redactConfigSnapshot(snapshot);
    const memory = result.config.memory as Record<string, string>;
    expect(memory.tokens).toBe("should-not-be-redacted");
  });

  it("still redacts 'token' (singular) fields", () => {
    const snapshot = makeSnapshot({
      channels: { slack: { token: "secret-slack-token-value-here" } },
    });
    const result = redactConfigSnapshot(snapshot);
    const channels = result.config.channels as Record<string, Record<string, string>>;
    expect(channels.slack.token).toBe(REDACTED_SENTINEL);
  });

  it("uses uiHints to determine sensitivity", () => {
    const hints: ConfigUiHints = {
      "custom.mySecret": { sensitive: true },
    };
    const snapshot = makeSnapshot({
      custom: { mySecret: "this-is-a-custom-secret-value" },
    });
    const result = redactConfigSnapshot(snapshot, hints);
    const custom = result.config.custom as Record<string, string>;
    expect(custom.mySecret).toBe(REDACTED_SENTINEL);
  });

  it("respects sensitive:false in uiHints even for regex-matching paths", () => {
    const hints: ConfigUiHints = {
      "gateway.auth.token": { sensitive: false },
    };
    const snapshot = makeSnapshot({
      gateway: { auth: { token: "not-actually-secret-value" } },
    });
    const result = redactConfigSnapshot(snapshot, hints);
    const gw = result.config.gateway as Record<string, Record<string, string>>;
    expect(gw.auth.token).toBe("not-actually-secret-value");
  });

  it("does not redact paths absent from uiHints (schema is single source of truth)", () => {
    const hints: ConfigUiHints = {
      "some.other.path": { sensitive: true },
    };
    const snapshot = makeSnapshot({
      gateway: { auth: { password: "not-in-hints-value" } },
    });
    const result = redactConfigSnapshot(snapshot, hints);
    const gw = result.config.gateway as Record<string, Record<string, string>>;
    expect(gw.auth.password).toBe("not-in-hints-value");
  });

  it("uses wildcard hints for array items", () => {
    const hints: ConfigUiHints = {
      "channels.slack.accounts.*.botToken": { sensitive: true },
    };
    const snapshot = makeSnapshot({
      channels: {
        slack: {
          accounts: [
            { botToken: "first-account-token-value-here" },
            { botToken: "second-account-token-value-here" },
          ],
        },
      },
    });
    const result = redactConfigSnapshot(snapshot, hints);
    const channels = result.config.channels as Record<
      string,
      Record<string, Array<Record<string, string>>>
    >;
    expect(channels.slack.accounts[0].botToken).toBe(REDACTED_SENTINEL);
    expect(channels.slack.accounts[1].botToken).toBe(REDACTED_SENTINEL);
  });
});

describe("restoreRedactedValues", () => {
  it("restores sentinel values from original config", () => {
    const incoming = {
      gateway: { auth: { token: REDACTED_SENTINEL } },
    };
    const original = {
      gateway: { auth: { token: "real-secret-token-value" } },
    };
    const result = restoreRedactedValues(incoming, original) as typeof incoming;
    expect(result.gateway.auth.token).toBe("real-secret-token-value");
  });

  it("preserves explicitly changed sensitive values", () => {
    const incoming = {
      gateway: { auth: { token: "new-token-value-from-user" } },
    };
    const original = {
      gateway: { auth: { token: "old-token-value" } },
    };
    const result = restoreRedactedValues(incoming, original) as typeof incoming;
    expect(result.gateway.auth.token).toBe("new-token-value-from-user");
  });

  it("preserves non-sensitive fields unchanged", () => {
    const incoming = {
      ui: { seamColor: "#ff0000" },
      gateway: { port: 9999, auth: { token: REDACTED_SENTINEL } },
    };
    const original = {
      ui: { seamColor: "#0088cc" },
      gateway: { port: 18789, auth: { token: "real-secret" } },
    };
    const result = restoreRedactedValues(incoming, original) as typeof incoming;
    expect(result.ui.seamColor).toBe("#ff0000");
    expect(result.gateway.port).toBe(9999);
    expect(result.gateway.auth.token).toBe("real-secret");
  });

  it("handles deeply nested sentinel restoration", () => {
    const incoming = {
      channels: {
        slack: {
          accounts: {
            ws1: { botToken: REDACTED_SENTINEL },
            ws2: { botToken: "user-typed-new-token-value" },
          },
        },
      },
    };
    const original = {
      channels: {
        slack: {
          accounts: {
            ws1: { botToken: "original-ws1-token-value" },
            ws2: { botToken: "original-ws2-token-value" },
          },
        },
      },
    };
    const result = restoreRedactedValues(incoming, original) as typeof incoming;
    expect(result.channels.slack.accounts.ws1.botToken).toBe("original-ws1-token-value");
    expect(result.channels.slack.accounts.ws2.botToken).toBe("user-typed-new-token-value");
  });

  it("handles missing original gracefully", () => {
    const incoming = {
      channels: { newChannel: { token: REDACTED_SENTINEL } },
    };
    const original = {};
    const result = restoreRedactedValues(incoming, original) as typeof incoming;
    // No original to restore from, sentinel stays
    expect(result.channels.newChannel.token).toBe(REDACTED_SENTINEL);
  });

  it("handles null and undefined inputs", () => {
    expect(restoreRedactedValues(null, { token: "x" })).toBeNull();
    expect(restoreRedactedValues(undefined, { token: "x" })).toBeUndefined();
  });

  it("round-trips config through redact → restore", () => {
    const originalConfig = {
      gateway: { auth: { token: "gateway-auth-secret-token-value" }, port: 18789 },
      channels: {
        slack: { botToken: "fake-slack-token-placeholder-value" },
        telegram: {
          botToken: "fake-telegram-token-placeholder-value",
          webhookSecret: "fake-tg-secret-placeholder-value",
        },
      },
      models: {
        providers: {
          openai: {
            apiKey: "sk-proj-fake-openai-api-key-value",
            baseUrl: "https://api.openai.com",
          },
        },
      },
      ui: { seamColor: "#0088cc" },
    };
    const snapshot = makeSnapshot(originalConfig);

    // Redact (simulates config.get response)
    const redacted = redactConfigSnapshot(snapshot);

    // Restore (simulates config.set before write)
    const restored = restoreRedactedValues(redacted.config, snapshot.config);

    expect(restored).toEqual(originalConfig);
  });

  it("round-trips with uiHints for custom sensitive fields", () => {
    const hints: ConfigUiHints = {
      "custom.myApiKey": { sensitive: true },
      "custom.displayName": { sensitive: false },
    };
    const originalConfig = {
      custom: { myApiKey: "secret-custom-api-key-value", displayName: "My Bot" },
    };
    const snapshot = makeSnapshot(originalConfig);
    const redacted = redactConfigSnapshot(snapshot, hints);
    const custom = redacted.config.custom as Record<string, string>;
    expect(custom.myApiKey).toBe(REDACTED_SENTINEL);
    expect(custom.displayName).toBe("My Bot");

    const restored = restoreRedactedValues(
      redacted.config,
      snapshot.config,
      hints,
    ) as typeof originalConfig;
    expect(restored).toEqual(originalConfig);
  });

  it("restores with uiHints respecting sensitive:false override", () => {
    const hints: ConfigUiHints = {
      "gateway.auth.token": { sensitive: false },
    };
    const incoming = {
      gateway: { auth: { token: REDACTED_SENTINEL } },
    };
    const original = {
      gateway: { auth: { token: "real-secret" } },
    };
    // With sensitive:false, the sentinel is NOT on a sensitive path,
    // so restore should NOT replace it (it's treated as a literal value)
    const result = restoreRedactedValues(incoming, original, hints) as typeof incoming;
    expect(result.gateway.auth.token).toBe(REDACTED_SENTINEL);
  });

  it("restores array items using wildcard uiHints", () => {
    const hints: ConfigUiHints = {
      "channels.slack.accounts.*.botToken": { sensitive: true },
    };
    const incoming = {
      channels: {
        slack: {
          accounts: [
            { botToken: REDACTED_SENTINEL },
            { botToken: "user-provided-new-token-value" },
          ],
        },
      },
    };
    const original = {
      channels: {
        slack: {
          accounts: [
            { botToken: "original-token-first-account" },
            { botToken: "original-token-second-account" },
          ],
        },
      },
    };
    const result = restoreRedactedValues(incoming, original, hints) as typeof incoming;
    expect(result.channels.slack.accounts[0].botToken).toBe("original-token-first-account");
    expect(result.channels.slack.accounts[1].botToken).toBe("user-provided-new-token-value");
  });
});
