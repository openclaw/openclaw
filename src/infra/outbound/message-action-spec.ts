// Message-action specs describe which actions need destinations and which
// legacy/plugin aliases count as an existing target.
import {
  hasNonEmptyString,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
  normalizeOptionalStringifiedId,
} from "@openclaw/normalization-core/string-coerce";
import { getBootstrapChannelPlugin } from "../../channels/plugins/bootstrap-registry.js";
import type {
  ChannelMessageActionAdapter,
  ChannelMessageActionName,
} from "../../channels/plugins/types.public.js";
import { hasPotentialPluginActionParam } from "./message-action-param-keys.js";

/**
 * Canonical parameter shape used by an outbound message action target.
 */
type MessageActionTargetMode = "to" | "channelId" | "none";

/**
 * Target-parameter policy for each supported channel message action.
 */
const MESSAGE_ACTION_TARGET_MODE: Record<ChannelMessageActionName, MessageActionTargetMode> = {
  send: "to",
  broadcast: "none",
  poll: "to",
  "poll-vote": "to",
  react: "to",
  reactions: "to",
  read: "to",
  edit: "to",
  unsend: "to",
  reply: "to",
  sendWithEffect: "to",
  renameGroup: "to",
  setGroupIcon: "to",
  addParticipant: "to",
  removeParticipant: "to",
  leaveGroup: "to",
  sendAttachment: "to",
  delete: "to",
  pin: "to",
  unpin: "to",
  "list-pins": "to",
  permissions: "to",
  "thread-create": "to",
  "thread-list": "none",
  "thread-reply": "to",
  search: "none",
  sticker: "to",
  "sticker-search": "none",
  "member-info": "none",
  "role-info": "none",
  "emoji-list": "none",
  "emoji-upload": "none",
  "sticker-upload": "none",
  "role-add": "none",
  "role-remove": "none",
  "channel-info": "channelId",
  "channel-list": "none",
  "channel-create": "none",
  "conversation-open": "none",
  "channel-edit": "channelId",
  "channel-delete": "channelId",
  "channel-move": "channelId",
  "category-create": "none",
  "category-edit": "none",
  "category-delete": "none",
  "topic-create": "to",
  "topic-edit": "to",
  "voice-status": "none",
  "event-list": "none",
  "event-create": "none",
  timeout: "none",
  kick: "none",
  ban: "none",
  "set-profile": "none",
  "set-presence": "none",
  "download-file": "none",
  "upload-file": "to",
};

/** Maps canonical `target` into the legacy field required by the action implementation. */
export function applyTargetToParams(params: {
  action: string;
  args: Record<string, unknown>;
}): void {
  const target = normalizeOptionalString(params.args.target) ?? "";
  const hasLegacyTo = hasNonEmptyString(params.args.to);
  const hasLegacyChannelId = hasNonEmptyString(params.args.channelId);
  const mode =
    // SAFETY: Missing keys fall back to "none"; only "to" and "channelId" map a target below.
    MESSAGE_ACTION_TARGET_MODE[params.action as keyof typeof MESSAGE_ACTION_TARGET_MODE] ?? "none";

  if (mode !== "none") {
    if (hasLegacyTo || hasLegacyChannelId) {
      throw new Error("Use `target` instead of `to`/`channelId`.");
    }
  } else if (hasLegacyTo) {
    throw new Error("Use `target` for actions that accept a destination.");
  }

  if (!target) {
    return;
  }
  if (mode === "channelId") {
    params.args.channelId = target;
    return;
  }
  if (mode === "to") {
    params.args.to = target;
    return;
  }
  throw new Error(`Action ${params.action} does not accept a target.`);
}

type ActionTargetAliasSpec = {
  aliases: string[];
};

export type ActionDeliveryTargetAliasSpec = NonNullable<
  NonNullable<ChannelMessageActionAdapter["messageActionTargetAliases"]>[ChannelMessageActionName]
>;

type ActionTargetAliasOptions = {
  channel?: string;
  /** null preserves a selected adapter's absence; undefined permits bootstrap discovery. */
  aliasSpec?: ActionDeliveryTargetAliasSpec | null;
};

function resolvePluginActionTargetAliasSpec(
  action: ChannelMessageActionName,
  channel: string,
  selected: ActionDeliveryTargetAliasSpec | null | undefined,
): ActionDeliveryTargetAliasSpec | null | undefined {
  return selected !== undefined
    ? selected
    : getBootstrapChannelPlugin(channel)?.actions?.messageActionTargetAliases?.[action];
}

