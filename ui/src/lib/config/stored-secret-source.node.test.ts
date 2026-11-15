// @vitest-environment node
import nodePath from "node:path";
import { describe, expect, it } from "vitest";
import { resolveConfigEnvVars } from "../../../../src/config/env-substitution.js";
import { resolveConfigIncludes } from "../../../../src/config/includes.js";
import { redactConfigSnapshot } from "../../../../src/config/redact-snapshot.js";
import { buildConfigSchemaCore } from "../../../../src/config/schema.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import { appendConfigPathSegment } from "../../../../src/shared/dot-path.js";
import type { ConfigSnapshot } from "../../api/types.ts";
import {
  keptChannelEdits,
  buildChannelConfigPatch,
} from "../../pages/channels/channel-config-draft.ts";
import { storedSkillApiKeySource } from "../skills/api-key-source.ts";
import { storedSecretSource } from "./stored-secret-source.ts";

// Every snapshot here goes through the Gateway's own include, env and redaction code, so the form
// is classified from exactly what config.get would send it.
const { uiHints: hints } = buildConfigSchemaCore();
const ENV = { SET_TOKEN: "env-token-value-not-real", OTHER_TOKEN: "other-env-value-not-real" };

function gatewaySnapshot(
  authored: Record<string, unknown>,
  files: Record<string, unknown> = {},
): ConfigSnapshot {
  const included = resolveConfigIncludes(authored, "/fixture/openclaw.json", {
    readFile: (file) => JSON.stringify(files[nodePath.basename(file)]),
    parseJson: JSON.parse,
  });
  const warnings: Array<{ path: string; message: string }> = [];
  const resolved = resolveConfigEnvVars(included, ENV, {
    onMissing: ({ varName, configPath }) =>
      warnings.push({
        path: configPath,
        message: `Missing env var "${varName}" - feature using this value will be unavailable`,
      }),
  }) as OpenClawConfig;
  const snapshot: ConfigFileSnapshot = {
    path: "/fixture/openclaw.json",
    ...(Object.keys(files).length > 0
      ? { includedPaths: Object.keys(files).map((file) => `/fixture/${file}`) }
      : {}),
    exists: true,
    raw: JSON.stringify(authored, null, 2),
    parsed: authored,
    sourceConfig: resolved,
    resolved,
    config: resolved,
    runtimeConfig: resolved,
    valid: true,
    hash: "fixture",
    issues: [],
    warnings,
    legacyIssues: [],
  };
  // SAFETY: The redacted snapshot is the config.get payload the UI types as ConfigSnapshot.
  return redactConfigSnapshot(snapshot, hints) as unknown as ConfigSnapshot;
}

const literal = { kind: "literal" };
const reference = { kind: "reference" };
const token = ["gateway", "auth", "token"];
const discord = ["channels", "discord", "token"];

