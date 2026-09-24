// Covers config snapshot redaction and restoration behavior.

import { expectDefined } from "@openclaw/normalization-core";
import JSON5 from "json5";
import { describe, expect, it } from "vitest";
import { redactSnapshotTestHints as mainSchemaHints } from "../../test/helpers/config/redact-snapshot-test-hints.js";
import type { ConfigUiHints } from "../shared/config-ui-hints-types.js";
import { materializeRuntimeConfig } from "./materialize.js";
import { REDACTED_SENTINEL, redactConfigSnapshot } from "./redact-snapshot.js";
import { makeSnapshot, restoreRedactedValues } from "./redact-snapshot.test-helpers.js";
import { buildConfigSchemaCore } from "./schema.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "./types.openclaw.js";

function makeJson5Snapshot<TConfig extends Record<string, unknown>>(config: TConfig) {
  return makeSnapshot(config, JSON5.stringify(config, { space: 2, quote: '"' }));
}

function expectGatewayAuthFieldValue(
  result: ReturnType<typeof redactConfigSnapshot>,
  field: "token" | "password",
  expected: string,
): void {
  const gateway = result.config.gateway as Record<string, Record<string, string>>;
  const resolved = result.resolved as Record<string, Record<string, Record<string, string>>>;
  const gatewayAuth = expectDefined(gateway.auth, "gateway auth");
  const resolvedGateway = expectDefined(resolved.gateway, "resolved gateway");
  const resolvedAuth = expectDefined(resolvedGateway.auth, "resolved gateway auth");
  expect(expectDefined(gatewayAuth[field], `gateway auth ${field}`)).toBe(expected);
  expect(expectDefined(resolvedAuth[field], `resolved gateway auth ${field}`)).toBe(expected);
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
        feishu: {
          appSecret: "feishu-app-secret-value-here-1234",
          encryptKey: "feishu-encrypt-key-value-here-1234",
        },
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
    expect(cfg.channels.feishu.encryptKey).toBe(REDACTED_SENTINEL);
    expect(cfg.models.providers.openai.apiKey).toBe(REDACTED_SENTINEL);
    expect(cfg.models.providers.openai.baseUrl).toBe("https://api.openai.com");
    expect(cfg.shortSecret.token).toBe(REDACTED_SENTINEL);
  });

  it("redacts googlechat serviceAccount object payloads", () => {
    const snapshot = makeSnapshot({
      channels: {
        googlechat: {
          serviceAccount: {
            type: "service_account",
            client_email: "bot@example.iam.gserviceaccount.com",
            private_key: "-----BEGIN PRIVATE KEY-----secret-----END PRIVATE KEY-----", // pragma: allowlist secret
          },
        },
      },
    });

    const result = redactConfigSnapshot(snapshot);
    const channels = result.config.channels as Record<string, Record<string, unknown>>;
    expect(
      expectDefined(channels.googlechat, "channels.googlechat test invariant").serviceAccount,
    ).toBe(REDACTED_SENTINEL);
  });

  it("redacts object-valued apiKey refs in model providers", () => {
    const snapshot = makeSnapshot({
      models: {
        providers: {
          openai: {
            apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
            baseUrl: "https://api.openai.com",
          },
        },
      },
    });

    const result = redactConfigSnapshot(snapshot);
    const models = result.config.models as Record<string, Record<string, Record<string, unknown>>>;
    const providers = expectDefined(models.providers, "model providers");
    const openai = expectDefined(providers.openai, "OpenAI provider");
    expect(openai.apiKey).toEqual({
      source: REDACTED_SENTINEL,
      provider: REDACTED_SENTINEL,
      id: REDACTED_SENTINEL,
    });
    expect(openai.baseUrl).toBe("https://api.openai.com");
  });

  it("removes embedded credentials from URL-valued endpoint fields", () => {
    const snapshot = makeJson5Snapshot({
      models: {
        providers: {
          openai: {
            baseUrl: "https://alice:secret@example.test/v1",
          },
        },
      },
    });

    const result = redactConfigSnapshot(snapshot);
    const cfg = result.config as typeof snapshot.config;
    expect(cfg.models.providers.openai.baseUrl).toBe(REDACTED_SENTINEL);
    expect(result.raw).toContain(REDACTED_SENTINEL);
    expect(result.raw).not.toContain("alice:secret@");
  });

  it("redacts and restores MCP SSE header values from schema hints", () => {
    const hints = buildConfigSchemaCore().uiHints;
    expect(hints["mcp.servers.*.headers.*"]?.sensitive).toBe(true);
    const editable = {
      enabled: false,
      url: "http://127.0.0.1:19999/mcp",
      headers: { "X-Empty": "", "X-Blank": "   ", "X-Env": "${MCP_HEADER}" },
    };
    const protectedServer = {
      ...editable,
      headers: { Authorization: "synthetic-header-value", "X-Test": "ok" },
    };
    const config = { mcp: { servers: { editable, protected: protectedServer } } };
    const snapshot = makeSnapshot(config);
    const result = redactConfigSnapshot(snapshot, hints);
    const expected = {
      mcp: {
        servers: {
          editable,
          protected: {
            ...protectedServer,
            headers: { Authorization: REDACTED_SENTINEL, "X-Test": REDACTED_SENTINEL },
          },
        },
      },
    };

    for (const projection of [
      result.config,
      result.parsed,
      result.sourceConfig,
      result.resolved,
      result.runtimeConfig,
    ]) {
      expect(projection).toEqual(expected);
    }
    expect(result.raw).toBe(JSON.stringify(expected));
    expect(restoreRedactedValues(result.config, config, hints)).toEqual(config);

    const servers = expectDefined(result.config.mcp?.servers, "redacted MCP servers");
    const renamed = {
      mcp: { servers: { renamed: servers.editable, protected: servers.protected } },
    };
    expect(restoreRedactedValues(renamed, config, hints)).toEqual({
      mcp: { servers: { renamed: editable, protected: protectedServer } },
    });
  });

  it("redacts sensitive auth material from MCP SSE URLs", () => {
    const hints = buildConfigSchemaCore().uiHints;
    const snapshot = makeJson5Snapshot({
      mcp: {
        servers: {
          remote: {
            url: "https://user:pass@example.com/mcp?token=secret123&safe=value",
          },
        },
      },
    });

    const result = redactConfigSnapshot(snapshot, hints);
    const cfg = result.config as typeof snapshot.config;
    expect(cfg.mcp.servers.remote.url).toBe(REDACTED_SENTINEL);
    expect(result.raw).toContain(REDACTED_SENTINEL);
    expect(result.raw).not.toContain("user:pass@");
    expect(result.raw).not.toContain("secret123");

    const restored = restoreRedactedValues(result.config, snapshot.config, hints);
    expect(restored.mcp.servers.remote.url).toBe(
      "https://user:pass@example.com/mcp?token=secret123&safe=value",
    );
  });

  it("redacts media request auth and proxy transport secrets from config snapshots", () => {
    const hints = buildConfigSchemaCore().uiHints;
    const snapshot = makeJson5Snapshot({
      tools: {
        media: {
          audio: {
            request: {
              auth: {
                mode: "authorization-bearer",
                token: "media-audio-secret-token",
              },
              proxy: {
                mode: "explicit-proxy",
                url: "http://alice:secret@proxy.example.internal:8080",
              },
            },
          },
        },
      },
    });

    const result = redactConfigSnapshot(snapshot, hints);
    const cfg = result.config as typeof snapshot.config;
    expect(cfg.tools.media.audio.request.auth.token).toBe(REDACTED_SENTINEL);
    expect(cfg.tools.media.audio.request.proxy.url).toBe(REDACTED_SENTINEL);
    expect(result.raw).toContain(REDACTED_SENTINEL);
    expect(result.raw).not.toContain("media-audio-secret-token");
    expect(result.raw).not.toContain("alice:secret@");

    const restored = restoreRedactedValues(result.config, snapshot.config, hints);
    expect(restored.tools.media.audio.request.auth.token).toBe("media-audio-secret-token");
    expect(restored.tools.media.audio.request.proxy.url).toBe(
      "http://alice:secret@proxy.example.internal:8080",
    );
  });

  it("redacts model provider request auth secrets from config snapshots", () => {
    const hints = buildConfigSchemaCore().uiHints;
    const snapshot = makeJson5Snapshot({
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            models: [],
            request: {
              auth: {
                mode: "authorization-bearer",
                token: "provider-secret-token",
              },
            },
          },
        },
      },
    });

    const result = redactConfigSnapshot(snapshot, hints);
    const cfg = result.config as typeof snapshot.config;
    expect(cfg.models.providers.openai.request.auth.token).toBe(REDACTED_SENTINEL);
    expect(result.raw).toContain(REDACTED_SENTINEL);
    expect(result.raw).not.toContain("provider-secret-token");

    const restored = restoreRedactedValues(result.config, snapshot.config, hints);
    expect(restored.models.providers.openai.request.auth.token).toBe("provider-secret-token");
  });

  it("redacts model provider local service env values from config snapshots", () => {
    const hints = buildConfigSchemaCore().uiHints;
    const snapshot = makeJson5Snapshot({
      models: {
        providers: {
          local: {
            baseUrl: "http://127.0.0.1:18000/v1",
            models: [],
            localService: {
              command: "/usr/local/bin/server",
              env: {
                HF_HOME: "local-service-secret-home",
                MAX_TOKENS: "local-service-secret-limit",
              },
            },
          },
        },
      },
    });

    const result = redactConfigSnapshot(snapshot, hints);
    const cfg = result.config as typeof snapshot.config;
    expect(cfg.models.providers.local.localService.env.HF_HOME).toBe(REDACTED_SENTINEL);
    expect(cfg.models.providers.local.localService.env.MAX_TOKENS).toBe(REDACTED_SENTINEL);
    expect(result.raw).toContain(REDACTED_SENTINEL);
    expect(result.raw).not.toContain("local-service-secret-home");
    expect(result.raw).not.toContain("local-service-secret-limit");

    const restored = restoreRedactedValues(result.config, snapshot.config, hints);
    expect(restored.models.providers.local.localService.env.HF_HOME).toBe(
      "local-service-secret-home",
    );
  });

  it("redacts install policy env values from config snapshots", () => {
    const hints = buildConfigSchemaCore().uiHints;
    const snapshot = makeJson5Snapshot({
      security: {
        installPolicy: {
          enabled: true,
          exec: {
            source: "exec",
            command: "/usr/local/bin/openclaw-install-policy",
            env: {
              POLICY_TOKEN: "operator-policy-secret-token",
              AUDIT_ENDPOINT: "operator-policy-secret-endpoint",
            },
          },
        },
      },
    });

    const result = redactConfigSnapshot(snapshot, hints);
    const cfg = result.config as typeof snapshot.config;
    expect(cfg.security.installPolicy.exec.env.POLICY_TOKEN).toBe(REDACTED_SENTINEL);
    expect(cfg.security.installPolicy.exec.env.AUDIT_ENDPOINT).toBe(REDACTED_SENTINEL);
    expect(result.raw).toContain(REDACTED_SENTINEL);
    expect(result.raw).not.toContain("operator-policy-secret-token");
    expect(result.raw).not.toContain("operator-policy-secret-endpoint");

    const restored = restoreRedactedValues(result.config, snapshot.config, hints);
    expect(restored.security.installPolicy.exec.env.POLICY_TOKEN).toBe(
      "operator-policy-secret-token",
    );
  });

  it("redacts model provider request proxy URLs from config snapshots", () => {
    const hints = buildConfigSchemaCore().uiHints;
    const snapshot = makeJson5Snapshot({
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            models: [],
            request: {
              proxy: {
                mode: "explicit-proxy",
                url: "http://alice:secret@proxy.example.internal:8080",
              },
            },
          },
        },
      },
    });

    const result = redactConfigSnapshot(snapshot, hints);
    const cfg = result.config as typeof snapshot.config;
    expect(cfg.models.providers.openai.request.proxy.url).toBe(REDACTED_SENTINEL);
    expect(result.raw).toContain(REDACTED_SENTINEL);
    expect(result.raw).not.toContain("alice:secret@");

    const restored = restoreRedactedValues(result.config, snapshot.config, hints);
    expect(restored.models.providers.openai.request.proxy.url).toBe(
      "http://alice:secret@proxy.example.internal:8080",
    );
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
    expect(expectDefined(providers.openai, "providers.openai test invariant").apiKey).toBe(
      REDACTED_SENTINEL,
    );
    expect(expectDefined(providers.openai, "providers.openai test invariant").accessToken).toBe(
      REDACTED_SENTINEL,
    );
    expect(expectDefined(providers.openai, "providers.openai test invariant").maxTokens).toBe(8192);
    expect(expectDefined(providers.openai, "providers.openai test invariant").maxOutputTokens).toBe(
      4096,
    );
    expect(
      expectDefined(providers.openai, "providers.openai test invariant").maxCompletionTokens,
    ).toBe(2048);
    expect(expectDefined(providers.openai, "providers.openai test invariant").tokenCount).toBe(500);
    expect(expectDefined(providers.openai, "providers.openai test invariant").tokenLimit).toBe(
      100000,
    );
    expect(expectDefined(providers.openai, "providers.openai test invariant").tokenBudget).toBe(
      50000,
    );

    const gw = result.config.gateway as Record<string, Record<string, string>>;
    expect(expectDefined(gw.auth, "gw.auth test invariant").token).toBe(REDACTED_SENTINEL);
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
    const irc = expectDefined(channels.irc, "channels.irc test invariant");
    const nickserv = irc.nickserv as Record<string, unknown>;

    expect(irc.passwordFile).toBe("/etc/openclaw/irc-password.txt");
    expect(nickserv.passwordFile).toBe("/etc/openclaw/nickserv-password.txt");
    expect(nickserv.password).toBe(REDACTED_SENTINEL);
  });

  it("keeps raw text when runtime materialization adds undefined safe-bin fields", () => {
    const sourceConfig = {
      tools: {
        exec: {
          mode: "full",
        },
      },
    } satisfies OpenClawConfig;
    const raw = JSON.stringify(sourceConfig);
    const runtimeConfig = materializeRuntimeConfig(structuredClone(sourceConfig));
    const snapshot = {
      ...makeSnapshot(sourceConfig, raw),
      config: runtimeConfig,
      runtimeConfig,
    };

    expect(runtimeConfig.tools?.exec).toHaveProperty("safeBinProfiles", undefined);
    expect(redactConfigSnapshot(snapshot).raw).toBe(raw);
  });

  it("preserves SecretRef structural fields while redacting SecretRef id", () => {
    const config = {
      models: {
        providers: {
          default: {
            apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
            baseUrl: "https://api.openai.com",
          },
        },
      },
    };
    const snapshot = makeSnapshot(config, JSON.stringify(config, null, 2));
    const result = redactConfigSnapshot(snapshot, mainSchemaHints);
    expect(result.raw).not.toContain("OPENAI_API_KEY");
    const parsed: {
      models?: { providers?: { default?: { apiKey?: { source?: string; provider?: string } } } };
    } = JSON5.parse(result.raw ?? "{}");
    expect(parsed.models?.providers?.default?.apiKey?.source).toBe("env");
    expect(parsed.models?.providers?.default?.apiKey?.provider).toBe("default");
    const restored = restoreRedactedValues(parsed, snapshot.config, mainSchemaHints);
    expect(restored).toEqual(snapshot.config);
  });

  it("handles overlap fallback and SecretRef in the same snapshot", () => {
    const config = {
      gateway: { mode: "default", auth: { password: "default" } }, // pragma: allowlist secret
      models: {
        providers: {
          default: {
            apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
            baseUrl: "https://api.openai.com",
          },
        },
      },
    };
    const snapshot = makeSnapshot(config, JSON.stringify(config, null, 2));
    const result = redactConfigSnapshot(snapshot, mainSchemaHints);
    expect(result.raw).toBeNull();
    const cfg = result.config as {
      gateway?: { mode?: string; auth?: { password?: string } };
      models?: {
        providers?: { default?: { apiKey?: { source?: string; provider?: string; id?: string } } };
      };
    };
    expect(cfg.gateway?.mode).toBe("default");
    expect(cfg.gateway?.auth?.password).toBe(REDACTED_SENTINEL);
    expect(cfg.models?.providers?.default?.apiKey?.source).toBe("env");
    expect(cfg.models?.providers?.default?.apiKey?.provider).toBe("default");
    expect(cfg.models?.providers?.default?.apiKey?.id).toBe(REDACTED_SENTINEL);
    const restored = restoreRedactedValues(result.config, snapshot.config, mainSchemaHints);
    expect(restored).toEqual(snapshot.config);
  });

  it.each([
    { kind: "empty", value: "" },
    { kind: "whitespace", value: "   " },
    { kind: "environment reference", value: "${GATEWAY_TOKEN}" },
  ])("does not mangle raw when a sensitive field is $kind", ({ value }) => {
    const config = { gateway: { auth: { token: value } }, other: value };
    const raw = JSON.stringify(config);
    const result = redactConfigSnapshot(makeSnapshot(config, raw));
    expect(result.config).toEqual(config);
    expect(result.raw).toBe(raw);
    expect(restoreRedactedValues(result.config, config)).toEqual(config);
  });

  it("redacts each projection without using its secrets to rewrite another projection", () => {
    const config = {
      channels: { discord: { token: "MTIzNDU2Nzg5MDEyMzQ1Njc4.GaBcDe.FgH" } },
      gateway: { auth: { token: "supersecrettoken123456" } },
      meta: { lastTouchedVersion: "resolved-only-value migration-only-value" },
    };
    const snapshot = {
      ...makeSnapshot(config, JSON.stringify(config)),
      resolved: { ...config, gateway: { auth: { token: "resolved-only-value" } } },
      sourceConfigBeforeMigrations: { gateway: { auth: { token: "migration-only-value" } } },
    };
    const result = redactConfigSnapshot(snapshot);
    const parsed = result.parsed as Record<string, Record<string, Record<string, string>>>;
    const sourceConfig = result.sourceConfig as Record<
      string,
      Record<string, Record<string, string>>
    >;
    const resolved = result.resolved as Record<string, Record<string, Record<string, string>>>;
    const runtimeConfig = result.runtimeConfig as Record<
      string,
      Record<string, Record<string, string>>
    >;
    const parsedChannels = expectDefined(parsed.channels, "parsed channels");
    const parsedDiscord = expectDefined(parsedChannels.discord, "parsed Discord config");
    const sourceGateway = expectDefined(sourceConfig.gateway, "source gateway");
    const sourceAuth = expectDefined(sourceGateway.auth, "source gateway auth");
    const resolvedGateway = expectDefined(resolved.gateway, "resolved gateway");
    const resolvedAuth = expectDefined(resolvedGateway.auth, "resolved gateway auth");
    const runtimeChannels = expectDefined(runtimeConfig.channels, "runtime channels");
    const runtimeDiscord = expectDefined(runtimeChannels.discord, "runtime Discord config");
    expect(parsedDiscord.token).toBe(REDACTED_SENTINEL);
    expect(sourceAuth.token).toBe(REDACTED_SENTINEL);
    expect(resolvedAuth.token).toBe(REDACTED_SENTINEL);
    expect(runtimeDiscord.token).toBe(REDACTED_SENTINEL);
    expect(result.sourceConfig).toBe(result.resolved);
    expect(result.runtimeConfig).toBe(result.config);
    expect(result).not.toHaveProperty("sourceConfigBeforeMigrations");
    expect(result.raw).toContain('"lastTouchedVersion":"resolved-only-value migration-only-value"');
  });

  it("withholds resolved config for invalid snapshots", () => {
    const snapshot: ConfigFileSnapshot = {
      path: "/test",
      exists: true,
      raw: '{ "gateway": { "auth": { "token": "leaky-secret" } } }',
      parsed: { gateway: { auth: { token: "leaky-secret" } } },
      sourceConfig: {
        gateway: { auth: { token: "leaky-secret" } },
      } as ConfigFileSnapshot["sourceConfig"],
      resolved: { gateway: { auth: { token: "leaky-secret" } } } as ConfigFileSnapshot["resolved"],
      valid: false,
      runtimeConfig: {} as ConfigFileSnapshot["runtimeConfig"],
      config: {} as ConfigFileSnapshot["config"],
      issues: [{ path: "", message: "invalid config" }],
      warnings: [],
      legacyIssues: [],
    };
    const result = redactConfigSnapshot(snapshot);
    expect(result.raw).toBeNull();
    expect(result.parsed).toBeNull();
    expect(result.sourceConfig).toStrictEqual({});
    expect(result.resolved).toStrictEqual({});
    expect(result.runtimeConfig).toStrictEqual({});
    expect(result.sourceConfig).toBe(result.resolved);
    expect(result.runtimeConfig).toBe(result.config);
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
    expect(expectDefined(env.vars, "env.vars test invariant").NODE_ENV).toBe("production");
    expect(expectDefined(env.vars, "env.vars test invariant").OPENAI_API_KEY).toBe(
      REDACTED_SENTINEL,
    );
  });

  it("does not redact string tokens fields", () => {
    const config = { memory: { tokens: "should-not-be-redacted" } };
    expect(redactConfigSnapshot(makeSnapshot(config)).config).toEqual(config);
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

  it("round-trips nested and array sensitivity cases", () => {
    const secret = "this-is-a-custom-secret-value";
    const nested = {
      custom1: { anykey: { mySecret: secret } },
      custom2: [{ mySecret: secret }],
    };
    const nestedRedacted = {
      custom1: { anykey: { mySecret: REDACTED_SENTINEL } },
      custom2: [{ mySecret: REDACTED_SENTINEL }],
    };
    const harmlessArrays = {
      harmless: ["this-is-a-custom-harmless-value", "this-is-a-custom-secret-looking-value"],
      custom: ["this-is-a-custom-harmless-value", secret],
    };
    const numericTokens = { nested: { level: { token: [42, 815] } } };
    const numericCustom = { nested: { level: { custom: [42, 815] } } };
    const cases: Array<{
      name: string;
      config: Record<string, unknown>;
      hints?: ConfigUiHints;
      expected: Record<string, unknown>;
    }> = [
      { name: "nested values (schema)", config: nested, expected: nestedRedacted },
      {
        name: "nested values (uiHints)",
        hints: {
          "custom1.*.mySecret": { sensitive: true },
          "custom2[].mySecret": { sensitive: true },
        },
        config: nested,
        expected: nestedRedacted,
      },
      {
        name: "directly sensitive records and arrays",
        config: { custom: { token: secret, mySecret: secret }, token: [secret, secret] },
        expected: {
          custom: { token: REDACTED_SENTINEL, mySecret: REDACTED_SENTINEL },
          token: [REDACTED_SENTINEL, REDACTED_SENTINEL],
        },
      },
      {
        name: "directly sensitive records and arrays (uiHints)",
        hints: { "custom.*": { sensitive: true }, "customArray[]": { sensitive: true } },
        config: { custom: { anykey: secret, mySecret: secret }, customArray: [secret, secret] },
        expected: {
          custom: { anykey: REDACTED_SENTINEL, mySecret: REDACTED_SENTINEL },
          customArray: [REDACTED_SENTINEL, REDACTED_SENTINEL],
        },
      },
      {
        name: "non-sensitive arrays remain unchanged",
        hints: { "custom[]": { sensitive: false } },
        config: harmlessArrays,
        expected: harmlessArrays,
      },
      {
        name: "deep schema-sensitive arrays and upstream-sensitive paths",
        config: {
          nested: {
            level: { token: [secret, secret], harmless: ["value", "value"] },
            password: { harmless: ["value", "value"] },
          },
        },
        expected: {
          nested: {
            level: {
              token: [REDACTED_SENTINEL, REDACTED_SENTINEL],
              harmless: ["value", "value"],
            },
            password: { harmless: [REDACTED_SENTINEL, REDACTED_SENTINEL] },
          },
        },
      },
      {
        name: "deep non-string arrays on schema-sensitive paths remain unchanged",
        config: numericTokens,
        expected: numericTokens,
      },
      {
        name: "deep arrays respect uiHints sensitivity",
        hints: { "nested.level.custom[]": { sensitive: true } },
        config: { nested: { level: { custom: [secret, secret] } } },
        expected: { nested: { level: { custom: [REDACTED_SENTINEL, REDACTED_SENTINEL] } } },
      },
      {
        name: "deep non-string arrays respect uiHints sensitivity",
        hints: { "nested.level.custom[]": { sensitive: true } },
        config: numericCustom,
        expected: numericCustom,
      },
    ];

    for (const { name, config, hints, expected } of cases) {
      const redacted = redactConfigSnapshot(makeSnapshot(config), hints);
      expect(redacted.config, name).toEqual(expected);
      expect(restoreRedactedValues(redacted.config, config, hints), name).toEqual(config);
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

  it("redacts privateKey paths even when absent from uiHints (defense in depth)", () => {
    const hints: ConfigUiHints = {
      "some.other.path": { sensitive: true },
    };
    const snapshot = makeSnapshot({
      channels: {
        nostr: {
          privateKey: "nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5",
          relays: ["wss://relay.example.com"],
        },
      },
    });

    const result = redactConfigSnapshot(snapshot, hints);
    const channels = result.config.channels as Record<string, Record<string, unknown>>;
    expect(expectDefined(channels.nostr, "channels.nostr test invariant").privateKey).toBe(
      REDACTED_SENTINEL,
    );
    expect(expectDefined(channels.nostr, "channels.nostr test invariant").relays).toEqual([
      "wss://relay.example.com",
    ]);

    const restored = restoreRedactedValues(result.config, snapshot.config, hints);
    expect(restored.channels.nostr.privateKey).toBe(
      "nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5",
    );
  });

  it("redacts and restores dynamic env catchall secrets when uiHints miss the path", () => {
    const hints: ConfigUiHints = {
      "some.other.path": { sensitive: true },
    };
    const snapshot = makeSnapshot({
      env: {
        GROQ_API_KEY: "gsk-secret-123", // pragma: allowlist secret
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
              GEMINI_API_KEY: "gemini-secret-456", // pragma: allowlist secret
              BRAVE_REGION: "us",
            },
          },
        },
      },
    });
    const redacted = redactConfigSnapshot(snapshot, hints);
    const entry = expectDefined(
      (
        redacted.config.skills as {
          entries: Record<string, { env: Record<string, string> }>;
        }
      ).entries.web_search,
      "( redacted.config.skills as { entries: Record<string, { env: Record<s... test invariant",
    );
    expect(entry.env.GEMINI_API_KEY).toBe(REDACTED_SENTINEL);
    expect(entry.env.BRAVE_REGION).toBe("us");

    const restored = restoreRedactedValues(redacted.config, snapshot.config, hints);
    expect(restored.skills.entries.web_search.env.GEMINI_API_KEY).toBe("gemini-secret-456");
    expect(restored.skills.entries.web_search.env.BRAVE_REGION).toBe("us");
  });

  it("contract-covers dynamic catchall/record paths for redact+restore", () => {
    const hints = mainSchemaHints;
    const snapshot = makeSnapshot({
      env: {
        GROQ_API_KEY: "gsk-contract-123", // pragma: allowlist secret
        NODE_ENV: "production",
      },
      skills: {
        entries: {
          web_search: {
            env: {
              GEMINI_API_KEY: "gemini-contract-456", // pragma: allowlist secret
              BRAVE_REGION: "us",
            },
          },
        },
      },
      broadcast: {
        apiToken: ["broadcast-secret-1", "broadcast-secret-2"],
        channels: ["ops", "eng"],
      },
    });

    const redacted = redactConfigSnapshot(snapshot, hints);
    const config = redacted.config as {
      env: Record<string, string>;
      skills: { entries: Record<string, { env: Record<string, string> }> };
      broadcast: Record<string, string[]>;
    };

    expect(config.env.GROQ_API_KEY).toBe(REDACTED_SENTINEL);
    expect(config.env.NODE_ENV).toBe("production");
    expect(
      expectDefined(
        config.skills.entries.web_search,
        "config.skills.entries.web_search test invariant",
      ).env.GEMINI_API_KEY,
    ).toBe(REDACTED_SENTINEL);
    expect(
      expectDefined(
        config.skills.entries.web_search,
        "config.skills.entries.web_search test invariant",
      ).env.BRAVE_REGION,
    ).toBe("us");
    expect(config.broadcast.apiToken).toEqual([REDACTED_SENTINEL, REDACTED_SENTINEL]);
    expect(config.broadcast.channels).toEqual(["ops", "eng"]);

    const restored = restoreRedactedValues(redacted.config, snapshot.config, hints);
    expect(restored).toEqual(snapshot.config);
  });

  it("redacts browser cdpUrl secrets while preserving bare endpoints", () => {
    const hints = buildConfigSchemaCore().uiHints;
    const snapshot = makeJson5Snapshot({
      browser: {
        cdpUrl: "https://user:pass@chrome.browserless.io?token=supersecret123",
        profiles: {
          remote: {
            cdpUrl: "https://chrome.staging.example.com?token=staging-secret",
          },
          prod: {
            cdpUrl: "https://alice:secret@chrome.prod.example.com",
          },
          local: {
            cdpUrl: "ws://localhost:9222",
          },
        },
      },
    });

    const result = redactConfigSnapshot(snapshot, hints);
    const cfg = result.config as typeof snapshot.config;
    expect(cfg.browser.cdpUrl).toBe(REDACTED_SENTINEL);
    expect(cfg.browser.profiles.remote.cdpUrl).toBe(REDACTED_SENTINEL);
    expect(cfg.browser.profiles.prod.cdpUrl).toBe(REDACTED_SENTINEL);
    expect(cfg.browser.profiles.local.cdpUrl).toBe("ws://localhost:9222");
    expect(result.raw).toContain(REDACTED_SENTINEL);
    expect(result.raw).not.toContain("user:pass@");
    expect(result.raw).not.toContain("supersecret123");
    expect(result.raw).not.toContain("staging-secret");
    expect(result.raw).not.toContain("alice:secret@");

    const restored = restoreRedactedValues(result.config, snapshot.config, hints);
    expect(restored.browser.cdpUrl).toBe(
      "https://user:pass@chrome.browserless.io?token=supersecret123",
    );
    expect(restored.browser.profiles.remote.cdpUrl).toBe(
      "https://chrome.staging.example.com?token=staging-secret",
    );
    expect(restored.browser.profiles.prod.cdpUrl).toBe(
      "https://alice:secret@chrome.prod.example.com",
    );
    expect(restored.browser.profiles.local.cdpUrl).toBe("ws://localhost:9222");
  });
});
