import { emptyChannelConfigSchema } from "../channels/plugins/config-schema.js";
import { buildAccountScopedDmSecurityPolicy } from "../channels/plugins/helpers.js";
import {
  createScopedAccountReplyToModeResolver,
  createTopLevelChannelReplyToModeResolver,
} from "../channels/plugins/threading-helpers.js";
import type {
  ChannelOutboundAdapter,
  ChannelPairingAdapter,
  ChannelSecurityAdapter,
} from "../channels/plugins/types.adapters.js";
import type {
  ChannelMessagingAdapter,
  ChannelOutboundSessionRoute,
  ChannelPollResult,
  ChannelThreadingAdapter,
} from "../channels/plugins/types.core.js";
import type {
  ChannelConfigSchema,
  ChannelConfigUiHint,
  ChannelPlugin,
} from "../channels/plugins/types.plugin.js";
import type { OpenClawConfig } from "../config/config.js";
import type { ReplyToMode } from "../config/types.base.js";
import { buildOutboundBaseSessionKey } from "../infra/outbound/base-session-key.js";
import type { OutboundDeliveryResult } from "../infra/outbound/deliver.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import type { OpenClawPluginApi, PluginCommandContext } from "../plugins/types.js";

export type { ChannelConfigUiHint, ChannelPlugin };
export type { OpenClawConfig };
export type { PluginRuntime };
export type { OpenClawPluginApi, PluginCommandContext };
export { buildChannelConfigSchema } from "../channels/plugins/config-schema.js";
export { clearAccountEntryFields } from "../channels/plugins/config-helpers.js";
export { parseOptionalDelimitedEntries } from "../channels/plugins/helpers.js";
export { tryReadSecretFileSync } from "../infra/secret-file.js";

export type ChannelOutboundSessionRouteParams = Parameters<
  NonNullable<ChannelMessagingAdapter["resolveOutboundSessionRoute"]>
>[0];

type ChannelEntryConfigSchema<TPlugin> =
  TPlugin extends ChannelPlugin<unknown>
    ? NonNullable<TPlugin["configSchema"]>
    : ChannelConfigSchema;

type DefineChannelPluginEntryOptions<TPlugin = ChannelPlugin> = {
  id: string;
  name: string;
  description: string;
  plugin: TPlugin;
  configSchema?: ChannelEntryConfigSchema<TPlugin> | (() => ChannelEntryConfigSchema<TPlugin>);
  setRuntime?: (runtime: PluginRuntime) => void;
  registerCliMetadata?: (api: OpenClawPluginApi) => void;
  registerFull?: (api: OpenClawPluginApi) => void;
};

type DefinedChannelPluginEntry<TPlugin> = {
  id: string;
  name: string;
  description: string;
  configSchema: ChannelEntryConfigSchema<TPlugin>;
  register: (api: OpenClawPluginApi) => void;
  channelPlugin: TPlugin;
  setChannelRuntime?: (runtime: PluginRuntime) => void;
};

type ChatChannelPluginBase<TResolvedAccount, Probe, Audit> = Omit<
  ChannelPlugin<TResolvedAccount, Probe, Audit>,
  "security" | "pairing" | "threading" | "outbound"
> &
  Partial<
    Pick<
      ChannelPlugin<TResolvedAccount, Probe, Audit>,
      "security" | "pairing" | "threading" | "outbound"
    >
  >;

type ChatChannelSecurityOptions<TResolvedAccount extends { accountId?: string | null }> = {
  dm: {
    channelKey: string;
    resolvePolicy: (account: TResolvedAccount) => string | null | undefined;
    resolveAllowFrom: (account: TResolvedAccount) => Array<string | number> | null | undefined;
    resolveFallbackAccountId?: (account: TResolvedAccount) => string | null | undefined;
    defaultPolicy?: string;
    allowFromPathSuffix?: string;
    policyPathSuffix?: string;
    approveChannelId?: string;
    approveHint?: string;
    normalizeEntry?: (raw: string) => string;
  };
  collectWarnings?: ChannelSecurityAdapter<TResolvedAccount>["collectWarnings"];
  collectAuditFindings?: ChannelSecurityAdapter<TResolvedAccount>["collectAuditFindings"];
};

type ChatChannelPairingOptions = {
  text: {
    idLabel: string;
    message: string;
    normalizeAllowEntry?: ChannelPairingAdapter["normalizeAllowEntry"];
    notify: (
      params: Parameters<NonNullable<ChannelPairingAdapter["notifyApproval"]>>[0] & {
        message: string;
      },
    ) => Promise<void> | void;
  };
};

type ChatChannelThreadingReplyModeOptions<TResolvedAccount> =
  | { topLevelReplyToMode: string }
  | {
      scopedAccountReplyToMode: {
        resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) => TResolvedAccount;
        resolveReplyToMode: (
          account: TResolvedAccount,
          chatType?: string | null,
        ) => ReplyToMode | null | undefined;
        fallback?: ReplyToMode;
      };
    }
  | {
      resolveReplyToMode: NonNullable<ChannelThreadingAdapter["resolveReplyToMode"]>;
    };