describe("storedSecretSource, against the Gateway's own redaction", () => {
  it("lets a plain value in the file be replaced", () => {
    const snapshot = gatewaySnapshot({ gateway: { auth: { token: "plain-token-not-real" } } });
    expect(snapshot.raw).toEqual(expect.any(String));
    expect(storedSecretSource(snapshot, token)).toEqual(literal);
  });

  it("names a whole ${VAR} and keeps it read-only", () => {
    const snapshot = gatewaySnapshot({ gateway: { auth: { token: "${SET_TOKEN}" } } });
    expect(storedSecretSource(snapshot, token)).toEqual({
      kind: "environment",
      name: "SET_TOKEN",
    });
  });

  it.each([
    ["text before", "Bearer ${SET_TOKEN}"],
    ["text after", "${SET_TOKEN}-suffix"],
    ["two variables", "${SET_TOKEN}:${OTHER_TOKEN}"],
    ["a default", "Bearer ${UNSET_TOKEN:-fallback-not-real}"],
  ])("keeps a template with %s read-only, and every other stored secret too", (_name, value) => {
    const snapshot = gatewaySnapshot({
      gateway: { auth: { token: "plain-token-not-real" } },
      channels: { discord: { token: value } },
    });
    // The Gateway can't show this file's text without the resolved value, so it withholds it.
    expect(snapshot.raw).toBeNull();
    expect(storedSecretSource(snapshot, discord)).toEqual(reference);
    expect(storedSecretSource(snapshot, token)).toEqual(reference);
  });

  it("keeps a template read-only when its variable is unset", () => {
    const snapshot = gatewaySnapshot({
      gateway: { auth: { token: "plain-token-not-real" } },
      channels: { discord: { token: "Bearer ${UNSET_TOKEN}" } },
    });
    // The template stays as text, so the file's text still matches; the warning gives it away.
    expect(snapshot.raw).toEqual(expect.any(String));
    expect(snapshot.config?.channels).toEqual({ discord: { token: "__OPENCLAW_REDACTED__" } });
    expect(storedSecretSource(snapshot, discord)).toEqual(reference);
    expect(storedSecretSource(snapshot, token)).toEqual(literal);
  });

  it("keeps an escaped template read-only, and every other stored secret too", () => {
    const snapshot = gatewaySnapshot({
      gateway: { auth: { token: "plain-token-not-real" } },
      channels: { discord: { token: "Bearer $${SET_TOKEN}" } },
    });
    expect(storedSecretSource(snapshot, discord)).toEqual(reference);
    expect(storedSecretSource(snapshot, token)).toEqual(reference);
  });

  it("keeps a SecretRef and each of its parts read-only", () => {
    const snapshot = gatewaySnapshot({
      gateway: { auth: { token: "plain-token-not-real" } },
      models: {
        providers: {
          fixture: {
            baseUrl: "https://provider.example.test/v1",
            apiKey: { source: "env", provider: "default", id: "SET_TOKEN" },
            models: [],
          },
        },
      },
    });
    const apiKey = ["models", "providers", "fixture", "apiKey"];
    for (const part of [
      apiKey,
      [...apiKey, "id"],
      [...apiKey, "source"],
      [...apiKey, "provider"],
    ]) {
      expect(storedSecretSource(snapshot, part)).toEqual(reference);
    }
    expect(storedSecretSource(snapshot, token)).toEqual(literal);
  });

  it("keeps a value from an $include read-only, and every other stored secret too", () => {
    const snapshot = gatewaySnapshot(
      {
        gateway: { auth: { token: "plain-token-not-real" } },
        channels: { $include: "./channels.json5" },
      },
      { "channels.json5": { discord: { token: "included-token-not-real" } } },
    );
    expect(snapshot.config?.channels).toEqual({ discord: { token: "__OPENCLAW_REDACTED__" } });
    expect(storedSecretSource(snapshot, discord)).toEqual(reference);
    expect(storedSecretSource(snapshot, token)).toEqual(reference);
  });

  it("keeps a value under a root $include read-only", () => {
    const snapshot = gatewaySnapshot(
      { $include: "./base.json5", gateway: { auth: { token: "plain-token-not-real" } } },
      { "base.json5": { channels: { discord: { token: "included-token-not-real" } } } },
    );
    expect(storedSecretSource(snapshot, discord)).toEqual(reference);
    expect(storedSecretSource(snapshot, token)).toEqual(reference);
  });

  it("classifies arrays and maps of secrets entry by entry", () => {
    const keys = ["plugins", "entries", "fixture", "config", "apiKeys"];
    const accounts = ["channels", "telegram", "accounts"];
    const snapshot = gatewaySnapshot({
      plugins: {
        entries: { fixture: { config: { apiKeys: ["plain-key-not-real", "${SET_TOKEN}"] } } },
      },
      channels: {
        telegram: {
          accounts: {
            main: { botToken: "plain-bot-not-real" },
            "ops.team": { botToken: "${OTHER_TOKEN}" },
          },
        },
      },
    });
    expect(storedSecretSource(snapshot, [...keys, 0])).toEqual(literal);
    expect(storedSecretSource(snapshot, [...keys, 1])).toEqual({
      kind: "environment",
      name: "SET_TOKEN",
    });
    expect(storedSecretSource(snapshot, [...keys, "0"])).toEqual(reference);
    expect(storedSecretSource(snapshot, [...accounts, "main", "botToken"])).toEqual(literal);
    expect(storedSecretSource(snapshot, [...accounts, "ops.team", "botToken"])).toEqual({
      kind: "environment",
      name: "OTHER_TOKEN",
    });
  });

  it("reads a warning at a dotted map key the way the Gateway spells it", () => {
    const path = ["channels", "telegram", "accounts", "ops.team", "botToken"];
    const snapshot = gatewaySnapshot({
      gateway: { auth: { token: "plain-token-not-real" } },
      channels: { telegram: { accounts: { "ops.team": { botToken: "x${UNSET_TOKEN}" } } } },
    });
    const spelled = path.reduce<string>(appendConfigPathSegment, "");
    expect(snapshot.warnings).toEqual([expect.objectContaining({ path: spelled })]);
    expect(storedSecretSource(snapshot, path)).toEqual(reference);
    expect(storedSecretSource(snapshot, token)).toEqual(literal);
  });

  it("fails closed on anything it can't prove", () => {
    const snapshot = gatewaySnapshot({ gateway: { auth: { token: "plain-token-not-real" } } });
    expect(storedSecretSource(null, token)).toEqual(reference);
    expect(storedSecretSource({ ...snapshot, valid: false }, token)).toEqual(reference);
    expect(storedSecretSource({ ...snapshot, raw: null }, token)).toEqual(reference);
    expect(storedSecretSource({ ...snapshot, raw: undefined }, token)).toEqual(reference);
    expect(storedSecretSource({ ...snapshot, parsed: undefined }, token)).toEqual(reference);
    expect(storedSecretSource({ ...snapshot, includedPaths: ["/fixture/x.json5"] }, token)).toEqual(
      reference,
    );
    // A value the form sees that the file doesn't author, such as a runtime default.
    expect(storedSecretSource(snapshot, ["gateway", "auth", "password"])).toEqual(reference);
    expect(
      storedSecretSource(
        { ...snapshot, sourceConfig: { gateway: { auth: { token: "visible" } } } },
        token,
      ),
    ).toEqual(reference);
  });
});

