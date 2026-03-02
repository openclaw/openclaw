import { describe, expect, it } from "vitest";
import { buildConfigSchema } from "./schema.js";
import { applyDerivedTags, CONFIG_TAGS, deriveTagsForPath } from "./schema.tags.js";

describe("config schema", () => {
  it("exports schema + hints", () => {
    const res = buildConfigSchema();
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
    const schema = buildConfigSchema();
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
});
