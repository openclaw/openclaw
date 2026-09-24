// Verifies channel schema failures follow the plugin manifest trust boundary.

import { Settings } from "typebox/system";
import { describe, expect, it } from "vitest";
import type { PluginManifestRecord, PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { validateConfigObjectRawWithPlugins } from "./validation.js";

const malformedSchema = {
  type: "object",
  properties: { mode: { $ref: "#/$defs/Mode" } },
};

function createRegistry(
  origin: PluginManifestRecord["origin"],
  schema: Record<string, unknown> = malformedSchema,
): PluginManifestRegistry {
  return {
    diagnostics: [],
    plugins: [
      {
        id: "schema-owner",
        channels: ["schema-channel"],
        channelConfigs: { "schema-channel": { schema } },
        cliBackends: [],
        hooks: [],
        manifestPath: "/plugins/schema-owner/openclaw.plugin.json",
        origin,
        providers: [],
        rootDir: "/plugins/schema-owner",
        skills: [],
        source: "/plugins/schema-owner/index.js",
      },
    ],
  };
}

function validate(origin: PluginManifestRecord["origin"]) {
  return validateConfigObjectRawWithPlugins(
    { channels: { "schema-channel": {} } },
    { pluginMetadataSnapshot: { manifestRegistry: createRegistry(origin) } },
  );
}

describe("channel schema error ownership", () => {
  const closedBranch = {
    type: "object",
    properties: { mode: { type: "string" } },
    additionalProperties: false,
  };
  const declaredBranch = {
    type: "object",
    properties: { mode: { type: "string" }, deny: { type: "boolean" } },
  };
  const restrictedValue = { mode: "secure", deny: true };
  it.each([
    {
      name: "allOf",
      schema: { ...declaredBranch, allOf: [closedBranch] },
      value: restrictedValue,
    },
    {
      name: "dependentSchemas",
      schema: { ...declaredBranch, dependentSchemas: { mode: closedBranch } },
      value: restrictedValue,
    },
    {
      name: "a reference sibling",
      schema: { ...closedBranch, $ref: "#/$defs/Declared", $defs: { Declared: declaredBranch } },
      value: restrictedValue,
    },
    {
      name: "overlapping properties and patterns",
      schema: {
        type: "object",
        properties: { room: declaredBranch },
        patternProperties: { "^room$": closedBranch },
      },
      value: { room: restrictedValue },
    },
    {
      name: "contains alongside items",
      schema: {
        type: "object",
        properties: {
          entries: { type: "array", items: closedBranch, contains: declaredBranch },
        },
      },
      value: { entries: [restrictedValue, { mode: "secure" }] },
    },
  ])("does not remove a declared field rejected by $name", ({ schema, value }) => {
    const registry = createRegistry("global", schema);
    const original = structuredClone(value);
    expect(
      validateConfigObjectRawWithPlugins(
        { channels: { "schema-channel": value } },
        { schemaValidation: "runtime", pluginMetadataSnapshot: { manifestRegistry: registry } },
      ).ok,
    ).toBe(false);
    expect(value).toEqual(original);
  });

  it.each([
    {
      name: "dependent schema",
      schema: {
        type: "object",
        properties: { requireMention: { type: "boolean" } },
        dependentSchemas: {
          requireMention: { properties: { requireMention: { const: true } } },
        },
        additionalProperties: false,
      },
      value: false,
      issuePath: "requireMention",
    },
    {
      name: "referenced constraint",
      schema: {
        type: "object",
        properties: { requireMention: { type: "boolean", $ref: "#/$defs/MentionPolicy" } },
        $defs: { MentionPolicy: { const: true } },
        additionalProperties: false,
      },
      value: false,
      issuePath: "requireMention",
    },
    {
      name: "dependency",
      schema: {
        type: "object",
        properties: { requireMention: { type: "boolean" }, token: { type: "string" } },
        dependentRequired: { requireMention: ["token"] },
        additionalProperties: false,
      },
      value: "bad",
      issuePath: "token",
    },
    {
      name: "leaf conditional",
      schema: JSON.parse(`{
        "type": "object",
        "properties": {"requireMention": {
          "type": "boolean", "if": {"type": "object"}, "then": {"required": ["permit"]}
        }},
        "additionalProperties": false
      }`),
      value: {},
      issuePath: "requireMention",
    },
  ])(
    "does not erase a $name requirement by omitting its invalid trigger",
    ({ schema, value, issuePath }) => {
      const registry = createRegistry("bundled");
      registry.plugins[0].channelConfigs = {
        "schema-channel": {
          schema,
        },
      };
      const result = validateConfigObjectRawWithPlugins(
        { channels: { "schema-channel": { requireMention: value } } },
        { schemaValidation: "runtime", pluginMetadataSnapshot: { manifestRegistry: registry } },
      );
      expect(result).toMatchObject({
        ok: false,
        issues: expect.arrayContaining([
          expect.objectContaining({ path: `channels.schema-channel.${issuePath}` }),
        ]),
      });
    },
  );

  it.each([
    { name: "external owner", origin: "global" as const, field: { type: "boolean" }, required: [] },
    {
      name: "required value",
      origin: "bundled" as const,
      field: { type: "boolean" },
      required: ["requireMention"],
    },
    { name: "container", origin: "bundled" as const, field: { type: "object" }, required: [] },
  ])("does not weaken $name contracts for a familiar field name", ({ origin, field, required }) => {
    const registry = createRegistry(origin);
    registry.plugins[0].channelConfigs = {
      "schema-channel": {
        schema: {
          type: "object",
          properties: { requireMention: field },
          required,
          additionalProperties: false,
        },
      },
    };
    expect(
      validateConfigObjectRawWithPlugins(
        { channels: { "schema-channel": { requireMention: "bad" } } },
        { schemaValidation: "runtime", pluginMetadataSnapshot: { manifestRegistry: registry } },
      ).ok,
    ).toBe(false);
  });

  it.each(["bundled", "global"] as const)("projects extras using the %s schema owner", (origin) => {
    const registry = createRegistry(origin, {
      type: "object",
      properties: {
        auth: {
          type: "object",
          properties: { mode: { type: "string" } },
          additionalProperties: false,
        },
        entries: {
          type: "object",
          properties: { documented: { type: "string" } },
          additionalProperties: {
            type: "object",
            properties: { enabled: { type: "boolean" } },
            required: ["enabled"],
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    });
    const entries = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [
        ["security", "roles", "auth"][index] ?? `${index}.a/~1`,
        { enabled: true, "extra./~": { keep: true } },
      ]),
    );
    const value = { entries };
    const raw = { channels: { "schema-channel": value } };
    const previousErrorLimit = Settings.Get().maxErrors;
    const result = validateConfigObjectRawWithPlugins(raw, {
      schemaValidation: "runtime",
      pluginMetadataSnapshot: { manifestRegistry: registry },
    });
    expect(result).toMatchObject({
      ok: true,
      config: {
        channels: {
          "schema-channel": {
            entries: Object.fromEntries(
              Object.keys(entries).map((key) => [key, { enabled: true }]),
            ),
          },
        },
      },
      ignoredPaths: Object.keys(entries).map((key) => [
        "channels",
        "schema-channel",
        "entries",
        key,
        "extra./~",
      ]),
    });
    expect(Settings.Get().maxErrors).toBe(previousErrorLimit);
    expect(raw.channels["schema-channel"].entries.security?.["extra./~"]).toEqual({ keep: true });
    expect(
      validateConfigObjectRawWithPlugins(
        { channels: { "schema-channel": { auth: { mode: "token", requireMfa: true } } } },
        { schemaValidation: "runtime", pluginMetadataSnapshot: { manifestRegistry: registry } },
      ).ok,
    ).toBe(false);
    expect(
      validateConfigObjectRawWithPlugins(raw, {
        pluginMetadataSnapshot: { manifestRegistry: registry },
      }).ok,
    ).toBe(false);
    expect(
      validateConfigObjectRawWithPlugins(
        { channels: { "schema-channel": { entries: { broken: { enabled: "yes", extra: 1 } } } } },
        { schemaValidation: "runtime", pluginMetadataSnapshot: { manifestRegistry: registry } },
      ).ok,
    ).toBe(false);
  });

  it("keeps Discord account IDs separate from policy property names", () => {
    const accounts = Object.fromEntries(
      ["security", "roles", "auth"].map((id) => [id, { enabled: false, futureProperty: true }]),
    );
    const raw = { channels: { discord: { accounts } } };
    const result = validateConfigObjectRawWithPlugins(raw, {
      schemaValidation: "runtime",
      pluginMetadataSnapshot: { manifestRegistry: { plugins: [], diagnostics: [] } },
      env: {},
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("Discord account projection failed");
    }
    for (const id of Object.keys(accounts)) {
      expect(result.config.channels?.discord?.accounts?.[id]).toMatchObject({ enabled: false });
      expect(result.config.channels?.discord?.accounts?.[id]).not.toHaveProperty("futureProperty");
      expect(raw.channels.discord.accounts[id]).toHaveProperty("futureProperty", true);
    }
  });

  it("reports malformed external channel schemas as scoped issues", () => {
    const result = validate("global");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual(
        expect.objectContaining({
          path: "channels.schema-channel",
          message: expect.stringContaining("invalid schema"),
        }),
      );
    }
  });

  it("keeps malformed bundled channel schemas on the throwing path", () => {
    expect(() => validate("bundled")).toThrow("invalid schema");
  });
});
