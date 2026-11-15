import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeHyphenSlug } from "@openclaw/normalization-core/string-normalization";

/**
 * Builds a human-readable group/channel title from stored chat metadata.
 * Prefers the native channel name (#general) or the chat subject verbatim;
 * returns undefined when only opaque route ids are available so callers can
 * fall back to the compact token form below.
 */
export function buildGroupDisplayTitle(params: {
  subject?: string;
  topicName?: string;
  groupChannel?: string;
  space?: string;
}): string | undefined {
  const subject = normalizeOptionalString(params.subject);
  const groupChannel = normalizeOptionalString(params.groupChannel);
  const space = normalizeOptionalString(params.space);
  if (groupChannel) {
    const channelLabel = groupChannel.startsWith("#") ? groupChannel : `#${groupChannel}`;
    return space ? `${space} ${channelLabel}` : channelLabel;
  }
  return (
    [subject ?? space, normalizeOptionalString(params.topicName)].filter(Boolean).join(" / ") ||
    undefined
  );
}

/** Builds a compact display label for group sessions from channel metadata or ids. */
export function buildGroupDisplayName(params: {
  provider?: string;
  subject?: string;
  topicName?: string;
  groupChannel?: string;
  space?: string;
  id?: string;
  key: string;
}) {
  const providerKey = normalizeOptionalLowercaseString(params.provider) ?? "group";
  const groupChannel = normalizeOptionalString(params.groupChannel);
  const space = normalizeOptionalString(params.space);
  const subject = buildGroupDisplayTitle({ subject: params.subject, topicName: params.topicName });
  const detail =
    (groupChannel && space
      ? `${space}${groupChannel.startsWith("#") ? "" : "#"}${groupChannel}`
      : groupChannel || subject || space || "") || "";
  const fallbackId = normalizeOptionalString(params.id) ?? params.key;
  const rawLabel = detail || fallbackId;
  let token = normalizeHyphenSlug(rawLabel);
  if (!params.groupChannel && token.startsWith("#")) {
    token = token.replace(/^#+/, "");
  }
  if (token && !/^[@#]/.test(token) && !token.startsWith("g-") && !token.includes("#")) {
    token = `g-${token}`;
  }
  return token ? `${providerKey}:${token}` : providerKey;
}
