import { normalizeGroupActivation } from "../../../auto-reply/group-activation.js";
import type { loadConfig } from "../../../config/config.js";
import {
  resolveChannelGroupPolicy,
  resolveChannelGroupRequireMention,
} from "../../../config/group-policy.js";
import {
  loadSessionStore,
  resolveGroupSessionKey,
  resolveStorePath,
} from "../../../config/sessions.js";
import { resolveAccountEntry } from "../../../routing/account-lookup.js";

export function resolveGroupPolicyFor(
  cfg: ReturnType<typeof loadConfig>,
  conversationId: string,
  accountId?: string,
) {
  const groupId = resolveGroupSessionKey({
    From: conversationId,
    ChatType: "group",
    Provider: "whatsapp",
  })?.id;
  const whatsappCfg = cfg.channels?.whatsapp as
    | {
        groupAllowFrom?: string[];
        allowFrom?: string[];
        accounts?: Record<string, { groupAllowFrom?: string[]; allowFrom?: string[] }>;
      }
    | undefined;
  const accountCfg = accountId ? resolveAccountEntry(whatsappCfg?.accounts, accountId) : undefined;
  // If the account explicitly defines groupAllowFrom or allowFrom (even as []),
  // use only the account-level values — do not fall back to root, since the
  // account may be intentionally clearing inherited root lists.
  const hasAccountOverride =
    accountCfg && ("groupAllowFrom" in accountCfg || "allowFrom" in accountCfg);
  const hasGroupAllowFrom = hasAccountOverride
    ? Boolean(accountCfg.groupAllowFrom?.length || accountCfg.allowFrom?.length)
    : Boolean(whatsappCfg?.groupAllowFrom?.length || whatsappCfg?.allowFrom?.length);
  return resolveChannelGroupPolicy({
    cfg,
    channel: "whatsapp",
    groupId: groupId ?? conversationId,
    accountId,
    hasGroupAllowFrom,
  });
}

export function resolveGroupRequireMentionFor(
  cfg: ReturnType<typeof loadConfig>,
  conversationId: string,
  accountId?: string,
) {
  const groupId = resolveGroupSessionKey({
    From: conversationId,
    ChatType: "group",
    Provider: "whatsapp",
  })?.id;
  return resolveChannelGroupRequireMention({
    cfg,
    channel: "whatsapp",
    groupId: groupId ?? conversationId,
    accountId,
  });
}

export function resolveGroupActivationFor(params: {
  cfg: ReturnType<typeof loadConfig>;
  agentId: string;
  sessionKey: string;
  conversationId: string;
  accountId?: string;
}) {
  const storePath = resolveStorePath(params.cfg.session?.store, {
    agentId: params.agentId,
  });
  const store = loadSessionStore(storePath);
  const entry = store[params.sessionKey];
  const requireMention = resolveGroupRequireMentionFor(
    params.cfg,
    params.conversationId,
    params.accountId,
  );
  const defaultActivation = !requireMention ? "always" : "mention";
  return normalizeGroupActivation(entry?.groupActivation) ?? defaultActivation;
}
