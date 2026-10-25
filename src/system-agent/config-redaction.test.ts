import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withPluginMetadataSnapshotScope } from "../plugins/current-plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import {
  isSystemAgentSensitiveConfigPathEmbedding as pathEmbeddingImpl,
  isSystemAgentSensitiveConfigValue as sensitiveValueImpl,
  redactSystemAgentConfigPath as redactPathImpl,
  redactSystemAgentConfig as redactConfigImpl,
} from "./config-redaction.js";
import {
  createSystemAgentPluginMetadataTestSnapshot,
  type SystemAgentPluginMetadataTestSnapshot,
} from "./system-agent.test-helpers.js";

let pluginMetadata: SystemAgentPluginMetadataTestSnapshot | undefined;

const pathEmbedding: typeof pathEmbeddingImpl = (...args) =>
  pluginMetadata!.run(() => pathEmbeddingImpl(...args));

const sensitiveValue: typeof sensitiveValueImpl = (...args) =>
  pluginMetadata!.run(() => sensitiveValueImpl(...args));

const redactPath: typeof redactPathImpl = (...args) =>
  pluginMetadata!.run(() => redactPathImpl(...args));

const redactConfig: typeof redactConfigImpl = (...args) =>
  pluginMetadata!.run(() => redactConfigImpl(...args));

const redactInvalid = (value: unknown) => redactConfig(value, { valid: false });

beforeEach(() => {
  const config = {};
  setRuntimeConfigSnapshot(config, config);
  pluginMetadata = createSystemAgentPluginMetadataTestSnapshot(config);
});

afterEach(() => {
  pluginMetadata = undefined;
  clearRuntimeConfigSnapshot();
});

describe("isSystemAgentSensitiveConfigValue", () => {
  it.each([
    ["https://example.test/v1", false],
    ["https://user:synthetic@example.test/v1", true],
    ["https://example.test/v1?token=synthetic", true],
  ])("classifies URL value %s without exposing appended path data", (value, sensitive) => {
    const path = "models.providers.synthetic.baseUrl";
    expect(sensitiveValue(path, value)).toBe(sensitive);
    expect(redactPath(`${path}.appended`)).toBe("<redacted path>");
  });

  it("keeps nonsensitive structured writes visible", () => {
    expect(
      sensitiveValue("channels.synology-chat", '{ enabled: true, webhookPath: "/synology" }'),
    ).toBe(false);
  });

  it("fails closed when a dynamic config owner has no current metadata", () => {
    expect(sensitiveValue("plugins.entries.missing.config.opaque", "plugin-secret")).toBe(true);
    expect(sensitiveValue("channels.missing.opaque", "channel-secret")).toBe(true);
    expect(sensitiveValue('channels["defaults.foo"].opaque', "channel-secret")).toBe(true);
    expect(sensitiveValue('channels["modelByChannel.evil"].opaque', "channel-secret")).toBe(true);
  });

  it.each([
    ["channels.defaults.groupPolicy", '"open"'],
    ['channels.modelByChannel["token=prod"].chat', '"openai/gpt-5.5"'],
  ])("keeps kernel-owned channel config %s visible", (path, value) => {
    expect(sensitiveValue(path, value)).toBe(false);
  });
});

describe("isSystemAgentSensitiveConfigPathEmbedding", () => {
  it("detects sensitive data appended to a plugin-owned hint", () => {
    expect(pathEmbedding("plugins.entries.codex.config.appServer.headersabcDEF123")).toBe(true);
  });

  it.each([
    "plugins.entries.codex.config.appServer.headers.Authorization",
    'session.identityLinks["token=prod"]',
    'channels.telegram.groups["prod.guild"].topics["token=prod"].groupPolicy',
    'channels.buzz.groups["00000000-0000-4000-8000-000000000000"].enabled',
    String.raw`hooks.entries.work.token\=prod`,
    'talk.providers.openai["token=prod"]',
    "hooks.mappings[0].agentId",
  ])("preserves schema-valid dynamic path %s", (path) => {
    expect(pathEmbedding(path)).toBe(false);
  });

  it.each([
    "channels.missing.opaque.abcDEF123",
    "plugins.entries.missing.config.opaque.abcDEF123",
    "plugins.entries.codex.config.opaque=abcDEF123",
    'channels.synology-chat["webhookUrl=abcDEF123"]',
    'plugins.entries.codex.config.appServer.headers["Authorization=Bearer-abc"]',
    'hooks.mappings["token=abcDEF123"].agentId',
    'channels.buzz.groups["gateway.auth.token=ACTUAL_GATEWAY_TOKEN"].enabled',
  ])("redacts unknown-owner or secret-bearing path %s", (path) => {
    expect(redactPath(path)).toBe("<redacted path>");
  });

  it.each([
    "plugins.entries.codex.config.appServer.headers.AuthorizationabcDEF123",
    'plugins.entries.codex.config.appServer.headers["X-Test"]',
    'channels.synology-chat.accounts["token=prod"].enabled',
    'broadcast["token=prod"]',
    'session.identityLinks["token=prod"]',
    'channels.modelByChannel["token=prod"].chat',
    'channels.telegram.groups["prod.guild"].topics["token=prod"].groupPolicy',
  ])("preserves schema-valid path %s", (path) => {
    expect(redactPath(path)).toBe(path);
  });
});

