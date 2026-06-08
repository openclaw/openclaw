import { describe, expect, it } from "vitest";
import { validateJsonSchemaValue, type JsonSchemaValue } from "../plugins/schema-validator.js";
import { GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA } from "./bundled-channel-config-metadata.generated.js";
import { validateConfigObjectWithPlugins } from "./validation.js";

function createTrustedUpstreamSlackConfig() {
  return {
    channels: {
      slack: {
        enabled: true,
        mode: "trusted-upstream",
        botToken: "xoxb-test",
        slackApiUrl: "http://x/",
        trustedUpstream: {
          requireHeader: {
            name: "X-OpenClaw-Trusted-Upstream-Verified",
            value: "true",
          },
          maxEventAge: 300,
          botUserId: "U07DE40S413",
          botId: "B07DEABCDEF",
        },
        webhookPath: "/slack/events",
        dmPolicy: "allowlist",
        allowFrom: ["u1"],
        groupPolicy: "allowlist",
        channels: {},
      },
    },
  };
}

function getSlackGeneratedSchema() {
  const entry = GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA.find(
    (candidate) => candidate.channelId === "slack",
  );
  if (!entry) {
    throw new Error("missing generated Slack channel config metadata");
  }
  return entry.schema as {
    properties?: Record<string, unknown>;
  };
}

describe("Slack trusted-upstream generated schema", () => {
  it("accepts trusted-upstream config through bundled-channel AJV validation", () => {
    const result = validateConfigObjectWithPlugins(createTrustedUpstreamSlackConfig());

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
      }),
    );
  });

  it("keeps the generated JSON schema in parity with trusted-upstream fields", () => {
    const schema = getSlackGeneratedSchema();
    const properties = schema.properties ?? {};
    const mode = properties.mode as { enum?: unknown[] } | undefined;
    const accounts = properties.accounts as
      | {
          additionalProperties?: {
            properties?: Record<string, unknown>;
          };
        }
      | undefined;
    const accountMode = accounts?.additionalProperties?.properties?.mode as
      | { enum?: unknown[] }
      | undefined;

    expect(mode?.enum).toContain("trusted-upstream");
    expect(accountMode?.enum).toContain("trusted-upstream");
    expect(properties.slackApiUrl).toEqual(
      expect.objectContaining({
        type: "string",
        format: "uri",
      }),
    );
    expect(properties.trustedUpstream).toEqual(
      expect.objectContaining({
        type: "object",
        additionalProperties: false,
      }),
    );

    const trustedUpstream = properties.trustedUpstream as
      | { properties?: Record<string, unknown> }
      | undefined;
    const trustedUpstreamProps = trustedUpstream?.properties ?? {};
    expect(trustedUpstreamProps.botUserId).toEqual(
      expect.objectContaining({
        type: "string",
        pattern: expect.any(String),
      }),
    );
    expect(trustedUpstreamProps.botId).toEqual(
      expect.objectContaining({
        type: "string",
        pattern: expect.any(String),
      }),
    );
  });

  it("rejects malformed trusted-upstream botUserId / botId via the generated Slack schema", () => {
    // Assert the generated bundled Slack schema itself enforces the botUserId /
    // botId patterns, using the same AJV helper the runtime uses to validate
    // channel config. This is independent of whether a live plugin registry is
    // loaded into the validation pipeline.
    const schema = getSlackGeneratedSchema() as JsonSchemaValue;

    const valid = createTrustedUpstreamSlackConfig();
    expect(
      validateJsonSchemaValue({
        schema,
        cacheKey: "slack-trusted-upstream-valid",
        value: valid.channels.slack,
        applyDefaults: true,
      }),
    ).toEqual(expect.objectContaining({ ok: true }));

    const badUser = createTrustedUpstreamSlackConfig();
    badUser.channels.slack.trustedUpstream.botUserId = "not-a-slack-user-id";
    expect(
      validateJsonSchemaValue({
        schema,
        cacheKey: "slack-trusted-upstream-bad-botuserid",
        value: badUser.channels.slack,
        applyDefaults: true,
      }),
    ).toEqual(expect.objectContaining({ ok: false }));

    const badBot = createTrustedUpstreamSlackConfig();
    badBot.channels.slack.trustedUpstream.botId = "not-a-slack-bot-id";
    expect(
      validateJsonSchemaValue({
        schema,
        cacheKey: "slack-trusted-upstream-bad-botid",
        value: badBot.channels.slack,
        applyDefaults: true,
      }),
    ).toEqual(expect.objectContaining({ ok: false }));
  });

  it("accepts trusted-upstream config without optional botUserId / botId (back-compat)", () => {
    const config = createTrustedUpstreamSlackConfig();
    delete (config.channels.slack.trustedUpstream as { botUserId?: string }).botUserId;
    delete (config.channels.slack.trustedUpstream as { botId?: string }).botId;
    expect(validateConfigObjectWithPlugins(config)).toEqual(expect.objectContaining({ ok: true }));
  });
});
