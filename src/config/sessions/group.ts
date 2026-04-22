import type { MsgContext } from "../../auto-reply/templating.js";
import { listChannelPlugins } from "../../channels/plugins/registry.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import { listDeliverableMessageChannels } from "../../utils/message-channel.js";
import type { GroupKeyResolution } from "./types.js";

const getGroupSurfaces = () => new Set<string>([...listDeliverableMessageChannels(), "webchat"]);

type LegacyGroupSessionSurface = {
  resolveLegacyGroupSessionKey?: (ctx: MsgContext) => GroupKeyResolution | null;
};

function resolveImplicitGroupSurface(params: {
  from: string;
  normalizedChatType?: "group" | "channel";
}): { provider: string; chatType: "group" | "channel" } | null {
  if (params.from.endsWith("@g.us")) {
    return { provider: "whatsapp", chatType: "group" };
  }
  if (params.normalizedChatType) {
    return null;
  }
  return null;
}

function resolveLegacyGroupSessionKey(ctx: MsgContext): GroupKeyResolution | null {
  for (const plugin of listChannelPlugins()) {
    const resolved = (
      plugin.messaging as LegacyGroupSessionSurface | undefined
    )?.resolveLegacyGroupSessionKey?.(ctx);
    if (resolved) {
      return resolved;
    }
  }
  return null;
}

type GroupDisplayNameParams = {
  provider?: string;
  subject?: string;
  groupChannel?: string;
  space?: string;
  id?: string;
  key: string;
};

function normalizeGroupDisplayText(raw?: string | null) {
  const trimmed = normalizeOptionalString(raw) ?? "";
  return trimmed ? trimmed.replace(/\s+/g, " ") : "";
}

function buildGroupDisplayDetail(params: GroupDisplayNameParams) {
  const groupChannel = normalizeGroupDisplayText(params.groupChannel);
  const space = normalizeGroupDisplayText(params.space);
  const subject = normalizeGroupDisplayText(params.subject);
  return (
    (groupChannel && space
      ? `${space}${groupChannel.startsWith("#") ? "" : "#"}${groupChannel}`
      : groupChannel || subject || space || "") || ""
  );
}

function shortenGroupId(value?: string) {
  const trimmed = normalizeGroupDisplayText(value);
  if (!trimmed) {
    return "";
  }
  if (trimmed.length <= 14) {
    return trimmed;
  }
  return `${trimmed.slice(0, 6)}...${trimmed.slice(-4)}`;
}

function buildLegacyGroupDisplayName(params: GroupDisplayNameParams) {
  const providerKey = normalizeOptionalLowercaseString(params.provider) ?? "group";
  const detail = buildGroupDisplayDetail(params).toLowerCase();
  const fallbackId = normalizeGroupDisplayText(params.id ?? params.key).toLowerCase();
  const rawLabel = detail || fallbackId;
  let token = rawLabel.replace(/\s+/g, "-").replace(/[^a-z0-9#@._+-]+/g, "-");
  token = token.replace(/-{2,}/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  if (!token) {
    token = shortenGroupId(rawLabel)
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9#@._+-]+/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "");
  }
  if (!params.groupChannel && token.startsWith("#")) {
    token = token.replace(/^#+/, "");
  }
  if (token && !/^[@#]/.test(token) && !token.startsWith("g-") && !token.includes("#")) {
    token = `g-${token}`;
  }
  return token ? `${providerKey}:${token}` : providerKey;
}

export function isLegacyGroupDisplayName(
  displayName: string | undefined,
  params: GroupDisplayNameParams,
) {
  const normalized = normalizeOptionalString(displayName);
  if (!normalized) {
    return false;
  }
  return normalized === buildLegacyGroupDisplayName(params);
}

export function buildGroupDisplayName(params: GroupDisplayNameParams) {
  const providerKey = normalizeOptionalLowercaseString(params.provider) ?? "group";
  const detail = buildGroupDisplayDetail(params);
  const fallbackId = normalizeGroupDisplayText(params.id) || normalizeGroupDisplayText(params.key);
  const token = normalizeGroupDisplayText(detail || shortenGroupId(fallbackId));
  return token ? `${providerKey}:${token}` : providerKey;
}

export function resolveGroupSessionKey(ctx: MsgContext): GroupKeyResolution | null {
  const from = normalizeOptionalString(ctx.From) ?? "";
  const chatType = normalizeOptionalLowercaseString(ctx.ChatType);
  const normalizedChatType =
    chatType === "channel" ? "channel" : chatType === "group" ? "group" : undefined;
  const implicitGroupSurface = resolveImplicitGroupSurface({ from, normalizedChatType });

  const legacyResolution = resolveLegacyGroupSessionKey(ctx);
  const looksLikeGroup =
    normalizedChatType === "group" ||
    normalizedChatType === "channel" ||
    from.includes(":group:") ||
    from.includes(":channel:") ||
    implicitGroupSurface !== null ||
    legacyResolution !== null;
  if (!looksLikeGroup) {
    return null;
  }

  const providerHint = normalizeOptionalLowercaseString(ctx.Provider);

  const parts = from.split(":").filter(Boolean);
  const head = normalizeLowercaseStringOrEmpty(parts[0]);
  const headIsSurface = head ? getGroupSurfaces().has(head) : false;

  if (!headIsSurface && !providerHint && legacyResolution) {
    return legacyResolution;
  }

  const provider = headIsSurface
    ? head
    : (providerHint ?? implicitGroupSurface?.provider ?? legacyResolution?.channel);
  if (!provider) {
    return null;
  }

  const second = normalizeOptionalLowercaseString(parts[1]);
  const secondIsKind = second === "group" || second === "channel";
  const kind = secondIsKind
    ? second
    : from.includes(":channel:") || normalizedChatType === "channel"
      ? "channel"
      : (implicitGroupSurface?.chatType ?? "group");
  const id = headIsSurface
    ? secondIsKind
      ? parts.slice(2).join(":")
      : parts.slice(1).join(":")
    : from;
  const finalId = normalizeLowercaseStringOrEmpty(id);
  if (!finalId) {
    return null;
  }

  return {
    key: `${provider}:${kind}:${finalId}`,
    channel: provider,
    id: finalId,
    chatType: kind === "channel" ? "channel" : "group",
  };
}
