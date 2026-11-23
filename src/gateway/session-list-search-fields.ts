import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { buildGroupDisplayName } from "../config/sessions/group-display.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { sessionDeliveryChannel, sessionDeliveryOrigin } from "../utils/delivery-context.read.js";
import { isGroupOrChannelDisplaySession, parseGroupKey } from "./session-utils-store.js";

/** The matcher and its conservative vocabulary must use the same model fields. */
export function addSessionListSearchModelFields(
  fields: Array<string | undefined>,
  identity: { provider?: string; model?: string } | undefined,
) {
  const provider = normalizeOptionalString(identity?.provider);
  const model = normalizeOptionalString(identity?.model);
  fields.push(provider, model);
  if (provider && model) {
    fields.push(`${provider}/${model}`);
  }
}

export function resolveSessionListSearchDisplayName(
  key: string,
  entry?: SessionEntry,
): string | undefined {
  if (entry?.displayName) {
    return entry.displayName;
  }
  const parsed = parseGroupKey(key);
  const channel = sessionDeliveryChannel(entry) ?? parsed?.channel;
  if (isGroupOrChannelDisplaySession(entry, parsed) && channel) {
    return buildGroupDisplayName({
      provider: channel,
      subject: entry?.subject,
      groupChannel: entry?.groupChannel,
      space: entry?.space,
      id: parsed?.id,
      key,
    });
  }
  return entry?.label ?? sessionDeliveryOrigin(entry)?.label;
}
