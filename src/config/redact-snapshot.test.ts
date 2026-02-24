import { describe, expect, it } from "vitest";
import {
  REDACTED_SENTINEL,
  redactConfigSnapshot,
  restoreRedactedValues as restoreRedactedValues_orig,
} from "./redact-snapshot.js";
import { __test__ } from "./schema.hints.js";
import type { ConfigUiHints } from "./schema.js";
import type { ConfigFileSnapshot } from "./types.openclaw.js";
import { OpenClawSchema } from "./zod-schema.js";

const { mapSensitivePaths } = __test__;

type TestSnapshot<TConfig extends Record<string, unknown>> = ConfigFileSnapshot & {
  parsed: TConfig;
  resolved: TConfig;
  config: TConfig;
};

function makeSnapshot<TConfig extends Record<string, unknown>>(
  config: TConfig,
  raw?: string,
): TestSnapshot<TConfig> {
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
  } as unknown as TestSnapshot<TConfig>;
}

function restoreRedactedValues<TOriginal>(
  incoming: unknown,
  original: TOriginal,
  hints?: ConfigUiHints,
): TOriginal {
  var result = restoreRedactedValues_orig(incoming, original, hints);
  expect(result.ok).toBe(true);
  return result.result as TOriginal;
}

function expectNestedLevelPairValue(
  source: Record<string, Record<string, Record<string, unknown>>>,
  field: string,
  expected: readonly [unknown, unknown],
): void {
  const values = source.nested.level[field] as unknown[];
  expect(values[0]).toBe(expected[0]);
  expect(values[1]).toBe(expected[1]);
}

function expectGatewayAuthFieldValue(
  result: ReturnType<typeof redactConfigSnapshot>,
  field: "token" | "password",
  expected: string,
): void {
  const gateway = result.config.gateway as Record<string, Record<string, string>>;
  const resolved = result.resolved as Record<string, Record<string, Record<string, string>>>;
  expect(gateway.auth[field]).toBe(expected);
  expect(resolved.gateway.auth[field]).toBe(expected);
}

