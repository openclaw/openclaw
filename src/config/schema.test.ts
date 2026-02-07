import { describe, expect, it } from "vitest";
import { buildConfigSchema } from "./schema.js";

type SchemaNode = Record<string, unknown>;

function findEmptyNodes(node: unknown, path: string): string[] {
  const results: string[] = [];
  if (node == null || typeof node !== "object" || Array.isArray(node)) {
    return results;
  }
  const obj = node as SchemaNode;
  if (Object.keys(obj).length === 0) {
    results.push(path);
    return results;
  }
  if (obj.properties && typeof obj.properties === "object") {
    for (const [k, v] of Object.entries(obj.properties as SchemaNode)) {
      results.push(...findEmptyNodes(v, `${path}.${k}`));
    }
  }
  if (obj.items) {
    results.push(...findEmptyNodes(obj.items, `${path}.items`));
  }
  if (obj.additionalProperties && typeof obj.additionalProperties === "object") {
    results.push(...findEmptyNodes(obj.additionalProperties, `${path}.additionalProperties`));
  }
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    if (Array.isArray(obj[key])) {
      (obj[key] as unknown[]).forEach((b, i) => {
        results.push(...findEmptyNodes(b, `${path}.${key}[${i}]`));
      });
    }
  }
  return results;
}

function findProblematicUnions(node: unknown, path: string): string[] {
  const results: string[] = [];
  if (node == null || typeof node !== "object" || Array.isArray(node)) {
    return results;
  }
  const obj = node as SchemaNode;
  for (const key of ["anyOf", "oneOf"]) {
    if (Array.isArray(obj[key]) && (obj[key] as unknown[]).length > 1) {
      const branches = obj[key] as SchemaNode[];
      const hasComplex = branches.some(
        (b) => b?.type === "object" || b?.properties || b?.type === "array" || b?.items,
      );
      const hasPrimitive = branches.some(
        (b) =>
          typeof b?.type === "string" &&
          b.type !== "object" &&
          b.type !== "array" &&
          !b.properties &&
          !b.items,
      );
      if (hasComplex && hasPrimitive) {
        results.push(path);
      }
    }
  }
  if (obj.properties && typeof obj.properties === "object") {
    for (const [k, v] of Object.entries(obj.properties as SchemaNode)) {
      results.push(...findProblematicUnions(v, `${path}.${k}`));
    }
  }
  if (obj.items) {
    results.push(...findProblematicUnions(obj.items, `${path}.items`));
  }
  if (obj.additionalProperties && typeof obj.additionalProperties === "object") {
    results.push(
      ...findProblematicUnions(obj.additionalProperties, `${path}.additionalProperties`),
    );
  }
  for (const k of ["anyOf", "oneOf", "allOf"]) {
    if (Array.isArray(obj[k])) {
      (obj[k] as unknown[]).forEach((b, i) => {
        results.push(...findProblematicUnions(b, `${path}.${k}[${i}]`));
      });
    }
  }
  return results;
}

