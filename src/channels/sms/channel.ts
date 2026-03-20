import type { OpenClawConfig } from "../../config/config.js";
import { buildLegacyDmAccountAllowlistAdapter } from "../../plugin-sdk/allowlist-config-edit.js";
import type { ChannelConfigAdapter, ChannelOutboundAdapter } from "../plugins/types.adapters.js";
import type { ChannelCapabilities, ChannelMeta } from "../plugins/types.core.js";
import type { ChannelPlugin } from "../plugins/types.plugin.js";
import { sendSmsViaNode } from "./outbound.js";

const SMS_CHANNEL_ID = "sms";
const DEFAULT_ACCOUNT_ID = "default";

type ResolvedSmsAccount = {
  accountId: string;
  config: {
    allowFrom?: Array<string | number>;
  };
};

const smsMeta: ChannelMeta = {
  id: SMS_CHANNEL_ID,
  label: "SMS",
  selectionLabel: "SMS (Android node)",
  detailLabel: "SMS",
  docsPath: "/channels/sms",
  docsLabel: "sms",
  blurb: "send and receive SMS via a connected Android device.",
  systemImage: "message",
};

const smsCapabilities: ChannelCapabilities = {
  chatTypes: ["direct"],
};

const smsConfig: ChannelConfigAdapter<ResolvedSmsAccount> = {
  listAccountIds: () => [DEFAULT_ACCOUNT_ID],
  resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) => {
    const id = accountId || DEFAULT_ACCOUNT_ID;
    const channels = (cfg as Record<string, unknown>).channels as
      | Record<string, unknown>
      | undefined;
    const smsChannelConfig = channels?.sms as Record<string, unknown> | undefined;
    const allowFrom = smsChannelConfig?.allowFrom as Array<string | number> | undefined;
    return {
      accountId: id,
      config: {
        allowFrom,
      },
    };
  },
  resolveAllowFrom: (params) => {
    const channels = (params.cfg as Record<string, unknown>).channels as
      | Record<string, unknown>
      | undefined;
    const smsChannelConfig = channels?.sms as Record<string, unknown> | undefined;
    return smsChannelConfig?.allowFrom as Array<string | number> | undefined;
  },
};

const smsOutbound: ChannelOutboundAdapter = {
  deliveryMode: "gateway",
  textChunkLimit: 1600,
  sendText: async ({ to, text, deps, accountId }) => {
    const result = await sendSmsViaNode({ to, text, nodeId: accountId, deps });
    if (!result.ok) {
      throw new Error(result.error ?? "SMS send failed");
    }
    return {
      channel: SMS_CHANNEL_ID,
      messageId: result.messageId ?? `sms-${Date.now()}`,
    };
  },
};

function normalizePhoneNumber(raw: string): string {
  return raw.replace(/[\s\-.()]/g, "");
}

const smsAllowlist = buildLegacyDmAccountAllowlistAdapter<ResolvedSmsAccount>({
  channelId: SMS_CHANNEL_ID,
  resolveAccount: ({ cfg, accountId }) => smsConfig.resolveAccount(cfg, accountId),
  normalize: ({ values }) => values.map((v) => normalizePhoneNumber(String(v))),
  resolveDmAllowFrom: (account) => account.config.allowFrom,
});

export const smsPlugin: ChannelPlugin<ResolvedSmsAccount> = {
  id: SMS_CHANNEL_ID,
  meta: smsMeta,
  capabilities: smsCapabilities,
  config: smsConfig,
  outbound: smsOutbound,
  allowlist: smsAllowlist,
};