describe("redactConfigSnapshot", () => {
  it("redacts common secret field patterns across config sections", () => {
    const snapshot = makeSnapshot({
      gateway: {
        auth: {
          token: "my-super-secret-gateway-token-value",
          password: "super-secret-password-value-here",
        },
      },
      channels: {
        telegram: {
          botToken: "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef",
          webhookSecret: "telegram-webhook-secret-value-1234",
        },
        slack: {
          botToken: "fake-slack-bot-token-placeholder-value",
          signingSecret: "slack-signing-secret-value-1234",
          token: "secret-slack-token-value-here",
        },
        feishu: { appSecret: "feishu-app-secret-value-here-1234" },
      },
      models: {
        providers: {
          openai: { apiKey: "sk-proj-abcdef1234567890ghij", baseUrl: "https://api.openai.com" },
        },
      },
      shortSecret: { token: "short" },
    });

    const result = redactConfigSnapshot(snapshot);
    const cfg = result.config as typeof snapshot.config;

    expect(cfg.gateway.auth.token).toBe(REDACTED_SENTINEL);
    expect(cfg.gateway.auth.password).toBe(REDACTED_SENTINEL);
    expect(cfg.channels.telegram.botToken).toBe(REDACTED_SENTINEL);
    expect(cfg.channels.telegram.webhookSecret).toBe(REDACTED_SENTINEL);
    expect(cfg.channels.slack.botToken).toBe(REDACTED_SENTINEL);
    expect(cfg.channels.slack.signingSecret).toBe(REDACTED_SENTINEL);
    expect(cfg.channels.slack.token).toBe(REDACTED_SENTINEL);
    expect(cfg.channels.feishu.appSecret).toBe(REDACTED_SENTINEL);
    expect(cfg.models.providers.openai.apiKey).toBe(REDACTED_SENTINEL);
    expect(cfg.models.providers.openai.baseUrl).toBe("https://api.openai.com");
    expect(cfg.shortSecret.token).toBe(REDACTED_SENTINEL);
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

  it("does not redact passwordFile path fields", () => {
    const snapshot = makeSnapshot({
      channels: {
        irc: {
          passwordFile: "/etc/openclaw/irc-password.txt",
          nickserv: {
            passwordFile: "/etc/openclaw/nickserv-password.txt",
            password: "super-secret-nickserv-password",
          },
        },
      },
    });

    const result = redactConfigSnapshot(snapshot);
    const channels = result.config.channels as Record<string, Record<string, unknown>>;
    const irc = channels.irc;
    const nickserv = irc.nickserv as Record<string, unknown>;

    expect(irc.passwordFile).toBe("/etc/openclaw/irc-password.txt");
    expect(nickserv.passwordFile).toBe("/etc/openclaw/nickserv-password.txt");
    expect(nickserv.password).toBe(REDACTED_SENTINEL);
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

  it("redacts parsed and resolved objects", () => {
    const snapshot = makeSnapshot({
      channels: { discord: { token: "MTIzNDU2Nzg5MDEyMzQ1Njc4.GaBcDe.FgH" } },
      gateway: { auth: { token: "supersecrettoken123456" } },
    });
    const result = redactConfigSnapshot(snapshot);
    const parsed = result.parsed as Record<string, Record<string, Record<string, string>>>;
    const resolved = result.resolved as Record<string, Record<string, Record<string, string>>>;
    expect(parsed.channels.discord.token).toBe(REDACTED_SENTINEL);
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

  it("respects token-name redaction boundaries", () => {
    const cases = [
      {
        name: "does not redact numeric tokens field",
        snapshot: makeSnapshot({ memory: { tokens: 8192 } }),
        assert: (config: Record<string, unknown>) => {
          expect((config.memory as Record<string, unknown>).tokens).toBe(8192);
        },
      },
      {
        name: "does not redact softThresholdTokens",
        snapshot: makeSnapshot({ compaction: { softThresholdTokens: 50000 } }),
        assert: (config: Record<string, unknown>) => {
          expect((config.compaction as Record<string, unknown>).softThresholdTokens).toBe(50000);
        },
      },
      {
        name: "does not redact string tokens field",
        snapshot: makeSnapshot({ memory: { tokens: "should-not-be-redacted" } }),
        assert: (config: Record<string, unknown>) => {
          expect((config.memory as Record<string, unknown>).tokens).toBe("should-not-be-redacted");
        },
      },
      {
        name: "still redacts singular token field",
        snapshot: makeSnapshot({
          channels: { slack: { token: "secret-slack-token-value-here" } },
        }),
        assert: (config: Record<string, unknown>) => {
          const channels = config.channels as Record<string, Record<string, string>>;
          expect(channels.slack.token).toBe(REDACTED_SENTINEL);
        },
      },
    ] as const;

    for (const testCase of cases) {
      const result = redactConfigSnapshot(testCase.snapshot);
      testCase.assert(result.config as Record<string, unknown>);
    }
  });

  it("uses uiHints to determine sensitivity", () => {
    const hints: ConfigUiHints = {
      "custom.mySecret": { sensitive: true },
    };
    const snapshot = makeSnapshot({
      custom: { mySecret: "this-is-a-custom-secret-value" },
    });
    const result = redactConfigSnapshot(snapshot, hints);
    const config = result.config as typeof snapshot.config;
    const custom = config.custom as Record<string, string>;
    const resolved = result.resolved as Record<string, Record<string, string>>;
    expect(custom.mySecret).toBe(REDACTED_SENTINEL);
    expect(resolved.custom.mySecret).toBe(REDACTED_SENTINEL);
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
    const config = redacted.config as typeof snapshot.config;
    expect(config.plugins.entries["voice-call"].config.apiToken).toBe(REDACTED_SENTINEL);
    expect(config.plugins.entries["voice-call"].config.displayName).toBe("Voice call extension");
    expect(config.channels["my-channel"].accessToken).toBe(REDACTED_SENTINEL);
    expect(config.channels["my-channel"].room).toBe("general");

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
    const config = redacted.config as typeof snapshot.config;
    expect(config.plugins.entries["voice-call"].config.apiToken).toBe("not-secret-on-purpose");
  });

  it("round-trips nested and array sensitivity cases", () => {
    const customSecretValue = "this-is-a-custom-secret-value";
    const buildNestedValuesSnapshot = () =>
      makeSnapshot({
        custom1: { anykey: { mySecret: customSecretValue } },
        custom2: [{ mySecret: customSecretValue }],
      });
    const assertNestedValuesRoundTrip = ({
      redacted,
      restored,
    }: {
      redacted: Record<string, unknown>;
      restored: Record<string, unknown>;
    }) => {
      const cfg = redacted as Record<string, Record<string, unknown>>;
      const cfgCustom2 = cfg.custom2 as unknown as unknown[];
      expect(cfgCustom2.length).toBeGreaterThan(0);
      expect((cfg.custom1.anykey as Record<string, unknown>).mySecret).toBe(REDACTED_SENTINEL);
      expect((cfgCustom2[0] as Record<string, unknown>).mySecret).toBe(REDACTED_SENTINEL);

      const out = restored as Record<string, Record<string, unknown>>;
      const outCustom2 = out.custom2 as unknown as unknown[];
      expect(outCustom2.length).toBeGreaterThan(0);
      expect((out.custom1.anykey as Record<string, unknown>).mySecret).toBe(customSecretValue);
      expect((outCustom2[0] as Record<string, unknown>).mySecret).toBe(customSecretValue);
    };

    const cases: Array<{
      name: string;
      snapshot: TestSnapshot<Record<string, unknown>>;
      hints?: ConfigUiHints;
      assert: (params: {
        redacted: Record<string, unknown>;
        restored: Record<string, unknown>;
      }) => void;
    }> = [
      {
        name: "nested values (schema)",
        snapshot: buildNestedValuesSnapshot(),
        assert: assertNestedValuesRoundTrip,
      },
      {
        name: "nested values (uiHints)",
        hints: {
          "custom1.*.mySecret": { sensitive: true },
          "custom2[].mySecret": { sensitive: true },
        },
        snapshot: buildNestedValuesSnapshot(),
        assert: assertNestedValuesRoundTrip,
      },
      {
        name: "directly sensitive records and arrays",
        snapshot: makeSnapshot({
          custom: {
            token: "this-is-a-custom-secret-value",
            mySecret: "this-is-a-custom-secret-value",
          },
          token: ["this-is-a-custom-secret-value", "this-is-a-custom-secret-value"],
        }),
        assert: ({ redacted, restored }) => {
          const cfg = redacted;
          const custom = cfg.custom as Record<string, unknown>;
          expect(custom.token).toBe(REDACTED_SENTINEL);
          expect(custom.mySecret).toBe(REDACTED_SENTINEL);
          expect((cfg.token as unknown[])[0]).toBe(REDACTED_SENTINEL);
          expect((cfg.token as unknown[])[1]).toBe(REDACTED_SENTINEL);

          const out = restored;
          const restoredCustom = out.custom as Record<string, unknown>;
          expect(restoredCustom.token).toBe("this-is-a-custom-secret-value");
          expect(restoredCustom.mySecret).toBe("this-is-a-custom-secret-value");
          expect((out.token as unknown[])[0]).toBe("this-is-a-custom-secret-value");
          expect((out.token as unknown[])[1]).toBe("this-is-a-custom-secret-value");
        },
      },
      {
        name: "directly sensitive records and arrays (uiHints)",
        hints: {
          "custom.*": { sensitive: true },
          "customArray[]": { sensitive: true },
        },
        snapshot: makeSnapshot({
          custom: {
            anykey: "this-is-a-custom-secret-value",
            mySecret: "this-is-a-custom-secret-value",
          },
          customArray: ["this-is-a-custom-secret-value", "this-is-a-custom-secret-value"],
        }),
        assert: ({ redacted, restored }) => {
          const cfg = redacted;
          const custom = cfg.custom as Record<string, unknown>;
          expect(custom.anykey).toBe(REDACTED_SENTINEL);
          expect(custom.mySecret).toBe(REDACTED_SENTINEL);
          expect((cfg.customArray as unknown[])[0]).toBe(REDACTED_SENTINEL);
          expect((cfg.customArray as unknown[])[1]).toBe(REDACTED_SENTINEL);

          const out = restored;
          const restoredCustom = out.custom as Record<string, unknown>;
          expect(restoredCustom.anykey).toBe("this-is-a-custom-secret-value");
          expect(restoredCustom.mySecret).toBe("this-is-a-custom-secret-value");
          expect((out.customArray as unknown[])[0]).toBe("this-is-a-custom-secret-value");
          expect((out.customArray as unknown[])[1]).toBe("this-is-a-custom-secret-value");
        },
      },
      {
        name: "non-sensitive arrays remain unchanged",
        hints: {
          "custom[]": { sensitive: false },
        },
        snapshot: makeSnapshot({
          harmless: ["this-is-a-custom-harmless-value", "this-is-a-custom-secret-looking-value"],
          custom: ["this-is-a-custom-harmless-value", "this-is-a-custom-secret-value"],
        }),
        assert: ({ redacted, restored }) => {
          const cfg = redacted;
          expect((cfg.harmless as unknown[])[0]).toBe("this-is-a-custom-harmless-value");
          expect((cfg.harmless as unknown[])[1]).toBe("this-is-a-custom-secret-looking-value");
          expect((cfg.custom as unknown[])[0]).toBe("this-is-a-custom-harmless-value");
          expect((cfg.custom as unknown[])[1]).toBe("this-is-a-custom-secret-value");

          const out = restored;
          expect((out.harmless as unknown[])[0]).toBe("this-is-a-custom-harmless-value");
          expect((out.harmless as unknown[])[1]).toBe("this-is-a-custom-secret-looking-value");
          expect((out.custom as unknown[])[0]).toBe("this-is-a-custom-harmless-value");
          expect((out.custom as unknown[])[1]).toBe("this-is-a-custom-secret-value");
        },
      },
      {
        name: "deep schema-sensitive arrays and upstream-sensitive paths",
        snapshot: makeSnapshot({
          nested: {
            level: {
              token: ["this-is-a-custom-secret-value", "this-is-a-custom-secret-value"],
              harmless: ["value", "value"],
            },
            password: {
              harmless: ["value", "value"],
            },
          },
        }),
        assert: ({ redacted, restored }) => {
          const cfg = redacted as Record<string, Record<string, Record<string, unknown>>>;
          expect((cfg.nested.level.token as unknown[])[0]).toBe(REDACTED_SENTINEL);
          expect((cfg.nested.level.token as unknown[])[1]).toBe(REDACTED_SENTINEL);
          expect((cfg.nested.level.harmless as unknown[])[0]).toBe("value");
          expect((cfg.nested.level.harmless as unknown[])[1]).toBe("value");
          expect((cfg.nested.password.harmless as unknown[])[0]).toBe(REDACTED_SENTINEL);
          expect((cfg.nested.password.harmless as unknown[])[1]).toBe(REDACTED_SENTINEL);

          const out = restored as Record<string, Record<string, Record<string, unknown>>>;
          expect((out.nested.level.token as unknown[])[0]).toBe("this-is-a-custom-secret-value");
          expect((out.nested.level.token as unknown[])[1]).toBe("this-is-a-custom-secret-value");
          expect((out.nested.level.harmless as unknown[])[0]).toBe("value");
          expect((out.nested.level.harmless as unknown[])[1]).toBe("value");
          expect((out.nested.password.harmless as unknown[])[0]).toBe("value");
          expect((out.nested.password.harmless as unknown[])[1]).toBe("value");
        },
      },
      {
        name: "deep non-string arrays on schema-sensitive paths remain unchanged",
        snapshot: makeSnapshot({
          nested: {
            level: {
              token: [42, 815],
            },
          },
        }),
        assert: ({ redacted, restored }) => {
          const cfg = redacted as Record<string, Record<string, Record<string, unknown>>>;
          expectNestedLevelPairValue(cfg, "token", [42, 815]);

          const out = restored as Record<string, Record<string, Record<string, unknown>>>;
          expectNestedLevelPairValue(out, "token", [42, 815]);
        },
      },
      {
        name: "deep arrays respect uiHints sensitivity",
        hints: {
          "nested.level.custom[]": { sensitive: true },
        },
        snapshot: makeSnapshot({
          nested: {
            level: {
              custom: ["this-is-a-custom-secret-value", "this-is-a-custom-secret-value"],
            },
          },
        }),
        assert: ({ redacted, restored }) => {
          const cfg = redacted as Record<string, Record<string, Record<string, unknown>>>;
          expect((cfg.nested.level.custom as unknown[])[0]).toBe(REDACTED_SENTINEL);
          expect((cfg.nested.level.custom as unknown[])[1]).toBe(REDACTED_SENTINEL);

          const out = restored as Record<string, Record<string, Record<string, unknown>>>;
          expect((out.nested.level.custom as unknown[])[0]).toBe("this-is-a-custom-secret-value");
          expect((out.nested.level.custom as unknown[])[1]).toBe("this-is-a-custom-secret-value");
        },
      },
      {
        name: "deep non-string arrays respect uiHints sensitivity",
        hints: {
          "nested.level.custom[]": { sensitive: true },
        },
        snapshot: makeSnapshot({
          nested: {
            level: {
              custom: [42, 815],
            },
          },
        }),
        assert: ({ redacted, restored }) => {
          const cfg = redacted as Record<string, Record<string, Record<string, unknown>>>;
          expectNestedLevelPairValue(cfg, "custom", [42, 815]);

          const out = restored as Record<string, Record<string, Record<string, unknown>>>;
          expectNestedLevelPairValue(out, "custom", [42, 815]);
        },
      },
    ];

    for (const testCase of cases) {
      const redacted = redactConfigSnapshot(testCase.snapshot, testCase.hints);
      const restored = restoreRedactedValues(
        redacted.config,
        testCase.snapshot.config,
        testCase.hints,
      );
      testCase.assert({
        redacted: redacted.config as Record<string, unknown>,
        restored: restored as Record<string, unknown>,
      });
    }
  });

  it("respects sensitive:false in uiHints even for regex-matching paths", () => {
    const hints: ConfigUiHints = {
      "gateway.auth.token": { sensitive: false },
    };
    const snapshot = makeSnapshot({
      gateway: { auth: { token: "not-actually-secret-value" } },
    });
    const result = redactConfigSnapshot(snapshot, hints);
    expectGatewayAuthFieldValue(result, "token", "not-actually-secret-value");
  });

  it("redacts sensitive-looking paths even when absent from uiHints (defense in depth)", () => {
    const hints: ConfigUiHints = {
      "some.other.path": { sensitive: true },
    };
    const snapshot = makeSnapshot({
      gateway: { auth: { password: "not-in-hints-value" } },
    });
    const result = redactConfigSnapshot(snapshot, hints);
    expectGatewayAuthFieldValue(result, "password", REDACTED_SENTINEL);
  });

  it("redacts and restores dynamic env catchall secrets when uiHints miss the path", () => {
    const hints: ConfigUiHints = {
      "some.other.path": { sensitive: true },
    };
    const snapshot = makeSnapshot({
      env: {
        GROQ_API_KEY: "gsk-secret-123",
        NODE_ENV: "production",
      },
    });
    const redacted = redactConfigSnapshot(snapshot, hints);
    const env = redacted.config.env as Record<string, string>;
    expect(env.GROQ_API_KEY).toBe(REDACTED_SENTINEL);
    expect(env.NODE_ENV).toBe("production");

    const restored = restoreRedactedValues(redacted.config, snapshot.config, hints);
    expect(restored.env.GROQ_API_KEY).toBe("gsk-secret-123");
    expect(restored.env.NODE_ENV).toBe("production");
  });

  it("redacts and restores skills entry env secrets in dynamic record paths", () => {
    const hints: ConfigUiHints = {
      "some.other.path": { sensitive: true },
    };
    const snapshot = makeSnapshot({
      skills: {
        entries: {
          web_search: {
            env: {
              GEMINI_API_KEY: "gemini-secret-456",
              BRAVE_REGION: "us",
            },
          },
        },
      },
    });
    const redacted = redactConfigSnapshot(snapshot, hints);
    const entry = (
      redacted.config.skills as {
        entries: Record<string, { env: Record<string, string> }>;
      }
    ).entries.web_search;
    expect(entry.env.GEMINI_API_KEY).toBe(REDACTED_SENTINEL);
    expect(entry.env.BRAVE_REGION).toBe("us");

    const restored = restoreRedactedValues(redacted.config, snapshot.config, hints);
    expect(restored.skills.entries.web_search.env.GEMINI_API_KEY).toBe("gemini-secret-456");
    expect(restored.skills.entries.web_search.env.BRAVE_REGION).toBe("us");
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

  it("rejects invalid restore inputs", () => {
    const invalidInputs = [null, undefined, "token-value"] as const;
    for (const input of invalidInputs) {
      const result = restoreRedactedValues_orig(input, { token: "x" });
      expect(result.ok).toBe(false);
    }
    expect(restoreRedactedValues_orig("token-value", { token: "x" })).toEqual({
      ok: false,
      error: "input not an object",
    });
  });

  it("returns a human-readable error when sentinel cannot be restored", () => {
    const incoming = {
      channels: { newChannel: { token: REDACTED_SENTINEL } },
    };
    const result = restoreRedactedValues_orig(incoming, {});
    expect(result.ok).toBe(false);
    expect(result.humanReadableMessage).toContain(REDACTED_SENTINEL);
    expect(result.humanReadableMessage).toContain("channels.newChannel.token");
  });

  it("keeps unmatched wildcard array entries unchanged outside extension paths", () => {
    const hints: ConfigUiHints = {
      "custom.*": { sensitive: true },
    };
    const incoming = {
      custom: { items: [REDACTED_SENTINEL] },
    };
    const original = {
      custom: { items: ["original-secret-value"] },
    };
    const result = restoreRedactedValues(incoming, original, hints) as typeof incoming;
    expect(result.custom.items[0]).toBe(REDACTED_SENTINEL);
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
    const custom = (redacted.config as typeof originalConfig).custom as Record<string, string>;
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
    const config = result.config as typeof snapshot.config;
    expect(config.agents.defaults.memorySearch.remote.apiKey).toBe(REDACTED_SENTINEL);
    expect(config.agents.list[0].memorySearch.remote.apiKey).toBe(REDACTED_SENTINEL);
    const restored = restoreRedactedValues(result.config, snapshot.config, hints);
    expect(restored.agents.defaults.memorySearch.remote.apiKey).toBe("1234");
    expect(restored.agents.list[0].memorySearch.remote.apiKey).toBe("6789");
  });
});