it.each([
  ["whole environment secret", "botToken", "${UNSET_TOKEN}", false],
  [
    "whole SecretRef",
    "botToken",
    { source: "env", provider: "default", id: "TELEGRAM_TOKEN" },
    false,
  ],
  ["ordinary environment field", "proxy", "${UNSET_PROXY}", true],
] as const)(
  "keeps %s intact when a saved reference meets an older plaintext edit",
  (_name, field, stored, writable) => {
    const snapshot = gatewaySnapshot({ channels: { telegram: { [field]: stored } } });
    const root = snapshot.sourceConfig!;
    const edits = keptChannelEdits(
      { configSnapshot: snapshot, configUiHints: hints },
      "telegram",
      root,
      [{ path: ["channels", "telegram", field], value: "typed-before-refresh" }],
    );
    const built = buildChannelConfigPatch({
      base: (root.channels as Record<string, Record<string, unknown>>).telegram!,
      channelId: "telegram",
      edits,
      schema: null,
    });
    expect(built?.patch ?? null).toEqual(
      writable ? { channels: { telegram: { proxy: "typed-before-refresh" } } } : null,
    );
  },
);

it.each([
  ["plaintext", "plain-key-not-real", literal],
  ["a SecretRef", { source: "env", provider: "default", id: "SET_TOKEN" }, reference],
  ["a whole ${VAR}", "${SET_TOKEN}", { kind: "environment", name: "SET_TOKEN" }],
  ["no key", undefined, null],
])("classifies a skill API key stored as %s", (_name, apiKey, source) => {
  const snapshot = gatewaySnapshot({ skills: { entries: { github: { apiKey } } } });
  expect(storedSkillApiKeySource(snapshot, "github")).toEqual(source);
  expect(storedSkillApiKeySource({ ...snapshot, valid: false }, "github")).toBeUndefined();
});
