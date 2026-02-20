import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import type { PluginRegistry } from "../plugins/registry.js";
import type { PluginRecord } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { resolveGatewayMessageChannel } from "./message-channel.js";

const createPluginRecord = (id: string, enabled: boolean): PluginRecord => ({
  id,
  name: id,
  source: "test",
  origin: "bundled",
  enabled,
  status: enabled ? "loaded" : "disabled",
  toolNames: [],
  hookNames: [],
  channelIds: [],
  providerIds: [],
  gatewayMethods: [],
  cliCommands: [],
  services: [],
  commands: [],
  httpHandlers: 0,
  hookCount: 0,
  configSchema: false,
  configUiHints: undefined,
  configJsonSchema: undefined,
});

const createRegistry = (
  channels: PluginRegistry["channels"],
  plugins: PluginRecord[] = [],
): PluginRegistry => ({
  plugins,
  tools: [],
  hooks: [],
  typedHooks: [],
  channels,
  commands: [],
  providers: [],
  gatewayHandlers: {},
  httpHandlers: [],
  httpRoutes: [],
  cliRegistrars: [],
  services: [],
  diagnostics: [],
});

const emptyRegistry = createRegistry([]);

const msteamsPlugin = {
  id: "msteams",
  meta: {
    id: "msteams",
    label: "Microsoft Teams",
    selectionLabel: "Microsoft Teams (Bot Framework)",
    docsPath: "/channels/msteams",
    blurb: "Bot Framework; enterprise support.",
    aliases: ["teams"],
  },
  capabilities: { chatTypes: ["direct"] },
  config: {
    listAccountIds: () => [],
    resolveAccount: () => ({}),
  },
} satisfies ChannelPlugin;

describe("message-channel", () => {
  beforeEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  afterEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  it("normalizes gateway message channels and rejects unknown values", () => {
    expect(resolveGatewayMessageChannel("discord")).toBe("discord");
    expect(resolveGatewayMessageChannel(" imsg ")).toBe("imessage");
    expect(resolveGatewayMessageChannel("web")).toBeUndefined();
    expect(resolveGatewayMessageChannel("nope")).toBeUndefined();
  });

  it("normalizes plugin aliases when registered", () => {
    setActivePluginRegistry(
      createRegistry([{ pluginId: "msteams", plugin: msteamsPlugin, source: "test" }]),
    );
    expect(resolveGatewayMessageChannel("teams")).toBe("msteams");
  });

  it("skips disabled channel plugins when resolving gateway channels", () => {
    // Register whatsapp as a known channel so it would normally resolve,
    // but mark the plugin record as disabled — it should be skipped.
    const whatsappPlugin = {
      id: "whatsapp",
      meta: {
        id: "whatsapp",
        label: "WhatsApp",
        selectionLabel: "WhatsApp",
        docsPath: "/channels/whatsapp",
        blurb: "WhatsApp messaging.",
        aliases: [],
      },
      capabilities: { chatTypes: ["direct"] },
      config: {
        listAccountIds: () => [],
        resolveAccount: () => ({}),
      },
    } satisfies ChannelPlugin;
    setActivePluginRegistry(
      createRegistry(
        [{ pluginId: "whatsapp", plugin: whatsappPlugin, source: "test" }],
        [createPluginRecord("whatsapp", false)],
      ),
    );
    // Without the fix, this resolves to "whatsapp". With the fix, disabled plugins are skipped.
    expect(resolveGatewayMessageChannel("whatsapp")).toBeUndefined();
  });
});
