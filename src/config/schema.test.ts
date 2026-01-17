import { describe, expect, it } from "vitest";

import { buildConfigSchema } from "./schema.js";

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
});
