/** Shared sender identity helpers for authorization checks. */
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  normalizeStringEntries,
  normalizeTrimmedStringList,
} from "@openclaw/normalization-core/string-normalization";
import type { AnyChannelPlugin as ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

function isConversationLikeIdentity(value: string): boolean {
  const normalized = normalizeOptionalLowercaseString(value);
  if (!normalized) {
    return false;
  }
  if (normalized.startsWith("chat_id:")) {
    return true;
  }
  return /(^|:)(channel|group|thread|topic|room|space|spaces):/.test(normalized);
}

export function shouldUseFromAsSenderFallback(params: {
  from?: string | null;
  chatType?: string | null;
}): boolean {
  const from = normalizeOptionalString(params.from) ?? "";
  if (!from) {
    return false;
  }
  const chatType = normalizeLowercaseStringOrEmpty(params.chatType);
  if (chatType && chatType !== "direct") {
    return false;
  }
  return !isConversationLikeIdentity(from);
}

export type AllowFromParams = {
  plugin?: ChannelPlugin;
  cfg: OpenClawConfig;
  accountId?: string | null;
};

export function formatAllowFromList(
  params: AllowFromParams & { allowFrom: Array<string | number> },
): string[] {
  const { plugin, cfg, accountId, allowFrom } = params;
  if (!allowFrom || allowFrom.length === 0) {
    return [];
  }
  if (plugin?.config?.formatAllowFrom) {
    return plugin.config.formatAllowFrom({ cfg, accountId, allowFrom });
  }
  return normalizeStringEntries(allowFrom);
}

export function normalizeAllowFromEntry(params: AllowFromParams & { value: string }): string[] {
  return formatAllowFromList({ ...params, allowFrom: [params.value] }).filter((entry) =>
    Boolean(entry.trim()),
  );
}

export function resolveSenderCandidates(
  params: AllowFromParams & {
    senderId?: string | null;
    senderE164?: string | null;
    commandSenderId?: string;
    from?: string | null;
    chatType?: string | null;
  },
): string[] {
  const { plugin, cfg, accountId } = params;
  const candidates = normalizeTrimmedStringList(
    plugin?.commands?.preferSenderE164ForCommands
      ? [params.senderE164, params.senderId]
      : [params.senderId, params.senderE164],
  );
  if (
    candidates.length === 0 &&
    shouldUseFromAsSenderFallback({ from: params.from, chatType: params.chatType })
  ) {
    candidates.push(...normalizeTrimmedStringList([params.from]));
  }

  candidates.push(...normalizeTrimmedStringList([params.commandSenderId]));
  return [
    ...new Set(
      candidates.flatMap((sender) =>
        normalizeAllowFromEntry({ plugin, cfg, accountId, value: sender }),
      ),
    ),
  ];
}