type ChatChannelThreadingOptions<TResolvedAccount> =
  ChatChannelThreadingReplyModeOptions<TResolvedAccount> &
    Omit<ChannelThreadingAdapter, "resolveReplyToMode">;

type ChatChannelAttachedOutboundOptions = {
  base: Omit<ChannelOutboundAdapter, "sendText" | "sendMedia" | "sendPoll">;
  attachedResults: {
    channel: string;
    sendText?: (
      ctx: Parameters<NonNullable<ChannelOutboundAdapter["sendText"]>>[0],
    ) => MaybePromise<Omit<OutboundDeliveryResult, "channel">>;
    sendMedia?: (
      ctx: Parameters<NonNullable<ChannelOutboundAdapter["sendMedia"]>>[0],
    ) => MaybePromise<Omit<OutboundDeliveryResult, "channel">>;
    sendPoll?: (
      ctx: Parameters<NonNullable<ChannelOutboundAdapter["sendPoll"]>>[0],
    ) => MaybePromise<Omit<ChannelPollResult, "channel">>;
  };
};

type MaybePromise<T> = T | Promise<T>;

function createInlineTextPairingAdapter(params: {
  idLabel: string;
  message: string;
  normalizeAllowEntry?: ChannelPairingAdapter["normalizeAllowEntry"];
  notify: (
    params: Parameters<NonNullable<ChannelPairingAdapter["notifyApproval"]>>[0] & {
      message: string;
    },
  ) => Promise<void> | void;
}): ChannelPairingAdapter {
  return {
    idLabel: params.idLabel,
    normalizeAllowEntry: params.normalizeAllowEntry,
    notifyApproval: async (ctx) => {
      await params.notify({
        ...ctx,
        message: params.message,
      });
    },
  };
}

function createInlineAttachedChannelResultAdapter(
  params: ChatChannelAttachedOutboundOptions["attachedResults"],
) {
  return {
    sendText: params.sendText
      ? async (ctx: Parameters<NonNullable<ChannelOutboundAdapter["sendText"]>>[0]) => ({
          channel: params.channel,
          ...(await params.sendText!(ctx)),
        })
      : undefined,
    sendMedia: params.sendMedia
      ? async (ctx: Parameters<NonNullable<ChannelOutboundAdapter["sendMedia"]>>[0]) => ({
          channel: params.channel,
          ...(await params.sendMedia!(ctx)),
        })
      : undefined,
    sendPoll: params.sendPoll
      ? async (ctx: Parameters<NonNullable<ChannelOutboundAdapter["sendPoll"]>>[0]) => ({
          channel: params.channel,
          ...(await params.sendPoll!(ctx)),
        })
      : undefined,
  } satisfies Pick<ChannelOutboundAdapter, "sendText" | "sendMedia" | "sendPoll">;
}

function resolveChatChannelSecurity<TResolvedAccount extends { accountId?: string | null }>(
  security:
    | ChannelSecurityAdapter<TResolvedAccount>
    | ChatChannelSecurityOptions<TResolvedAccount>
    | undefined,
): ChannelSecurityAdapter<TResolvedAccount> | undefined {
  if (!security) {
    return undefined;
  }
  if (!("dm" in security)) {
    return security;
  }
  return {
    resolveDmPolicy: ({ cfg, accountId, account }) =>
      buildAccountScopedDmSecurityPolicy({
        cfg,
        channelKey: security.dm.channelKey,
        accountId,
        fallbackAccountId: security.dm.resolveFallbackAccountId?.(account) ?? account.accountId,
        policy: security.dm.resolvePolicy(account),
        allowFrom: security.dm.resolveAllowFrom(account) ?? [],
        defaultPolicy: security.dm.defaultPolicy,
        allowFromPathSuffix: security.dm.allowFromPathSuffix,
        policyPathSuffix: security.dm.policyPathSuffix,
        approveChannelId: security.dm.approveChannelId,
        approveHint: security.dm.approveHint,
        normalizeEntry: security.dm.normalizeEntry,
      }),
    ...(security.collectWarnings ? { collectWarnings: security.collectWarnings } : {}),
    ...(security.collectAuditFindings
      ? { collectAuditFindings: security.collectAuditFindings }
      : {}),
  };
}

function resolveChatChannelPairing(
  pairing: ChannelPairingAdapter | ChatChannelPairingOptions | undefined,
): ChannelPairingAdapter | undefined {
  if (!pairing) {
    return undefined;
  }
  if (!("text" in pairing)) {
    return pairing;
  }
  return createInlineTextPairingAdapter(pairing.text);
}

