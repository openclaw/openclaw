import { beforeAll, describe, expect, it } from "vitest";
import { buildConfigSchema, lookupConfigSchema } from "./schema.js";
import { applyDerivedTags, CONFIG_TAGS, deriveTagsForPath } from "./schema.tags.js";

describe("config schema", () => {
  type SchemaInput = NonNullable<Parameters<typeof buildConfigSchema>[0]>;
  let baseSchema: ReturnType<typeof buildConfigSchema>;
  let pluginUiHintInput: SchemaInput;
  let tokenHintInput: SchemaInput;
  let mergedSchemaInput: SchemaInput;
  let heartbeatChannelInput: SchemaInput;
  let cachedMergeInput: SchemaInput;

  beforeAll(() => {
    baseSchema = buildConfigSchema();
    pluginUiHintInput = {
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
    };
    tokenHintInput = {
      plugins: [
        {
          id: "voice-call",
          configUiHints: {
            tokens: { label: "Tokens", sensitive: false },
          },
        },
      ],
    };
    mergedSchemaInput = {
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
    };
    heartbeatChannelInput = {
      channels: [
        {
          id: "bluebubbles",
          label: "BlueBubbles",
          configSchema: { type: "object" },
        },
      ],
    };
    cachedMergeInput = {
      plugins: [
        {
          id: "voice-call",
          name: "Voice Call",
          configSchema: { type: "object", properties: { provider: { type: "string" } } },
        },
      ],
      channels: [
        {
          id: "matrix",
          label: "Matrix",
          configSchema: { type: "object", properties: { accessToken: { type: "string" } } },
        },
      ],
    };
  });

  it("exports schema + hints", () => {
    const res = baseSchema;
    const schema = res.schema as { properties?: Record<string, unknown> };
    expect(schema.properties?.gateway).toBeTruthy();
    expect(schema.properties?.agents).toBeTruthy();
    expect(schema.properties?.acp).toBeTruthy();
    expect(schema.properties?.$schema).toBeUndefined();
    expect(res.uiHints.gateway?.label).toBe("Gateway");
    expect(res.uiHints["gateway.auth.token"]?.sensitive).toBe(true);
    expect(res.uiHints["channels.discord.threadBindings.spawnAcpSessions"]?.label).toBeTruthy();
    expect(res.version).toBeTruthy();
    expect(res.generatedAt).toBeTruthy();
  });

  it("merges plugin ui hints", () => {
    const res = buildConfigSchema(pluginUiHintInput);

    expect(res.uiHints["plugins.entries.voice-call"]?.label).toBe("Voice Call");
    expect(res.uiHints["plugins.entries.voice-call.config"]?.label).toBe("Voice Call Config");
    expect(res.uiHints["plugins.entries.voice-call.config.twilio.authToken"]?.label).toBe(
      "Auth Token",
    );
    expect(res.uiHints["plugins.entries.voice-call.config.twilio.authToken"]?.sensitive).toBe(true);
  });

  it("does not re-mark existing non-sensitive token-like fields", () => {
    const res = buildConfigSchema(tokenHintInput);

    expect(res.uiHints["plugins.entries.voice-call.config.tokens"]?.sensitive).toBe(false);
  });

  it("merges plugin + channel schemas", () => {
    const res = buildConfigSchema(mergedSchemaInput);

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

  it("adds heartbeat target hints with dynamic channels", () => {
    const res = buildConfigSchema(heartbeatChannelInput);

    const defaultsHint = res.uiHints["agents.defaults.heartbeat.target"];
    const listHint = res.uiHints["agents.list.*.heartbeat.target"];
    expect(defaultsHint?.help).toContain("bluebubbles");
    expect(defaultsHint?.help).toContain("last");
    expect(listHint?.help).toContain("bluebubbles");
  });

  it("caches merged schemas for identical plugin/channel metadata", () => {
    const first = buildConfigSchema(cachedMergeInput);
    const second = buildConfigSchema({
      plugins: [{ ...cachedMergeInput.plugins![0] }],
      channels: [{ ...cachedMergeInput.channels![0] }],
    });
    expect(second).toBe(first);
  });

  it("derives security/auth tags for credential paths", () => {
    const tags = deriveTagsForPath("gateway.auth.token");
    expect(tags).toContain("security");
    expect(tags).toContain("auth");
  });

  it("derives tools/performance tags for web fetch timeout paths", () => {
    const tags = deriveTagsForPath("tools.web.fetch.timeoutSeconds");
    expect(tags).toContain("tools");
    expect(tags).toContain("performance");
  });

  it("keeps tags in the allowed taxonomy", () => {
    const withTags = applyDerivedTags({
      "gateway.auth.token": {},
      "tools.web.fetch.timeoutSeconds": {},
      "channels.slack.accounts.*.token": {},
    });
    const allowed = new Set<string>(CONFIG_TAGS);
    for (const hint of Object.values(withTags)) {
      for (const tag of hint.tags ?? []) {
        expect(allowed.has(tag)).toBe(true);
      }
    }
  });

  it("covers core/built-in config paths with tags", () => {
    const schema = baseSchema;
    const allowed = new Set<string>(CONFIG_TAGS);
    for (const [key, hint] of Object.entries(schema.uiHints)) {
      if (!key.includes(".")) {
        continue;
      }
      const tags = hint.tags ?? [];
      expect(tags.length, `expected tags for ${key}`).toBeGreaterThan(0);
      for (const tag of tags) {
        expect(allowed.has(tag), `unexpected tag ${tag} on ${key}`).toBe(true);
      }
    }
  });

  it("looks up a config schema path with immediate child summaries", () => {
    const lookup = lookupConfigSchema(baseSchema, "gateway.auth");
    expect(lookup?.path).toBe("gateway.auth");
    expect(lookup?.hintPath).toBe("gateway.auth");
    expect(lookup?.children.some((child) => child.key === "token")).toBe(true);
    const tokenChild = lookup?.children.find((child) => child.key === "token");
    expect(tokenChild?.path).toBe("gateway.auth.token");
    expect(tokenChild?.hint?.sensitive).toBe(true);
    expect(tokenChild?.hintPath).toBe("gateway.auth.token");
    const schema = lookup?.schema as { properties?: unknown } | undefined;
    expect(schema?.properties).toBeUndefined();
  });

  it("returns a shallow lookup schema without nested composition keywords", () => {
    const lookup = lookupConfigSchema(baseSchema, "agents.list.0.runtime");
    expect(lookup?.path).toBe("agents.list.0.runtime");
    expect(lookup?.hintPath).toBe("agents.list[].runtime");
    expect(lookup?.schema).toEqual({});
  });

  it("matches wildcard ui hints for concrete lookup paths", () => {
    const lookup = lookupConfigSchema(baseSchema, "agents.list.0.identity.avatar");
    expect(lookup?.path).toBe("agents.list.0.identity.avatar");
    expect(lookup?.hintPath).toBe("agents.list.*.identity.avatar");
    expect(lookup?.hint?.help).toContain("workspace-relative path");
  });

  it("normalizes bracketed lookup paths", () => {
    const lookup = lookupConfigSchema(baseSchema, "agents.list[0].identity.avatar");
    expect(lookup?.path).toBe("agents.list.0.identity.avatar");
    expect(lookup?.hintPath).toBe("agents.list.*.identity.avatar");
  });

  it("matches ui hints that use empty array brackets", () => {
    const lookup = lookupConfigSchema(baseSchema, "agents.list.0.runtime");
    expect(lookup?.path).toBe("agents.list.0.runtime");
    expect(lookup?.hintPath).toBe("agents.list[].runtime");
    expect(lookup?.hint?.label).toBe("Agent Runtime");
  });

  it("uses the indexed tuple item schema for positional array lookups", () => {
    const tupleSchema = {
      schema: {
        type: "object",
        properties: {
          pair: {
            type: "array",
            items: [{ type: "string" }, { type: "number" }],
          },
        },
      },
      uiHints: {},
      version: "test",
      generatedAt: "test",
    } as unknown as Parameters<typeof lookupConfigSchema>[0];

    const lookup = lookupConfigSchema(tupleSchema, "pair.1");
    expect(lookup?.path).toBe("pair.1");
    expect(lookup?.schema).toMatchObject({ type: "number" });
    expect((lookup?.schema as { items?: unknown } | undefined)?.items).toBeUndefined();
  });

  it("rejects prototype-chain lookup segments", () => {
    expect(() => lookupConfigSchema(baseSchema, "constructor")).not.toThrow();
    expect(lookupConfigSchema(baseSchema, "constructor")).toBeNull();
    expect(lookupConfigSchema(baseSchema, "__proto__.polluted")).toBeNull();
  });

  it("rejects overly deep lookup paths", () => {
    const buildNestedObjectSchema = (segments: string[]): Record<string, unknown> => {
      const [head, ...rest] = segments;
      if (!head) {
        return { type: "string" };
      }
      return {
        type: "object",
        properties: {
          [head]: buildNestedObjectSchema(rest),
        },
      };
    };

    const deepPathSegments = Array.from({ length: 33 }, (_, index) => `a${index}`);
    const deepSchema = {
      schema: buildNestedObjectSchema(deepPathSegments),
      uiHints: {},
      version: "test",
      generatedAt: "test",
    } as unknown as Parameters<typeof lookupConfigSchema>[0];

    expect(lookupConfigSchema(deepSchema, deepPathSegments.join("."))).toBeNull();
  });

  it("returns null for missing config schema paths", () => {
    expect(lookupConfigSchema(baseSchema, "gateway.notReal.path")).toBeNull();
  });
});
