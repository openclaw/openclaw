import { expectDefined } from "@openclaw/normalization-core";
import JSON5 from "json5";
import { describe, expect, it } from "vitest";
import { redactSnapshotTestHints as mainSchemaHints } from "../../test/helpers/config/redact-snapshot-test-hints.js";
import type { ConfigUiHints } from "../shared/config-ui-hints-types.js";
import { materializeRuntimeConfig } from "./materialize.js";
import { REDACTED_SENTINEL, redactConfigSnapshot } from "./redact-snapshot.js";
import { replaceSensitiveValuesInRaw } from "./redact-snapshot.raw.js";
import { makeSnapshot, restoreRedactedValues } from "./redact-snapshot.test-helpers.js";
import { buildConfigSchemaCore } from "./schema.js";
import type { OpenClawConfig } from "./types.openclaw.js";

describe("redactConfigSnapshot", () => {
  it("round-trips heuristic secrets without redacting safe field names", () => {
    const safe = {
      maxTokens: 16384,
      maxOutputTokens: 4096,
      maxCompletionTokens: 2048,
      contextTokens: 200000,
      tokenCount: 500,
      tokenLimit: 100000,
      tokenBudget: 50000,
      tokens: "visible",
      softThresholdTokens: 50000,
      passwordFile: "/etc/password.txt",
      maxTokensField: "max_completion_tokens",
      baseUrl: "https://api.example.com",
    };
    const config = {
      provider: { ...safe, apiKey: "synthetic-api-key", accessToken: "synthetic-access-token" },
      channels: {
        custom: {
          botToken: "synthetic-bot-token",
          webhookSecret: "synthetic-webhook-secret",
          password: "synthetic-password",
          encryptKey: "synthetic-encrypt-key",
          privateKey: "synthetic-private-key",
        },
      },
    };
    const result = redactConfigSnapshot(makeSnapshot(config));
    expect(result.config).toEqual({
      provider: { ...safe, apiKey: REDACTED_SENTINEL, accessToken: REDACTED_SENTINEL },
      channels: {
        custom: {
          botToken: REDACTED_SENTINEL,
          webhookSecret: REDACTED_SENTINEL,
          password: REDACTED_SENTINEL,
          encryptKey: REDACTED_SENTINEL,
          privateKey: REDACTED_SENTINEL,
        },
      },
    });
    expect(restoreRedactedValues(result.config, config)).toEqual(config);
  });

  it("redacts whole serviceAccount objects without schema hints", () => {
    const config = {
      channels: {
        googlechat: {
          serviceAccount: {
            type: "service_account",
            client_email: "bot@example.test",
            private_key: "synthetic-private-key",
          },
        },
      },
    };
    const result = redactConfigSnapshot(makeSnapshot(config));
    expect(result.config).toEqual({
      channels: { googlechat: { serviceAccount: REDACTED_SENTINEL } },
    });
    expect(restoreRedactedValues(result.config, config)).toEqual(config);
  });

  it("redacts every string in an apiKey object without schema hints", () => {
    const config = {
      models: {
        providers: {
          example: {
            apiKey: { source: "env", provider: "default", id: "EXAMPLE_API_KEY" },
          },
        },
      },
    };
    expect(redactConfigSnapshot(makeSnapshot(config)).config).toEqual({
      models: {
        providers: {
          example: {
            apiKey: {
              source: REDACTED_SENTINEL,
              provider: REDACTED_SENTINEL,
              id: REDACTED_SENTINEL,
            },
          },
        },
      },
    });
  });

  it("round-trips embedded URL credentials in JSON5 raw text", () => {
    const config = {
      models: { providers: { example: { baseUrl: "https://alice:secret@example.test/v1" } } },
    };
    const raw =
      '{ models: { providers: { example: { baseUrl: "https://alice:secret@example.test/v1", }, }, }, }';
    const result = redactConfigSnapshot(makeSnapshot(config, raw));
    expect(result.config).toEqual({
      models: { providers: { example: { baseUrl: REDACTED_SENTINEL } } },
    });
    expect(result.raw).toBe(
      raw.replace(config.models.providers.example.baseUrl, REDACTED_SENTINEL),
    );
    expect(restoreRedactedValues(JSON5.parse(result.raw ?? "{}"), config)).toEqual(config);
  });

  it("redacts and restores MCP headers while leaving blank and env-backed values editable", () => {
    const hints = buildConfigSchemaCore().uiHints;
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
    const result = redactConfigSnapshot(makeSnapshot(config), hints);
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
    expect(
      restoreRedactedValues(
        { mcp: { servers: { renamed: servers.editable, protected: servers.protected } } },
        config,
        hints,
      ),
    ).toEqual({
      mcp: { servers: { renamed: editable, protected: protectedServer } },
    });
  });

  it("redacts all local-service env values including token-count names", () => {
    const config = {
      models: {
        providers: {
          local: {
            localService: {
              command: "/usr/local/bin/server",
              env: { HF_HOME: "synthetic-home", MAX_TOKENS: "synthetic-limit" },
            },
          },
        },
      },
    };
    const result = redactConfigSnapshot(makeSnapshot(config), buildConfigSchemaCore().uiHints);
    expect(result.config).toEqual({
      models: {
        providers: {
          local: {
            localService: {
              command: "/usr/local/bin/server",
              env: { HF_HOME: REDACTED_SENTINEL, MAX_TOKENS: REDACTED_SENTINEL },
            },
          },
        },
      },
    });
    expect(result.raw).not.toContain("synthetic-home");
    expect(result.raw).not.toContain("synthetic-limit");
    expect(restoreRedactedValues(result.config, config, buildConfigSchemaCore().uiHints)).toEqual(
      config,
    );
  });

  it("redacts install-policy env values using generated hints", () => {
    const hints = buildConfigSchemaCore().uiHints;
    const config = {
      security: {
        installPolicy: {
          enabled: true,
          exec: {
            source: "exec",
            command: "/usr/local/bin/policy",
            env: { AUDIT_ENDPOINT: "synthetic-endpoint" },
          },
        },
      },
    };
    const result = redactConfigSnapshot(makeSnapshot(config), hints);
    expect(result.config).toEqual({
      security: {
        installPolicy: {
          enabled: true,
          exec: {
            source: "exec",
            command: "/usr/local/bin/policy",
            env: { AUDIT_ENDPOINT: REDACTED_SENTINEL },
          },
        },
      },
    });
    expect(result.raw).not.toContain("synthetic-endpoint");
    expect(restoreRedactedValues(result.config, config, hints)).toEqual(config);
  });

  it("keeps raw text when runtime materialization adds undefined safe-bin fields", () => {
    const sourceConfig = { tools: { exec: { mode: "full" } } } satisfies OpenClawConfig;
    const raw = JSON.stringify(sourceConfig);
    const runtimeConfig = materializeRuntimeConfig(structuredClone(sourceConfig));
    const snapshot = { ...makeSnapshot(sourceConfig, raw), config: runtimeConfig, runtimeConfig };
    expect(runtimeConfig.tools?.exec).toHaveProperty("safeBinProfiles", undefined);
    expect(redactConfigSnapshot(snapshot).raw).toBe(raw);
  });

  it("preserves SecretRef structure in raw text and restores its id", () => {
    const config = {
      models: {
        providers: {
          default: {
            apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
          },
        },
      },
    };
    const result = redactConfigSnapshot(makeSnapshot(config), mainSchemaHints);
    const expected = {
      models: {
        providers: {
          default: {
            apiKey: { source: "env", provider: "default", id: REDACTED_SENTINEL },
          },
        },
      },
    };
    expect(result.config).toEqual(expected);
    expect(JSON5.parse(result.raw ?? "{}")).toEqual(expected);
    expect(restoreRedactedValues(JSON5.parse(result.raw ?? "{}"), config, mainSchemaHints)).toEqual(
      config,
    );
  });

  it("withholds overlapping raw replacements without corrupting SecretRef identity", () => {
    const config = {
      gateway: { mode: "default", auth: { password: "default" } }, // pragma: allowlist secret
      models: {
        providers: {
          default: { apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" } },
        },
      },
    };
    const result = redactConfigSnapshot(makeSnapshot(config), mainSchemaHints);
    expect(result.raw).toBeNull();
    expect(result.config).toEqual({
      gateway: { mode: "default", auth: { password: REDACTED_SENTINEL } },
      models: {
        providers: {
          default: { apiKey: { source: "env", provider: "default", id: REDACTED_SENTINEL } },
        },
      },
    });
    expect(restoreRedactedValues(result.config, config, mainSchemaHints)).toEqual(config);
  });

  it.each(["", "${GATEWAY_TOKEN}"])("preserves non-concrete secret %j in raw text", (value) => {
    const config = { gateway: { auth: { token: value } }, other: value };
    const raw = JSON.stringify(config);
    const result = redactConfigSnapshot(makeSnapshot(config, raw));
    expect(result.config).toEqual(config);
    expect(result.raw).toBe(raw);
    expect(restoreRedactedValues(result.config, config)).toEqual(config);
  });

  it("redacts projections independently without rewriting raw text with another projection's secrets", () => {
    const config = {
      gateway: { auth: { token: "synthetic-runtime-token" } },
      meta: { lastTouchedVersion: "resolved-only-value migration-only-value" },
    };
    const result = redactConfigSnapshot({
      ...makeSnapshot(config),
      resolved: { ...config, gateway: { auth: { token: "resolved-only-value" } } },
      sourceConfigBeforeMigrations: { gateway: { auth: { token: "migration-only-value" } } },
    });
    const expected = { ...config, gateway: { auth: { token: REDACTED_SENTINEL } } };
    for (const projection of [
      result.config,
      result.parsed,
      result.sourceConfig,
      result.resolved,
      result.runtimeConfig,
    ]) {
      expect(projection).toEqual(expected);
    }
    expect(result.sourceConfig).toBe(result.resolved);
    expect(result.runtimeConfig).toBe(result.config);
    expect(result).not.toHaveProperty("sourceConfigBeforeMigrations");
    expect(result.raw).toBe(JSON.stringify(expected));
  });

  it("withholds every content projection for invalid snapshots", () => {
    const result = redactConfigSnapshot({
      ...makeSnapshot({ gateway: { auth: { token: "leaky-secret" } } }),
      valid: false,
    });
    expect(result.raw).toBeNull();
    expect(result.parsed).toBeNull();
    for (const projection of [
      result.config,
      result.sourceConfig,
      result.resolved,
      result.runtimeConfig,
    ]) {
      expect(projection).toStrictEqual({});
    }
    expect(result.sourceConfig).toBe(result.resolved);
    expect(result.runtimeConfig).toBe(result.config);
  });

  it("falls back to heuristic redaction under unmatched extension subtrees", () => {
    const hints: ConfigUiHints = { "plugins.entries.proof.config": { label: "Proof" } };
    const config = {
      plugins: {
        entries: { proof: { config: { apiToken: "synthetic-token", displayName: "Proof" } } },
      },
    };
    const result = redactConfigSnapshot(makeSnapshot(config), hints);
    expect(result.config).toEqual({
      plugins: {
        entries: { proof: { config: { apiToken: REDACTED_SENTINEL, displayName: "Proof" } } },
      },
    });
    expect(restoreRedactedValues(result.config, config, hints)).toEqual(config);
  });

  it("honors sensitive:false after falling back from schema lookup", () => {
    const hints: ConfigUiHints = {
      "some.other.path": { sensitive: true },
      "plugins.entries.proof.config.apiToken": { sensitive: false },
    };
    const config = { plugins: { entries: { proof: { config: { apiToken: "public-token" } } } } };
    expect(redactConfigSnapshot(makeSnapshot(config), hints).config).toEqual(config);
  });

  it.each<{ name: string; hints?: ConfigUiHints }>([
    { name: "heuristic fallback" },
    { name: "schema hints", hints: { "nested.token[]": { sensitive: true } } },
  ])("round-trips mixed secret arrays with $name", ({ hints }) => {
    const config = {
      nested: { token: ["synthetic-secret", 42, null, "${TOKEN}", ""], harmless: ["visible"] },
    };
    const result = redactConfigSnapshot(makeSnapshot(config), hints);
    expect(result.config).toEqual({
      nested: { token: [REDACTED_SENTINEL, 42, null, "${TOKEN}", ""], harmless: ["visible"] },
    });
    expect(restoreRedactedValues(result.config, config, hints)).toEqual(config);
  });

  it("round-trips custom nested records and object arrays using wildcard hints", () => {
    const hints: ConfigUiHints = {
      "records.*.value": { sensitive: true },
      "items[].value": { sensitive: true },
    };
    const config = {
      records: { first: { value: "record-secret" } },
      items: [{ value: "array-secret" }],
    };
    const result = redactConfigSnapshot(makeSnapshot(config), hints);
    expect(result.config).toEqual({
      records: { first: { value: REDACTED_SENTINEL } },
      items: [{ value: REDACTED_SENTINEL }],
    });
    expect(restoreRedactedValues(result.config, config, hints)).toEqual(config);
  });
});

describe("generated redaction hints", () => {
  it("normalizes authored URL tags and protects custom plugin endpoints", () => {
    const hints = buildConfigSchemaCore({
      plugins: [
        {
          id: "endpoint-proof",
          configSchema: { type: "object", properties: { endpoint: { type: "string" } } },
          configUiHints: { endpoint: { sensitive: false, tags: [" URL-SECRET "] } },
        },
      ],
    }).uiHints;
    const config = {
      plugins: {
        entries: {
          "endpoint-proof": {
            config: {
              endpoint: "https://proof-user:proof-password@example.test/v1?token=proof-token",
            },
          },
        },
      },
    };
    const result = redactConfigSnapshot(makeSnapshot(config), hints);
    expect(result.config.plugins?.entries?.["endpoint-proof"]?.config?.endpoint).toBe(
      REDACTED_SENTINEL,
    );
    for (const secret of ["proof-user", "proof-password", "proof-token"]) {
      expect(JSON.stringify(result)).not.toContain(secret);
    }
    expect(restoreRedactedValues(result.config, config, hints)).toEqual(config);
  });

  it("redacts remote edge-auth headers", () => {
    const hints = buildConfigSchemaCore().uiHints;
    const config = { gateway: { remote: { edgeAuth: { "X-Edge-Auth": "synthetic-secret" } } } };
    const result = redactConfigSnapshot(makeSnapshot(config), hints);
    expect(result.config).toEqual({
      gateway: { remote: { edgeAuth: { "X-Edge-Auth": REDACTED_SENTINEL } } },
    });
    expect(restoreRedactedValues(result.config, config, hints)).toEqual(config);
  });

  it("redacts web-fetch operator headers", () => {
    const hints = buildConfigSchemaCore().uiHints;
    const config = {
      tools: { web: { fetch: { headers: { "X-Routing-Target": "staging-private-route" } } } },
    };
    const result = redactConfigSnapshot(makeSnapshot(config), hints);
    expect(result.config).toEqual({
      tools: { web: { fetch: { headers: { "X-Routing-Target": REDACTED_SENTINEL } } } },
    });
    expect(restoreRedactedValues(result.config, config, hints)).toEqual(config);
  });
});

describe("replaceSensitiveValuesInRaw", () => {
  it("redacts non-empty values while preserving blank strings", () => {
    const result = replaceSensitiveValuesInRaw({
      raw: '{ "token": "", "secret": "abc123", "other": "" }',
      sensitiveValues: ["", "abc123"],
      redactedSentinel: REDACTED_SENTINEL,
    });
    expect(result).toBe(`{ "token": "", "secret": "${REDACTED_SENTINEL}", "other": "" }`);
  });

  it("replaces longest values first for overlapping matches", () => {
    const result = replaceSensitiveValuesInRaw({
      raw: '{ "token": "abcd", "prefix": "ab" }',
      sensitiveValues: ["ab", "abcd", "abcd"],
      redactedSentinel: REDACTED_SENTINEL,
    });
    expect(result).toBe(`{ "token": "${REDACTED_SENTINEL}", "prefix": "${REDACTED_SENTINEL}" }`);
  });
});
