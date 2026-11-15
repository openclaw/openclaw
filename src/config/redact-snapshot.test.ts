import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { redactSnapshotTestHints as mainSchemaHints } from "../../test/helpers/config/redact-snapshot-test-hints.js";
import { createWarnLogCapture } from "../logging/test-helpers/warn-log-capture.js";
import type { ConfigUiHints } from "../shared/config-ui-hints-types.js";
import { materializeRuntimeConfig } from "./materialize.js";
import {
  REDACTED_SENTINEL,
  redactConfigSnapshot,
  restoreRedactedValues as restoreRedactedValues_orig,
} from "./redact-snapshot.js";
import { replaceSensitiveValuesInRaw } from "./redact-snapshot.raw.js";
import { makeSnapshot, restoreRedactedValues } from "./redact-snapshot.test-helpers.js";
import { buildConfigSchemaCore } from "./schema.js";
import type { OpenClawConfig } from "./types.openclaw.js";

const apiKeyConfig = (apiKey: Record<string, unknown>, provider = "default") => ({
  models: { providers: { [provider]: { apiKey } } },
});
const secretRef = { source: "env", provider: "default", id: "OPENAI_API_KEY" };
const account = (id: string, token = REDACTED_SENTINEL) => ({ id, token });
const secretAccount = (id: string, tokenId = id) => account(id, `synthetic-${tokenId}-token`);
const providerAccounts = (id: string, ...accounts: ReturnType<typeof account>[]) => ({
  id,
  accounts,
});
const tokenConfig = (token: string) => ({ gateway: { auth: { token } } });
function expectProjections(result: ReturnType<typeof redactConfigSnapshot>, expected: unknown) {
  for (const projection of [
    result.config,
    result.parsed,
    result.sourceConfig,
    result.resolved,
    result.runtimeConfig,
  ]) {
    expect(projection).toEqual(expected);
  }
}

