import { describe, expect, it } from "vitest";
import type { ConfigUiHints } from "./schema.js";
import type { ConfigFileSnapshot } from "./types.openclaw.js";
import {
  REDACTED_SENTINEL,
  redactConfigSnapshot,
  restoreRedactedValues as restoreRedactedValues_orig,
} from "./redact-snapshot.js";
import { __test__ } from "./schema.hints.js";
import { OpenClawSchema } from "./zod-schema.js";

const { mapSensitivePaths } = __test__;

function makeSnapshot(config: Record<string, unknown>, raw?: string): ConfigFileSnapshot {
  return {
    path: "/home/user/.openclaw/config.json5",
    exists: true,
    raw: raw ?? JSON.stringify(config),
    parsed: config,
    resolved: config as ConfigFileSnapshot["resolved"],
    valid: true,
    config: config as ConfigFileSnapshot["config"],
    hash: "abc123",
    issues: [],
    warnings: [],
    legacyIssues: [],
  };
}

function restoreRedactedValues(
  incoming: unknown,
  original: unknown,
  hints?: ConfigUiHints,
): unknown {
  var result = restoreRedactedValues_orig(incoming, original, hints);
  expect(result.ok).toBe(true);
  return result.result;
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

  it("does not redact maxTokens-style fields", () => {
    const snapshot = makeSnapshot({
      maxTokens: 16384,
      models: {
        providers: {
          openai: {
            models: [
              {
                id: "gpt-5",
                maxTokens: 65536,
                contextTokens: 200000,
                maxTokensField: "max_completion_tokens",
              },
            ],
            apiKey: "sk-proj-abcdef1234567890ghij",
            accessToken: "access-token-value-1234567890",
            maxTokens: 8192,
            maxOutputTokens: 4096,
            maxCompletionTokens: 2048,
            contextTokens: 128000,
            tokenCount: 500,
            tokenLimit: 100000,
            tokenBudget: 50000,
          },
        },
      },
      gateway: { auth: { token: "secret-gateway-token-value" } },
    });

    const result = redactConfigSnapshot(snapshot);
    expect((result.config as Record<string, unknown>).maxTokens).toBe(16384);
    const models = result.config.models as Record<string, unknown>;
    const providerList = ((
      (models.providers as Record<string, unknown>).openai as Record<string, unknown>
    ).models ?? []) as Array<Record<string, unknown>>;
    expect(providerList[0]?.maxTokens).toBe(65536);
    expect(providerList[0]?.contextTokens).toBe(200000);
    expect(providerList[0]?.maxTokensField).toBe("max_completion_tokens");

    const providers = (models.providers as Record<string, Record<string, unknown>>) ?? {};
    expect(providers.openai.apiKey).toBe(REDACTED_SENTINEL);
    expect(providers.openai.accessToken).toBe(REDACTED_SENTINEL);
    expect(providers.openai.maxTokens).toBe(8192);
    expect(providers.openai.maxOutputTokens).toBe(4096);
    expect(providers.openai.maxCompletionTokens).toBe(2048);
    expect(providers.openai.contextTokens).toBe(128000);
    expect(providers.openai.tokenCount).toBe(500);
    expect(providers.openai.tokenLimit).toBe(100000);
    expect(providers.openai.tokenBudget).toBe(50000);

    const gw = result.config.gateway as Record<string, Record<string, string>>;
    expect(gw.auth.token).toBe(REDACTED_SENTINEL);
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

  it("redacts resolved object as well", () => {
    const config = {
      gateway: { auth: { token: "supersecrettoken123456" } },
    };
    const snapshot = makeSnapshot(config);
    const result = redactConfigSnapshot(snapshot);
    const resolved = result.resolved as Record<string, Record<string, Record<string, string>>>;
    expect(resolved.gateway.auth.token).toBe(REDACTED_SENTINEL);
  });

  it("handles null raw gracefully", () => {
    const snapshot: ConfigFileSnapshot = {
      path: "/test",
      exists: false,
      raw: null,
      parsed: null,
      resolved: {} as ConfigFileSnapshot["resolved"],
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

  it("withholds resolved config for invalid snapshots", () => {
    const snapshot: ConfigFileSnapshot = {
      path: "/test",
      exists: true,
      raw: '{ "gateway": { "auth": { "token": "leaky-secret" } } }',
      parsed: { gateway: { auth: { token: "leaky-secret" } } },
      resolved: { gateway: { auth: { token: "leaky-secret" } } } as ConfigFileSnapshot["resolved"],
      valid: false,
      config: {} as ConfigFileSnapshot["config"],
      issues: [{ path: "", message: "invalid config" }],
      warnings: [],
      legacyIssues: [],
    };
    const result = redactConfigSnapshot(snapshot);
    expect(result.raw).toBeNull();
    expect(result.parsed).toBeNull();
    expect(result.resolved).toEqual({});
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
    expect(env.vars.OPENAI_API_KEY).toBe(REDACTED_SENTINEL);
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

  it("keeps regex fallback for extension keys not covered by uiHints", () => {
    const hints: ConfigUiHints = {
      "plugins.entries.voice-call.config": { label: "Voice Call Config" },
      "channels.my-channel": { label: "My Channel" },
    };
    const snapshot = makeSnapshot({
      plugins: {
        entries: {
          "voice-call": {
            config: {
              apiToken: "voice-call-secret-token",
              displayName: "Voice call extension",
            },
          },
        },
      },
      channels: {
        "my-channel": {
          accessToken: "my-channel-secret-token",
          room: "general",
        },
      },
    });

    const redacted = redactConfigSnapshot(snapshot, hints);
    expect(redacted.config.plugins.entries["voice-call"].config.apiToken).toBe(REDACTED_SENTINEL);
    expect(redacted.config.plugins.entries["voice-call"].config.displayName).toBe(
      "Voice call extension",
    );
    expect(redacted.config.channels["my-channel"].accessToken).toBe(REDACTED_SENTINEL);
    expect(redacted.config.channels["my-channel"].room).toBe("general");

    const restored = restoreRedactedValues(redacted.config, snapshot.config, hints);
    expect(restored).toEqual(snapshot.config);
  });

  it("honors sensitive:false for extension keys even with regex fallback", () => {
    const hints: ConfigUiHints = {
      "plugins.entries.voice-call.config": { label: "Voice Call Config" },
      "plugins.entries.voice-call.config.apiToken": { sensitive: false },
    };
    const snapshot = makeSnapshot({
      plugins: {
        entries: {
          "voice-call": {
            config: {
              apiToken: "not-secret-on-purpose",
            },
          },
        },
      },
    });

    const redacted = redactConfigSnapshot(snapshot, hints);
    expect(redacted.config.plugins.entries["voice-call"].config.apiToken).toBe(
      "not-secret-on-purpose",
    );
  });

  it("handles nested values properly (roundtrip)", () => {
    const snapshot = makeSnapshot({
      custom1: { anykey: { mySecret: "this-is-a-custom-secret-value" } },
      custom2: [{ mySecret: "this-is-a-custom-secret-value" }],
    });
    const result = redactConfigSnapshot(snapshot);
    expect(result.config.custom1.anykey.mySecret).toBe(REDACTED_SENTINEL);
    expect(result.config.custom2[0].mySecret).toBe(REDACTED_SENTINEL);
    const restored = restoreRedactedValues(result.config, snapshot.config);
    expect(restored.custom1.anykey.mySecret).toBe("this-is-a-custom-secret-value");
    expect(restored.custom2[0].mySecret).toBe("this-is-a-custom-secret-value");
  });

  it("handles nested values properly with hints (roundtrip)", () => {
    const hints: ConfigUiHints = {
      "custom1.*.mySecret": { sensitive: true },
      "custom2[].mySecret": { sensitive: true },
    };
    const snapshot = makeSnapshot({
      custom1: { anykey: { mySecret: "this-is-a-custom-secret-value" } },
      custom2: [{ mySecret: "this-is-a-custom-secret-value" }],
    });
    const result = redactConfigSnapshot(snapshot, hints);
    expect(result.config.custom1.anykey.mySecret).toBe(REDACTED_SENTINEL);
    expect(result.config.custom2[0].mySecret).toBe(REDACTED_SENTINEL);
    const restored = restoreRedactedValues(result.config, snapshot.config, hints);
    expect(restored.custom1.anykey.mySecret).toBe("this-is-a-custom-secret-value");
    expect(restored.custom2[0].mySecret).toBe("this-is-a-custom-secret-value");
  });

  it("handles records that are directly sensitive (roundtrip)", () => {
    const snapshot = makeSnapshot({
      custom: { token: "this-is-a-custom-secret-value", mySecret: "this-is-a-custom-secret-value" },
    });
    const result = redactConfigSnapshot(snapshot);
    expect(result.config.custom.token).toBe(REDACTED_SENTINEL);
    expect(result.config.custom.mySecret).toBe(REDACTED_SENTINEL);
    const restored = restoreRedactedValues(result.config, snapshot.config);
    expect(restored.custom.token).toBe("this-is-a-custom-secret-value");
    expect(restored.custom.mySecret).toBe("this-is-a-custom-secret-value");
  });

  it("handles records that are directly sensitive with hints (roundtrip)", () => {
    const hints: ConfigUiHints = {
      "custom.*": { sensitive: true },
    };
    const snapshot = makeSnapshot({
      custom: {
        anykey: "this-is-a-custom-secret-value",
        mySecret: "this-is-a-custom-secret-value",
      },
    });
    const result = redactConfigSnapshot(snapshot, hints);
    expect(result.config.custom.anykey).toBe(REDACTED_SENTINEL);
    expect(result.config.custom.mySecret).toBe(REDACTED_SENTINEL);
    const restored = restoreRedactedValues(result.config, snapshot.config, hints);
    expect(restored.custom.anykey).toBe("this-is-a-custom-secret-value");
    expect(restored.custom.mySecret).toBe("this-is-a-custom-secret-value");
  });

  it("handles arrays that are directly sensitive (roundtrip)", () => {
    const snapshot = makeSnapshot({
      token: ["this-is-a-custom-secret-value", "this-is-a-custom-secret-value"],
    });
    const result = redactConfigSnapshot(snapshot);
    expect(result.config.token[0]).toBe(REDACTED_SENTINEL);
    expect(result.config.token[1]).toBe(REDACTED_SENTINEL);
    const restored = restoreRedactedValues(result.config, snapshot.config);
    expect(restored.token[0]).toBe("this-is-a-custom-secret-value");
    expect(restored.token[1]).toBe("this-is-a-custom-secret-value");
  });

  it("handles arrays that are directly sensitive with hints (roundtrip)", () => {
    const hints: ConfigUiHints = {
      "custom[]": { sensitive: true },
    };
    const snapshot = makeSnapshot({
      custom: ["this-is-a-custom-secret-value", "this-is-a-custom-secret-value"],
    });
    const result = redactConfigSnapshot(snapshot, hints);
    expect(result.config.custom[0]).toBe(REDACTED_SENTINEL);
    expect(result.config.custom[1]).toBe(REDACTED_SENTINEL);
    const restored = restoreRedactedValues(result.config, snapshot.config, hints);
    expect(restored.custom[0]).toBe("this-is-a-custom-secret-value");
    expect(restored.custom[1]).toBe("this-is-a-custom-secret-value");
  });

  it("handles arrays that are not sensitive (roundtrip)", () => {
    const snapshot = makeSnapshot({
      harmless: ["this-is-a-custom-harmless-value", "this-is-a-custom-secret-looking-value"],
    });
    const result = redactConfigSnapshot(snapshot);
    expect(result.config.harmless[0]).toBe("this-is-a-custom-harmless-value");
    expect(result.config.harmless[1]).toBe("this-is-a-custom-secret-looking-value");
    const restored = restoreRedactedValues(result.config, snapshot.config);
    expect(restored.harmless[0]).toBe("this-is-a-custom-harmless-value");
    expect(restored.harmless[1]).toBe("this-is-a-custom-secret-looking-value");
  });

  it("handles arrays that are not sensitive with hints (roundtrip)", () => {
    const hints: ConfigUiHints = {
      "custom[]": { sensitive: false },
    };
    const snapshot = makeSnapshot({
      custom: ["this-is-a-custom-harmless-value", "this-is-a-custom-secret-value"],
    });
    const result = redactConfigSnapshot(snapshot, hints);
    expect(result.config.custom[0]).toBe("this-is-a-custom-harmless-value");
    expect(result.config.custom[1]).toBe("this-is-a-custom-secret-value");
    const restored = restoreRedactedValues(result.config, snapshot.config, hints);
    expect(restored.custom[0]).toBe("this-is-a-custom-harmless-value");
    expect(restored.custom[1]).toBe("this-is-a-custom-secret-value");
  });

  it("handles deep arrays that are directly sensitive (roundtrip)", () => {
    const snapshot = makeSnapshot({
      nested: {
        level: {
          token: ["this-is-a-custom-secret-value", "this-is-a-custom-secret-value"],
        },
      },
    });
    const result = redactConfigSnapshot(snapshot);
    expect(result.config.nested.level.token[0]).toBe(REDACTED_SENTINEL);
    expect(result.config.nested.level.token[1]).toBe(REDACTED_SENTINEL);
    const restored = restoreRedactedValues(result.config, snapshot.config);
    expect(restored.nested.level.token[0]).toBe("this-is-a-custom-secret-value");
    expect(restored.nested.level.token[1]).toBe("this-is-a-custom-secret-value");
  });

  it("handles deep arrays that are directly sensitive with hints (roundtrip)", () => {
    const hints: ConfigUiHints = {
      "nested.level.custom[]": { sensitive: true },
    };
    const snapshot = makeSnapshot({
      nested: {
        level: {
          custom: ["this-is-a-custom-secret-value", "this-is-a-custom-secret-value"],
        },
      },
    });
    const result = redactConfigSnapshot(snapshot, hints);
    expect(result.config.nested.level.custom[0]).toBe(REDACTED_SENTINEL);
    expect(result.config.nested.level.custom[1]).toBe(REDACTED_SENTINEL);
    const restored = restoreRedactedValues(result.config, snapshot.config, hints);
    expect(restored.nested.level.custom[0]).toBe("this-is-a-custom-secret-value");
    expect(restored.nested.level.custom[1]).toBe("this-is-a-custom-secret-value");
  });

  it("handles deep non-string arrays that are directly sensitive (roundtrip)", () => {
    const snapshot = makeSnapshot({
      nested: {
        level: {
          token: [42, 815],
        },
      },
    });
    const result = redactConfigSnapshot(snapshot);
    expect(result.config.nested.level.token[0]).toBe(42);
    expect(result.config.nested.level.token[1]).toBe(815);
    const restored = restoreRedactedValues(result.config, snapshot.config);
    expect(restored.nested.level.token[0]).toBe(42);
    expect(restored.nested.level.token[1]).toBe(815);
  });

  it("handles deep non-string arrays that are directly sensitive with hints (roundtrip)", () => {
    const hints: ConfigUiHints = {
      "nested.level.custom[]": { sensitive: true },
    };
    const snapshot = makeSnapshot({
      nested: {
        level: {
          custom: [42, 815],
        },
      },
    });
    const result = redactConfigSnapshot(snapshot, hints);
    expect(result.config.nested.level.custom[0]).toBe(42);
    expect(result.config.nested.level.custom[1]).toBe(815);
    const restored = restoreRedactedValues(result.config, snapshot.config, hints);
    expect(restored.nested.level.custom[0]).toBe(42);
    expect(restored.nested.level.custom[1]).toBe(815);
  });

  it("handles deep arrays that are upstream sensitive (roundtrip)", () => {
    const snapshot = makeSnapshot({
      nested: {
        password: {
          harmless: ["value", "value"],
        },
      },
    });
    const result = redactConfigSnapshot(snapshot);
    expect(result.config.nested.password.harmless[0]).toBe(REDACTED_SENTINEL);
    expect(result.config.nested.password.harmless[1]).toBe(REDACTED_SENTINEL);
    const restored = restoreRedactedValues(result.config, snapshot.config);
    expect(restored.nested.password.harmless[0]).toBe("value");
    expect(restored.nested.password.harmless[1]).toBe("value");
  });

  it("handles deep arrays that are not sensitive (roundtrip)", () => {
    const snapshot = makeSnapshot({
      nested: {
        level: {
          harmless: ["value", "value"],
        },
      },
    });
    const result = redactConfigSnapshot(snapshot);
    expect(result.config.nested.level.harmless[0]).toBe("value");
    expect(result.config.nested.level.harmless[1]).toBe("value");
    const restored = restoreRedactedValues(result.config, snapshot.config);
    expect(restored.nested.level.harmless[0]).toBe("value");
    expect(restored.nested.level.harmless[1]).toBe("value");
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
      "channels.slack.accounts[].botToken": { sensitive: true },
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
    expect(restoreRedactedValues_orig(incoming, original).ok).toBe(false);
  });

  it("handles null and undefined inputs", () => {
    expect(restoreRedactedValues_orig(null, { token: "x" }).ok).toBe(false);
    expect(restoreRedactedValues_orig(undefined, { token: "x" }).ok).toBe(false);
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
      "channels.slack.accounts[].botToken": { sensitive: true },
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

describe("realredactConfigSnapshot_real", () => {
  it("main schema redact works (samples)", () => {
    const schema = OpenClawSchema.toJSONSchema({
      target: "draft-07",
      unrepresentable: "any",
    });
    schema.title = "OpenClawConfig";
    const hints = mapSensitivePaths(OpenClawSchema, "", {});

    const snapshot = makeSnapshot({
      agents: {
        defaults: {
          memorySearch: {
            remote: {
              apiKey: "1234",
            },
          },
        },
        list: [
          {
            memorySearch: {
              remote: {
                apiKey: "6789",
              },
            },
          },
        ],
      },
    });

    const result = redactConfigSnapshot(snapshot, hints);
    expect(result.config.agents.defaults.memorySearch.remote.apiKey).toBe(REDACTED_SENTINEL);
    expect(result.config.agents.list[0].memorySearch.remote.apiKey).toBe(REDACTED_SENTINEL);
    const restored = restoreRedactedValues(result.config, snapshot.config, hints);
    expect(restored.agents.defaults.memorySearch.remote.apiKey).toBe("1234");
    expect(restored.agents.list[0].memorySearch.remote.apiKey).toBe("6789");
  });
});