const ACTION_TARGET_ALIASES: Partial<Record<ChannelMessageActionName, ActionTargetAliasSpec>> = {
  unsend: { aliases: ["messageId"] },
  edit: { aliases: ["messageId"] },
  react: { aliases: ["chatGuid", "chatIdentifier", "chatId"] },
  renameGroup: { aliases: ["chatGuid", "chatIdentifier", "chatId"] },
  setGroupIcon: { aliases: ["chatGuid", "chatIdentifier", "chatId"] },
  addParticipant: { aliases: ["chatGuid", "chatIdentifier", "chatId"] },
  removeParticipant: { aliases: ["chatGuid", "chatIdentifier", "chatId"] },
  leaveGroup: { aliases: ["chatGuid", "chatIdentifier", "chatId"] },
};

function listActionTargetAliasSpecs(
  action: ChannelMessageActionName,
  params: Record<string, unknown>,
  options?: ActionTargetAliasOptions,
): ActionTargetAliasSpec[] {
  const specs: ActionTargetAliasSpec[] = [];
  const coreSpec = ACTION_TARGET_ALIASES[action];
  if (coreSpec) {
    specs.push(coreSpec);
  }
  const normalizedChannel = normalizeOptionalLowercaseString(options?.channel);
  if (!normalizedChannel || !hasPotentialPluginActionParam(params)) {
    return specs;
  }
  // Plugin aliases are only checked after cheap param-shape screening to avoid bootstrap reads.
  const channelSpec = resolvePluginActionTargetAliasSpec(
    action,
    normalizedChannel,
    options?.aliasSpec,
  );
  if (channelSpec) {
    specs.push(channelSpec);
  }
  return specs;
}

/** Resolves a plugin-declared delivery alias into the shared target contract. */
export function resolveActionDeliveryTargetAlias(
  action: ChannelMessageActionName,
  params: Record<string, unknown>,
  options?: ActionTargetAliasOptions,
): string | undefined {
  const channel = normalizeOptionalLowercaseString(options?.channel);
  if (!channel || !hasPotentialPluginActionParam(params)) {
    return undefined;
  }
  const aliases = resolvePluginActionTargetAliasSpec(action, channel, options?.aliasSpec);
  const resolved = aliases?.resolveDeliveryTarget?.({ args: params });
  if (resolved !== undefined) {
    return normalizeOptionalString(resolved);
  }
  const deliveryAliases = aliases?.deliveryTargetAliases ?? [];
  const targets = deliveryAliases
    .map((alias) => normalizeOptionalStringifiedId(params[alias]))
    .filter((value): value is string => Boolean(value));
  if (new Set(targets).size > 1) {
    throw new Error(`Action ${action} received conflicting delivery target aliases.`);
  }
  return targets[0];
}

/** Reports whether a plugin alias identifies an existing resource rather than a conversation. */
export function actionHasResourceReference(
  action: ChannelMessageActionName,
  params: Record<string, unknown>,
  options?: ActionTargetAliasOptions,
): boolean {
  const channel = normalizeOptionalLowercaseString(options?.channel);
  if (!channel || !hasPotentialPluginActionParam(params)) {
    return false;
  }
  const aliases = resolvePluginActionTargetAliasSpec(action, channel, options?.aliasSpec);
  // Legacy alias specs do not distinguish conversations from resources.
  // Do not infer ambient authority unless the owner explicitly partitions them.
  if (!aliases?.deliveryTargetAliases) {
    return false;
  }
  const deliveryAliases = new Set(aliases.deliveryTargetAliases);
  return aliases.aliases.some(
    (alias) =>
      !deliveryAliases.has(alias) && normalizeOptionalStringifiedId(params[alias]) !== undefined,
  );
}

/**
 * Reports whether an action normally needs a destination target.
 */
export function actionRequiresTarget(action: ChannelMessageActionName): boolean {
  return MESSAGE_ACTION_TARGET_MODE[action] !== "none";
}

/**
 * Detects whether an action invocation already carries a usable target.
 */
export function actionHasTarget(
  action: ChannelMessageActionName,
  params: Record<string, unknown>,
  options?: ActionTargetAliasOptions,
): boolean {
  if (hasNonEmptyString(params.to) || hasNonEmptyString(params.channelId)) {
    return true;
  }
  return listActionTargetAliasSpecs(action, params, options).some((spec) =>
    spec.aliases.some((alias) => normalizeOptionalStringifiedId(params[alias]) !== undefined),
  );
}
