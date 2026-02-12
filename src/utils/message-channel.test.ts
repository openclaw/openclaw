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
  channels,
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
    setActivePluginRegistry(createRegistry([], [createPluginRecord("whatsapp", false)]));
    expect(resolveGatewayMessageChannel("whatsapp")).toBeUndefined();
  });
});