function resolveChatChannelThreading<TResolvedAccount>(
  threading: ChannelThreadingAdapter | ChatChannelThreadingOptions<TResolvedAccount> | undefined,
): ChannelThreadingAdapter | undefined {
  if (!threading) {
    return undefined;
  }
  if (!("topLevelReplyToMode" in threading) && !("scopedAccountReplyToMode" in threading)) {
    return threading;
  }

  let resolveReplyToMode: ChannelThreadingAdapter["resolveReplyToMode"];
  if ("topLevelReplyToMode" in threading) {
    resolveReplyToMode = createTopLevelChannelReplyToModeResolver(threading.topLevelReplyToMode);
  } else {
    resolveReplyToMode = createScopedAccountReplyToModeResolver<TResolvedAccount>(
      threading.scopedAccountReplyToMode,
    );
  }

  return {
    ...threading,
    resolveReplyToMode,
  };
}

function resolveChatChannelOutbound(
  outbound: ChannelOutboundAdapter | ChatChannelAttachedOutboundOptions | undefined,
): ChannelOutboundAdapter | undefined {
  if (!outbound) {
    return undefined;
  }
  if (!("attachedResults" in outbound)) {
    return outbound;
  }
  return {
    ...outbound.base,
    ...createInlineAttachedChannelResultAdapter(outbound.attachedResults),
  };
}

export function defineChannelPluginEntry<TPlugin>({
  id,
  name,
  description,
  plugin,
  configSchema,
  setRuntime,
  registerCliMetadata,
  registerFull,
}: DefineChannelPluginEntryOptions<TPlugin>): DefinedChannelPluginEntry<TPlugin> {
  const resolvedConfigSchema: ChannelEntryConfigSchema<TPlugin> =
    typeof configSchema === "function"
      ? configSchema()
      : ((configSchema ?? emptyChannelConfigSchema()) as ChannelEntryConfigSchema<TPlugin>);
  const entry = {
    id,
    name,
    description,
    configSchema: resolvedConfigSchema,
    register(api: OpenClawPluginApi) {
      if (api.registrationMode === "cli-metadata") {
        registerCliMetadata?.(api);
        return;
      }
      setRuntime?.(api.runtime);
      api.registerChannel({ plugin: plugin as ChannelPlugin });
      if (api.registrationMode !== "full") {
        return;
      }
      registerCliMetadata?.(api);
      registerFull?.(api);
    },
  };
  return {
    ...entry,
    channelPlugin: plugin,
    ...(setRuntime ? { setChannelRuntime: setRuntime } : {}),
  };
}

export function defineSetupPluginEntry<TPlugin>(plugin: TPlugin) {
  return { plugin };
}

export function stripChannelTargetPrefix(raw: string, ...providers: string[]): string {
  const trimmed = raw.trim();
  for (const provider of providers) {
    const prefix = `${provider.toLowerCase()}:`;
    if (trimmed.toLowerCase().startsWith(prefix)) {
      return trimmed.slice(prefix.length).trim();
    }
  }
  return trimmed;
}

export function stripTargetKindPrefix(raw: string): string {
  return raw.replace(/^(user|channel|group|conversation|room|dm):/i, "").trim();
}

export function buildChannelOutboundSessionRoute(params: {
  cfg: OpenClawConfig;
  agentId: string;
  channel: string;
  accountId?: string | null;
  peer: { kind: "direct" | "group" | "channel"; id: string };
  chatType: "direct" | "group" | "channel";
  from: string;
  to: string;
  threadId?: string | number;
}): ChannelOutboundSessionRoute {
  const baseSessionKey = buildOutboundBaseSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: params.channel,
    accountId: params.accountId,
    peer: params.peer,
  });
  return {
    sessionKey: baseSessionKey,
    baseSessionKey,
    peer: params.peer,
    chatType: params.chatType,
    from: params.from,
    to: params.to,
    ...(params.threadId !== undefined ? { threadId: params.threadId } : {}),
  };
}

export function createChatChannelPlugin<
  TResolvedAccount extends { accountId?: string | null },
  Probe = unknown,
  Audit = unknown,
>(params: {
  base: ChatChannelPluginBase<TResolvedAccount, Probe, Audit>;
  security?:
    | ChannelSecurityAdapter<TResolvedAccount>
    | ChatChannelSecurityOptions<TResolvedAccount>;
  pairing?: ChannelPairingAdapter | ChatChannelPairingOptions;
  threading?: ChannelThreadingAdapter | ChatChannelThreadingOptions<TResolvedAccount>;
  outbound?: ChannelOutboundAdapter | ChatChannelAttachedOutboundOptions;
}): ChannelPlugin<TResolvedAccount, Probe, Audit> {
  return {
    ...params.base,
    conversationBindings: {
      supportsCurrentConversationBinding: true,
      ...params.base.conversationBindings,
    },
    ...(params.security ? { security: resolveChatChannelSecurity(params.security) } : {}),
    ...(params.pairing ? { pairing: resolveChatChannelPairing(params.pairing) } : {}),
    ...(params.threading ? { threading: resolveChatChannelThreading(params.threading) } : {}),
    ...(params.outbound ? { outbound: resolveChatChannelOutbound(params.outbound) } : {}),
  } as ChannelPlugin<TResolvedAccount, Probe, Audit>;
}
