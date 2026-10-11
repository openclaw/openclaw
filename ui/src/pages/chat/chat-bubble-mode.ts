import { normalizeUniqueTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import type { UiSettings } from "../../app/settings-contract.ts";
import {
  areUiSessionKeysEquivalent,
  normalizeDefaultMainSessionAliasForUi,
} from "../../lib/sessions/session-key.ts";

type ChatBubbleSettings = Pick<UiSettings, "chatBubbleSessionKeys">;

export function normalizeChatBubbleSessionKeys(value: unknown): string[] | undefined {
  const keys = normalizeUniqueTrimmedStringList(value);
  const normalized = [...new Set(keys.map(normalizeDefaultMainSessionAliasForUi))];
  return normalized.length > 0 ? normalized : undefined;
}

export function isChatBubbleMode(settings: ChatBubbleSettings, sessionKey: string): boolean {
  return (
    settings.chatBubbleSessionKeys?.some((key) => areUiSessionKeysEquivalent(key, sessionKey)) ??
    false
  );
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
  const keys = (normalizeChatBubbleSessionKeys(settings.chatBubbleSessionKeys) ?? []).filter(
    (candidate) => !areUiSessionKeysEquivalent(candidate, key),
  );
  if (enabled) {
    keys.push(key);
  }
  return { chatBubbleSessionKeys: keys.length > 0 ? keys : undefined };
}
