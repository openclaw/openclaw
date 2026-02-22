import { describe, expect, it } from "vitest";
import { buildConfigSchema } from "./schema.js";
import { ToolsWebSchema } from "./zod-schema.agent-runtime.js";

describe("config schema", () => {
  it("exports schema + hints", () => {
    const res = buildConfigSchema();
    const schema = res.schema as { properties?: Record<string, unknown> };
    expect(schema.properties?.gateway).toBeTruthy();
    expect(schema.properties?.agents).toBeTruthy();
    expect(schema.properties?.$schema).toBeUndefined();
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

  it("does not re-mark existing non-sensitive token-like fields", () => {
    const res = buildConfigSchema({
      plugins: [
        {
          id: "voice-call",
          configUiHints: {
            tokens: { label: "Tokens", sensitive: false },
          },
        },
      ],
    });

    expect(res.uiHints["plugins.entries.voice-call.config.tokens"]?.sensitive).toBe(false);
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

describe("tools.web.urlAllowlist validation", () => {
  it("accepts valid domain patterns", () => {
    const validPatterns = [
      "example.com",
      "*.github.com",
      "*.example.co.uk",
      "sub.domain.com",
      "a.b.c.d.com",
      "localhost",
    ];
    for (const pattern of validPatterns) {
      const result = ToolsWebSchema.safeParse({
        urlAllowlist: [pattern],
        search: { enabled: true },
        fetch: { enabled: true },
      });
      expect(result.success, `Expected "${pattern}" to be valid`).toBe(true);
    }
  });

  it("rejects invalid domain patterns", () => {
    const invalidPatterns = [
      "", // empty string
      "https://example.com", // protocol included
      "example.com/path", // path included
      "*", // just asterisk
      "*.", // asterisk with dot
      ".com", // starts with dot
      "example.", // ends with dot
      "-example.com", // starts with hyphen
      "example-.com", // ends with hyphen
    ];
    for (const pattern of invalidPatterns) {
      const result = ToolsWebSchema.safeParse({
        urlAllowlist: [pattern],
        search: { enabled: true },
        fetch: { enabled: true },
      });
      expect(result.success, `Expected "${pattern}" to be invalid`).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain("Invalid domain pattern");
      }
    }
  });

  it("allows undefined urlAllowlist", () => {
    const result = ToolsWebSchema.safeParse({
      search: { enabled: true },
      fetch: { enabled: true },
    });
    expect(result.success).toBe(true);
  });

  it("allows empty urlAllowlist", () => {
    const result = ToolsWebSchema.safeParse({
      urlAllowlist: [],
      search: { enabled: true },
      fetch: { enabled: true },
    });
    expect(result.success).toBe(true);
  });
});
