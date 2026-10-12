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
});
