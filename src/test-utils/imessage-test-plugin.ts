import { normalizeIMessageHandle } from "../channels/plugins/normalize/imessage.js";
import type { ChannelOutboundAdapter, ChannelPlugin } from "../channels/plugins/types.js";
import { collectStatusIssuesFromLastError } from "../plugin-sdk/status-helpers.js";
import { loadBundledPluginPublicSurfaceSync } from "./bundled-plugin-public-surface.js";

let defaultIMessageOutbound: ChannelOutboundAdapter | null = null;

function getDefaultIMessageOutbound(): ChannelOutboundAdapter {
  if (defaultIMessageOutbound) {
    return defaultIMessageOutbound;
  }
  defaultIMessageOutbound = loadBundledPluginPublicSurfaceSync<{
    imessageOutbound: ChannelOutboundAdapter;
  }>({
    pluginId: "imessage",
    artifactBasename: "src/outbound-adapter.js",
  }).imessageOutbound;
  return defaultIMessageOutbound;
}

export const createIMessageTestPlugin = (params?: {
  outbound?: ChannelOutboundAdapter;
}): ChannelPlugin => ({
  id: "imessage",
  meta: {
    id: "imessage",
    label: "iMessage",
    selectionLabel: "iMessage (imsg)",
    docsPath: "/channels/imessage",
    blurb: "iMessage test stub.",
    aliases: ["imsg"],
  },
  capabilities: { chatTypes: ["direct", "group"], media: true },
  config: {
    listAccountIds: () => [],
    resolveAccount: () => ({}),
  },
  status: {
    collectStatusIssues: (accounts) => collectStatusIssuesFromLastError("imessage", accounts),
  },
  outbound: params?.outbound ?? getDefaultIMessageOutbound(),
  messaging: {
    targetResolver: {
      looksLikeId: (raw) => {
        const trimmed = raw.trim();
        if (!trimmed) {
          return false;
        }
        if (/^(imessage:|sms:|auto:|chat_id:|chat_guid:|chat_identifier:)/i.test(trimmed)) {
          return true;
        }
        if (trimmed.includes("@")) {
          return true;
        }
        return /^\+?\d{3,}$/.test(trimmed);
      },
      hint: "<handle|chat_id:ID>",
    },
    normalizeTarget: (raw) => normalizeIMessageHandle(raw),
  },
});
