import { normalizeChatSendShortcut, type ChatSendShortcut } from "./settings.ts";

// Any mouse or trackpad, including one paired with a tablet, keeps the synced pref.
const TOUCH_ONLY_QUERY = "(pointer: coarse) and (any-hover: none)";

// The synced pref is shared across devices, but on-screen keyboards have no
// Shift+Enter, so Return must insert a new line there; Send and Ctrl/Cmd+Enter
// still submit. jsdom lacks matchMedia and keeps the synced pref.
export function resolveChatSendShortcut(value: unknown): ChatSendShortcut {
  return globalThis.matchMedia?.(TOUCH_ONLY_QUERY).matches
    ? "modifier-enter"
    : normalizeChatSendShortcut(value);
}