describe("redactConfigSnapshot", () => {
  it.each(["synthetic-inline-credential", 'synthetic-line-one\n"synthetic-line-two"'])(
    "protects inline environment values in every public projection and restores them: %j",
    (credential) => {
      const hints = buildConfigSchemaCore().uiHints;
      const vars = {
        AZURE_OPENAI_KEY: credential,
        DATABASE_URL: "postgres://example:synthetic@example.invalid/db",
        REFERENCE: "${REDACTION_TEST_REFERENCE}",
        EMPTY: "",
      };
      const config = { env: { vars } };
      const redacted = {
        env: {
          vars: { ...vars, AZURE_OPENAI_KEY: REDACTED_SENTINEL, DATABASE_URL: REDACTED_SENTINEL },
        },
      };
      const result = redactConfigSnapshot(makeSnapshot(config), hints);
      expectProjections(result, redacted);
      expect(result.raw).toBe(credential.includes("\n") ? null : JSON.stringify(redacted));
      expect(restoreRedactedValues(result.config, config, hints)).toEqual(config);
    },
  );

  it("redacts whole serviceAccount objects without schema hints", () => {
    const serviceAccount = {
      type: "service_account",
      client_email: "bot@example.test",
      private_key: "synthetic-private-key",
    };
    const config = { channels: { googlechat: { serviceAccount } } };
    const result = redactConfigSnapshot(makeSnapshot(config));
    expect(result.config).toEqual({
      channels: { googlechat: { serviceAccount: REDACTED_SENTINEL } },
    });
    expect(restoreRedactedValues(result.config, config)).toEqual(config);
  });

  it("redacts every string in an apiKey object without schema hints", () => {
    const config = apiKeyConfig(
      { source: "env", provider: "default", id: "EXAMPLE_API_KEY" },
      "example",
    );
    expect(redactConfigSnapshot(makeSnapshot(config)).config).toEqual(
      apiKeyConfig(
        {
          source: REDACTED_SENTINEL,
          provider: REDACTED_SENTINEL,
          id: REDACTED_SENTINEL,
        },
        "example",
      ),
    );
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
    expectProjections(result, expected);
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

  it("keeps raw text when runtime materialization adds undefined safe-bin fields", () => {
    const sourceConfig = { tools: { exec: { mode: "full" } } } satisfies OpenClawConfig;
    const raw = JSON.stringify(sourceConfig);
    const runtimeConfig = materializeRuntimeConfig(structuredClone(sourceConfig));
    const snapshot = { ...makeSnapshot(sourceConfig, raw), config: runtimeConfig, runtimeConfig };
    expect(runtimeConfig.tools?.exec).toHaveProperty("safeBinProfiles", undefined);
    expect(redactConfigSnapshot(snapshot).raw).toBe(raw);
  });

  it("withholds overlapping raw replacements without corrupting SecretRef identity", () => {
    const config = {
      gateway: { mode: "default", auth: { password: "default" } }, // pragma: allowlist secret
      ...apiKeyConfig(secretRef),
    };
    const result = redactConfigSnapshot(makeSnapshot(config), mainSchemaHints);
    expect(result.raw).toBeNull();
    expect(result.config).toEqual({
      gateway: { mode: "default", auth: { password: REDACTED_SENTINEL } },
      ...apiKeyConfig({ ...secretRef, id: REDACTED_SENTINEL }),
    });
    expect(restoreRedactedValues(result.config, config, mainSchemaHints)).toEqual(config);
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
    expectProjections(result, expected);
    expect(result.sourceConfig).toBe(result.resolved);
    expect(result.runtimeConfig).toBe(result.config);
    expect(result).not.toHaveProperty("sourceConfigBeforeMigrations");
    expect(result.raw).toBe(JSON.stringify(expected));
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
});

describe("generated redaction hints", () => {
  it("preserves account SecretRef identity via generated channel metadata hints", () => {
    const hints = buildConfigSchemaCore().uiHints;
    expect(hints["channels.matrix.accounts.*.password"]?.sensitive).toBe(true);
    expect(hints["channels.matrix.accounts.*.accessToken"]?.sensitive).toBe(true);

    const password = { source: "store", provider: "default", id: "MATRIX_WORK_PASSWORD" };
    const snapshot = makeSnapshot({ channels: { matrix: { accounts: { work: { password } } } } });

    const result = redactConfigSnapshot(snapshot, hints);
    expect(result.config).toHaveProperty("channels.matrix.accounts.work.password", {
      source: "store",
      provider: "default",
      id: REDACTED_SENTINEL,
    });

    const restored = restoreRedactedValues(result.config, snapshot.config, hints);
    expect(restored.channels.matrix.accounts.work.password).toEqual(password);
  });

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
});

describe("replaceSensitiveValuesInRaw", () => {
  it.each([
    {
      name: "preserves blank strings",
      raw: '{ "token": "", "secret": "abc123", "other": "" }',
      sensitiveValues: ["", "abc123"],
      expected: `{ "token": "", "secret": "${REDACTED_SENTINEL}", "other": "" }`,
    },
    {
      name: "replaces longest values first for overlapping matches",
      raw: '{ "token": "abcd", "prefix": "ab" }',
      sensitiveValues: ["ab", "abcd", "abcd"],
      expected: `{ "token": "${REDACTED_SENTINEL}", "prefix": "${REDACTED_SENTINEL}" }`,
    },
  ])("$name", ({ raw, sensitiveValues, expected }) => {
    expect(
      replaceSensitiveValuesInRaw({ raw, sensitiveValues, redactedSentinel: REDACTED_SENTINEL }),
    ).toBe(expected);
  });
});

describe("redactConfigSnapshot", () => {
  it.each([true, false])("omits private snapshot fields when valid=%s", (valid) => {
    const token = "synthetic-canonical-token-canary";
    const authoredToken = "synthetic-authored-token-canary";
    const preMigrationToken = "synthetic-pre-migration-token-canary";
    const snapshot = {
      ...makeSnapshot({
        ...tokenConfig(token),
        plugins: { allow: ["demo"] },
      }),
      valid,
      authoredConfig: tokenConfig(authoredToken),
      sourceConfigBeforeMigrations: makeSnapshot(tokenConfig(preMigrationToken)).sourceConfig,
      pluginMetadataSnapshot: {
        manifestRegistry: { plugins: [{ rootDir: "/private/plugin/root" }] },
      },
    };
    const original = structuredClone(snapshot);

    const result = redactConfigSnapshot(snapshot);
    const serialized = JSON.stringify(result);

    for (const secret of [preMigrationToken, authoredToken, token, "/private/plugin/root"]) {
      expect(serialized).not.toContain(secret);
    }
    for (const key of [
      "sourceConfigBeforeMigrations",
      "authoredConfig",
      "pluginMetadataSnapshot",
    ]) {
      expect(key in result).toBe(false);
    }
    expect(result).toMatchObject({ path: snapshot.path, hash: "abc123", exists: true, valid });
    const expectedConfig = valid
      ? { gateway: { auth: { token: REDACTED_SENTINEL } }, plugins: { allow: ["demo"] } }
      : {};
    for (const projection of [
      result.config,
      result.sourceConfig,
      result.resolved,
      result.runtimeConfig,
    ]) {
      expect(projection).toEqual(expectedConfig);
    }
    expect(result.sourceConfig).toBe(result.resolved);
    expect(result.runtimeConfig).toBe(result.config);
    if (!valid) {
      expect(result.raw).toBeNull();
      expect(result.parsed).toBeNull();
    }
    expect(snapshot).toEqual(original);
  });
});

describe("restoreRedactedValues", () => {
  it("warns when a write restores a truncated array", async () => {
    const incoming = { plugins: { allow: ["source"] } };
    const original = { plugins: { allow: ["source", "second"] } };
    const warnLogs = createWarnLogCapture("openclaw-config-redaction-array-test");
    try {
      expect(restoreRedactedValues(incoming, original)).toEqual(incoming);
      expect(await warnLogs.findText("Redacted config array key plugins.allow[]")).toContain(
        "has been truncated",
      );
    } finally {
      warnLogs.cleanup();
    }
  });

  it("rejects inherited constructor values when the original key is missing", () => {
    const hints = { constructor: { sensitive: true } };
    expect(restoreRedactedValues_orig({ constructor: REDACTED_SENTINEL }, {}, hints).ok).toBe(
      false,
    );
  });

  it("rejects invalid restore inputs", () => {
    for (const input of [null, undefined, "token-value"]) {
      const result = restoreRedactedValues_orig(input, { token: "x" });
      expect(result.ok).toBe(false);
    }
    expect(restoreRedactedValues_orig("token-value", { token: "x" })).toEqual({
      ok: false,
      error: "input not an object",
    });
  });

  it("rejects sentinel literals even when uiHints mark the path non-sensitive", () => {
    const hints: ConfigUiHints = { "gateway.auth.token": { sensitive: false } };
    const incoming = tokenConfig(REDACTED_SENTINEL);
    const original = tokenConfig("real-secret");
    const result = restoreRedactedValues_orig(incoming, original, hints);
    expect(result.ok).toBe(false);
    expect(result.humanReadableMessage).toContain("Reserved redaction sentinel");
  });

  describe("stable array identities", () => {
    const hints = { "accounts[].token": { sensitive: true } };
    it.each([
      {
        name: "a unique owner after ambiguous siblings are deleted",
        previous: [
          secretAccount("duplicate", "first-duplicate"),
          secretAccount("duplicate", "second-duplicate"),
          secretAccount("bravo"),
        ],
        incoming: [account("bravo")],
        expected: [secretAccount("bravo")],
      },
      {
        name: "prototype-shaped identities without inherited-key collisions",
        previous: [secretAccount("__proto__", "prototype"), secretAccount("constructor")],
        incoming: [account("constructor"), account("__proto__")],
        expected: [secretAccount("constructor"), secretAccount("__proto__", "prototype")],
      },
      {
        name: "escaped environment identities positionally after runtime substitution",
        previous: [secretAccount("${ACCOUNT_ID}", "literal"), secretAccount("bravo")],
        incoming: [account("$${ACCOUNT_ID}"), account("bravo")],
        expected: [secretAccount("$${ACCOUNT_ID}", "literal"), secretAccount("bravo")],
      },
    ])("restores $name", ({ previous, incoming, expected }) => {
      expect(
        restoreRedactedValues({ accounts: incoming }, { accounts: previous }, hints).accounts,
      ).toEqual(expected);
    });

    it.each([
      {
        name: "a new identity borrowing its position",
        previous: [secretAccount("alpha"), secretAccount("bravo"), secretAccount("charlie")],
        incoming: [account("new-owner")],
        secret: "synthetic-alpha-token",
      },
      {
        name: "an unidentified entry moving onto an identified owner's position",
        previous: [{ token: "synthetic-unidentified-token" }, secretAccount("bravo")],
        incoming: [account("bravo"), { token: REDACTED_SENTINEL }],
        secret: "synthetic-bravo-token",
      },
    ])("rejects $name", ({ previous, incoming, secret }) => {
      const result = restoreRedactedValues_orig(
        { accounts: incoming },
        { accounts: previous },
        hints,
      );
      expect(result.ok).toBe(false);
      expect(result.humanReadableMessage).not.toContain(secret);
    });

    it("keeps positional restoration when original identities are duplicated", () => {
      const identities = [{ id: "duplicate" }, { id: "duplicate" }];
      const restored = restoreRedactedValues(
        { accounts: identities.map(({ id }) => account(id)) },
        {
          accounts: identities.map(({ id }, index) => account(id, `synthetic-${index}-token`)),
        },
        hints,
      );

      expect(restored.accounts.map((entry) => entry.token)).toEqual([
        "synthetic-0-token",
        "synthetic-1-token",
      ]);
    });
  });

  it("matches stable identities independently at each nested array boundary", () => {
    const hints: ConfigUiHints = { "providers[].accounts[].token": { sensitive: true } };
    const original = {
      providers: [
        providerAccounts("provider-alpha", secretAccount("account-one", "alpha-one")),
        providerAccounts(
          "provider-bravo",
          secretAccount("account-one", "bravo-one"),
          secretAccount("account-two", "bravo-two"),
        ),
      ],
    };
    const incoming = {
      providers: [
        providerAccounts("provider-bravo", account("account-two"), account("account-one")),
      ],
    };

    const restored = restoreRedactedValues(incoming, original, hints);

    expect(restored.providers).toEqual([
      providerAccounts(
        "provider-bravo",
        secretAccount("account-two", "bravo-two"),
        secretAccount("account-one", "bravo-one"),
      ),
    ]);
  });

  it("rejects SecretRef source/provider changes when id is still redacted", () => {
    const incoming = apiKeyConfig({ source: "file", provider: "vault", id: REDACTED_SENTINEL });
    const original = apiKeyConfig(secretRef);
    const result = restoreRedactedValues_orig(incoming, original, mainSchemaHints);
    expect(result.ok).toBe(false);
    expect(result.humanReadableMessage).toContain("changed source/provider");
  });

  it("reports a provider-focused error when original SecretRefs lack provider", () => {
    const incoming = apiKeyConfig({ source: "env", id: REDACTED_SENTINEL });
    const original = apiKeyConfig({ source: "env", id: "OPENAI_API_KEY" });
    const result = restoreRedactedValues_orig(incoming, original, mainSchemaHints);
    expect(result.ok).toBe(false);
    expect(result.humanReadableMessage).toContain("requires a provider field");
  });
});
