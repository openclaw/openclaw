import type { ChannelOutboundAdapter } from "../channels/plugins/types.adapters.js";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";

type StubChannelOptions = {
  id: ChannelPlugin["id"];
  label: string;
  summary?: Record<string, unknown>;
};

const createStubOutboundAdapter = (channel: ChannelPlugin["id"]): ChannelOutboundAdapter => {
  const send = async () => ({ channel, messageId: `${channel}-msg` });
  return { deliveryMode: "direct", sendText: send, sendMedia: send };
};

const createStubChannelPlugin = (params: StubChannelOptions): ChannelPlugin => ({
  id: params.id,
  meta: {
    id: params.id,
    label: params.label,
    selectionLabel: params.label,
    docsPath: `/channels/${params.id}`,
    blurb: "test stub.",
  },
  capabilities: { chatTypes: ["direct"] },
  config: {
    listAccountIds: () => [DEFAULT_ACCOUNT_ID],
    resolveAccount: () => ({}),
    isConfigured: async () => false,
  },
  status: {
    buildChannelSummary: async () => ({ configured: false, ...params.summary }),
  },
  outbound: createStubOutboundAdapter(params.id),
  messaging: {
    normalizeTarget: (raw) => raw,
  },
  gateway: {
    logoutAccount: async () => ({
      cleared: false,
      envToken: false,
      loggedOut: false,
    }),
  },
});

export function createDefaultGatewayTestChannels() {
  const channels: StubChannelOptions[] = [
    { id: "whatsapp", label: "WhatsApp" },
    {
      id: "telegram",
      label: "Telegram",
      summary: { tokenSource: "none", lastProbeAt: null },
    },
    { id: "discord", label: "Discord" },
    { id: "slack", label: "Slack" },
    { id: "signal", label: "Signal", summary: { lastProbeAt: null } },
    { id: "imessage", label: "iMessage" },
    { id: "msteams", label: "Microsoft Teams" },
    { id: "matrix", label: "Matrix" },
    { id: "zalo", label: "Zalo" },
    { id: "zalouser", label: "Zalo Personal" },
    { id: "imessage", label: "iMessage" },
  ];
  return channels.map((channel) => ({
    pluginId: channel.id,
    source: "test" as const,
    plugin: createStubChannelPlugin(channel),
  }));
}
