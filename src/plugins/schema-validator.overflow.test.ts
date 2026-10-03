import { describe, expect, it } from "vitest";
import type { PluginManifestRecord } from "./manifest-registry.types.js";
import { resolvePluginConfigEnablement } from "./plugin-config-enablement.js";
import { validateJsonSchemaValue, validatePluginSchemaValue } from "./schema-validator.js";
import type { JsonSchemaValue } from "./schema-validator.js";

function nestedSchema(keyword: "properties" | "additionalProperties" | "items", depth: number) {
  let schema: JsonSchemaValue = { type: "object" };
  for (let i = 0; i < depth; i++) {
    schema =
      keyword === "properties"
        ? { type: "object", properties: { x: schema } }
        : keyword === "items"
          ? { type: "array", items: schema }
          : { type: "object", additionalProperties: schema };
  }
  return schema;
}

describe("schema overflow handling", () => {
  it.each(["properties", "additionalProperties", "items"] as const)(
    "returns an unusable-schema result for excessive %s nesting",
    (keyword) => {
      const result = validateJsonSchemaValue({
        schema: nestedSchema(keyword, 3_000),
        value: {},
        cache: false,
      });
      expect(result).toMatchObject({ ok: false, schemaError: true });
      expect(result.ok ? "" : result.errors[0]?.text).toContain("schema is too deep or large");
    },
  );

  it("contains overflow before compilation when fingerprinting a deeply nested schema", () => {
    expect(
      validateJsonSchemaValue({
        schema: nestedSchema("properties", 10_000),
        value: {},
        cache: false,
      }),
    ).toMatchObject({ ok: false, schemaError: true });
  });

  it("preserves unusable-schema classification for external manifests", () => {
    expect(
      validatePluginSchemaValue({
        origin: "global",
        schema: nestedSchema("additionalProperties", 3_000),
        value: {},
      }),
    ).toMatchObject({ ok: false, schemaError: true });
  });

  it("reports an overflowing external plugin schema as invalid rather than missing setup", () => {
    const manifest: PluginManifestRecord = {
      id: "overflow-fixture",
      origin: "global",
      configSchema: nestedSchema("additionalProperties", 3_000),
      manifestPath: "/fixture/openclaw.plugin.json",
      rootDir: "/fixture",
      source: "/fixture/index.js",
      channels: [],
      cliBackends: [],
      hooks: [],
      providers: [],
      skills: [],
    };
    expect(
      resolvePluginConfigEnablement({ config: {}, pluginId: manifest.id, manifest }),
    ).toMatchObject({
      mode: "invalid",
      error: expect.stringContaining("schema is too deep or large"),
    });
  });

  it("keeps bundled schema overflow loud instead of marking config missing", () => {
    expect(() =>
      validatePluginSchemaValue({
        origin: "bundled",
        schema: nestedSchema("additionalProperties", 3_000),
        value: {},
      }),
    ).toThrow(RangeError);
  });
});