describe("redactSystemAgentConfig", () => {
  it.each(["plus", "core"])(
    "redacts retained owner credentials with %s selected first",
    (first) => {
      const snapshot = createPluginMetadataSnapshotFixture({
        plugins: ["core", "plus"].map((id) => ({
          id,
          origin: "config",
          channels: ["proofchat"],
          channelConfigs: {
            proofchat: {
              ...(id === "plus" ? { preferOver: ["core"] } : {}),
              schema: {
                type: "object",
                properties: { core: { type: "string" }, plus: { type: "string" } },
              },
              uiHints: { [id]: { sensitive: true } },
            },
          },
        })),
      });
      const preferred: OpenClawConfig = {
        plugins: { entries: { plus: { enabled: true } } },
        channels: { proofchat: { plus: "synthetic-plus", core: "synthetic-core" } },
      };
      const fallback: OpenClawConfig = {
        plugins: { entries: { plus: { enabled: false }, core: { enabled: true } } },
        channels: { proofchat: { plus: "synthetic-plus", core: "synthetic-core" } },
      };
      withPluginMetadataSnapshotScope(
        snapshot,
        () => {
          const configs =
            first === "plus" ? ([preferred, fallback] as const) : ([fallback, preferred] as const);
          for (const config of [...configs, configs[0]]) {
            setRuntimeConfigSnapshot(config, config);
            expect(redactConfigImpl(config, { config })).toMatchObject({
              channels: { proofchat: { plus: "<redacted>", core: "<redacted>" } },
            });
            for (const owner of ["core", "plus"]) {
              expect(sensitiveValueImpl(`channels.proofchat.${owner}`, "synthetic")).toBe(true);
              expect(redactPathImpl(`channels.proofchat.${owner}.synthetic`)).toBe(
                "<redacted path>",
              );
            }
          }
        },
        { config: preferred, compatibleConfigs: [preferred, fallback] },
      );
    },
  );

  it.each([
    [
      "unknown owners",
      {
        "custom.channel": { opaque: "channel-secret" },
        "synology-chat": { opaque: "invalid-channel-secret" },
      },
      { "custom.channel": "<redacted>", "synology-chat": "<redacted>" },
    ],
    [
      "kernel namespaces",
      {
        defaults: { groupPolicy: "open" },
        modelByChannel: { telegram: { chat: "openai/gpt-5.5" } },
        missing: { opaque: "channel-secret" },
        "defaults.foo": { opaque: "dotted-channel-secret" },
        "modelByChannel.evil": { opaque: "dotted-model-secret" },
      },
      {
        defaults: { groupPolicy: "open" },
        modelByChannel: { telegram: { chat: "openai/gpt-5.5" } },
        missing: "<redacted>",
        "defaults.foo": "<redacted>",
        "modelByChannel.evil": "<redacted>",
      },
    ],
    [
      "invalid kernel descendants",
      {
        defaults: { groupPolicy: "open", opaque: "kernel-secret" },
        modelByChannel: { telegram: { chat: 42 } },
      },
      {
        defaults: { groupPolicy: "open", opaque: "<redacted>" },
        modelByChannel: "<redacted>",
      },
    ],
    ["malformed container", [{ opaque: "channel-secret" }], "<redacted>"],
  ])("redacts %s in invalid channel config", (_name, channels, expected) => {
    expect(redactInvalid({ channels })).toEqual({ channels: expected });
  });

  it.each([
    [
      { "custom.plugin": { config: { opaque: "plugin-secret" } } },
      { "custom.plugin": { config: "<redacted>" } },
    ],
    [{ broken: "plugin-secret" }, { broken: "<redacted>" }],
  ])("redacts invalid plugin entries %j", (entries, expected) => {
    expect(redactInvalid({ plugins: { entries } })).toEqual({ plugins: { entries: expected } });
  });
});
