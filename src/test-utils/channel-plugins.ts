import type {
  ChannelCapabilities,
  ChannelId,
  ChannelOutboundAdapter,
  ChannelPlugin,
} from "../channels/plugins/types.js";
import type { PluginRegistry } from "../plugins/registry.js";

type TestChannelRegistration = {
  pluginId: string;
  plugin: unknown;
  source: string;
};

export const createTestRegistry = (channels: TestChannelRegistration[] = []): PluginRegistry => ({
  plugins: [],
  tools: [],
  hooks: [],
  typedHooks: [],
  channels: channels as unknown as PluginRegistry["channels"],
  providers: [],
  searchProviders: [],
  gatewayHandlers: {},
  httpHandlers: [],
  httpRoutes: [],
  cliRegistrars: [],
  services: [],
  commands: [],
  diagnostics: [],
});

export const createChannelTestPluginBase = (params: {
  id: ChannelId;
  label?: string;
  docsPath?: string;
  capabilities?: ChannelCapabilities;
  config?: Partial<ChannelPlugin["config"]>;
}): Pick<ChannelPlugin, "id" | "meta" | "capabilities" | "config"> => ({
  id: params.id,
  meta: {
    id: params.id,
    label: params.label ?? String(params.id),
    selectionLabel: params.label ?? String(params.id),
    docsPath: params.docsPath ?? `/channels/${params.id}`,
    blurb: "test stub.",
  },
  capabilities: params.capabilities ?? { chatTypes: ["direct"] },
  config: {
    listAccountIds: () => ["default"],
    resolveAccount: () => ({}),
    ...params.config,
  },
});

export const createMSTeamsTestPluginBase = (): Pick<
  ChannelPlugin,
  "id" | "meta" | "capabilities" | "config"
> => {
  const base = createChannelTestPluginBase({
    id: "msteams",
    label: "Microsoft Teams",
    docsPath: "/channels/msteams",
    config: { listAccountIds: () => [], resolveAccount: () => ({}) },
  });
  return {
    ...base,
    meta: {
      ...base.meta,
      selectionLabel: "Microsoft Teams (Bot Framework)",
      blurb: "Bot Framework; enterprise support.",
      aliases: ["teams"],
    },
  };
};

export const createMSTeamsTestPlugin = (params?: {
  aliases?: string[];
  outbound?: ChannelOutboundAdapter;
}): ChannelPlugin => {
  const base = createMSTeamsTestPluginBase();
  return {
    ...base,
    meta: {
      ...base.meta,
      ...(params?.aliases ? { aliases: params.aliases } : {}),
    },
    ...(params?.outbound ? { outbound: params.outbound } : {}),
  };
};

export const createOutboundTestPlugin = (params: {
  id: ChannelId;
  outbound: ChannelOutboundAdapter;
  label?: string;
  docsPath?: string;
  capabilities?: ChannelCapabilities;
}): ChannelPlugin => ({
  ...createChannelTestPluginBase({
    id: params.id,
    label: params.label,
    docsPath: params.docsPath,
    capabilities: params.capabilities,
    config: { listAccountIds: () => [] },
  }),
  outbound: params.outbound,
});
