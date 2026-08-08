import { describe, expect, it } from "vitest";
import type { PluginCandidate } from "./discovery.js";
import { createManifestPluginRecord, validatePluginConfig } from "./loader-shared.js";
import type { PluginManifestRecord } from "./manifest-registry.js";

const emptyObjectSchema = {
  type: "object",
  additionalProperties: false,
  properties: {},
} as const;

function withSchemaKeyword(key: "if" | "then" | "else", value: unknown) {
  return { [key]: value };
}

const manifestRecord = {
  id: "example",
  channels: [],
  providers: [],
  cliBackends: [],
  skills: [],
  hooks: [],
  origin: "global",
  rootDir: "/plugins/example",
  source: "/plugins/example/index.js",
  manifestPath: "/plugins/example/openclaw.plugin.json",
} satisfies PluginManifestRecord;

function createRecordWithBuildVersion(openclawVersion: unknown) {
  const candidate = {
    idHint: "example",
    source: manifestRecord.source,
    rootDir: manifestRecord.rootDir,
    origin: manifestRecord.origin,
    packageManifest: {
      build: { openclawVersion },
    } as unknown as NonNullable<PluginCandidate["packageManifest"]>,
  } satisfies PluginCandidate;

  return createManifestPluginRecord({
    candidate,
    manifestRecord,
    enabled: true,
    activationState: {
      enabled: true,
      activated: true,
      explicitlyEnabled: true,
      source: "explicit",
    },
  });
}

describe("createManifestPluginRecord", () => {
  it("ignores malformed package build version metadata", () => {
    expect(createRecordWithBuildVersion(" 2026.7.2 ").builtWithOpenClawVersion).toBe("2026.7.2");
    expect(createRecordWithBuildVersion(42).builtWithOpenClawVersion).toBeUndefined();
  });
});

describe("validatePluginConfig manifest schema isolation", () => {
  it("returns an error instead of throwing on a structurally invalid schema", () => {
    const result = validatePluginConfig({
      schema: {
        type: "object",
        properties: { mode: { $ref: "#/$defs/Mode" } },
      },
      value: {},
    });

    expect(result).toMatchObject({ ok: false });
    expect(result.ok ? [] : result.error.join(" ")).toContain("invalid schema");
  });

  it("returns an error instead of throwing when a schema is nested past the stack limit", () => {
    let schema: Record<string, unknown> = { type: "object" };
    for (let depth = 0; depth < 3_000; depth++) {
      schema = { type: "object", properties: { nested: schema } };
    }

    expect(validatePluginConfig({ schema, value: {} })).toMatchObject({ ok: false });
  });
});

describe("validatePluginConfig empty schema classification", () => {
  it("validates pattern properties instead of requiring empty config", () => {
    const schema = {
      ...emptyObjectSchema,
      patternProperties: { "^S_": { type: "string" } },
    };

    expect(validatePluginConfig({ schema, value: { S_SETTING: "configured" } })).toEqual({
      ok: true,
      value: { S_SETTING: "configured" },
    });
    expect(validatePluginConfig({ schema, value: { S_SETTING: 42 } })).toMatchObject({
      ok: false,
    });
  });

  it("validates dependent schemas instead of using the empty-config shortcut", () => {
    const result = validatePluginConfig({
      schema: {
        ...emptyObjectSchema,
        dependentSchemas: { mode: { required: ["token"] } },
      },
      value: { mode: true },
    });

    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.error.join(" ")).not.toContain("config must be empty");
    }
  });

  it.each([
    {
      branch: "then",
      schema: {
        ...withSchemaKeyword("if", true),
        ...withSchemaKeyword("then", { minProperties: 1 }),
      },
    },
    {
      branch: "else",
      schema: {
        ...withSchemaKeyword("if", false),
        ...withSchemaKeyword("else", { minProperties: 1 }),
      },
    },
  ])("applies an active $branch conditional", ({ schema }) => {
    expect(
      validatePluginConfig({ schema: { ...emptyObjectSchema, ...schema }, value: {} }),
    ).toMatchObject({ ok: false });
  });

  it.each([
    withSchemaKeyword("if", true),
    withSchemaKeyword("then", { minProperties: 1 }),
    withSchemaKeyword("else", { minProperties: 1 }),
  ])("keeps standalone conditional keywords on the empty-config path: %o", (keyword) => {
    expect(
      validatePluginConfig({
        schema: { ...emptyObjectSchema, ...keyword },
        value: { unexpected: true },
      }),
    ).toEqual({ ok: false, error: ["<root>: config must be empty"] });
  });
});
