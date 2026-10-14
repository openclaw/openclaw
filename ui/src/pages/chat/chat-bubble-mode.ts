import { normalizeUniqueTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import type { UiSettings } from "../../app/settings-contract.ts";
import {
  areUiSessionKeysEquivalent,
  normalizeDefaultMainSessionAliasForUi,
  parseAgentSessionKey,
} from "../../lib/sessions/session-key.ts";

type ChatBubbleSettings = Pick<
  UiSettings,
  "chatBubbleSessionKeys" | "chatBubbleDisabledSessionKeys"
>;

export function normalizeChatBubbleSessionKeys(value: unknown): string[] | undefined {
  const keys = normalizeUniqueTrimmedStringList(value);
  const normalized = [...new Set(keys.map(normalizeDefaultMainSessionAliasForUi))];
  return normalized.length > 0 ? normalized : undefined;
}

export function isChatBubbleMode(
  settings: ChatBubbleSettings,
  sessionKey: string,
  labEnabled = false,
  mainKey = "main",
): boolean {
  if (!labEnabled) {
    return false;
  }
  const includes = (keys: string[] | undefined) =>
    keys?.some((key) => areUiSessionKeysEquivalent(key, sessionKey));
  if (includes(settings.chatBubbleDisabledSessionKeys)) {
    return false;
  }
  if (includes(settings.chatBubbleSessionKeys)) {
    return true;
  }
  const key = normalizeDefaultMainSessionAliasForUi(sessionKey);
  const rest = parseAgentSessionKey(key)?.rest ?? key;
  return rest === "main" || rest === mainKey.trim().toLowerCase() || key === "global";
}

export function setChatBubbleMode(
  settings: ChatBubbleSettings,
  sessionKey: string,
  enabled: boolean,
): Partial<UiSettings> {
  const key = normalizeDefaultMainSessionAliasForUi(sessionKey);
  if (!key) {
    return {};
  }
  const withoutSession = (keys: string[] | undefined) =>
    (normalizeChatBubbleSessionKeys(keys) ?? []).filter(
      (candidate) => !areUiSessionKeysEquivalent(candidate, key),
    );
  const on = withoutSession(settings.chatBubbleSessionKeys);
  const off = withoutSession(settings.chatBubbleDisabledSessionKeys);
  (enabled ? on : off).push(key);
  return {
    chatBubbleSessionKeys: on.length > 0 ? on : undefined,
    chatBubbleDisabledSessionKeys: off.length > 0 ? off : undefined,
  };
}