describe("config schema", () => {
  it("exports schema + hints", () => {
    const res = buildConfigSchema();
    const schema = res.schema as { properties?: Record<string, unknown> };
    expect(schema.properties?.gateway).toBeTruthy();
    expect(schema.properties?.agents).toBeTruthy();
    expect(res.uiHints.gateway?.label).toBe("Gateway");
    expect(res.uiHints["gateway.auth.token"]?.sensitive).toBe(true);
    expect(res.version).toBeTruthy();
    expect(res.generatedAt).toBeTruthy();
  });

  it("merges plugin ui hints", () => {
    const res = buildConfigSchema({
      plugins: [
        {
          id: "voice-call",
          name: "Voice Call",
          description: "Outbound voice calls",
          configUiHints: {
            provider: { label: "Provider" },
            "twilio.authToken": { label: "Auth Token", sensitive: true },
          },
        },
      ],
    });

    expect(res.uiHints["plugins.entries.voice-call"]?.label).toBe("Voice Call");
    expect(res.uiHints["plugins.entries.voice-call.config"]?.label).toBe("Voice Call Config");
    expect(res.uiHints["plugins.entries.voice-call.config.twilio.authToken"]?.label).toBe(
      "Auth Token",
    );
    expect(res.uiHints["plugins.entries.voice-call.config.twilio.authToken"]?.sensitive).toBe(true);
  });

  it("merges plugin + channel schemas", () => {
    const res = buildConfigSchema({
      plugins: [
        {
          id: "voice-call",
          name: "Voice Call",
          configSchema: {
            type: "object",
            properties: {
              provider: { type: "string" },
            },
          },
        },
      ],
      channels: [
        {
          id: "matrix",
          label: "Matrix",
          configSchema: {
            type: "object",
            properties: {
              accessToken: { type: "string" },
            },
          },
        },
      ],
    });

    const schema = res.schema as {
      properties?: Record<string, unknown>;
    };
    const pluginsNode = schema.properties?.plugins as Record<string, unknown> | undefined;
    const entriesNode = pluginsNode?.properties as Record<string, unknown> | undefined;
    const entriesProps = entriesNode?.entries as Record<string, unknown> | undefined;
    const entryProps = entriesProps?.properties as Record<string, unknown> | undefined;
    const pluginEntry = entryProps?.["voice-call"] as Record<string, unknown> | undefined;
    const pluginConfig = pluginEntry?.properties as Record<string, unknown> | undefined;
    const pluginConfigSchema = pluginConfig?.config as Record<string, unknown> | undefined;
    const pluginConfigProps = pluginConfigSchema?.properties as Record<string, unknown> | undefined;
    expect(pluginConfigProps?.provider).toBeTruthy();

    const channelsNode = schema.properties?.channels as Record<string, unknown> | undefined;
    const channelsProps = channelsNode?.properties as Record<string, unknown> | undefined;
    const channelSchema = channelsProps?.matrix as Record<string, unknown> | undefined;
    const channelProps = channelSchema?.properties as Record<string, unknown> | undefined;
    expect(channelProps?.accessToken).toBeTruthy();
  });

  it("channels schema uses additionalProperties: false", () => {
    const res = buildConfigSchema();
    const schema = res.schema as Record<string, unknown>;
    const channels = (schema.properties as Record<string, unknown>)?.channels as Record<
      string,
      unknown
    >;
    expect(channels.additionalProperties).toBe(false);
  });

  it("schema has no empty {} leaf nodes", () => {
    const res = buildConfigSchema();
    const empties = findEmptyNodes(res.schema, "root");
    expect(empties).toEqual([]);
  });

  it("agents.defaults.model schema is a plain object (no anyOf/oneOf union)", () => {
    const res = buildConfigSchema();
    const schema = res.schema as Record<string, unknown>;
    const agents = (schema.properties as Record<string, unknown>)?.agents as Record<
      string,
      unknown
    >;
    const defaults = (agents.properties as Record<string, unknown>)?.defaults as Record<
      string,
      unknown
    >;
    const model = (defaults.properties as Record<string, unknown>)?.model as Record<
      string,
      unknown
    >;
    expect(model.anyOf).toBeUndefined();
    expect(model.oneOf).toBeUndefined();
    expect(model.type).toBe("object");
  });

  it("schema has no mixed complex/primitive anyOf unions", () => {
    const res = buildConfigSchema();
    const problematic = findProblematicUnions(res.schema, "root");
    expect(problematic).toEqual([]);
  });

  it("custom command fields in channel schemas are not empty objects after patching", () => {
    // Regression: TelegramCustomCommandSchema used .transform() which emitted {}
    // in JSON schema. The fix uses .pipe() and patchSchemaForUI replaces any
    // remaining {} leaves with {type:"string"}. Verify by merging a channel that
    // uses the same customCommands array-of-objects shape.
    const res = buildConfigSchema({
      channels: [
        {
          id: "testchan",
          label: "Test",
          configSchema: {
            type: "object",
            properties: {
              customCommands: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    command: {},
                    description: {},
                  },
                  required: ["command", "description"],
                  additionalProperties: false,
                },
              },
            },
          },
        },
      ],
    });
    const schema = res.schema as Record<string, unknown>;
    const channels = (schema.properties as Record<string, unknown>)?.channels as Record<
      string,
      unknown
    >;
    const testchan = (channels.properties as Record<string, unknown>)?.testchan as Record<
      string,
      unknown
    >;
    const cc = (testchan.properties as Record<string, unknown>)?.customCommands as Record<
      string,
      unknown
    >;
    const items = cc.items as Record<string, unknown>;
    const itemProps = items.properties as Record<string, unknown>;
    const command = itemProps.command as Record<string, unknown>;
    const description = itemProps.description as Record<string, unknown>;

    // Should have been patched to {type:"string"}, not left as {}
    expect(Object.keys(command).length).toBeGreaterThan(0);
    expect(command.type).toBe("string");
    expect(Object.keys(description).length).toBeGreaterThan(0);
    expect(description.type).toBe("string");
  });

  it("adds heartbeat target hints with dynamic channels", () => {
    const res = buildConfigSchema({
      channels: [
        {
          id: "bluebubbles",
          label: "BlueBubbles",
          configSchema: { type: "object" },
        },
      ],
    });

    const defaultsHint = res.uiHints["agents.defaults.heartbeat.target"];
    const listHint = res.uiHints["agents.list.*.heartbeat.target"];
    expect(defaultsHint?.help).toContain("bluebubbles");
    expect(defaultsHint?.help).toContain("last");
    expect(listHint?.help).toContain("bluebubbles");
  });
});
