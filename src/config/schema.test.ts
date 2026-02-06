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

  it("returns zh-CN labels and localized schema titles", () => {
    const res = buildConfigSchema({ locale: "zh-CN" });
    const schema = res.schema as { properties?: Record<string, unknown> };
    const gateway = schema.properties?.gateway as { title?: string } | undefined;
    const agents = schema.properties?.agents as { title?: string } | undefined;

    expect(res.uiHints.gateway?.label).toBe("网关");
    expect(res.uiHints.agents?.label).toBe("代理");
    expect(gateway?.title).toBe("网关");
    expect(agents?.title).toBe("代理");
  });

  it("does not let channel metadata override existing zh labels", () => {
    const res = buildConfigSchema({
      locale: "zh-CN",
      channels: [
        {
          id: "slack",
          label: "Slack English Label",
          description: "English channel blurb",
          configSchema: { type: "object" },
        },
      ],
    });

    expect(res.uiHints["channels.slack"]?.label).toBe("Slack");
  });

  it("auto-generates zh labels for injected plugin/channel schema fields", () => {
    const res = buildConfigSchema({
      locale: "zh-CN",
      plugins: [
        {
          id: "demo",
          name: "Demo Plugin",
          configSchema: {
            type: "object",
            properties: {
              maxTokens: { type: "number" },
              timeoutSeconds: { type: "number" },
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
              maxTokens: { type: "number" },
              timeoutSeconds: { type: "number" },
            },
          },
        },
      ],
    });

    expect(res.uiHints["plugins.entries.demo.config.maxTokens"]?.label).toContain("最大");
    expect(res.uiHints["plugins.entries.demo.config.timeoutSeconds"]?.label).toContain("超时");
    expect(res.uiHints["channels.matrix.maxTokens"]?.label).toContain("最大");
    expect(res.uiHints["channels.matrix.timeoutSeconds"]?.label).toContain("超时");
  });
});
