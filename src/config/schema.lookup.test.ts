import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ConfigUiHints } from "./schema.hints.js";
import { buildConfigSchemaCore } from "./schema.js";
import { classifyConfigSchemaPathSegment, lookupConfigSchema } from "./schema.lookup.js";
import type { ConfigJsonSchemaObject, ConfigSchemaResponse } from "./schema.shared.js";

function schemaResponse(schema: ConfigJsonSchemaObject): ConfigSchemaResponse {
  return { schema, uiHints: {}, version: "test", generatedAt: "test" };
}

describe("plugin config schema lookup", () => {
  it("exposes referenced IMAP account fields with their bounds and sensitive hints", () => {
    const imapManifest: {
      id: string;
      configSchema: ConfigJsonSchemaObject;
      uiHints: ConfigUiHints;
    } = JSON.parse(
      readFileSync(new URL("../../extensions/imap/openclaw.plugin.json", import.meta.url), "utf8"),
    );
    const response = buildConfigSchemaCore({
      cache: false,
      plugins: [
        {
          id: imapManifest.id,
          configSchema: imapManifest.configSchema,
          configUiHints: imapManifest.uiHints,
        },
      ],
    });
    const accountPath = "plugins.entries.imap.config.accounts.main";
    const account = lookupConfigSchema(response, accountPath);

    expect(account?.children).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "host", type: "string", required: true }),
        expect.objectContaining({ key: "watch", type: "object", hasChildren: true }),
        expect.objectContaining({
          key: "password",
          hasChildren: true,
          hint: expect.objectContaining({ sensitive: true }),
        }),
      ]),
    );
    expect(lookupConfigSchema(response, `${accountPath}.watch.pollSeconds`)?.schema).toMatchObject({
      type: "integer",
      minimum: 15,
    });
    expect(lookupConfigSchema(response, `${accountPath}.senderAuth.min`)?.schema).toMatchObject({
      type: "string",
      enum: ["verified", "asserted", "unverified", "mutable"],
    });
    expect(
      lookupConfigSchema(response, `${accountPath}.addressTokens.0.token`)?.schema,
    ).toMatchObject({
      type: "string",
      minLength: 1,
    });
    expect(lookupConfigSchema(response, `${accountPath}.password.source`)?.schema).toMatchObject({
      type: "string",
      enum: ["env", "file", "exec", "store"],
    });
    expect(lookupConfigSchema(response, `${accountPath}.notAField`)).toBeNull();
    expect(lookupConfigSchema(response, `${accountPath}.watch.notAField`)).toBeNull();
    expect(lookupConfigSchema(response, `${accountPath}.host.nested`)).toBeNull();
    expect(classifyConfigSchemaPathSegment(response, accountPath.split("."), "watch")).toBe(
      "property",
    );
    expect(
      classifyConfigSchemaPathSegment(response, `${accountPath}.addressTokens`.split("."), "0"),
    ).toBe("array-index");
    expect(
      classifyConfigSchemaPathSegment(
        response,
        "plugins.entries.imap.config.accounts".split("."),
        "bad.name",
      ),
    ).toBe("invalid-record-key");
    expect(
      lookupConfigSchema(response, "plugins.entries.imap.config.accounts")?.schema,
    ).toMatchObject({
      additionalProperties: {
        properties: { watch: { properties: { pollSeconds: { type: "integer", minimum: 15 } } } },
      },
    });
  });

  it.each(["$defs", "definitions"])("keeps %s aliases scoped to their plugin fragment", (key) => {
    const response = schemaResponse({
      properties: {
        otherPlugin: {
          [key]: { value: { type: "boolean" } },
          properties: { setting: { $ref: `#/${key}/value` } },
        },
        plugin: {
          [key]: {
            value: { type: "string", minLength: 3 },
            alias: { $ref: `#/${key}/value` },
          },
          properties: { setting: { $ref: `#/${key}/alias`, description: "Plugin setting" } },
        },
      },
    });

    expect(lookupConfigSchema(response, "plugin.setting")?.schema).toEqual({
      type: "string",
      minLength: 3,
      description: "Plugin setting",
    });
    expect(lookupConfigSchema(response, "otherPlugin.setting")?.schema).toEqual({
      type: "boolean",
    });
    expect(response.schema.properties).toMatchObject({
      plugin: { properties: { setting: { $ref: `#/${key}/alias` } } },
    });
  });

  it.each(["$defs", "definitions"])("does not let nested %s shadow the fragment root", (key) => {
    const response = schemaResponse({
      [key]: { list: { type: "array", items: { type: "string" } } },
      properties: {
        block: {
          [key]: { list: { type: "object", properties: { note: { type: "number" } } } },
          properties: { values: { $ref: `#/${key}/list` } },
        },
      },
    });

    expect(lookupConfigSchema(response, "block")?.children).toEqual([
      expect.objectContaining({ key: "values", type: "array", hasChildren: true }),
    ]);
    expect(lookupConfigSchema(response, "block.values")?.schema).toEqual({
      type: "array",
      items: { type: "string" },
    });
    expect(lookupConfigSchema(response, "block.values.0")?.schema).toEqual({ type: "string" });
    expect(classifyConfigSchemaPathSegment(response, ["block", "values"], "0")).toBe("array-index");
    expect(lookupConfigSchema(response, "block.values.note")).toBeNull();
  });

  it("uses a nested resource's $id as its reference root", () => {
    const response = schemaResponse({
      $defs: { value: { type: "boolean" } },
      properties: {
        resource: {
          $id: "https://example.test/config.json",
          $defs: { value: { type: "string" } },
          properties: { setting: { $ref: "#/$defs/value" } },
        },
      },
    });

    expect(lookupConfigSchema(response, "resource.setting")?.schema).toEqual({ type: "string" });
  });

  it("leaves missing and cyclic references unresolved without hiding valid siblings", () => {
    const response = schemaResponse({
      $defs: {
        first: { $ref: "#/$defs/second" },
        second: { $ref: "#/$defs/first" },
        choice: {
          anyOf: [{ $ref: "#/$defs/choice" }, { properties: { value: { type: "number" } } }],
        },
      },
      properties: {
        missing: { $ref: "#/$defs/missing" },
        cyclic: { $ref: "#/$defs/first" },
        malformed: { $ref: "#/$defs/%", description: "Unsupported reference" },
        choice: { $ref: "#/$defs/choice" },
      },
    });

    expect(lookupConfigSchema(response, "missing")).toBeNull();
    expect(lookupConfigSchema(response, "cyclic")).toBeNull();
    expect(lookupConfigSchema(response, "malformed.value")).toBeNull();
    expect(lookupConfigSchema(response, "choice.value")?.schema).toEqual({ type: "number" });
    expect(classifyConfigSchemaPathSegment(response, ["choice"], "value")).toBe("property");
  });

  it("projects recursive definitions finitely while allowing concrete child lookups", () => {
    const response = schemaResponse({
      $defs: {
        node: {
          type: "object",
          properties: { label: { type: "string" }, next: { $ref: "#/$defs/node" } },
        },
      },
      properties: {
        nodes: { type: "object", additionalProperties: { $ref: "#/$defs/node" } },
      },
    });

    expect(lookupConfigSchema(response, "nodes")?.schema).toEqual({
      type: "object",
      additionalProperties: {
        type: "object",
        properties: { label: { type: "string" }, next: {} },
      },
    });
    expect(lookupConfigSchema(response, "nodes.main.next.label")?.schema).toEqual({
      type: "string",
    });
    expect(lookupConfigSchema(response, "nodes.main")?.children).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: "next", hasChildren: true })]),
    );
  });

  it("applies constraints from both a reference and its siblings", () => {
    const response = schemaResponse({
      $defs: {
        token: { type: "string", minLength: 10, maxLength: 64, description: "Shared token" },
        account: {
          type: "object",
          required: ["host"],
          properties: { host: { type: "string" }, port: { type: "integer", minimum: 1 } },
        },
      },
      properties: {
        token: { $ref: "#/$defs/token", minLength: 1, maxLength: 32, description: "API token" },
        account: {
          $ref: "#/$defs/account",
          required: ["user"],
          properties: { user: { type: "string" }, port: { maximum: 65535 } },
        },
      },
    });

    expect(lookupConfigSchema(response, "token")?.schema).toEqual({
      type: "string",
      description: "API token",
      minLength: 10,
      maxLength: 32,
    });
    const account = lookupConfigSchema(response, "account");
    expect(account?.children.map(({ key, required }) => [key, required])).toEqual([
      ["host", true],
      ["port", false],
      ["user", true],
    ]);
    expect(lookupConfigSchema(response, "account.port")?.schema).toEqual({
      type: "integer",
      minimum: 1,
      allOf: [{ maximum: 65535 }],
    });
  });

  it("keeps conflicting sibling constraints instead of replacing the referenced ones", () => {
    const response = schemaResponse({
      $defs: { mode: { type: "string", enum: ["fast", "safe", "off"], pattern: "^[a-z]+$" } },
      properties: { mode: { $ref: "#/$defs/mode", enum: ["safe", "off"] } },
    });

    expect(lookupConfigSchema(response, "mode")?.schema).toEqual({
      type: "string",
      enum: ["fast", "safe", "off"],
      pattern: "^[a-z]+$",
      allOf: [{ enum: ["safe", "off"] }],
    });
  });

  it("bounds the projection of shared references that fan out", () => {
    const depth = 40;
    const $defs: Record<string, ConfigJsonSchemaObject> = { level40: { type: "string" } };
    for (let level = depth - 1; level >= 0; level -= 1) {
      const next = { $ref: `#/$defs/level${level + 1}` };
      $defs[`level${level}`] = { type: "array", items: [next, next] };
    }
    const response = schemaResponse({ $defs, properties: { tree: { $ref: "#/$defs/level0" } } });

    const started = performance.now();
    const result = lookupConfigSchema(response, "tree");
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(result?.schema.type).toBe("array");
    expect(JSON.stringify(result).length).toBeLessThan(100_000);
    expect(lookupConfigSchema(response, "tree.0.1.0.1.0.1.0.1.0.1.0.1.0.1.0.1")?.schema).toEqual(
      expect.objectContaining({ type: "array" }),
    );
  });

  it("bounds path resolution through unions of shared references", () => {
    const depth = 30;
    const $defs: Record<string, ConfigJsonSchemaObject> = {
      [`level${depth}`]: { type: "object", properties: { name: { type: "string" } } },
    };
    for (let level = depth - 1; level >= 0; level -= 1) {
      const next = { $ref: `#/$defs/level${level + 1}` };
      $defs[`level${level}`] = { anyOf: [next, next] };
    }
    const response = schemaResponse({ $defs, properties: { tree: { $ref: "#/$defs/level0" } } });

    const started = performance.now();
    expect(lookupConfigSchema(response, "tree.unknown")).toBeNull();
    expect(classifyConfigSchemaPathSegment(response, ["tree"], "unknown")).toBeNull();
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(lookupConfigSchema(response, "tree.name")?.schema).toEqual({ type: "string" });
    expect(classifyConfigSchemaPathSegment(response, ["tree"], "name")).toBe("property");
  });

  it("resolves references reached through patternProperties", () => {
    const response = schemaResponse({
      $defs: { endpoint: { type: "object", properties: { url: { type: "string" } } } },
      properties: {
        endpoints: {
          type: "object",
          patternProperties: { "^[a-z]+$": { $ref: "#/$defs/endpoint" } },
        },
      },
    });

    expect(lookupConfigSchema(response, "endpoints")?.schema).toEqual({
      type: "object",
      patternProperties: {
        "^[a-z]+$": { type: "object", properties: { url: { type: "string" } } },
      },
    });
    expect(lookupConfigSchema(response, "endpoints.primary.url")?.schema).toEqual({
      type: "string",
    });
  });
});
